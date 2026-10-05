#!/usr/bin/env bun
/// <reference types="bun-types" />
/**
 * DingTalk channel broker.
 *
 * One daemon per machine. It owns the only DingTalk Stream WebSocket (the
 * gateway load-balances across an app's connections, so a second connection
 * would silently steal a share of the messages), the OpenAPI access token,
 * access control, and the routing table that decides which Claude Code
 * session each inbound message belongs to.
 *
 * Claude Code sessions never talk to DingTalk directly. Each session runs a
 * thin MCP shim (server.ts) that connects here over a Unix socket.
 *
 * Routing keys: DMs route by `dm:<senderStaffId>`, group chats by
 * `group:<openConversationId>`. A message that matches no bound session is
 * refused with config.unroutedReply rather than being queued or broadcast.
 *
 * Env flags (testing):
 *   DINGTALK_NO_STREAM=1     skip the DingTalk WebSocket entirely
 *   DINGTALK_DRY_SEND=1      record outbound sends to sent.jsonl, no network
 *   DINGTALK_ALLOW_INJECT=1  accept `inject` frames from clients
 *   DINGTALK_BROKER_IDLE_MS  exit after this long with zero clients (0 = never)
 *
 * Supervision:
 *   DINGTALK_BROKER_STANDBY=1  if another broker already owns the socket, wait
 *                              and take over when it goes away instead of
 *                              exiting — for a launchd job that must stay up
 */

import { createServer, connect, type Socket, type Server } from 'net'
import {
  readFileSync,
  writeFileSync,
  appendFileSync,
  mkdirSync,
  renameSync,
  unlinkSync,
  existsSync,
  chmodSync,
} from 'fs'
import { join } from 'path'
import {
  STATE_DIR,
  ACCESS_FILE,
  ROUTES_FILE,
  ATTACHMENT_DIR,
  SOCKET_PATH,
  BROKER_PID_FILE,
  loadDingConfig,
  debugLog,
  dmKey,
  groupKey,
  lineDecoder,
  sendLine,
  type RouteKey,
  type RoutesFile,
  type RouteRow,
  type ReplyArgs,
  type ShimToBroker,
} from './shared.ts'
import { TenantManager, type InboundFrame } from './tenants.ts'

const NO_STREAM = process.env.DINGTALK_NO_STREAM === '1'
const DRY_SEND = process.env.DINGTALK_DRY_SEND === '1'
const ALLOW_INJECT = process.env.DINGTALK_ALLOW_INJECT === '1'
const IDLE_EXIT_MS = Number(process.env.DINGTALK_BROKER_IDLE_MS ?? 10 * 60_000)
const SENT_LOG = join(STATE_DIR, 'sent.jsonl')

mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 })
const config = loadDingConfig()

function log(line: string): void {
  process.stderr.write(`dingtalk broker: ${line}\n`)
  debugLog('broker', line)
}

// Stay alive through channel errors — sessions depend on this process.
process.on('unhandledRejection', err => {
  log(`unhandled rejection: ${err}`)
})
process.on('uncaughtException', err => {
  log(`uncaught exception: ${err}`)
})

// --- access control ----------------------------------------------------------

type GroupPolicy = { allowFrom: string[] }

type Access = {
  dmPolicy: 'allowlist' | 'disabled' | 'open'
  allowFrom: string[] // DingTalk staffIds
  groups: Record<string, GroupPolicy> // keyed by openConversationId
}

function defaultAccess(): Access {
  return { dmPolicy: 'allowlist', allowFrom: [], groups: {} }
}

function loadAccess(): Access {
  try {
    const parsed = JSON.parse(readFileSync(ACCESS_FILE, 'utf8')) as Partial<Access>
    return {
      dmPolicy: parsed.dmPolicy ?? 'allowlist',
      allowFrom: parsed.allowFrom ?? [],
      groups: parsed.groups ?? {},
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return defaultAccess()
    try {
      renameSync(ACCESS_FILE, `${ACCESS_FILE}.corrupt-${Date.now()}`)
    } catch {}
    log('access.json corrupt, moved aside. Starting fresh.')
    return defaultAccess()
  }
}

// --- DingTalk OpenAPI: access token ------------------------------------------

let accessToken: string | null = null
let tokenExpiresAt = 0

async function getAccessToken(): Promise<string> {
  if (accessToken && Date.now() < tokenExpiresAt - 60_000) return accessToken
  const res = await fetch('https://api.dingtalk.com/v1.0/oauth2/accessToken', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      appKey: config.clientId,
      appSecret: config.clientSecret,
    }),
  })
  if (!res.ok) {
    throw new Error(`dingtalk accessToken: ${res.status} ${await res.text()}`)
  }
  const body = (await res.json()) as { accessToken: string; expireIn: number }
  accessToken = body.accessToken
  tokenExpiresAt = Date.now() + body.expireIn * 1000
  return accessToken
}

// --- DingTalk reaction (emoji) API -------------------------------------------

const THINKING_EMOTION = '🤔思考中'
const THINKING_EMOTION_ID = '2659900'

function emotionBody(msgId: string, conversationId: string): object {
  return {
    robotCode: config.robotCode,
    openMsgId: msgId,
    openConversationId: conversationId,
    emotionType: 2,
    emotionName: THINKING_EMOTION,
    textEmotion: {
      emotionId: THINKING_EMOTION_ID,
      emotionName: THINKING_EMOTION,
      text: THINKING_EMOTION,
      backgroundId: 'im_bg_1',
    },
  }
}

