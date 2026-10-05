#!/usr/bin/env bun
/// <reference types="bun-types" />
/**
 * End-to-end test of the MCP shim (server.ts).
 *
 * Speaks JSON-RPC over the shim's stdio the way Claude Code does, and checks
 * the whole path: the shim starts a broker on its own, claims its route,
 * turns a routed message into a `notifications/claude/channel`, and forwards
 * reply tool calls back out. No credentials or network needed.
 *
 *   bun test/shim.ts
 */

import { connect } from 'net'
import { spawn } from 'child_process'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { lineDecoder, sendLine } from '../shared.ts'

const ROOT = join(import.meta.dir, '..')
const tmp = mkdtempSync(join(tmpdir(), 'dingtalk-shim-'))
const SOCK = join(tmp, 'broker.sock')
const SENT = join(tmp, 'sent.jsonl')
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
    unroutedReply: 'NO-ROUTE',
  }),
)
writeFileSync(
  join(tmp, 'access.json'),
  JSON.stringify({ dmPolicy: 'allowlist', allowFrom: ['111'], groups: {} }),
)

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

const env = {
  ...process.env,
  DINGTALK_STATE_DIR: tmp,
  DINGTALK_NO_STREAM: '1',
  DINGTALK_DRY_SEND: '1',
  DINGTALK_ALLOW_INJECT: '1',
  DINGTALK_BROKER_IDLE_MS: '0',
  DINGTALK_ROUTE: 'dm:111',
  DINGTALK_SESSION_LABEL: 'shim-under-test',
}

const shim = spawn(process.execPath, [join(ROOT, 'server.ts')], {
  cwd: tmp,
  env,
  stdio: ['pipe', 'pipe', 'pipe'],
})
let shimErr = ''
shim.stderr?.on('data', d => { shimErr += d.toString() })

// --- JSON-RPC over the shim's stdio -------------------------------------------

let nextId = 1
const rpcPending = new Map<number, (msg: Record<string, unknown>) => void>()
const notifications: Array<Record<string, unknown>> = []

shim.stdout?.on('data', lineDecoder(m => {
  const msg = m as Record<string, unknown>
  if (typeof msg.id === 'number' && rpcPending.has(msg.id)) {
    const cb = rpcPending.get(msg.id)!
    rpcPending.delete(msg.id)
    cb(msg)
  } else if (msg.method) {
    notifications.push(msg)
  }
}))

