#!/usr/bin/env bun
/// <reference types="bun-types" />
/**
 * Stand-in for the `claude` CLI in tenant-mode tests.
 *
 * Mimics what the real CLI does as far as the broker can tell, without
 * starting a model:
 *
 *   claude --bg [--resume <id>] …   start a "session" in the background and
 *                                   print `backgrounded · <short id>`
 *   claude stop <short id>          stop it
 *   claude rm <short id>            forget it
 *
 * The "session" is this script again in `__session` mode, playing the part
 * of the tenant's MCP shim: it registers with the broker the way server.ts
 * does and answers every message with `echo: <text>`. A message starting
 * with `ATTACK:` makes it behave like a compromised tenant — it tries to
 * reply to someone else, rewrite routing and use the owner controls, then
 * reports what the broker allowed.
 *
 * Fault injection, by tenant staffId (comma-separated env lists):
 *   FAKE_CLAUDE_FAIL_TENANTS   `claude --bg` exits non-zero
 *   FAKE_CLAUDE_HANG_TENANTS   session starts but never connects its channel
 *
 * Every invocation is appended to $DINGTALK_STATE_DIR/fake-claude.jsonl.
 */

import { connect } from 'net'
import { spawn } from 'child_process'
import { appendFileSync, writeFileSync, readFileSync, mkdirSync, unlinkSync } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { STATE_DIR, SOCKET_PATH, lineDecoder, sendLine } from '../shared.ts'

const argv = process.argv.slice(2)
const SESSIONS = join(STATE_DIR, 'fake-sessions')
const tenant = process.env.DINGTALK_TENANT ?? ''
const listed = (name: string) => (process.env[name] ?? '').split(',').includes(tenant)

function record(extra: object = {}): void {
  appendFileSync(
    join(STATE_DIR, 'fake-claude.jsonl'),
    `${JSON.stringify({
      argv,
      cwd: process.cwd(),
      tenant,
      leakedParentEnv: ['CLAUDECODE', 'CLAUDE_CODE_SESSION_ID'].filter(k => k in process.env),
      ...extra,
    })}\n`,
  )
}

if (argv[0] === '__session') {
  runSession(argv[1]!)
} else if (argv.includes('--bg')) {
  record()
  if (listed('FAKE_CLAUDE_FAIL_TENANTS')) {
    process.stderr.write('Error: simulated launch failure\n')
    process.exit(1)
  }
  const i = argv.indexOf('--resume')
  const sessionId = i >= 0 ? argv[i + 1]! : randomUUID()
  const short = sessionId.slice(0, 8)
  mkdirSync(SESSIONS, { recursive: true })
  if (!listed('FAKE_CLAUDE_HANG_TENANTS')) {
    const child = spawn(process.execPath, [import.meta.path, '__session', sessionId], {
      cwd: process.cwd(),
      env: { ...process.env, CLAUDE_CODE_SESSION_ID: sessionId, CLAUDE_PROJECT_DIR: process.cwd() },
      detached: true,
      stdio: 'ignore',
    })
    child.unref()
    writeFileSync(join(SESSIONS, `${short}.pid`), String(child.pid))
  }
  // The real CLI prints after the session is already up; give the session a
  // head start so its hello reaches the broker before the id does.
  setTimeout(() => {
    process.stdout.write(`backgrounded · ${short} (idle — send a prompt to start)\n`)
    process.exit(0)
  }, 300)
} else if (argv[0] === 'stop' || argv[0] === 'kill') {
  record()
  try {
    process.kill(Number(readFileSync(join(SESSIONS, `${argv[1]}.pid`), 'utf8')), 'SIGTERM')
    process.stdout.write(`stopped ${argv[1]}\n`)
  } catch {
    process.stdout.write(`No job matching '${argv[1]}'.\n`)
    process.exit(1)
  }
} else if (argv[0] === 'rm') {
  record()
  try { unlinkSync(join(SESSIONS, `${argv[1]}.pid`)) } catch {}
  process.stdout.write(`removed ${argv[1]}\n`)
} else {
  process.stderr.write(`fake-claude: unsupported invocation ${JSON.stringify(argv)}\n`)
  process.exit(2)
}

function runSession(sessionId: string): void {
  let nextId = 1
  const pending = new Map<string, (r: { ok: boolean; error?: string; rows?: unknown[] }) => void>()
  const sock = connect(SOCKET_PATH, () => {
    sendLine(sock, {
      t: 'hello',
      pid: process.pid,
      cwd: process.env.CLAUDE_PROJECT_DIR ?? process.cwd(),
      label: `fake:${tenant}`,
      routes: [],
      sessionId,
      tenant,
    })
  })
  const request = (frame: Record<string, unknown>) =>
    new Promise<{ ok: boolean; error?: string; rows?: unknown[] }>(resolve => {
      const id = String(nextId++)
      pending.set(id, resolve)
      sendLine(sock, { ...frame, id })
    })

  sock.on('data', lineDecoder(async m => {
    const f = m as Record<string, unknown>
    if (f.t === 'rejected') process.exit(3)
    if (f.t === 'result') {
      pending.get(f.id as string)?.(f as { ok: boolean })
      pending.delete(f.id as string)
      return
    }
    if (f.t !== 'inbound') return
    const meta = f.meta as Record<string, string>
    const content = f.content as string
    const own = { chat_id: meta.chat_id, is_group: meta.is_group, user: meta.user }

    if (content.startsWith('ESCALATE:')) {
      const r = await request({ t: 'escalate', text: content.slice('ESCALATE:'.length) })
      await request({ t: 'reply', args: { ...own, text: `escalated: ${r.ok ? 'ok' : `denied (${r.error})`}` } })
      return
    }
    if (!content.startsWith('ATTACK:')) {
      const file = meta.file_path ?? meta.image_path
      await request({ t: 'reply', args: { ...own, text: `echo: ${content}${file ? ` [${file}]` : ''}` } })
      return
    }
    const verdict = (r: { ok: boolean }) => (r.ok ? 'ALLOWED' : 'denied')
    const foreign = await request({
      t: 'reply',
      args: { chat_id: 'cid-dm-222', is_group: 'false', user: '222', text: 'hijacked' },
    })
    const group = await request({
      t: 'reply',
      args: { chat_id: 'cidGROUP', is_group: 'true', text: 'hijacked' },
    })
    const bind = await request({ t: 'bind', keys: ['dm:222'] })
    const owner = await request({ t: 'tenants', action: 'list' })
    const routes = await request({ t: 'routes' })
    await request({
      t: 'reply',
      args: {
        ...own,
        text: `attack: foreignReply=${verdict(foreign)} groupReply=${verdict(group)} bind=${verdict(bind)} tenants=${verdict(owner)} routesVisible=${routes.rows?.length ?? -1}`,
      },
    })
  }))
  sock.on('close', () => process.exit(0))
  sock.on('error', () => process.exit(1))
  process.on('SIGTERM', () => {
    sock.end()
    process.exit(0)
  })
}
