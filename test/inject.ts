#!/usr/bin/env bun
/// <reference types="bun-types" />
/**
 * Push a fake DingTalk message into a running broker, bypassing the Stream
 * WebSocket. The broker must have been started with DINGTALK_ALLOW_INJECT=1.
 *
 *   bun test/inject.ts --staff 111 --text "hello"
 *   bun test/inject.ts --staff 111 --group cidX --text "@bot hi"
 */

import { connect } from 'net'
import { SOCKET_PATH, lineDecoder, sendLine } from '../shared.ts'

const argv = process.argv.slice(2)
function opt(name: string, fallback = ''): string {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback
}

const staffId = opt('staff', '111')
const group = opt('group')
const text = opt('text', 'hello')
const nick = opt('nick', `user-${staffId}`)

const msg = {
  senderStaffId: staffId,
  senderNick: nick,
  conversationId: group || `cid-dm-${staffId}`,
  conversationType: group ? '2' : '1',
  msgtype: 'text',
  msgId: `inject-${process.pid}-${argv.join('-').length}`,
  text: { content: text },
}

const sock = connect(SOCKET_PATH, () => {
  sendLine(sock, { t: 'hello', pid: process.pid, cwd: '/injector', label: 'injector', routes: [] })
  sendLine(sock, { t: 'inject', id: '1', msg })
})

sock.on('data', lineDecoder(m => {
  const frame = m as Record<string, unknown>
  if (frame.t !== 'result') return
  if (frame.ok) console.log(`injected ${group ? 'group' : 'dm'} message from ${staffId}: ${text}`)
  else console.error(`inject failed: ${frame.error}`)
  sock.end()
  process.exit(frame.ok ? 0 : 1)
}))

sock.on('error', err => {
  console.error(`inject: ${err.message}`)
  process.exit(1)
})