async function emotionCall(
  path: 'reply' | 'recall',
  msgId: string,
  conversationId: string,
): Promise<boolean> {
  if (!config.robotCode || DRY_SEND) return false
  try {
    const token = await getAccessToken()
    const res = await fetch(`https://api.dingtalk.com/v1.0/robot/emotion/${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-acs-dingtalk-access-token': token,
      },
      body: JSON.stringify(emotionBody(msgId, conversationId)),
    })
    if (!res.ok) {
      log(`emotion/${path} ${res.status}: ${await res.text()}`)
      return false
    }
    return true
  } catch (err) {
    log(`emotion/${path} error: ${err instanceof Error ? err.message : err}`)
    return false
  }
}

const addReaction = (msgId: string, cid: string) => emotionCall('reply', msgId, cid)
const recallReaction = (msgId: string, cid: string) => emotionCall('recall', msgId, cid)

// Track pending reactions so the reply tool can recall them
const pendingReactions = new Map<string, { msgId: string; conversationId: string }>()

// Session-scoped reply webhooks from DingTalk. Each inbound message includes
// an ephemeral URL (valid ~5 min) you can POST to without auth. Preferred over
// the OpenAPI path because it works even before the app is published — the
// OpenAPI sendDM fails with staffId.notExisted for unpublished apps.
type SessionHook = { url: string; expiresAt: number }
const sessionHooks = new Map<string, SessionHook>()

// --- DingTalk media upload ----------------------------------------------------

async function uploadMedia(
  filePath: string,
  type: 'file' | 'image' = 'file',
): Promise<string> {
  if (DRY_SEND) return `dry-media-${filePath.split('/').pop()}`
  const token = await getAccessToken()
  const fileBytes = readFileSync(filePath)
  const fileName = filePath.split('/').pop() ?? 'file'

  const form = new FormData()
  form.append('type', type)
  form.append('media', new Blob([fileBytes]), fileName)

  const res = await fetch(
    `https://oapi.dingtalk.com/media/upload?access_token=${token}&type=${type}`,
    { method: 'POST', body: form },
  )
  if (!res.ok) {
    throw new Error(`media/upload ${res.status}: ${await res.text()}`)
  }
  const body = (await res.json()) as { media_id?: string; errcode?: number; errmsg?: string }
  if (body.errcode && body.errcode !== 0) {
    throw new Error(`media/upload error: ${body.errcode} ${body.errmsg}`)
  }
  if (!body.media_id) {
    throw new Error(`media/upload: no media_id in response`)
  }
  return body.media_id
}

// --- send helpers (text + file) -----------------------------------------------

type MsgPayload =
  | { kind: 'text'; text: string }
  | { kind: 'file'; mediaId: string; fileName: string; fileType: string }

function webhookBody(p: MsgPayload): object {
  if (p.kind === 'text') return { msgtype: 'text', text: { content: p.text } }
  const isImage = ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp'].includes(p.fileType)
  if (isImage) return { msgtype: 'image', image: { mediaId: p.mediaId } }
  return { msgtype: 'file', file: { mediaId: p.mediaId, fileName: p.fileName, fileType: p.fileType } }
}

function robotMsgFields(p: MsgPayload): { msgKey: string; msgParam: string } {
  if (p.kind === 'text') return { msgKey: 'sampleText', msgParam: JSON.stringify({ content: p.text }) }
  return {
    msgKey: 'sampleFile',
    msgParam: JSON.stringify({ mediaId: p.mediaId, fileName: p.fileName, fileType: p.fileType }),
  }
}

/** In dry-send mode, record what would have gone out so tests can assert on it. */
function recordDrySend(target: string, isGroup: boolean, payload: MsgPayload): void {
  try {
    appendFileSync(
      SENT_LOG,
      `${JSON.stringify({ ts: new Date().toISOString(), target, isGroup, payload })}\n`,
    )
  } catch {}
}

async function sendViaSessionWebhook(
  chatId: string,
  payload: MsgPayload,
): Promise<boolean> {
  const hook = sessionHooks.get(chatId)
  if (!hook) return false
  if (Date.now() >= hook.expiresAt) {
    sessionHooks.delete(chatId)
    return false
  }
  const res = await fetch(hook.url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(webhookBody(payload)),
  })
  if (!res.ok) {
    log(`sessionWebhook ${res.status}: ${await res.text()}`)
    return false
  }
  return true
}

async function sendDM(
  chatId: string,
  staffId: string | undefined,
  payload: MsgPayload,
): Promise<void> {
  if (DRY_SEND) return recordDrySend(staffId ?? chatId, false, payload)
  if (await sendViaSessionWebhook(chatId, payload)) return
  if (!staffId) {
    throw new Error(
      'DM reply needs the user (staffId) arg when sessionWebhook is unavailable',
    )
  }
  if (!config.robotCode) {
    throw new Error('DINGTALK_ROBOT_CODE not configured')
  }
  const token = await getAccessToken()
  const { msgKey, msgParam } = robotMsgFields(payload)
  const res = await fetch(
    'https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-acs-dingtalk-access-token': token,
      },
      body: JSON.stringify({
        robotCode: config.robotCode,
        userIds: [staffId],
        msgKey,
        msgParam,
      }),
    },
  )
  if (!res.ok) throw new Error(`sendDM ${res.status}: ${await res.text()}`)
  // batchSend answers 200 even when it delivers nothing; the verdict is in the body.
  const body = (await res.json().catch(() => ({}))) as {
    processQueryKey?: string
    invalidStaffIdList?: string[]
    flowControlledStaffIdList?: string[]
  }
  if (body.invalidStaffIdList?.includes(staffId)) {
    throw new Error(`sendDM: ${staffId} can't receive messages from this robot (outside the app's visible range?)`)
  }
  if (body.flowControlledStaffIdList?.includes(staffId)) {
    throw new Error(`sendDM: DingTalk is rate-limiting messages to ${staffId}`)
  }
  log(`sendDM via OpenAPI to ${staffId} (processQueryKey ${body.processQueryKey ?? 'none'})`)
}

