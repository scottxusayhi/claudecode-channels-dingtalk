#!/usr/bin/env bun
/// <reference types="bun-types" />
/**
 * Tests for the question log (monitor.ts).
 *
 * Builds a fake Claude Code transcript store and state dir in a temp folder
 * and runs the monitor against them as a separate process, the way launchd
 * does. No broker, no sessions, no network.
 *
 *   bun test/monitor.ts
 */

import { spawnSync, spawn } from 'child_process'
import { createServer, type Server } from 'net'
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, readFileSync, existsSync, statSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { lineDecoder, sendLine } from '../shared.ts'

const ROOT = join(import.meta.dir, '..')
const tmp = mkdtempSync(join(tmpdir(), 'dingtalk-monitor-'))
const state = join(tmp, 'state')
const config = join(tmp, 'claude')
const tenantsRoot = '/srv/dt-tenants'
const projects = join(config, 'projects')
const dirFor = (staffId: string) => join(projects, `-srv-dt-tenants-${staffId}`)
mkdirSync(state, { recursive: true })
writeFileSync(join(state, 'config.json'), JSON.stringify({
  clientId: 'x', clientSecret: 'x', tenants: { enabled: true, root: tenantsRoot },
}))
const env = { ...process.env, DINGTALK_STATE_DIR: state, CLAUDE_CONFIG_DIR: config, DINGTALK_MONITOR_SCAN_MS: '200' }

let passed = 0
const failures: string[] = []
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) { passed++; console.log(`  \x1b[32mPASS\x1b[0m  ${name}`) }
  else { failures.push(name); console.log(`  \x1b[31mFAIL\x1b[0m  ${name}${detail ? `\n        ${detail.replace(/\n/g, '\n        ')}` : ''}`) }
}

