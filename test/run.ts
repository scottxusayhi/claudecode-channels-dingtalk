#!/usr/bin/env bun
/// <reference types="bun-types" />
/**
 * End-to-end routing tests for the DingTalk channel broker.
 *
 * Runs a real broker against a throwaway state directory with the DingTalk
 * WebSocket disabled and outbound sends recorded to sent.jsonl instead of
 * hitting the API, so this needs no credentials, no network, and no real
 * DingTalk users or groups.
 *
 *   bun test/run.ts
 */

import { connect, type Socket } from 'net'
import { spawn } from 'child_process'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { lineDecoder, sendLine } from '../shared.ts'

const ROOT = join(import.meta.dir, '..')
const tmp = mkdtempSync(join(tmpdir(), 'dingtalk-routing-'))
const SOCK = join(tmp, 'broker.sock')
const SENT = join(tmp, 'sent.jsonl')
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


writeFileSync(
  join(tmp, 'config.json'),
  JSON.stringify({
    clientId: 'dingtest',
    clientSecret: 'test-secret',
    robotCode: 'dingtest',
    unroutedReply: REFUSAL,
  }),
)
writeFileSync(
  join(tmp, 'access.json'),
  JSON.stringify({
    dmPolicy: 'allowlist',
    allowFrom: ['111', '222', '333', '444'],
    groups: { cidGROUP: { allowFrom: [] } },
  }),
)

// --- assertions ---------------------------------------------------------------

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