async function sendGroup(
  openConversationId: string,
  payload: MsgPayload,
): Promise<void> {
  if (DRY_SEND) return recordDrySend(openConversationId, true, payload)
  if (await sendViaSessionWebhook(openConversationId, payload)) return
  if (!config.robotCode) {
    throw new Error('DINGTALK_ROBOT_CODE not configured')
  }
  const token = await getAccessToken()
  const { msgKey, msgParam } = robotMsgFields(payload)
  const res = await fetch(
    'https://api.dingtalk.com/v1.0/robot/groupMessages/send',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-acs-dingtalk-access-token': token,
      },
      body: JSON.stringify({
        robotCode: config.robotCode,
        openConversationId,
        msgKey,
        msgParam,
      }),
    },
  )
  if (!res.ok) throw new Error(`sendGroup ${res.status}: ${await res.text()}`)
}

/** Execute a `reply` tool call forwarded by a shim. */
async function doReply(args: ReplyArgs): Promise<void> {
  const { chat_id, text, is_group, user, file } = args
  if (!chat_id || !is_group) {
    throw new Error('reply: chat_id and is_group are required')
  }
  if (!text && !file) {
    throw new Error('reply: at least one of text or file is required')
  }

  const pending = pendingReactions.get(chat_id)
  if (pending) {
    pendingReactions.delete(chat_id)
    void recallReaction(pending.msgId, pending.conversationId)
  }

  const send = is_group === 'true'
    ? (p: MsgPayload) => sendGroup(chat_id, p)
    : (p: MsgPayload) => sendDM(chat_id, user, p)

  if (text) await send({ kind: 'text', text })

  if (file) {
    if (!existsSync(file)) throw new Error(`file not found: ${file}`)
    const fileName = file.split('/').pop() ?? 'file'
    const dotIdx = fileName.lastIndexOf('.')
    const fileType = dotIdx > 0 ? fileName.slice(dotIdx + 1).toLowerCase() : 'bin'
    const isImage = ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp'].includes(fileType)
    const mediaId = await uploadMedia(file, isImage ? 'image' : 'file')
    await send({ kind: 'file', mediaId, fileName, fileType })
  }
}

// --- routing table -----------------------------------------------------------

type Client = {
  id: string
  socket: Socket
  pid: number
  cwd: string
  label: string
  keys: Set<RouteKey>
  /** staffId when this is a tenant session the broker launched. */
  tenant?: string
}

let nextClientId = 1
const clients = new Map<string, Client>()
const routeTable = new Map<RouteKey, Client>()
let lastClientAt = Date.now()

function loadRoutes(): RoutesFile {
  try {
    return JSON.parse(readFileSync(ROUTES_FILE, 'utf8')) as RoutesFile
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      log('routes.json unreadable, starting with an empty routing table')
    }
    return {}
  }
}

/**
 * Bindings outlive the session that made them: a session restart (or a reload
 * after a code change) re-claims its keys from here by matching cwd.
 */
let persisted = loadRoutes()

function persistRoutes(): void {
  try {
    writeFileSync(ROUTES_FILE, `${JSON.stringify(persisted, null, 2)}\n`, {
      mode: 0o600,
    })
  } catch (err) {
    log(`could not persist routes.json: ${err instanceof Error ? err.message : err}`)
  }
}

/** Claim route keys for a client, taking them from whoever holds them now. */
function bindKeys(client: Client, keys: RouteKey[], persist = true): RouteKey[] {
  const evictions = new Map<Client, RouteKey[]>()
  for (const key of keys) {
    const holder = routeTable.get(key)
    if (holder && holder.id !== client.id) {
      holder.keys.delete(key)
      const list = evictions.get(holder) ?? []
      list.push(key)
      evictions.set(holder, list)
    }
    routeTable.set(key, client)
    client.keys.add(key)
    // A newly bound sender should hear from us immediately, not sit out the
    // rest of a refusal cooldown from before they were routed.
    unroutedCooldown.delete(key)
    if (persist) persisted[key] = { cwd: client.cwd, label: client.label }
  }
  if (persist) persistRoutes()
  for (const [holder, taken] of evictions) {
    sendLine(holder.socket, { t: 'evicted', keys: taken, by: client.label })
    log(`route(s) ${taken.join(', ')} moved from ${holder.label} to ${client.label}`)
  }
  return [...client.keys]
}

function unbindKeys(client: Client, keys: RouteKey[]): RouteKey[] {
  for (const key of keys) {
    if (routeTable.get(key)?.id === client.id) routeTable.delete(key)
    client.keys.delete(key)
    delete persisted[key]
  }
  persistRoutes()
  return [...client.keys]
}

function dropClient(client: Client): void {
  const released = client.keys.size
  for (const key of client.keys) {
    if (routeTable.get(key)?.id === client.id) routeTable.delete(key)
  }
  clients.delete(client.id)
  lastClientAt = Date.now()
  if (client.tenant && ![...clients.values()].some(c => c.tenant === client.tenant)) {
    tenants?.onOffline(client.tenant)
  }
  log(
    `session ${client.label} (pid ${client.pid}) disconnected, released ${released} route(s); ${clients.size} session(s) left`,
  )
}

function routeRows(viewer: Client | null): RouteRow[] {
  const keys = new Set<RouteKey>([...Object.keys(persisted), ...routeTable.keys()])
  return [...keys].sort().map(key => {
    const live = routeTable.get(key)
    const rec = persisted[key]
    return {
      key,
      label: live?.label ?? rec?.label ?? '',
      cwd: live?.cwd ?? rec?.cwd ?? '',
      pid: live?.pid ?? 0,
      online: !!live,
      mine: !!live && !!viewer && live.id === viewer.id,
    }
  })
}

// --- inbound via DingTalk Stream Mode ----------------------------------------

type RichTextSegment = {
  type?: string // "picture" for image segments
  text?: string
  downloadCode?: string
  pictureDownloadCode?: string
}