let n = 0
function channelMsg(staffId: string, nick: string, text: string, extra = ''): string {
  n++
  return JSON.stringify({
    type: 'user', isMeta: true, sessionId: `sess-${staffId}`, timestamp: `2026-10-05T0${n % 10}:00:00.000Z`,
    message: { role: 'user', content: `<channel source="plugin:dingtalk:dingtalk" chat_id="cid-${staffId}=" user="${staffId}" user_name="${nick}" is_group="false" message_id="m${n}"${extra}>\n${text}\n</channel>` },
  }) + '\n'
}
const assistant = (text: string) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } }) + '\n'
const run = (...args: string[]) => spawnSync(process.execPath, [join(ROOT, 'monitor.ts'), ...args], { env, encoding: 'utf8' })
const recorded = () => existsSync(join(state, 'questions.jsonl'))
  ? readFileSync(join(state, 'questions.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : []

try {
  console.log('catching up on existing transcripts')
  mkdirSync(dirFor('111'), { recursive: true })
  mkdirSync(dirFor('222'), { recursive: true })
  mkdirSync(join(projects, '-srv-other-project'), { recursive: true })
  writeFileSync(join(dirFor('111'), 'a.jsonl'),
    channelMsg('111', '甲', '你好') + assistant('不是问题') + channelMsg('111', '甲', '第一行\n第二行'))
  writeFileSync(join(dirFor('222'), 'b.jsonl'),
    channelMsg('222', '乙', '看看这张图', ' image_path="/w/222/attachments/x.png"'))
  writeFileSync(join(projects, '-srv-other-project', 'c.jsonl'), channelMsg('999', '外人', '别的项目的消息'))
  const r1 = run('--once')
  check('the first run exits cleanly', r1.status === 0, r1.stderr)
  let q = recorded()
  check('records every tenant message', q.length === 3, JSON.stringify(q))
  check('keeps who asked', q.some(x => x.staffId === '111' && x.nick === '甲' && x.text === '你好'))
  check('keeps multi-line messages whole', q.some(x => x.text === '第一行\n第二行'))
  check('notes attachments', q.some(x => x.staffId === '222' && x.image === '/w/222/attachments/x.png'))
  check('ignores transcripts outside the tenants root', !q.some(x => x.staffId === '999'))
  check('ignores assistant turns', !q.some(x => x.text.includes('不是问题')))

  console.log('\nnothing is counted twice')
  run('--once')
  check('a second run adds nothing', recorded().length === 3)
  // A resumed session that continued as a copy repeats the whole history in a new file.
  writeFileSync(join(dirFor('111'), 'a-copy.jsonl'), readFileSync(join(dirFor('111'), 'a.jsonl'), 'utf8') + channelMsg('111', '甲', '复制之后的新问题'))
  run('--once')
  q = recorded()
  check('a resumed copy of a session adds only what is new', q.length === 4 && q.at(-1)!.text === '复制之后的新问题', JSON.stringify(q.map(x => x.text)))

  console.log('\na line still being written')
  const half = channelMsg('222', '乙', '写了一半的')
  appendFileSync(join(dirFor('222'), 'b.jsonl'), half.slice(0, 40))
  run('--once')
  check('is not read yet', recorded().length === 4)
  appendFileSync(join(dirFor('222'), 'b.jsonl'), half.slice(40))
  run('--once')
  check('is read once it is complete', recorded().length === 5 && recorded().at(-1)!.text === '写了一半的')

  console.log('\nwatching')
  const w = spawn(process.execPath, [join(ROOT, 'monitor.ts')], { env, stdio: ['ignore', 'ignore', 'pipe'] })
  await new Promise(r => setTimeout(r, 500))
  mkdirSync(dirFor('333'), { recursive: true })
  appendFileSync(join(dirFor('333'), 'd.jsonl'), channelMsg('333', '丙', '新来的租户'))
  await new Promise(r => setTimeout(r, 800))
  w.kill()
  check('picks up a new tenant while running', recorded().some(x => x.staffId === '333'))

  console.log('\nprivacy and reading')
  for (const f of ['questions.jsonl', 'questions.log', 'monitor-offsets.json']) {
    check(`${f} is private (0600)`, (statSync(join(state, f)).mode & 0o777) === 0o600)
  }
  const log = readFileSync(join(state, 'questions.log'), 'utf8')
  check('questions.log has one line per message', log.trim().split('\n').length === 6 && log.includes('第一行 ⏎ 第二行'))
  const rep = run('report', '--staff', '甲').stdout
  check('report filters by name', rep.includes('甲 (111) — 3 条') && !rep.includes('乙'), rep)
  const all = run('report').stdout
  check('report groups by person', all.includes('乙 (222) — 2 条') && all.includes('丙 (333) — 1 条'), all)

  console.log('\nnotifying the owner')
  writeFileSync(join(state, 'config.json'), JSON.stringify({
    clientId: 'x', clientSecret: 'x', tenants: { enabled: true, root: tenantsRoot, escalateTo: ['999'] },
  }))
  // A stand-in broker: welcomes any client and records the replies it is asked to send.
  const sent: Array<{ user: string; chat_id: string; text: string }> = []
  let broker: Server | null = null
  const startBroker = () => new Promise<void>(resolve => {
    broker = createServer(sock => {
      sock.on('data', lineDecoder(m => {
        const f = m as { t: string; id?: string; args?: { user: string; chat_id: string; text: string } }
        if (f.t === 'hello') sendLine(sock, { t: 'welcome', brokerPid: 1, bound: [] })
        if (f.t === 'reply') { sent.push(f.args!); sendLine(sock, { t: 'result', id: f.id!, ok: true }) }
      }))
    }).listen(join(state, 'broker.sock'), () => resolve())
  })
  const stopBroker = () => new Promise<void>(resolve => {
    if (!broker) return resolve()
    broker.close(() => resolve())
    broker = null
    setTimeout(resolve, 500) // close() waits for connections a client may have left half-open
  })
  const fresh = (staffId: string, nick: string, text: string) => JSON.stringify({
    type: 'user', sessionId: `sess-${staffId}`, timestamp: new Date().toISOString(),
    message: { role: 'user', content: `<channel source="plugin:dingtalk:dingtalk" chat_id="cid-${staffId}=" user="${staffId}" user_name="${nick}" is_group="false" message_id="f${++n}">\n${text}\n</channel>` },
  }) + '\n'
  await startBroker()
  const watcher = spawn(process.execPath, [join(ROOT, 'monitor.ts')], { env, stdio: ['ignore', 'ignore', 'pipe'] })
  let watcherErr = ''
  watcher.stderr!.on('data', d => { watcherErr += d })
  await new Promise(r => setTimeout(r, 600))
  check('catching up on old messages sends nothing', sent.length === 0, JSON.stringify(sent))
  mkdirSync(dirFor('444'), { recursive: true })
  mkdirSync(dirFor('999'), { recursive: true })
  appendFileSync(join(dirFor('444'), 'e.jsonl'), fresh('444', '丁', '帮我看下这个报错') + fresh('444', '丁', '还有一个问题'))
  appendFileSync(join(dirFor('999'), 'f.jsonl'), fresh('999', '主人', '我自己的消息'))
  await new Promise(r => setTimeout(r, 1000))
  check('a new message is forwarded to the owner', sent.length === 1 && sent[0]!.user === '999', JSON.stringify(sent))
  check('…both messages in one DM, with who sent them', !!sent[0] && sent[0].text.includes('丁 给助手发了消息') && sent[0].text.includes('帮我看下这个报错') && sent[0].text.includes('还有一个问题'), sent[0]?.text)
  check("…not the owner's own message", !sent.some(s => s.text.includes('我自己的消息')))
  check("…and not on the owner's real DM chat", !!sent[0] && !sent[0].chat_id.startsWith('cid'), sent[0]?.chat_id)

  await stopBroker()
  appendFileSync(join(dirFor('444'), 'e.jsonl'), fresh('444', '丁', '趁 broker 不在时发的'))
  await new Promise(r => setTimeout(r, 800))
  await startBroker()
  await new Promise(r => setTimeout(r, 1000))
  check('a notification that could not be sent is retried', sent.length === 2 && sent[1]!.text.includes('趁 broker 不在时发的'), JSON.stringify(sent.map(s => s.text)))
  check('the failure is logged', watcherErr.includes('could not notify'), watcherErr)

  writeFileSync(join(state, 'config.json'), JSON.stringify({
    clientId: 'x', clientSecret: 'x', monitor: { notifyTo: [] }, tenants: { enabled: true, root: tenantsRoot, escalateTo: ['999'] },
  }))
  appendFileSync(join(dirFor('444'), 'e.jsonl'), fresh('444', '丁', '关掉提醒之后'))
  await new Promise(r => setTimeout(r, 1000))
  watcher.kill()
  check('monitor.notifyTo: [] turns notifications off', sent.length === 2 && recorded().some(x => x.text === '关掉提醒之后'))

  writeFileSync(join(state, 'config.json'), JSON.stringify({
    clientId: 'x', clientSecret: 'x', monitor: { notifyTo: ['888'] }, tenants: { enabled: true, root: tenantsRoot },
  }))
  // Not spawnSync: the stand-in broker lives in this process and has to keep answering.
  const t = spawn(process.execPath, [join(ROOT, 'monitor.ts'), 'notify-test'], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  let tOut = ''
  t.stdout!.on('data', d => { tOut += d }); t.stderr!.on('data', d => { tOut += d })
  const status = await new Promise<number | null>(r => t.on('exit', r))
  check('notify-test sends a sample to monitor.notifyTo', status === 0 && sent.at(-1)?.user === '888' && sent.at(-1)!.text.includes('测试'), tOut)
  await stopBroker()
} finally {
  rmSync(tmp, { recursive: true, force: true })
}

console.log(`\n${failures.length ? '\x1b[31m' : '\x1b[32m'}${passed} passed, ${failures.length} failed\x1b[0m`)
process.exit(failures.length ? 1 : 0)