function rpc(method: string, params?: unknown): Promise<Record<string, unknown>> {
  const id = nextId++
  return new Promise(resolve => {
    rpcPending.set(id, resolve)
    shim.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
  })
}
function notify(method: string, params?: unknown): void {
  shim.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`)
}
function callTool(name: string, args: Record<string, unknown>) {
  return rpc('tools/call', { name, arguments: args })
}
function toolText(res: Record<string, unknown>): string {
  const result = res.result as { content?: Array<{ text?: string }> } | undefined
  return result?.content?.[0]?.text ?? JSON.stringify(res)
}

function injectDM(staffId: string, text: string): Promise<boolean> {
  return new Promise(resolve => {
    const sock = connect(SOCK, () => {
      sendLine(sock, { t: 'hello', pid: process.pid, cwd: '/injector', label: 'injector', routes: [] })
      sendLine(sock, {
        t: 'inject',
        id: '1',
        msg: {
          senderStaffId: staffId,
          senderNick: `user-${staffId}`,
          conversationId: `cid-dm-${staffId}`,
          conversationType: '1',
          msgtype: 'text',
          msgId: `shimtest-${text.length}-${staffId}`,
          text: { content: text },
        },
      })
    })
    sock.on('data', lineDecoder(m => {
      const f = m as Record<string, unknown>
      if (f.t !== 'result') return
      sock.end()
      resolve(!!f.ok)
    }))
    sock.on('error', () => resolve(false))
  })
}

async function cleanup(code: number): Promise<never> {
  await stopAndWait(shim.pid)
  try {
    if (existsSync(join(tmp, 'broker.pid'))) {
      await stopAndWait(parseInt(readFileSync(join(tmp, 'broker.pid'), 'utf8').trim(), 10))
    }
  } catch {}
  try { rmSync(tmp, { recursive: true, force: true }) } catch {}
  process.exit(code)
}

try {
  console.log(`\nstate dir: ${tmp}\n`)
  console.log('MCP handshake')

  const init = await rpc('initialize', {
    protocolVersion: '2025-11-25',
    capabilities: { roots: {}, elicitation: {} },
    clientInfo: { name: 'shim-test', version: '0' },
  })
  const initResult = init.result as Record<string, unknown>
  check('initialize succeeds', !!initResult)
  check(
    'server advertises the claude/channel capability',
    JSON.stringify(initResult?.capabilities ?? {}).includes('claude/channel'),
  )
  notify('notifications/initialized')

  const tools = await rpc('tools/list')
  const names = ((tools.result as { tools?: Array<{ name: string }> })?.tools ?? []).map(t => t.name)
  check('reply tool is exposed', names.includes('reply'), names.join(', '))
  check('bind tool is exposed', names.includes('bind'), names.join(', '))
  check('routes tool is exposed', names.includes('routes'), names.join(', '))

  // The shim starts its own broker; give it a moment to come up and register.
  for (let i = 0; i < 60 && !existsSync(SOCK); i++) await sleep(100)
  check('shim starts a broker on its own', existsSync(SOCK))
  await sleep(300)

  console.log('\nrouting')
  const routesOut = toolText(await callTool('routes', {}))
  check('DINGTALK_ROUTE binding took effect', routesOut.includes('dm:111'), routesOut)
  check('the route is marked as owned by this session', routesOut.includes('* dm:111'), routesOut)

  notifications.length = 0
  check('routed message is accepted by the broker', await injectDM('111', 'hello over MCP'))
  await sleep(200)
  const channelNotes = notifications.filter(n => n.method === 'notifications/claude/channel')
  check('shim emits a channel notification', channelNotes.length === 1, `got ${channelNotes.length}`)
  const params = channelNotes[0]?.params as { content?: string; meta?: Record<string, string> } | undefined
  check('notification carries the message text', params?.content === 'hello over MCP')
  check('notification carries the sender staffId', params?.meta?.user === '111')
  check('notification marks the message as a DM', params?.meta?.is_group === 'false')
  check('notification carries the chat_id', params?.meta?.chat_id === 'cid-dm-111')

  notifications.length = 0
  await injectDM('222', 'not allowlisted')
  await sleep(200)
  check(
    'non-allowlisted sender produces no notification',
    notifications.filter(n => n.method === 'notifications/claude/channel').length === 0,
  )

  console.log('\nreply tool')
  const replyOut = toolText(await callTool('reply', {
    chat_id: 'cid-dm-111',
    is_group: 'false',
    user: '111',
    text: 'reply from the shim',
  }))
  check('reply tool reports success', replyOut === 'sent', replyOut)
  const sent = existsSync(SENT)
    ? readFileSync(SENT, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))
    : []
  check(
    'reply actually reached the send path',
    sent.some(s => s.payload?.text === 'reply from the shim' && s.target === '111'),
    JSON.stringify(sent),
  )

  const badReply = await callTool('reply', { chat_id: 'x' })
  check('reply validates its arguments', (badReply.result as { isError?: boolean })?.isError === true)

  console.log('\nbind tool')
  const bindOut = toolText(await callTool('bind', { action: 'bind', targets: ['group:cidNEW', '333'] }))
  check('bind claims new targets', bindOut.includes('group:cidNEW') && bindOut.includes('dm:333'), bindOut)
  const unbindOut = toolText(await callTool('bind', { action: 'unbind', targets: ['dm:333'] }))
  check('unbind releases a target', !unbindOut.split('handles:')[1]?.includes('dm:333'), unbindOut)
  const badBind = await callTool('bind', { action: 'bind', targets: [] })
  check('bind rejects an empty target list', (badBind.result as { isError?: boolean })?.isError === true)

  console.log('\ntenant shims never start a broker')
  {
    const tmp2 = mkdtempSync(join(tmpdir(), 'dingtalk-shim-'))
    writeFileSync(join(tmp2, 'config.json'), JSON.stringify({ clientId: 'dingtest', clientSecret: 'x', robotCode: 'dingtest' }))
    const t = spawn(process.execPath, [join(ROOT, 'server.ts')], {
      cwd: tmp2,
      env: { ...process.env, DINGTALK_STATE_DIR: tmp2, DINGTALK_TENANT: '999', CLAUDE_CODE_SESSION_ID: 'deadbeef-0000', DINGTALK_CHANNEL_SETTLE_MS: '0' },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let terr = ''
    t.stderr?.on('data', d => { terr += d.toString() })
    t.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 't', version: '0' } } })}\n`)
    t.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)
    await sleep(2500)
    check('with no broker running, a tenant shim waits instead of starting one',
      !existsSync(join(tmp2, 'broker.sock')) && !existsSync(join(tmp2, 'broker.pid')), terr)
    check('…and says so', terr.includes('tenant sessions wait for it rather than start one'), terr)
    await stopAndWait(t.pid)
    rmSync(tmp2, { recursive: true, force: true })
  }

  console.log(
    `\n${failures.length ? '\x1b[31m' : '\x1b[32m'}${passed} passed, ${failures.length} failed\x1b[0m`,
  )
  if (failures.length) {
    console.log(`failed: ${failures.join('; ')}`)
    if (shimErr) console.log(`\n--- shim stderr ---\n${shimErr}`)
  }
  await cleanup(failures.length ? 1 : 0)
} catch (err) {
  console.error(`test harness error: ${err instanceof Error ? err.stack : err}`)
  if (shimErr) console.error(`\n--- shim stderr ---\n${shimErr}`)
  await cleanup(1)
}
