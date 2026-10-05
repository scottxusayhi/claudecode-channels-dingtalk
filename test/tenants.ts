#!/usr/bin/env bun
/// <reference types="bun-types" />
/**
 * Tenant-mode tests: the broker starting, routing to, confining and retiring
 * one background session per allowlisted DingTalk user.
 *
 * `claude` is replaced by test/fake-claude.ts, so this needs no model, no
 * credentials and no network — but the broker, its socket protocol and the
 * tenant registry are the real thing.
 *
 *   bun test/tenants.ts
 */

import { connect, type Socket } from 'net'
import { spawn, type ChildProcess } from 'child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, statSync, realpathSync } from 'fs'
import { join } from 'path'
import { tmpdir, homedir } from 'os'
import { lineDecoder, sendLine } from '../shared.ts'
import { LAUNCH_FAILED_REPLY, BUSY_REPLY, safeName } from '../tenants.ts'

const ROOT = join(import.meta.dir, '..')
const FAKE_CLAUDE = join(ROOT, 'test', 'fake-claude.ts')
const REFUSAL = 'NO-ROUTE-REFUSAL'
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

/**
 * Stop a process and wait until it is gone. A broker writes its last log
 * lines and routes on the way out; deleting its state dir before then leaves
 * a half-removed directory behind.
 */
async function stopAndWait(pid: number | undefined, ms = 5000): Promise<void> {
  if (!pid) return
  try { process.kill(pid, 'SIGTERM') } catch { return }
  const end = Date.now() + ms
  while (Date.now() < end) {
    try { process.kill(pid, 0) } catch { return }
    await new Promise(r => setTimeout(r, 50))
  }
  try { process.kill(pid, 'SIGKILL') } catch {}
}


