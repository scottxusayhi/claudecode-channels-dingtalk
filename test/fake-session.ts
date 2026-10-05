#!/usr/bin/env bun
/// <reference types="bun-types" />
/**
 * A fake Claude Code session for poking at the broker by hand.
 *
 * It speaks the shim half of the broker protocol but prints inbound messages
 * instead of turning them into MCP notifications, so you can watch routing
 * without starting real Claude Code sessions (each of which would need a
 * restart on every code change).
 *
 *   bun test/fake-session.ts --label A --cwd /fake/a --bind dm:111
 *   bun test/fake-session.ts --label B --cwd /fake/b --bind dm:222 --bind group:cidX
 *
 * Point it at a scratch broker with DINGTALK_STATE_DIR.
 */

import { connect } from 'net'
import { SOCKET_PATH, lineDecoder, sendLine, parseRouteKey } from '../shared.ts'

const argv = process.argv.slice(2)
function opt(name: string, fallback: string): string {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback
}
function optAll(name: string): string[] {
  const out: string[] = []
  argv.forEach((a, i) => {
    if (a === `--${name}` && argv[i + 1]) out.push(argv[i + 1])
  })
  return out
}

const label = opt('label', 'fake')
const cwd = opt('cwd', process.cwd())
const routes = optAll('bind')
  .map(parseRouteKey)
  .filter((k): k is string => !!k)

const sock = connect(SOCKET_PATH, () => {
  sendLine(sock, { t: 'hello', pid: process.pid, cwd, label, routes })
})

sock.on('data', lineDecoder(msg => {
  const frame = msg as Record<string, unknown>
  if (frame.t === 'welcome') {
    console.log(`[${label}] connected; bound: ${(frame.bound as string[]).join(', ') || '(none)'}`)
    return
  }
  if (frame.t === 'inbound') {
    const meta = frame.meta as Record<string, string>
    console.log(`[${label}] INBOUND from ${meta.user_name || meta.user} (${meta.is_group === 'true' ? 'group' : 'dm'}): ${frame.content}`)
    return
  }
  if (frame.t === 'evicted') {
    console.log(`[${label}] EVICTED ${(frame.keys as string[]).join(', ')} by "${frame.by}"`)
    return
  }
  console.log(`[${label}] ${JSON.stringify(frame)}`)
}))

sock.on('error', err => {
  console.error(`[${label}] socket error: ${err.message}`)
  process.exit(1)
})
sock.on('close', () => {
  console.log(`[${label}] broker connection closed`)
  process.exit(0)
})

process.on('SIGINT', () => {
  sock.end()
  process.exit(0)
})
