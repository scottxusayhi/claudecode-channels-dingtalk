/**
 * Shared state paths, config loading, and the broker<->shim wire protocol.
 *
 * The DingTalk channel runs as two kinds of process:
 *
 *   broker.ts  — one long-lived daemon per machine. Owns the single DingTalk
 *                Stream WebSocket, the OpenAPI access token, access control,
 *                and the routing table.
 *   server.ts  — one thin MCP shim per Claude Code session, spawned by Claude
 *                Code over stdio. Registers with the broker, turns routed
 *                inbound messages into `notifications/claude/channel`, and
 *                forwards `reply` tool calls back to the broker.
 *
 * They talk newline-delimited JSON over a Unix socket.
 */

import { readFileSync, appendFileSync, existsSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

// --- state paths -------------------------------------------------------------

export const STATE_DIR =
  process.env.DINGTALK_STATE_DIR ??
  join(homedir(), '.claude', 'channels', 'dingtalk')
export const ACCESS_FILE = join(STATE_DIR, 'access.json')
export const CONFIG_FILE = join(STATE_DIR, 'config.json')
export const ROUTES_FILE = join(STATE_DIR, 'routes.json')
export const TENANTS_FILE = join(STATE_DIR, 'tenants.json')
/** Owner-written tenant personas: `<staffId>.md`, falling back to `default.md`. */
export const PERSONAS_DIR = join(STATE_DIR, 'personas')
/** Per-tenant system-prompt files the broker composes at launch (persona + memory). */
export const PROMPTS_DIR = join(STATE_DIR, 'prompts')
export const ATTACHMENT_DIR = join(STATE_DIR, 'attachments')
export const SOCKET_PATH = join(STATE_DIR, 'broker.sock')
export const BROKER_PID_FILE = join(STATE_DIR, 'broker.pid')
export const DEBUG_LOG = join(STATE_DIR, 'debug.log')

/**
 * Append to the shared debug log. Several processes write to this file, so
 * every line carries a source tag (`broker`, `shim:<pid>`). O_APPEND writes
 * of a single short line are atomic enough not to interleave in practice.
 */
export function debugLog(tag: string, line: string): void {
  try {
    appendFileSync(DEBUG_LOG, `${new Date().toISOString()} [${tag}] ${line}\n`)
  } catch {}
}

// --- config ------------------------------------------------------------------

export type DingConfig = {
  clientId: string
  clientSecret: string
  robotCode: string | undefined
  /** Sent back to senders whose messages match no bound session. */
  unroutedReply: string
  /** Tenant mode settings, or null when tenant mode is off. */
  tenants: TenantConfig | null
}

/**
 * Tenant mode: every allowlisted DM sender gets their own background Claude
 * Code session in an isolated workspace, started on demand by the broker.
 */
export type TenantConfig = {
  /** Parent of the per-tenant workspaces. Must sit inside a trusted folder. */
  root: string
  /** Channel the tenant sessions load; must be on the managed allowlist. */
  channel: string
  /** argv prefix used to run Claude Code (`claude --bg …`, `claude stop …`). */
  claudeCommand: string[]
  model: string | undefined
  /** Built-in tools available to tenants (passed to --tools). */
  tools: string[]
  /** Domains sandboxed Bash may reach. Empty means no network for Bash. */
  allowedDomains: string[]
  /** Extra paths under $HOME that sandboxed Bash may read (toolchains). */
  allowRead: string[]
  /** Stop a tenant's session after this long without activity. 0 = never. */
  idleMinutes: number
  /** Long-term memory per tenant, kept in `<workspace>/.memory/MEMORY.md`. */
  memory: boolean
  /**
   * staffIds a tenant session may ask for help (the ask_owner tool). The only
   * people a tenant session can message besides its own user.
   */
  escalateTo: string[]
  maxSessions: number
  launchTimeoutSec: number
}

const DEFAULT_TENANT_TOOLS = [
  'Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash', 'WebSearch', 'WebFetch', 'TodoWrite',
]

/** Toolchain directories under $HOME that hold no credentials. */
const DEFAULT_TOOLCHAIN_DIRS = ['.bun', '.local', '.nvm', '.pyenv', '.cargo', '.rustup', '.volta']

function defaultClaudeCommand(): string[] {
  const local = join(homedir(), '.local', 'bin', 'claude')
  return [existsSync(local) ? local : 'claude']
}

function strings(v: unknown): string[] | undefined {
  return Array.isArray(v) && v.every(x => typeof x === 'string') ? (v as string[]) : undefined
}

export function parseTenantConfig(raw: unknown): TenantConfig | null {
  if (!raw || typeof raw !== 'object') return null
  const t = raw as Record<string, unknown>
  if (t.enabled !== true) return null
  if (typeof t.root !== 'string' || !t.root.startsWith('/')) {
    process.stderr.write(
      `dingtalk channel: tenants.enabled is true but tenants.root is not an absolute path — tenant mode is off.\n`,
    )
    return null
  }
  const num = (v: unknown, d: number) => (typeof v === 'number' && v >= 0 ? v : d)
  return {
    root: t.root.replace(/\/+$/, ''),
    channel: typeof t.channel === 'string' ? t.channel : 'plugin:dingtalk@remote-cc',
    claudeCommand: strings(t.claudeCommand) ?? defaultClaudeCommand(),
    model: typeof t.model === 'string' ? t.model : undefined,
    tools: strings(t.tools) ?? DEFAULT_TENANT_TOOLS,
    allowedDomains: strings(t.allowedDomains) ?? [],
    allowRead:
      strings(t.allowRead) ??
      DEFAULT_TOOLCHAIN_DIRS.map(d => join(homedir(), d)).filter(d => existsSync(d)),
    idleMinutes: num(t.idleMinutes, 120),
    memory: t.memory !== false,
    escalateTo: strings(t.escalateTo) ?? [],
    maxSessions: num(t.maxSessions, 8),
    launchTimeoutSec: num(t.launchTimeoutSec, 90),
  }
}

export const DEFAULT_UNROUTED_REPLY =
  '⚠️ 没有权限：当前没有为你绑定的会话，无法处理你的消息。'

/**
 * Read credentials from env vars or config.json. `requireCreds: false` lets
 * the shim validate without exiting — it only needs to surface a helpful
 * error, the broker is the one that actually calls DingTalk.
 */
export function loadDingConfig(): DingConfig {
  let fromFile: Partial<DingConfig> = {}
  try {
    fromFile = JSON.parse(readFileSync(CONFIG_FILE, 'utf8')) as Partial<DingConfig>
  } catch {}
  const clientId = process.env.DINGTALK_CLIENT_ID ?? fromFile.clientId
  const clientSecret = process.env.DINGTALK_CLIENT_SECRET ?? fromFile.clientSecret
  const robotCode = process.env.DINGTALK_ROBOT_CODE ?? fromFile.robotCode

  if (!clientId || !clientSecret) {
    process.stderr.write(
      `dingtalk channel: missing clientId/clientSecret.\n` +
        `  Either set DINGTALK_CLIENT_ID and DINGTALK_CLIENT_SECRET env vars,\n` +
        `  or write ${CONFIG_FILE} with:\n` +
        `    {"clientId":"...","clientSecret":"...","robotCode":"..."}\n` +
        `  See the plugin README for how to create a DingTalk app.\n`,
    )
    process.exit(1)
  }
  if (!robotCode) {
    process.stderr.write(
      `dingtalk channel: DINGTALK_ROBOT_CODE not set — reply tool will fail until it is.\n`,
    )
  }
  return {
    clientId,
    clientSecret,
    robotCode,
    unroutedReply: fromFile.unroutedReply ?? DEFAULT_UNROUTED_REPLY,
    tenants: parseTenantConfig((fromFile as { tenants?: unknown }).tenants),
  }
}

// --- route keys --------------------------------------------------------------

/** `dm:<staffId>` for direct messages, `group:<openConversationId>` for groups. */
export type RouteKey = string

export function dmKey(staffId: string): RouteKey {
  return `dm:${staffId}`
}

export function groupKey(openConversationId: string): RouteKey {
  return `group:${openConversationId}`
}

/**
 * Normalize a user-typed route target. Accepts an explicit `dm:`/`group:`
 * prefix, or a bare id — openConversationIds start with `cid`, staffIds
 * don't, which is enough to disambiguate the common case.
 */
export function parseRouteKey(raw: string): RouteKey | null {
  const s = raw.trim()
  if (!s) return null
  if (s.startsWith('dm:')) {
    const v = s.slice(3).trim()
    return v ? dmKey(v) : null
  }
  if (s.startsWith('group:')) {
    const v = s.slice(6).trim()
    return v ? groupKey(v) : null
  }
  return s.startsWith('cid') ? groupKey(s) : dmKey(s)
}

// --- persisted routing table -------------------------------------------------

/**
 * routes.json remembers which working directory owns which route key, so a
 * session that restarts (or reloads after a code change) gets its bindings
 * back automatically instead of needing /dingtalk:bind again.
 */
export type RouteRecord = { cwd: string; label: string }
export type RoutesFile = Record<RouteKey, RouteRecord>

// --- wire protocol -----------------------------------------------------------

export type ReplyArgs = {
  chat_id?: string
  text?: string
  is_group?: string
  user?: string
  file?: string
}

export type ShimToBroker =
  | {
      t: 'hello'
      pid: number
      cwd: string
      label: string
      routes: RouteKey[]
      /** CLAUDE_CODE_SESSION_ID of the session that spawned this shim. */
      sessionId?: string
      /** Set when the broker launched this session for a tenant. */
      tenant?: string
    }
  | { t: 'bind'; id: string; keys: RouteKey[] }
  | { t: 'unbind'; id: string; keys: RouteKey[] }
  | { t: 'routes'; id: string }
  | { t: 'reply'; id: string; args: ReplyArgs }
  | { t: 'tenants'; id: string; action: 'list' | 'stop' | 'reset'; staffId?: string }
  /** A tenant session asking the owner(s) in tenants.escalateTo for help. */
  | { t: 'escalate'; id: string; text: string }
  /** Test-only: inject a fake BotMessage, bypassing the DingTalk WebSocket. */
  | { t: 'inject'; id: string; msg: unknown }

export type RouteRow = {
  key: RouteKey
  label: string
  cwd: string
  pid: number
  online: boolean
  mine: boolean
}

export type TenantRow = {
  staffId: string
  nick: string
  workspace: string
  status: 'starting' | 'running' | 'stopped' | 'failed'
  online: boolean
  bgId: string | null
  sessionId: string | null
  lastActiveAt: string
  queued: number
  /** Persona file the session starts with, or null for none. */
  persona: string | null
  /** Size of the tenant's memory file in bytes, or null if there is none. */
  memoryBytes: number | null
}

export type BrokerToShim =
  | { t: 'welcome'; brokerPid: number; bound: RouteKey[] }
  /** The broker refused this session's hello (e.g. a tenant identity mismatch). */
  | { t: 'rejected'; reason: string }
  | { t: 'inbound'; content: string; meta: Record<string, string> }
  | {
      t: 'result'
      id: string
      ok: boolean
      error?: string
      bound?: RouteKey[]
      rows?: RouteRow[]
      tenants?: TenantRow[]
    }
  /** Another session took over one of our route keys. */
  | { t: 'evicted'; keys: RouteKey[]; by: string }

// --- newline-delimited JSON framing ------------------------------------------

/** Refuse to buffer more than this without seeing a newline. */
const MAX_LINE_BYTES = 16 * 1024 * 1024

/**
 * Build a chunk handler that reassembles newline-delimited JSON. Malformed
 * lines are handed to `onError` and skipped rather than killing the socket.
 */
export function lineDecoder(
  onMessage: (msg: unknown) => void,
  onError?: (err: unknown, line: string) => void,
): (chunk: Buffer | string) => void {
  let buf = ''
  return chunk => {
    buf += chunk.toString()
    if (buf.length > MAX_LINE_BYTES) {
      onError?.(new Error('line buffer overflow, dropping'), '')
      buf = ''
      return
    }
    let idx: number
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim()
      buf = buf.slice(idx + 1)
      if (!line) continue
      try {
        onMessage(JSON.parse(line))
      } catch (err) {
        onError?.(err, line)
      }
    }
  }
}

export function sendLine(
  sock: { write(data: string): unknown } | null | undefined,
  msg: object,
): void {
  if (!sock) return
  try {
    sock.write(`${JSON.stringify(msg)}\n`)
  } catch {}
}