let passed = 0
const failures: string[] = []
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    passed++
    console.log(`  \x1b[32mPASS\x1b[0m  ${name}`)
  } else {
    failures.push(name)
    console.log(`  \x1b[31mFAIL\x1b[0m  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

async function waitFor(pred: () => boolean | Promise<boolean>, ms = 5000): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await pred()) return true
    await sleep(25)
  }
  return pred()
}

// --- a broker in a throwaway state dir ----------------------------------------

type Env = {
  dir: string
  sock: string
  broker: ChildProcess
  stderr: () => string
}

async function startBroker(tenantCfg: object, extraEnv: Record<string, string> = {}): Promise<Env> {
  const dir = mkdtempSync(join(tmpdir(), 'dingtalk-tenants-'))
  writeFileSync(join(dir, 'config.json'), JSON.stringify({
    clientId: 'dingtest',
    clientSecret: 'test-secret',
    robotCode: 'dingtest',
    unroutedReply: REFUSAL,
    tenants: {
      enabled: true,
      root: join(dir, 'tenants'),
      claudeCommand: [process.execPath, FAKE_CLAUDE],
      ...tenantCfg,
    },
  }))
  writeFileSync(join(dir, 'access.json'), JSON.stringify({
    dmPolicy: 'allowlist',
    allowFrom: ['111', '222', '333', '444', '555', '666'],
    groups: { cidGROUP: { allowFrom: [] } },
  }))
  let err = ''
  const broker = spawn(process.execPath, [join(ROOT, 'broker.ts')], {
    env: {
      ...process.env,
      DINGTALK_STATE_DIR: dir,
      DINGTALK_NO_STREAM: '1',
      DINGTALK_DRY_SEND: '1',
      DINGTALK_ALLOW_INJECT: '1',
      DINGTALK_BROKER_IDLE_MS: '0',
      // As if the broker had been started from inside an owner's session.
      CLAUDECODE: '1',
      CLAUDE_CODE_SESSION_ID: 'parent-session-must-not-leak',
      ...extraEnv,
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  broker.stderr?.on('data', d => { err += d.toString() })
  const sock = join(dir, 'broker.sock')
  if (!(await waitFor(() => existsSync(sock), 6000))) throw new Error(`broker never listened\n${err}`)
  return { dir, sock, broker, stderr: () => err }
}

async function stopBroker(env: Env): Promise<void> {
  await stopAndWait(env.broker.pid)
  // Fake sessions are detached, like real background sessions; sweep them up.
  spawn('pkill', ['-f', `${FAKE_CLAUDE} __session`]).unref()
  try { rmSync(env.dir, { recursive: true, force: true }) } catch {}
}

function sent(env: Env): Array<{ target: string; isGroup: boolean; text: string }> {
  const f = join(env.dir, 'sent.jsonl')
  if (!existsSync(f)) return []
  return readFileSync(f, 'utf8').split('\n').filter(Boolean).map(l => {
    const j = JSON.parse(l)
    return { target: j.target, isGroup: j.isGroup, text: j.payload?.text ?? '' }
  })
}
const sentTo = (env: Env, target: string) => sent(env).filter(s => s.target === target).map(s => s.text)

type Invocation = { argv: string[]; tenant: string; cwd: string; leakedParentEnv: string[] }
function invocations(env: Env): Invocation[] {
  const f = join(env.dir, 'fake-claude.jsonl')
  if (!existsSync(f)) return []
  return readFileSync(f, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))
}
const launches = (env: Env, tenant: string) =>
  invocations(env).filter(i => i.argv.includes('--bg') && i.tenant === tenant)
const argAfter = (argv: string[], flag: string) => argv[argv.indexOf(flag) + 1]

function registry(env: Env): Record<string, { sessionId?: string; bgId?: string; workspace: string }> {
  try {
    return JSON.parse(readFileSync(join(env.dir, 'tenants.json'), 'utf8'))
  } catch {
    return {}
  }
}

// --- an owner-side client (also used to inject messages) ------------------------

type Result = { ok: boolean; error?: string; tenants?: Array<{ staffId: string; status: string; online: boolean }> }

class Client {
  inbox: Array<{ content: string; meta: Record<string, string> }> = []
  rejected: string | null = null
  closed = false
  ready: Promise<void>
  private sock: Socket
  private pend = new Map<string, (r: Result) => void>()
  private nextId = 1
  private onReady!: () => void

  constructor(sockPath: string, hello: Record<string, unknown>) {
    this.ready = new Promise<void>(res => { this.onReady = res })
    this.sock = connect(sockPath, () => sendLine(this.sock, { t: 'hello', pid: 1, routes: [], ...hello }))
    this.sock.on('data', lineDecoder(m => {
      const f = m as Record<string, unknown>
      if (f.t === 'welcome') this.onReady()
      else if (f.t === 'rejected') { this.rejected = f.reason as string; this.onReady() }
      else if (f.t === 'inbound') this.inbox.push({ content: f.content as string, meta: f.meta as Record<string, string> })
      else if (f.t === 'result') { this.pend.get(f.id as string)?.(f as unknown as Result); this.pend.delete(f.id as string) }
    }))
    this.sock.on('close', () => { this.closed = true })
    this.sock.on('error', () => {})
  }

  request(frame: Record<string, unknown>): Promise<Result> {
    const id = String(this.nextId++)
    return new Promise(resolve => {
      this.pend.set(id, resolve)
      sendLine(this.sock, { ...frame, id })
    })
  }

  dm(staffId: string, text: string) {
    return this.request({
      t: 'inject',
      msg: {
        senderStaffId: staffId,
        senderNick: `user-${staffId}`,
        conversationId: `cid-dm-${staffId}`,
        conversationType: '1',
        msgtype: 'text',
        msgId: `m-${staffId}-${this.nextId}`,
        text: { content: text },
      },
    })
  }

  quote(staffId: string, text: string, quoted: string, quotedFromSelf: boolean) {
    return this.request({
      t: 'inject',
      msg: {
        senderId: `$:enc:${staffId}`,
        senderStaffId: staffId,
        senderNick: `user-${staffId}`,
        conversationId: `cid-dm-${staffId}`,
        conversationType: '1',
        msgtype: 'text',
        msgId: `q-${staffId}-${this.nextId}`,
        text: {
          content: text,
          isReplyMsg: true,
          repliedMsg: {
            msgType: 'text',
            msgId: 'earlier',
            senderId: quotedFromSelf ? `$:enc:${staffId}` : '$:enc:bot',
            content: { text: quoted },
          },
        },
      },
    })
  }

  file(staffId: string, fileName: string) {
    return this.request({
      t: 'inject',
      msg: {
        senderStaffId: staffId,
        senderNick: `user-${staffId}`,
        conversationId: `cid-dm-${staffId}`,
        conversationType: '1',
        msgtype: 'file',
        msgId: `f-${staffId}-${this.nextId}`,
        content: { downloadCode: `dc-${this.nextId}`, fileName },
      },
    })
  }

  group(staffId: string, text: string) {
    return this.request({
      t: 'inject',
      msg: {
        senderStaffId: staffId,
        senderNick: `user-${staffId}`,
        conversationId: 'cidGROUP',
        conversationType: '2',
        msgtype: 'text',
        msgId: `g-${staffId}-${this.nextId}`,
        text: { content: text },
      },
    })
  }

  end(): void { this.sock.end() }
}

// --- phase 1: routing, confinement, lifecycle ------------------------------------

async function phaseMain(): Promise<void> {
  const env = await startBroker(
    { idleMinutes: 0, maxSessions: 3, launchTimeoutSec: 2, escalateTo: ['000'] },
    { FAKE_CLAUDE_FAIL_TENANTS: '333', FAKE_CLAUDE_HANG_TENANTS: '444' },
  )
  try {
    const owner = new Client(env.sock, { cwd: '/owner', label: 'owner' })
    await owner.ready
    const personas = join(env.dir, 'personas')
    mkdirSync(personas, { recursive: true })
    writeFileSync(join(personas, 'default.md'), 'You are the default assistant.')
    writeFileSync(join(personas, '222.md'), 'You are the assistant for tenant 222.')
    // Memories kept in earlier conversations, as a tenant session would leave them.
    mkdirSync(join(env.dir, 'tenants', '111', '.memory'), { recursive: true })
    writeFileSync(join(env.dir, 'tenants', '111', '.memory', 'MEMORY.md'), '- 用户最喜欢青绿色\n')
    mkdirSync(join(env.dir, 'tenants', '222', '.memory'), { recursive: true })
    writeFileSync(join(env.dir, 'tenants', '222', '.memory', 'MEMORY.md'), `${'- 很长的记忆\n'.repeat(1500)}`)
    const promptOf = (id: string) => readFileSync(join(env.dir, 'prompts', `${id}.md`), 'utf8')

    console.log('\nfirst message starts a session')
    await owner.dm('111', 'hello 111')
    check('message is answered by a freshly started tenant session',
      await waitFor(() => sentTo(env, '111').includes('echo: hello 111')))
    const ws111 = join(env.dir, 'tenants', '111')
    check('workspace is created under the tenants root', existsSync(ws111))
    check('workspace is private (0700)', existsSync(ws111) && (statSync(ws111).mode & 0o777) === 0o700)
    check('tenant registry records the session id', !!registry(env)['111']?.sessionId)

    const l = launches(env, '111')[0]!
    // macOS tmpdir is a symlink (/var -> /private/var); compare real paths.
    check('session is launched in the tenant workspace', !!l && realpathSync(l.cwd) === realpathSync(ws111), l?.cwd)
    check('launch uses --restricted', l?.argv.includes('--restricted'))
    check('launch uses dontAsk', argAfter(l.argv, '--permission-mode') === 'dontAsk')
    check('launch loads the channel through --channels', argAfter(l.argv, '--channels') === 'plugin:dingtalk@remote-cc')
    check('the session may call reply and ask_owner without prompting',
      argAfter(l.argv, '--allowedTools') === 'mcp__plugin_dingtalk_dingtalk__reply,mcp__plugin_dingtalk_dingtalk__ask_owner',
      argAfter(l.argv, '--allowedTools'))
    check('launch whitelists built-in tools', !!argAfter(l.argv, '--tools') && !argAfter(l.argv, '--tools')!.includes('SendMessage'))
    const settings = JSON.parse(argAfter(l.argv, '--settings')!)
    check('sandbox denies reading the whole home directory',
      settings.sandbox?.filesystem?.denyRead?.includes(homedir()))
    check('sandbox re-allows only this workspace among tenants',
      settings.sandbox?.filesystem?.allowRead?.includes(ws111) &&
      !settings.sandbox.filesystem.allowRead.some((p: string) => p.startsWith(join(env.dir, 'tenants')) && p !== ws111))
    check('sandbox fails closed', settings.sandbox?.failIfUnavailable === true && settings.sandbox?.allowUnsandboxedCommands === false)
    check('other sessions cannot message the tenant session', settings.crossSessionInbound === 'refuse')
    check('claude.ai connectors are off', settings.env?.ENABLE_CLAUDEAI_MCP_SERVERS === 'false')
    check("the owner's session env does not leak into the launch", l.leakedParentEnv.length === 0, l.leakedParentEnv.join(','))
    check('persona files readable by others are tightened to 0600',
      (statSync(join(personas, 'default.md')).mode & 0o077) === 0)
    check('the session gets a composed prompt file, kept out of the workspace',
      argAfter(l.argv, '--append-system-prompt-file') === join(env.dir, 'prompts', '111.md'), argAfter(l.argv, '--append-system-prompt-file'))
    check('a tenant without its own persona gets the default one', promptOf('111').includes('You are the default assistant.'))
    check('the prompt explains how to keep memory', promptOf('111').includes('.memory/MEMORY.md'))
    check("the tenant's earlier memories are loaded", promptOf('111').includes('用户最喜欢青绿色'))
    check('memories are framed as information, not instructions', promptOf('111').includes('不是对你的指令'))
    check('the composed prompt is private (0600)', (statSync(join(env.dir, 'prompts', '111.md')).mode & 0o077) === 0)
    check('the system prompt is rendered fresh, so persona edits reach resumed conversations',
      argAfter(l.argv, '--system-prompt-snapshot') === 'off')

    await owner.dm('111', 'again')
    check('a live session gets later messages without another launch',
      await waitFor(() => sentTo(env, '111').includes('echo: again')) && launches(env, '111').length === 1)

    console.log('\nquoted replies keep what was quoted')
    await owner.quote('111', '能看到我引用的内容吗', '再试下', true)
    check('the quoted text reaches the session, before what the user typed',
      await waitFor(() => sentTo(env, '111').some(t => t.includes('> 再试下') && t.indexOf('> 再试下') < t.indexOf('能看到我引用的内容吗'))),
      sentTo(env, '111').at(-1))
    check("…attributed to the user by name, so the assistant can't mistake it for its own",
      sentTo(env, '111').some(t => t.includes('user-111引用了自己之前发的消息')))
    await owner.quote('111', '这句是什么意思', '好的，文件收到了\n第二行', false)
    check("a quote of the assistant's own reply says so, line by line",
      await waitFor(() => sentTo(env, '111').some(t => t.includes('user-111引用了你之前的回复') && t.includes('> 好的，文件收到了\n> 第二行'))),
      sentTo(env, '111').at(-1))

    console.log('\nattachments land where the tenant can read them')
    await owner.file('111', 'report.xlsx')
    const savedAt = join(ws111, 'attachments', 'report.xlsx')
    check("a tenant's attachment is saved inside their workspace",
      await waitFor(() => sentTo(env, '111').some(t => t.includes(savedAt))), sentTo(env, '111').at(-1))
    check('…and is private (0600)', existsSync(savedAt) && (statSync(savedAt).mode & 0o077) === 0)
    check('…and not in the shared attachments directory', !existsSync(join(env.dir, 'attachments', 'report.xlsx')))

    console.log('\nmessages queue while a session starts')
    await Promise.all([owner.dm('222', 'q1'), owner.dm('222', 'q2'), owner.dm('222', 'q3')])
    check('all queued messages arrive', await waitFor(() => sentTo(env, '222').length >= 3))
    check('queued messages arrive in order',
      JSON.stringify(sentTo(env, '222').slice(0, 3)) === JSON.stringify(['echo: q1', 'echo: q2', 'echo: q3']),
      JSON.stringify(sentTo(env, '222')))
    check('a burst starts only one session', launches(env, '222').length === 1)
    check("a tenant's own persona wins over the default",
      promptOf('222').includes('tenant 222') && !promptOf('222').includes('default assistant'))
    check("one tenant's memory never lands in another's prompt", !promptOf('222').includes('青绿色') && !promptOf('111').includes('很长的记忆'))
    check('a runaway memory file is cut short', promptOf('222').length < 12_000 && promptOf('222').includes('已截断'))

    console.log('\na compromised tenant stays confined')
    await owner.dm('111', 'ATTACK: go')
    check('attack report comes back', await waitFor(() => sentTo(env, '111').some(t => t.startsWith('attack:'))))
    const report = sentTo(env, '111').find(t => t.startsWith('attack:')) ?? ''
    check('cannot reply into another user\'s DM', report.includes('foreignReply=denied'), report)
    check('cannot reply into a group', report.includes('groupReply=denied'), report)
    check('cannot change routing', report.includes('bind=denied'), report)
    check('cannot use the owner controls', report.includes('tenants=denied'), report)
    check('sees only its own route', report.includes('routesVisible=1'), report)
    check('nothing was sent as the bot to the victim', !sentTo(env, '222').includes('hijacked'))
    check('nothing was sent as the bot to the group', !sent(env).some(s => s.isGroup && s.text === 'hijacked'))

    console.log('\nasking the owner for help')
    await owner.dm('111', 'ESCALATE:帮我订明天去上海的机票，我没有订票工具')
    check('a stuck tenant session reaches the owner',
      await waitFor(() => sentTo(env, '000').some(t => t.includes('user-111 的助手需要你帮忙') && t.includes('订明天去上海的机票'))),
      sentTo(env, '000').at(-1))
    check('…and learns that it did', await waitFor(() => sentTo(env, '111').includes('escalated: ok')))
    for (let i = 0; i < 5; i++) await owner.dm('111', `ESCALATE:again ${i}`)
    check('asking is rate-limited to 5 an hour',
      await waitFor(() => sentTo(env, '111').some(t => t.startsWith('escalated: denied') && t.includes('5 times'))),
      sentTo(env, '111').at(-1))
    const fromOwner = await owner.request({ t: 'escalate', text: 'not a tenant' })
    check("a non-tenant session can't use the escalation path", !fromOwner.ok)

    console.log('\nimpersonation')
    const fake = new Client(env.sock, { cwd: ws111, label: 'impostor', tenant: '111', sessionId: '00000000-dead-beef-0000-000000000000' })
    await fake.ready
    check('a session id that was never launched is rejected', !!fake.rejected, fake.rejected ?? 'accepted')
    check('the impostor is disconnected', await waitFor(() => fake.closed))
    const ghost = new Client(env.sock, { cwd: '/x', label: 'ghost', tenant: '999', sessionId: 'whatever' })
    await ghost.ready
    check('an unknown tenant is rejected', !!ghost.rejected)
    await owner.dm('111', 'still mine?')
    check('the real tenant still receives its messages', await waitFor(() => sentTo(env, '111').includes('echo: still mine?')))

    console.log('\nowner override')
    await owner.request({ t: 'bind', keys: ['dm:111'] })
    await owner.dm('111', 'to the owner')
    check('an owner binding takes the user over', await waitFor(() => owner.inbox.some(m => m.content === 'to the owner')))
    check('…and the tenant session does not see it', !sentTo(env, '111').includes('echo: to the owner'))
    await owner.request({ t: 'unbind', keys: ['dm:111'] })
    await owner.dm('111', 'back to tenant')
    check('releasing it hands the user back to their session',
      await waitFor(() => sentTo(env, '111').includes('echo: back to tenant')))
    check('…without starting a new session', launches(env, '111').length === 1)

    console.log('\nwhat tenant mode does not cover')
    const before = invocations(env).length
    await owner.group('111', '@bot hi')
    check('an unbound group still gets the refusal', await waitFor(() => sent(env).some(s => s.isGroup && s.text === REFUSAL)))
    await owner.dm('999', 'let me in')
    await sleep(200)
    check('a sender outside the allowlist gets nothing', sentTo(env, '999').length === 0)
    check('neither starts a session', invocations(env).length === before)

    console.log('\nlaunch failures')
    await owner.dm('333', 'hi')
    check('a failed launch tells the user', await waitFor(() => sentTo(env, '333').includes(LAUNCH_FAILED_REPLY)))
    await owner.dm('444', 'hi')
    check('a session that never connects times out and tells the user',
      await waitFor(() => sentTo(env, '444').includes(LAUNCH_FAILED_REPLY), 5000))
    const bg444 = registry(env)['444']?.bgId
    check('…and the half-started session is stopped',
      !!bg444 && await waitFor(() => invocations(env).some(i => i.argv[0] === 'stop' && i.argv[1] === bg444)))

    console.log('\nsession cap')
    await owner.dm('555', 'third')
    check('a third live session is allowed', await waitFor(() => sentTo(env, '555').includes('echo: third')))
    await owner.dm('666', 'fourth')
    check('a fourth is refused with a busy notice', await waitFor(() => sentTo(env, '666').includes(BUSY_REPLY)))
    check('…without launching', launches(env, '666').length === 0)

    console.log('\nowner controls')
    const listed = await owner.request({ t: 'tenants', action: 'list' })
    const row = (id: string) => listed.tenants?.find(t => t.staffId === id)
    check('list shows running tenants', row('111')?.online === true && row('222')?.online === true)
    check('list shows failed launches', row('333')?.status === 'failed')
    check('list shows which persona each tenant gets',
      (row('111') as { persona?: string } | undefined)?.persona === 'default.md' &&
      (row('222') as { persona?: string } | undefined)?.persona === '222.md')

    const sid111 = registry(env)['111']!.sessionId!
    const stop = await owner.request({ t: 'tenants', action: 'stop', staffId: '111' })
    check('stop succeeds', stop.ok, stop.error)
    const offline111 = async () =>
      (await owner.request({ t: 'tenants', action: 'list' })).tenants?.find(t => t.staffId === '111')?.online === false
    check('stop ends the session', await waitFor(offline111, 3000))
    await owner.dm('111', 'wake up')
    check('the next message resumes the session', await waitFor(() => sentTo(env, '111').includes('echo: wake up')))
    const relaunch = launches(env, '111')[1]
    check('…with --resume and the same conversation', !!relaunch && argAfter(relaunch.argv, '--resume') === sid111,
      relaunch ? relaunch.argv.join(' ') : 'no relaunch')

    const reset = await owner.request({ t: 'tenants', action: 'reset', staffId: '222' })
    check('reset succeeds', reset.ok, reset.error)
    check('reset forgets the conversation', !registry(env)['222']?.sessionId)
    await sleep(300)
    await owner.dm('222', 'fresh start')
    check('after reset the next message starts a new conversation',
      await waitFor(() => sentTo(env, '222').includes('echo: fresh start')) &&
      !launches(env, '222').at(-1)!.argv.includes('--resume'))
  } finally {
    if (failures.length) console.log(`\n--- broker stderr ---\n${env.stderr().slice(-3000)}`)
    await stopBroker(env)
  }
}

// --- phase 2: idle sessions are stopped and resumed -------------------------------

async function phaseIdle(): Promise<void> {
  const env = await startBroker({ idleMinutes: 0.02, memory: false }, { DINGTALK_TENANT_REAP_MS: '200' })
  try {
    console.log('\nidle reaping')
    const owner = new Client(env.sock, { cwd: '/owner', label: 'owner' })
    await owner.ready
    await owner.dm('111', 'before idle')
    check('session answers', await waitFor(() => sentTo(env, '111').includes('echo: before idle')))
    check('with no persona and memory off, nothing is appended to the prompt', !launches(env, '111')[0]!.argv.includes('--append-system-prompt-file'))
    check('with nobody to escalate to, ask_owner is not offered',
      argAfter(launches(env, '111')[0]!.argv, '--allowedTools') === 'mcp__plugin_dingtalk_dingtalk__reply')
    const bg = registry(env)['111']?.bgId
    check('an idle session is stopped',
      await waitFor(() => invocations(env).some(i => i.argv[0] === 'stop' && i.argv[1] === bg), 5000))
    await sleep(300)
    await owner.dm('111', 'after idle')
    check('the next message resumes it', await waitFor(() => sentTo(env, '111').includes('echo: after idle')))
    check('…as the same conversation',
      argAfter(launches(env, '111').at(-1)!.argv, '--resume') === registry(env)['111']?.sessionId)
  } finally {
    if (failures.length) console.log(`\n--- broker stderr ---\n${env.stderr().slice(-2000)}`)
    await stopBroker(env)
  }
}

console.log('\nnames never collide')
check('distinct staffIds never share a workspace or persona file', safeName('a.b') !== safeName('a_b'))
check('…however they are spelled', new Set(['a_b', 'a.b', 'a b', 'a/b', 'a_2eb']).size === new Set(['a_b', 'a.b', 'a b', 'a/b', 'a_2eb'].map(safeName)).size)
check('all-digit staffIds keep their name', safeName('0123456789012345') === '0123456789012345')
check('path tricks are neutralised', !safeName('../../etc').includes('/') && !safeName('../../etc').includes('.'))

try {
  await phaseMain()
  await phaseIdle()
} catch (err) {
  failures.push(`harness: ${err instanceof Error ? err.message : err}`)
  console.error(err)
}
console.log(`\n${failures.length ? '\x1b[31m' : '\x1b[32m'}${passed} passed, ${failures.length} failed\x1b[0m`)
if (failures.length) console.log(`failed: ${failures.join('; ')}`)
process.exit(failures.length ? 1 : 0)
