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
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, readFileSync, existsSync, statSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

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
} finally {
  rmSync(tmp, { recursive: true, force: true })
}

console.log(`\n${failures.length ? '\x1b[31m' : '\x1b[32m'}${passed} passed, ${failures.length} failed\x1b[0m`)
process.exit(failures.length ? 1 : 0)