function sentLines(): Array<{ target: string; isGroup: boolean; payload: { kind: string; text?: string } }> {
  if (!existsSync(SENT)) return []
  return readFileSync(SENT, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(l => JSON.parse(l))
}

function clearSent(): void {
  writeFileSync(SENT, '')
}

// --- fake session -------------------------------------------------------------

let fakePid = 9000

type Result = { ok: boolean; error?: string; bound?: string[]; rows?: unknown[] }

class FakeClient {
  inbox: Array<{ content: string; meta: Record<string, string> }> = []
  evictions: Array<{ keys: string[]; by: string }> = []
  bound: string[] = []
  ready: Promise<void>
  private sock: Socket
  private pend = new Map<string, (r: Result) => void>()
  private nextId = 1
  private onReady!: () => void

  constructor(readonly label: string, readonly cwd: string, routes: string[] = []) {
    this.ready = new Promise<void>(res => { this.onReady = res })
    this.sock = connect(SOCK, () => {
      sendLine(this.sock, { t: 'hello', pid: fakePid++, cwd, label, routes })
    })
    this.sock.on('data', lineDecoder(m => this.onFrame(m as Record<string, unknown>)))
    this.sock.on('error', () => {})
  }

  private onFrame(f: Record<string, unknown>): void {
    if (f.t === 'welcome') {
      this.bound = f.bound as string[]
      this.onReady()
    } else if (f.t === 'inbound') {
      this.inbox.push({ content: f.content as string, meta: f.meta as Record<string, string> })
    } else if (f.t === 'evicted') {
      const keys = f.keys as string[]
      this.evictions.push({ keys, by: f.by as string })
      this.bound = this.bound.filter(k => !keys.includes(k))
    } else if (f.t === 'result') {
      const cb = this.pend.get(f.id as string)
      if (cb) {
        this.pend.delete(f.id as string)
        if (f.bound) this.bound = f.bound as string[]
        cb(f as unknown as Result)
      }
    }
  }

  request(frame: Record<string, unknown>): Promise<Result> {
    const id = String(this.nextId++)
    return new Promise<Result>(resolve => {
      this.pend.set(id, resolve)
      sendLine(this.sock, { ...frame, id })
    })
  }

  bind(keys: string[]) { return this.request({ t: 'bind', keys }) }
  unbind(keys: string[]) { return this.request({ t: 'unbind', keys }) }
  routes() { return this.request({ t: 'routes' }) }
  reply(args: Record<string, unknown>) { return this.request({ t: 'reply', args }) }

  inject(staffId: string, text: string, group?: string) {
    return this.request({
      t: 'inject',
      msg: {
        senderStaffId: staffId,
        senderNick: `user-${staffId}`,
        conversationId: group ?? `cid-dm-${staffId}`,
        conversationType: group ? '2' : '1',
        msgtype: 'text',
        msgId: `inj-${Math.abs(text.length * 7919 + staffId.length)}-${this.nextId}`,
        text: { content: text },
      },
    })
  }

  drain(): Array<{ content: string; meta: Record<string, string> }> {
    const out = this.inbox
    this.inbox = []
    return out
  }

  close(): Promise<void> {
    return new Promise(resolve => {
      this.sock.once('close', () => resolve())
      this.sock.end()
    })
  }
}

// --- run ----------------------------------------------------------------------

const broker = spawn(process.execPath, [join(ROOT, 'broker.ts')], {
  env: {
    ...process.env,
    DINGTALK_STATE_DIR: tmp,
    DINGTALK_NO_STREAM: '1',
    DINGTALK_DRY_SEND: '1',
    DINGTALK_ALLOW_INJECT: '1',
    DINGTALK_BROKER_IDLE_MS: '0',
  },
  stdio: ['ignore', 'ignore', 'pipe'],
})
let brokerErr = ''
broker.stderr?.on('data', d => { brokerErr += d.toString() })

async function cleanup(code: number): Promise<never> {
  await stopAndWait(broker.pid)
  try { rmSync(tmp, { recursive: true, force: true }) } catch {}
  process.exit(code)
}

try {
  for (let i = 0; i < 60 && !existsSync(SOCK); i++) await sleep(100)
  if (!existsSync(SOCK)) {
    console.error(`broker never created ${SOCK}\n${brokerErr}`)
    await cleanup(1)
  }

  console.log(`\nstate dir: ${tmp}\n`)

  const injector = new FakeClient('injector', '/injector')
  const A = new FakeClient('A', '/fake/a')
  const B = new FakeClient('B', '/fake/b')
  await Promise.all([injector.ready, A.ready, B.ready])

  await A.bind(['dm:111'])
  await B.bind(['dm:222', 'group:cidGROUP'])
  await sleep(50)

  console.log('routing')
  await injector.inject('111', 'hello A')
  await sleep(80)
  check('DM from 111 reaches session A', A.drain().length === 1)
  check('DM from 111 does not reach session B', B.drain().length === 0)

  await injector.inject('222', 'hello B')
  await sleep(80)
  check('DM from 222 reaches session B', B.drain().length === 1)
  check('DM from 222 does not reach session A', A.drain().length === 0)

  await injector.inject('111', '@bot group ping', 'cidGROUP')
  await sleep(80)
  const groupHit = B.drain()
  check('group message routes by chat_id, not sender', groupHit.length === 1)
  check('group message carries is_group=true', groupHit[0]?.meta.is_group === 'true')
  check('group message does not leak to the sender\'s DM session', A.drain().length === 0)

  console.log('\nunrouted fallback')
  clearSent()
  await injector.inject('333', 'anyone home?')
  await sleep(80)
  check('allowlisted but unbound sender reaches nobody', A.drain().length === 0 && B.drain().length === 0)
  const refusals = sentLines().filter(s => s.payload.text === REFUSAL)
  check('unbound sender gets the refusal reply', refusals.length === 1, `got ${refusals.length}`)
  check('refusal goes back to the sender', refusals[0]?.target === '333')

  await injector.inject('333', 'hello again')
  await sleep(80)
  check(
    'second message from the same sender is not refused again (cooldown)',
    sentLines().filter(s => s.payload.text === REFUSAL).length === 1,
  )

  console.log('\naccess control')
  clearSent()
  await injector.inject('999', 'let me in')
  await sleep(80)
  check('non-allowlisted sender reaches nobody', A.drain().length === 0 && B.drain().length === 0)
  check('non-allowlisted sender gets no reply at all (silent drop)', sentLines().length === 0)

  console.log('\ntakeover')
  await A.bind(['dm:222'])
  await sleep(80)
  check('B is told its route was taken', B.evictions.some(e => e.keys.includes('dm:222')))
  check('B no longer lists the taken route', !B.bound.includes('dm:222'))
  await injector.inject('222', 'who gets this?')
  await sleep(80)
  check('messages for the taken route now reach A', A.drain().length === 1)
  check('messages for the taken route no longer reach B', B.drain().length === 0)

  console.log('\nreply path')
  clearSent()
  const rep = await B.reply({ chat_id: 'cidGROUP', is_group: 'true', text: 'from B' })
  await sleep(50)
  check('reply is forwarded to the broker', rep.ok, rep.error)
  const sentReply = sentLines().find(s => s.payload.text === 'from B')
  check('reply reaches the right conversation', sentReply?.target === 'cidGROUP' && sentReply?.isGroup === true)

  console.log('\ndisconnect and re-bind')
  await A.close()
  await sleep(120)
  clearSent()
  await injector.inject('111', 'A is gone')
  await sleep(80)
  check(
    'routes are released when a session disconnects',
    sentLines().filter(s => s.payload.text === REFUSAL).length === 1,
  )

  const A2 = new FakeClient('A2', '/fake/a')
  await A2.ready
  await sleep(50)
  check(
    'a session restarting in the same directory inherits its routes',
    A2.bound.includes('dm:111') && A2.bound.includes('dm:222'),
    `bound: ${A2.bound.join(', ')}`,
  )
  await injector.inject('111', 'welcome back')
  await sleep(80)
  check('inherited routes deliver again', A2.drain().length === 1)

  console.log('\nunbind')
  // A sender the refusal cooldown has never seen, so the fallback is observable.
  await A2.bind(['dm:444'])
  await sleep(50)
  await injector.inject('444', 'before unbind')
  await sleep(80)
  check('freshly bound route delivers', A2.drain().length === 1)

  await A2.unbind(['dm:444'])
  await sleep(50)
  clearSent()
  await injector.inject('444', 'after unbind')
  await sleep(80)
  check('unbound route stops delivering', A2.drain().length === 0)
  check('unbound route falls through to the refusal', sentLines().filter(s => s.payload.text === REFUSAL).length === 1)
  check(
    'unbind forgets the route so a restart does not inherit it',
    !('dm:444' in JSON.parse(readFileSync(join(tmp, 'routes.json'), 'utf8'))),
  )

  console.log('\ncooldown reset')
  clearSent()
  await A2.bind(['dm:444'])
  await A2.unbind(['dm:444'])
  await sleep(50)
  await injector.inject('444', 'refused again after a re-bind')
  await sleep(80)
  check(
    'binding a route clears its refusal cooldown',
    sentLines().filter(s => s.payload.text === REFUSAL).length === 1,
  )

  const table = await A2.routes()
  check('routes listing works', table.ok && Array.isArray(table.rows) && table.rows.length > 0)

  console.log('\nstandby (launchd) broker')
  const standby = spawn(process.execPath, [join(ROOT, 'broker.ts')], {
    env: { ...process.env, DINGTALK_STATE_DIR: tmp, DINGTALK_NO_STREAM: '1', DINGTALK_DRY_SEND: '1', DINGTALK_BROKER_IDLE_MS: '0', DINGTALK_BROKER_STANDBY: '1' },
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  let standbyErr = ''
  standby.stderr?.on('data', d => { standbyErr += d.toString() })
  await sleep(1500)
  check('a second broker in standby mode stays up instead of exiting', standby.exitCode === null && standbyErr.includes('standing by'), standbyErr)
  await stopAndWait(broker.pid)
  for (let i = 0; i < 100 && !standbyErr.includes('listening on'); i++) await sleep(100)
  check('…and takes over the socket once the active broker is gone', standbyErr.includes('taking over') && standbyErr.includes('listening on'), standbyErr)
  const late = new FakeClient('late', '/fake/late')
  check('…accepting sessions again', await Promise.race([late.ready.then(() => true), sleep(3000).then(() => false)]))
  await stopAndWait(standby.pid)

  console.log(
    `\n${failures.length ? '\x1b[31m' : '\x1b[32m'}${passed} passed, ${failures.length} failed\x1b[0m`,
  )
  if (failures.length) {
    console.log(`failed: ${failures.join('; ')}`)
    if (brokerErr) console.log(`\n--- broker stderr ---\n${brokerErr}`)
  }
  await cleanup(failures.length ? 1 : 0)
} catch (err) {
  console.error(`test harness error: ${err instanceof Error ? err.stack : err}`)
  if (brokerErr) console.error(`\n--- broker stderr ---\n${brokerErr}`)
  await cleanup(1)
}