/** The message a user quoted with DingTalk's "reply" (引用回复). */
type RepliedMsg = {
  msgType?: string
  msgId?: string
  senderId?: string
  createdAt?: number
  content?: { text?: string; richText?: RichTextSegment[]; fileName?: string }
}

type BotMessage = {
  senderId?: string
  senderStaffId?: string
  senderNick?: string
  conversationId?: string
  conversationType?: string // "1" = DM, "2" = group
  msgtype?: string
  msgId?: string
  text?: { content?: string; isReplyMsg?: boolean; repliedMsg?: RepliedMsg }
  content?: { downloadCode?: string; fileName?: string; richText?: RichTextSegment[] }
  picture?: { downloadCode?: string }
  sessionWebhook?: string
  sessionWebhookExpiredTime?: number
}

// Download a bot-received attachment (picture, file) via DingTalk's
// messageFiles/download API into `dir`. Returns a local absolute path, or
// null on failure. Requires robotCode; access token is 2h-cached.
async function downloadAttachment(
  downloadCode: string,
  msgId: string | undefined,
  originalFileName: string | undefined,
  dir: string,
): Promise<string | null> {
  if (DRY_SEND) {
    // No network in dry-send mode; leave a stand-in so tests can see where it lands.
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const path = join(dir, (originalFileName ?? `${downloadCode}.bin`).replace(/[/\\:*?"<>|]/g, '_'))
    writeFileSync(path, `dry-send stand-in for ${downloadCode}\n`, { mode: 0o600 })
    return path
  }
  if (!config.robotCode) {
    log('attachment download skipped (no robotCode)')
    return null
  }
  try {
    const token = await getAccessToken()
    const res = await fetch(
      'https://api.dingtalk.com/v1.0/robot/messageFiles/download',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-acs-dingtalk-access-token': token,
        },
        body: JSON.stringify({ downloadCode, robotCode: config.robotCode }),
      },
    )
    if (!res.ok) {
      log(`messageFiles/download ${res.status}: ${await res.text()}`)
      return null
    }
    const body = (await res.json()) as { downloadUrl?: string }
    if (!body.downloadUrl) {
      log('messageFiles/download returned no downloadUrl')
      return null
    }
    const fileRes = await fetch(body.downloadUrl)
    if (!fileRes.ok) {
      log(`file fetch ${fileRes.status}`)
      return null
    }
    const bytes = new Uint8Array(await fileRes.arrayBuffer())

    // Extract original filename from Content-Disposition if not provided
    const disposition = fileRes.headers.get('content-disposition') ?? ''
    const fnMatch = disposition.match(/filename\*?=(?:UTF-8''|")?([^";]+)"?/i)
    if (!originalFileName && fnMatch) {
      originalFileName = decodeURIComponent(fnMatch[1])
    }

    // Determine file extension for fallback naming
    let ext = 'bin'
    if (fnMatch) {
      const dotIdx = fnMatch[1].lastIndexOf('.')
      if (dotIdx > 0) ext = decodeURIComponent(fnMatch[1].slice(dotIdx + 1)).toLowerCase()
    } else {
      const ctype = fileRes.headers.get('content-type') ?? ''
      const ctypeMap: Record<string, string> = {
        'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp',
        'image/jpeg': 'jpg', 'image/svg+xml': 'svg', 'image/bmp': 'bmp',
        'application/pdf': 'pdf', 'application/zip': 'zip',
        'application/json': 'json', 'text/plain': 'txt',
        'application/octet-stream': 'bin',
      }
      const mime = ctype.split(';')[0].trim().toLowerCase()
      if (ctypeMap[mime]) {
        ext = ctypeMap[mime]
      } else if (mime.startsWith('image/')) {
        ext = mime.split('/')[1] ?? 'bin'
      } else {
        const subtype = mime.split('/')[1]
        if (subtype && /^[a-z0-9]{1,10}$/.test(subtype)) ext = subtype
      }
    }
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    let fileName: string
    if (originalFileName) {
      const safeName = originalFileName.replace(/[/\\:*?"<>|]/g, '_')
      fileName = existsSync(join(dir, safeName))
        ? `${Date.now()}_${safeName}`
        : safeName
    } else {
      const safeId = (msgId ?? `${Date.now()}`).replace(/[^A-Za-z0-9_-]/g, '_')
      fileName = `${safeId}.${ext}`
    }
    const path = join(dir, fileName)
    writeFileSync(path, bytes, { mode: 0o600 })
    return path
  } catch (err) {
    log(`attachment download error: ${err instanceof Error ? err.message : err}`)
    return null
  }
}

// Senders with no bound session get one refusal per route key per window, so
// a burst of messages doesn't turn into a burst of DingTalk API calls.
const UNROUTED_COOLDOWN_MS = 5 * 60_000
const unroutedCooldown = new Map<RouteKey, number>()

async function refuseUnrouted(
  conversationId: string,
  staffId: string,
  isGroup: boolean,
  key: RouteKey,
): Promise<void> {
  const last = unroutedCooldown.get(key) ?? 0
  if (Date.now() - last < UNROUTED_COOLDOWN_MS) {
    log(`unrouted ${key} — refusal suppressed by cooldown`)
    return
  }
  unroutedCooldown.set(key, Date.now())
  try {
    const payload: MsgPayload = { kind: 'text', text: config.unroutedReply }
    if (isGroup) await sendGroup(conversationId, payload)
    else await sendDM(conversationId, staffId, payload)
    log(`unrouted ${key} — refused`)
  } catch (err) {
    log(`unrouted ${key} — refusal send failed: ${err instanceof Error ? err.message : err}`)
  }
}

// --- tenant mode -------------------------------------------------------------

function tenantClient(staffId: string): Client | undefined {
  for (const c of clients.values()) if (c.tenant === staffId) return c
  return undefined
}

const tenants: TenantManager | null = config.tenants
  ? new TenantManager(config.tenants, {
      log: line => log(line),
      deliver(staffId, frame) {
        const c = tenantClient(staffId)
        if (!c) return false
        // Take the route back if an owner's binding for it has since gone away.
        const key = dmKey(staffId)
        if (!routeTable.has(key)) {
          routeTable.set(key, c)
          c.keys.add(key)
        }
        sendLine(c.socket, { t: 'inbound', ...frame })
        return true
      },
      async send(staffId, chatId, text) {
        await sendDM(chatId, staffId, { kind: 'text', text })
      },
      async notify(staffId, chatId, text) {
        try {
          await sendDM(chatId, staffId, { kind: 'text', text })
        } catch (err) {
          log(`tenant ${staffId}: notice failed: ${err instanceof Error ? err.message : err}`)
        }
      },
    })
  : null

if (tenants) log(`tenant mode on — workspaces under ${config.tenants!.root}`)

const QUOTED_KIND: Record<string, string> = {
  picture: '图片', file: '文件', audio: '语音', video: '视频', richText: '图文', markdown: 'Markdown',
}

/**
 * Render a quoted reply as a quote block to put before the user's own words.
 * The block is read by the assistant, so it names the sender and says "you"
 * only for the assistant itself — "你自己" would read as the assistant.
 * DingTalk sends only the quoted message's text and sender id; for pictures
 * and files there is no download code, so those are named, not fetched.
 */
function quoteBlock(msg: BotMessage, isGroup: boolean): string | null {
  const q = msg.text?.isReplyMsg ? msg.text.repliedMsg : undefined
  if (!q) return null
  const sender = msg.senderNick || '用户'
  const what = q.senderId && q.senderId === msg.senderId
    ? '自己之前发的消息'
    : isGroup ? '群里其他人的消息' : '你之前的回复'
  let body = q.content?.text?.trim() ?? ''
  const rich = q.content?.richText
  if (!body && Array.isArray(rich)) {
    body = rich.map(s => s.text ?? (s.type === 'picture' ? '[图片]' : '')).join('').trim()
  }
  if (!body) body = `[${QUOTED_KIND[q.msgType ?? ''] ?? q.msgType ?? '未知'}消息${q.content?.fileName ? `：${q.content.fileName}` : ''}]`
  return [`> ${sender}引用了${what}：`, ...body.split('\n').map(l => `> ${l}`)].join('\n')
}

async function handleInbound(msg: BotMessage): Promise<void> {
  const senderStaffId = msg.senderStaffId
  const senderNick = msg.senderNick ?? ''
  const conversationId = msg.conversationId
  const conversationType = msg.conversationType
  if (!senderStaffId || !conversationId || !conversationType) return

  const isGroup = conversationType === '2'
  const msgtype = msg.msgtype ?? 'text'

  // Extract text and downloadCode, handling richText messages (image+text combo)
  let text = ''
  let downloadCode: string | undefined
  if (msgtype === 'richText' && Array.isArray(msg.content?.richText)) {
    const segments = msg.content!.richText!
    const textParts: string[] = []
    for (const seg of segments) {
      if (seg.text) textParts.push(seg.text)
      if (!downloadCode && (seg.downloadCode || seg.pictureDownloadCode)) {
        downloadCode = seg.downloadCode ?? seg.pictureDownloadCode
      }
    }
    text = textParts.join('').trim()
  } else {
    text = typeof msg.text?.content === 'string' ? msg.text.content.trim() : ''
    downloadCode = msg.content?.downloadCode ?? msg.picture?.downloadCode ?? undefined
  }
  const isAttachment =
    (msgtype === 'picture' || msgtype === 'richText' || msgtype === 'file') && !!downloadCode

  if (!text && !isAttachment) {
    log(
      `skipped msgtype=${msgtype} text=${!!text} downloadCode=${!!downloadCode} keys=${JSON.stringify(Object.keys(msg))}`,
    )
    return
  }

  // Access control. Senders who fail it are dropped in silence — replying
  // would confirm to a stranger that this bot exists and is listening.
  const access = loadAccess()
  if (access.dmPolicy === 'disabled') return
  if (!isGroup) {
    if (access.dmPolicy !== 'open' && !access.allowFrom.includes(senderStaffId)) {
      log(`denied dm from ${senderStaffId} (not in allowlist)`)
      return
    }
  } else {
    const policy = access.groups[conversationId]
    if (!policy) {
      log(`denied group ${conversationId} (not configured)`)
      return
    }
    if (policy.allowFrom.length > 0 && !policy.allowFrom.includes(senderStaffId)) {
      log(`denied ${senderStaffId} in group ${conversationId}`)
      return
    }
    // Group bots only receive @-mentions from DingTalk, so mention-gating is
    // already enforced by the platform.
  }

  // Record the reply webhook before routing — the refusal path needs it too.
  if (
    typeof msg.sessionWebhook === 'string' &&
    typeof msg.sessionWebhookExpiredTime === 'number'
  ) {
    sessionHooks.set(conversationId, {
      url: msg.sessionWebhook,
      expiresAt: msg.sessionWebhookExpiredTime,
    })
  }

  const key = isGroup ? groupKey(conversationId) : dmKey(senderStaffId)
  const client = routeTable.get(key)
  // Tenant mode covers DMs from senders named in the allowlist itself — an
  // open DM policy lets strangers talk to bound sessions, never spawns one.
  const forTenant =
    !client && !isGroup && !!tenants && access.allowFrom.includes(senderStaffId)
  if (!client && !forTenant) {
    await refuseUnrouted(conversationId, senderStaffId, isGroup, key)
    return
  }

  let attachmentPath: string | undefined
  if (isAttachment) {
    // A tenant session can only read its own workspace, so its attachments are
    // saved there; bound (owner) sessions keep using the shared directory.
    const tenantId = client?.tenant ?? (forTenant ? senderStaffId : undefined)
    const dir = tenantId
      ? tenants!.attachmentDir(tenantId, senderNick, conversationId)
      : ATTACHMENT_DIR
    const p = await downloadAttachment(downloadCode!, msg.msgId, msg.content?.fileName, dir)
    if (p) attachmentPath = p
  }

  const attachmentLabel = msgtype === 'file' ? '(file)' : '(image)'
  const said = text || (attachmentPath ? attachmentLabel : `${attachmentLabel}, download failed`)
  const quote = quoteBlock(msg, isGroup)
  const content = quote ? `${quote}\n\n${said}` : said

  const markThinking = () => {
    if (!msg.msgId) return
    void addReaction(msg.msgId, conversationId).then(ok => {
      if (ok) pendingReactions.set(conversationId, { msgId: msg.msgId!, conversationId })
    })
  }

  const frame: InboundFrame = {
    content,
    meta: {
      chat_id: conversationId,
      user: senderStaffId,
      user_name: senderNick,
      is_group: isGroup ? 'true' : 'false',
      message_id: msg.msgId ?? '',
      ...(attachmentPath
        ? msgtype === 'file'
          ? { file_path: attachmentPath }
          : { image_path: attachmentPath }
        : {}),
    },
  }

  if (client) {
    markThinking()
    sendLine(client.socket, { t: 'inbound', ...frame })
    if (client.tenant) tenants?.touch(client.tenant)
    log(`routed ${key} -> ${client.label} (pid ${client.pid})`)
    return
  }
  const outcome = await tenants!.route(senderStaffId, senderNick, conversationId, frame)
  if (outcome !== 'refused') markThinking()
  log(`routed ${key} -> tenant session (${outcome})`)
}

// --- shim socket server -------------------------------------------------------

let shuttingDown = false
let server: Server | null = null

function onConnection(socket: Socket): void {
  socket.setNoDelay(true)
  let client: Client | null = null

  async function onFrame(frame: ShimToBroker): Promise<void> {
    if (frame.t === 'hello' && frame.tenant) {
      if (client) return
      const staffId = frame.tenant
      const refuse = (reason: string) => {
        log(`rejected tenant session for ${staffId} (pid ${frame.pid}): ${reason}`)
        sendLine(socket, { t: 'rejected', reason })
        socket.end()
      }
      if (!tenants) return refuse('tenant mode is off')
      tenants.verifyHello(staffId, frame.sessionId ?? '', () => {
        if (socket.destroyed || client) return
        const c: Client = {
          id: String(nextClientId++),
          socket,
          pid: frame.pid,
          cwd: frame.cwd,
          label: `tenant:${staffId}`,
          keys: new Set(),
          tenant: staffId,
        }
        client = c
        clients.set(c.id, c)
        // An owner's manual binding for this sender outranks their own session.
        const holder = routeTable.get(dmKey(staffId))
        const bound = holder && !holder.tenant ? [] : bindKeys(c, [dmKey(staffId)], false)
        log(`tenant session for ${staffId} connected (pid ${c.pid}, ${c.cwd}); bound ${bound.join(', ') || '(owner holds the route)'}`)
        sendLine(socket, { t: 'welcome', brokerPid: process.pid, bound })
        tenants.onOnline(staffId, frame.sessionId!)
      }, refuse)
      return
    }

    if (frame.t === 'hello') {
      if (client) return
      const c: Client = {
        id: String(nextClientId++),
        socket,
        pid: frame.pid,
        cwd: frame.cwd,
        label: frame.label || `pid${frame.pid}`,
        keys: new Set(),
      }
      client = c
      clients.set(c.id, c)
      // Re-claim keys this working directory owned before, plus anything
      // DINGTALK_ROUTE asked for explicitly.
      const inherited = Object.entries(persisted)
        .filter(([, rec]) => rec.cwd === c.cwd)
        .map(([key]) => key)
      const bound = bindKeys(c, [...new Set([...inherited, ...frame.routes])])
      log(
        `session ${c.label} (pid ${c.pid}, ${c.cwd}) connected; bound ${bound.length ? bound.join(', ') : '(nothing)'}`,
      )
      sendLine(socket, { t: 'welcome', brokerPid: process.pid, bound })
      return
    }

    if (!client) {
      log('frame arrived before hello, ignoring')
      return
    }
    const c = client

    const deny = (id: string, error: string) =>
      sendLine(socket, { t: 'result', id, ok: false, error })

    switch (frame.t) {
      case 'bind':
        if (c.tenant) return deny(frame.id, 'tenant sessions cannot change routing')
        sendLine(socket, {
          t: 'result',
          id: frame.id,
          ok: true,
          bound: bindKeys(c, frame.keys),
        })
        return
      case 'unbind':
        if (c.tenant) return deny(frame.id, 'tenant sessions cannot change routing')
        sendLine(socket, {
          t: 'result',
          id: frame.id,
          ok: true,
          bound: unbindKeys(c, frame.keys),
        })
        return
      case 'routes':
        sendLine(socket, {
          t: 'result',
          id: frame.id,
          ok: true,
          bound: [...c.keys],
          // A tenant sees only its own route, not who else is using the bot.
          rows: c.tenant ? routeRows(c).filter(r => r.mine) : routeRows(c),
        })
        return
      case 'reply':
        try {
          let args = frame.args
          if (c.tenant) {
            const checked = tenants!.checkReply(c.tenant, args)
            if ('error' in checked) return deny(frame.id, checked.error)
            args = checked.args
            tenants!.touch(c.tenant)
          }
          await doReply(args)
          // Who answered whom — never the message text.
          log(`reply ${c.tenant ? `tenant ${c.tenant}` : c.label} -> ${args.chat_id}${args.file ? ' (+file)' : ''}`)
          sendLine(socket, { t: 'result', id: frame.id, ok: true })
        } catch (err) {
          sendLine(socket, {
            t: 'result',
            id: frame.id,
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          })
        }
        return
      case 'escalate': {
        if (!c.tenant || !tenants) return deny(frame.id, 'only tenant sessions can ask the owner for help')
        try {
          const err = await tenants.escalate(c.tenant, String(frame.text ?? ''))
          if (err) return deny(frame.id, err)
          tenants.touch(c.tenant)
          sendLine(socket, { t: 'result', id: frame.id, ok: true })
        } catch (err) {
          deny(frame.id, `could not reach the owner: ${err instanceof Error ? err.message : err}`)
        }
        return
      }
      case 'tenants': {
        if (c.tenant) return deny(frame.id, 'not available to tenant sessions')
        if (!tenants) return deny(frame.id, 'tenant mode is off (set tenants.enabled in config.json)')
        if (frame.action !== 'list') {
          if (!frame.staffId) return deny(frame.id, `${frame.action} needs a staffId`)
          const err = frame.action === 'stop'
            ? await tenants.stop(frame.staffId)
            : await tenants.reset(frame.staffId)
          if (err) return deny(frame.id, err)
        }
        sendLine(socket, { t: 'result', id: frame.id, ok: true, tenants: tenants.list() })
        return
      }
      case 'inject':
        if (!ALLOW_INJECT) {
          sendLine(socket, {
            t: 'result',
            id: frame.id,
            ok: false,
            error: 'inject disabled — start the broker with DINGTALK_ALLOW_INJECT=1',
          })
          return
        }
        try {
          await handleInbound(frame.msg as BotMessage)
          sendLine(socket, { t: 'result', id: frame.id, ok: true })
        } catch (err) {
          sendLine(socket, {
            t: 'result',
            id: frame.id,
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          })
        }
        return
    }
  }

  const decode = lineDecoder(
    raw => {
      void onFrame(raw as ShimToBroker).catch(err => {
        log(`frame handler failed: ${err instanceof Error ? err.message : err}`)
      })
    },
    (err, line) => log(`bad frame: ${err} :: ${line.slice(0, 200)}`),
  )

  socket.on('data', decode)
  socket.on('error', err => log(`socket error: ${err.message}`))
  socket.on('close', () => {
    if (client) dropClient(client)
  })
}

// --- DingTalk Stream Mode connection -----------------------------------------

async function openStreamSession(): Promise<{ endpoint: string; ticket: string }> {
  const res = await fetch(
    'https://api.dingtalk.com/v1.0/gateway/connections/open',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        clientId: config.clientId,
        clientSecret: config.clientSecret,
        subscriptions: [
          { type: 'CALLBACK', topic: '/v1.0/im/bot/messages/get' },
        ],
        ua: 'claude-channel-dingtalk/0.2.0',
        localIp: '127.0.0.1',
      }),
    },
  )
  if (!res.ok) {
    throw new Error(`open stream ${res.status}: ${await res.text()}`)
  }
  const body = (await res.json()) as { endpoint: string; ticket: string }
  if (!body.endpoint || !body.ticket) {
    throw new Error(`open stream: unexpected response ${JSON.stringify(body)}`)
  }
  return body
}

