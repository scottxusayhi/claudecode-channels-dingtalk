#!/usr/bin/env bun
/// <reference types="bun-types" />
/**
 * Try a tenant's assistant without touching the tenant.
 *
 * Starts a throwaway broker (no DingTalk connection, nothing actually sent)
 * and a fresh background session that wears the tenant's real persona and a
 * copy of their memory, then plays a conversation and prints the replies.
 * The tenant's real session, conversation history and memory file are never
 * opened for writing; anything the assistant would send — including asking
 * the owner for help — is only printed here.
 *
 *   bun test/simulate.ts --staff <staffId> "你在吗" "推荐一款今晚喝的酒"
 *
 * Uses the real `claude` CLI, so each message is a model turn. The scratch
 * workspace is created under ~/projects (must be a trusted folder); override
 * with SIM_TRUSTED_PARENT.
 */

import { connect, type Socket } from 'net'
import { spawn } from 'child_process'
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, copyFileSync, existsSync, rmSync, statSync,
} from 'fs'
import { join } from 'path'
import { tmpdir, homedir } from 'os'
import { lineDecoder, sendLine } from '../shared.ts'

const ROOT = join(import.meta.dir, '..')
const REAL = join(homedir(), '.claude', 'channels', 'dingtalk')
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

/** A turn is over once the assistant has sent nothing new for this long. */
const QUIET_MS = 8_000

// --- arguments ----------------------------------------------------------------

const argv = process.argv.slice(2)
const staffIdx = argv.indexOf('--staff')
if (staffIdx < 0 || !argv[staffIdx + 1]) {
  console.error('usage: bun test/simulate.ts --staff <staffId> [message ...]')
  process.exit(2)
}
const staffId = argv[staffIdx + 1]!
const messages = argv.filter((_, i) => i !== staffIdx && i !== staffIdx + 1)
if (!messages.length) messages.push('你好，你在吗？')

// --- what the real tenant has: read only ----------------------------------------

const realConfig = JSON.parse(readFileSync(join(REAL, 'config.json'), 'utf8')) as {
  tenants?: Record<string, unknown>
}
const realTenants = (() => {
  try { return JSON.parse(readFileSync(join(REAL, 'tenants.json'), 'utf8')) } catch { return {} }
})() as Record<string, { nick?: string; workspace?: string }>
const nick = realTenants[staffId]?.nick ?? staffId
const encoded = staffId.replace(/[^A-Za-z0-9-]/g, c => `_${c.charCodeAt(0).toString(16).padStart(2, '0')}`)
const realPersona = [join(REAL, 'personas', `${encoded}.md`), join(REAL, 'personas', 'default.md')].find(existsSync)
const realMemory = realTenants[staffId]?.workspace && join(realTenants[staffId]!.workspace!, '.memory', 'MEMORY.md')

// --- the sandbox -------------------------------------------------------------------

const state = mkdtempSync(join(tmpdir(), 'dingtalk-sim-'))
const root = mkdtempSync(join(process.env.SIM_TRUSTED_PARENT ?? join(homedir(), 'projects'), '.dt-sim-'))
const escalateTo = (realConfig.tenants?.escalateTo as string[] | undefined) ?? []
writeFileSync(join(state, 'config.json'), JSON.stringify({
  // Fake credentials: this broker never talks to DingTalk.
  clientId: 'sim', clientSecret: 'sim', robotCode: 'sim',
  tenants: {
    ...realConfig.tenants,
    enabled: true,
    root,
    idleMinutes: 0,
    escalateTo,
  },
}))
writeFileSync(join(state, 'access.json'), JSON.stringify({ dmPolicy: 'allowlist', allowFrom: [staffId], groups: {} }))
mkdirSync(join(state, 'personas'), { recursive: true, mode: 0o700 })
if (realPersona) copyFileSync(realPersona, join(state, 'personas', `${encoded}.md`))
mkdirSync(join(root, encoded, '.memory'), { recursive: true, mode: 0o700 })
if (realMemory && existsSync(realMemory)) copyFileSync(realMemory, join(root, encoded, '.memory', 'MEMORY.md'))

console.log(`simulating ${nick} (${staffId})`)
console.log(`  persona: ${realPersona ?? '(none)'}  — copied`)
console.log(`  memory:  ${realMemory && existsSync(realMemory) ? `${realMemory} — copied` : '(none)'}`)
console.log(`  ask_owner goes to: ${escalateTo.join(', ') || '(nobody)'} — recorded here, not sent\n`)

const realLog = join(REAL, 'debug.log')
const realLogStart = existsSync(realLog) ? statSync(realLog).size : 0

const broker = spawn(process.execPath, [join(ROOT, 'broker.ts')], {
  env: {
    ...process.env,
    DINGTALK_STATE_DIR: state,
    DINGTALK_NO_STREAM: '1',
    DINGTALK_DRY_SEND: '1',
    DINGTALK_ALLOW_INJECT: '1',
    DINGTALK_BROKER_IDLE_MS: '0',
  },
  stdio: ['ignore', 'ignore', 'pipe'],
})
let brokerErr = ''
broker.stderr?.on('data', d => { brokerErr += d.toString() })

// --- talking to it ------------------------------------------------------------------

const sent = (): Array<{ target: string; text: string }> => {
  const f = join(state, 'sent.jsonl')
  if (!existsSync(f)) return []
  return readFileSync(f, 'utf8').split('\n').filter(Boolean).map(l => {
    const j = JSON.parse(l)
    return { target: j.target, text: j.payload?.text ?? '' }
  })
}