type Frame = {
  specVersion?: string
  type?: string
  headers?: {
    appId?: string
    connectionId?: string
    contentType?: string
    messageId?: string
    time?: string
    topic?: string
  }
  data?: string
}

function ackFrame(
  ws: WebSocket,
  headers: Frame['headers'],
  data: unknown = { response: {} },
): void {
  try {
    ws.send(
      JSON.stringify({
        code: 200,
        headers: {
          contentType: 'application/json',
          messageId: headers?.messageId,
        },
        message: 'OK',
        data: JSON.stringify(data),
      }),
    )
  } catch (err) {
    log(`ack send failed: ${err}`)
  }
}

/**
 * The shape of a payload with every string replaced by its length — enough to
 * see which fields DingTalk sent (quotes, rich text, new message types)
 * without writing anyone's message into the log.
 */
function shapeOf(v: unknown, depth = 0): unknown {
  if (typeof v === 'string') return `str(${v.length})`
  if (typeof v !== 'object' || v === null) return v
  if (depth > 5) return '…'
  if (Array.isArray(v)) return v.length ? [shapeOf(v[0], depth + 1), `×${v.length}`] : []
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shapeOf(x, depth + 1)]))
}

function handleStreamFrame(ws: WebSocket, raw: string): void {
  let frame: Frame
  try {
    frame = JSON.parse(raw) as Frame
  } catch {
    return
  }
  const topic = frame.headers?.topic

  if (frame.type === 'SYSTEM') {
    if (topic === 'ping') {
      ackFrame(ws, frame.headers, { response: 'pong' })
    } else if (topic === 'disconnect') {
      try {
        ws.close()
      } catch {}
    } else {
      ackFrame(ws, frame.headers)
    }
    return
  }

  if (frame.type !== 'CALLBACK') return

  if (topic !== '/v1.0/im/bot/messages/get') {
    ackFrame(ws, frame.headers)
    return
  }

  // Ack first so the gateway doesn't redeliver while we're processing.
  ackFrame(ws, frame.headers)
  let data: BotMessage
  try {
    data = JSON.parse(frame.data ?? '{}') as BotMessage
  } catch {
    return
  }
  const logDetail = data.msgtype === 'text'
    ? `text=${data.text?.content?.slice(0, 50)}`
    : `content=${JSON.stringify(data.content)}`
  log(
    `INBOUND msgtype=${data.msgtype} msgId=${data.msgId} staffId=${data.senderStaffId} nick=${data.senderNick} conversationId=${data.conversationId} conversationType=${data.conversationType} ${logDetail}`,
  )
  debugLog('broker', `INBOUND-SHAPE ${JSON.stringify(shapeOf(data))}`)
  void handleInbound(data).catch(err => {
    log(`handleInbound failed: ${err instanceof Error ? err.message : err}`)
  })
}

// The gateway sends nothing on an idle connection, and NATs (phone hotspots
// especially) and proxies quietly drop idle TCP mappings after a minute or
// two — leaving a socket that looks open but never delivers another message.
// So keep the connection busy with WebSocket pings, as the official SDKs do,
// and treat a missing pong as a dead connection.
const PING_INTERVAL_MS = 20_000
const LIVENESS_TIMEOUT_MS = 45_000

async function streamLoop(): Promise<void> {
  let backoff = 1000
  while (!shuttingDown) {
    try {
      const { endpoint, ticket } = await openStreamSession()
      const url = `${endpoint}?ticket=${encodeURIComponent(ticket)}`
      const host = (() => { try { return new URL(endpoint).host } catch { return endpoint } })()
      log(`connecting to stream (${host})`)
      const ws = new WebSocket(url)
      let openedAt = 0
      let lastActivity = Date.now()
      let keepalive: ReturnType<typeof setInterval> | null = null
      const alive = () => { lastActivity = Date.now() }
      ws.addEventListener('pong', alive)
      await new Promise<void>(resolve => {
        ws.onopen = () => {
          openedAt = Date.now()
          log(`stream open (${host})`)
          backoff = 1000
          alive()
          keepalive = setInterval(() => {
            const silent = Date.now() - lastActivity
            if (silent > LIVENESS_TIMEOUT_MS) {
              log(`no pong for ${Math.round(silent / 1000)}s — connection is dead, reconnecting`)
              try { ws.close() } catch {}
              return
            }
            // Bun's client WebSocket adds ping(); the DOM typings don't know it.
            try { (ws as unknown as { ping(): void }).ping() } catch {}
          }, PING_INTERVAL_MS)
        }
        ws.onmessage = ev => {
          alive()
          handleStreamFrame(
            ws,
            typeof ev.data === 'string' ? ev.data : String(ev.data),
          )
        }
        ws.onclose = ev => {
          if (keepalive) clearInterval(keepalive)
          const age = openedAt ? `${Math.round((Date.now() - openedAt) / 1000)}s` : 'never opened'
          log(`stream closed (${ev.code} ${ev.reason ?? ''}) after ${age}`)
          resolve()
        }
        ws.onerror = ev => {
          log(`stream error: ${(ev as unknown as { message?: string })?.message ?? 'unknown'}`)
        }
      })
    } catch (err) {
      log(`stream loop error: ${err instanceof Error ? err.message : err}`)
    }
    if (shuttingDown) break
    log(`reconnecting in ${Math.round(backoff / 1000)}s`)
    await new Promise(r => setTimeout(r, backoff))
    backoff = Math.min(backoff * 2, 60_000)
  }
}