let sock: Socket
let nextId = 1
const pend = new Map<string, (r: Record<string, unknown>) => void>()
const request = (frame: Record<string, unknown>) =>
  new Promise<Record<string, unknown>>(resolve => {
    const id = String(nextId++)
    pend.set(id, resolve)
    sendLine(sock, { ...frame, id })
  })

async function say(text: string): Promise<void> {
  const before = sent().length
  const t0 = Date.now()
  await request({
    t: 'inject',
    msg: {
      senderId: `$:sim:${staffId}`,
      senderStaffId: staffId,
      senderNick: nick,
      conversationId: `cid-sim-${staffId}`,
      conversationType: '1',
      msgtype: 'text',
      msgId: `sim-${nextId}`,
      text: { content: text },
    },
  })
  // The assistant may answer in several messages. Wait for the first, then
  // until it has been quiet for a while — moving on early would pin this
  // turn's later replies on the next message.
  while (Date.now() - t0 < 240_000 && !sent().slice(before).some(s => s.target === staffId)) await sleep(300)
  let seen = sent().length
  let quietSince = Date.now()
  while (Date.now() - t0 < 300_000 && Date.now() - quietSince < QUIET_MS) {
    await sleep(500)
    if (sent().length !== seen) { seen = sent().length; quietSince = Date.now() }
  }
  console.log(`\x1b[36m${nick}:\x1b[0m ${text}`)
  const out = sent().slice(before)
  if (!out.length) console.log('\x1b[31m(no reply within 4 minutes)\x1b[0m')
  for (const s of out) {
    const label = s.target === staffId ? '助手' : `助手 → 求助 ${s.target}（未发送）`
    console.log(`\x1b[33m${label}:\x1b[0m ${s.text}`)
  }
  console.log(`\x1b[2m(${((Date.now() - t0) / 1000).toFixed(1)}s)\x1b[0m\n`)
}

/** The session's own record of the conversation: what it received and what it sent, in order. */
function printTranscript(): void {
  const key = `-${root.replace(/^\//, '').replace(/[/._]/g, '-')}-${encoded}`
  const dir = join(homedir(), '.claude', 'projects', key)
  if (!existsSync(dir)) { console.log('(no session transcript found)'); return }
  console.log('--- as the session saw it ---')
  for (const f of readdirSync(dir).filter(n => n.endsWith('.jsonl'))) {
    for (const line of readFileSync(join(dir, f), 'utf8').split('\n').filter(Boolean)) {
      const e = JSON.parse(line)
      const ts = String(e.timestamp ?? '').slice(11, 19)
      const c = e.message?.content
      if (e.type === 'user' && typeof c === 'string' && c.startsWith('<channel')) {
        console.log(`${ts}  ← ${c.replace(/^<channel[^>]*>\s*|\s*<\/channel>\s*$/g, '').replace(/\n/g, ' ')}`)
      } else if (e.type === 'assistant' && Array.isArray(c)) {
        for (const part of c) {
          if (part.type !== 'tool_use') continue
          if (String(part.name).endsWith('__reply')) console.log(`${ts}  → reply: ${String(part.input?.text ?? '').replace(/\n/g, ' ').slice(0, 90)}`)
          if (String(part.name).endsWith('__ask_owner')) console.log(`${ts}  → ask_owner: ${String(part.input?.text ?? '').replace(/\n/g, ' ').slice(0, 90)}`)
        }
      }
    }
  }
  console.log()
}

async function cleanup(): Promise<void> {
  try { await Promise.race([request({ t: 'tenants', action: 'reset', staffId }), sleep(15_000)]) } catch {}
  await stopAndWait(broker.pid)
  rmSync(root, { recursive: true, force: true })
  rmSync(state, { recursive: true, force: true })
  // Claude Code keeps transcripts per working directory; this one was ours.
  for (const base of [join(homedir(), '.claude', 'projects'), join(homedir(), 'Library', 'Caches', 'claude-cli-nodejs')]) {
    const key = `-${root.replace(/^\//, '').replace(/[/._]/g, '-')}`
    for (const suffix of ['', `-${encoded}`]) rmSync(join(base, key + suffix), { recursive: true, force: true })
  }
}

try {
  const sockPath = join(state, 'broker.sock')
  for (let i = 0; i < 60 && !existsSync(sockPath); i++) await sleep(100)
  sock = connect(sockPath)
  await new Promise<void>(resolve => {
    sock.on('connect', () => sendLine(sock, { t: 'hello', pid: process.pid, cwd: '/sim-owner', label: 'sim-owner', routes: [] }))
    sock.on('data', lineDecoder(m => {
      const f = m as Record<string, unknown>
      if (f.t === 'welcome') resolve()
      if (f.t === 'result') { pend.get(f.id as string)?.(f); pend.delete(f.id as string) }
    }))
  })
  for (const m of messages) await say(m)
  printTranscript()

  const added = existsSync(realLog) ? readFileSync(realLog).subarray(realLogStart).toString('utf8') : ''
  if (added.includes(staffId)) console.log('\x1b[31m!! the real broker logged this staffId during the run — check debug.log\x1b[0m')
  else console.log('the real broker never saw this simulation.')
} catch (err) {
  console.error(`simulation failed: ${err instanceof Error ? err.message : err}\n${brokerErr.slice(-2000)}`)
} finally {
  await cleanup()
}
process.exit(0)