// --- lifecycle ----------------------------------------------------------------

function shutdown(code = 0): void {
  if (shuttingDown) return
  shuttingDown = true
  log('shutting down')
  try { server?.close() } catch {}
  try { if (existsSync(SOCKET_PATH)) unlinkSync(SOCKET_PATH) } catch {}
  try {
    if (parseInt(readFileSync(BROKER_PID_FILE, 'utf8').trim(), 10) === process.pid) {
      unlinkSync(BROKER_PID_FILE)
    }
  } catch {}
  process.exit(code)
}
process.on('SIGTERM', () => shutdown())
process.on('SIGINT', () => shutdown())

/** Is a live broker already listening on the socket? */
function probeExistingBroker(): Promise<boolean> {
  return new Promise(resolve => {
    let settled = false
    const done = (v: boolean) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { sock.destroy() } catch {}
      resolve(v)
    }
    const sock = connect(SOCKET_PATH)
    const timer = setTimeout(() => done(false), 500)
    sock.once('connect', () => done(true))
    sock.once('error', () => done(false))
  })
}

async function start(): Promise<void> {
  if (existsSync(SOCKET_PATH)) {
    if (await probeExistingBroker()) {
      if (process.env.DINGTALK_BROKER_STANDBY !== '1') {
        log('another broker already owns the socket — exiting')
        process.exit(0)
      }
      log('another broker already owns the socket — standing by to take over')
      while (await probeExistingBroker()) await new Promise(r => setTimeout(r, 5_000))
      log('the other broker is gone — taking over')
    }
    log('removing stale socket')
    try { unlinkSync(SOCKET_PATH) } catch {}
  }

  server = createServer(onConnection)
  await new Promise<void>((resolve, reject) => {
    server!.once('error', reject)
    server!.listen(SOCKET_PATH, () => resolve())
  })
  // Anything that can connect can send messages as the bot.
  try { chmodSync(SOCKET_PATH, 0o600) } catch {}
  writeFileSync(BROKER_PID_FILE, `${process.pid}\n`, { mode: 0o600 })
  log(`listening on ${SOCKET_PATH} (pid ${process.pid})`)

  // In tenant mode the broker is the front door: with every tenant session
  // idle-stopped it has no clients, yet it must stay up to start the next one.
  if (IDLE_EXIT_MS > 0 && !tenants) {
    const idleTimer = setInterval(() => {
      if (clients.size === 0 && Date.now() - lastClientAt > IDLE_EXIT_MS) {
        log(`no sessions for ${Math.round(IDLE_EXIT_MS / 1000)}s — exiting`)
        shutdown()
      }
    }, 30_000)
    idleTimer.unref?.()
  }

  if (NO_STREAM) {
    log('DINGTALK_NO_STREAM=1 — DingTalk WebSocket disabled')
  } else {
    void streamLoop().catch(err => {
      log(`stream loop fatal: ${err instanceof Error ? err.message : err}`)
      shutdown(1)
    })
  }
}

await start()
