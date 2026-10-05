#!/usr/bin/env bun
/**
 * Question log for tenant mode: what each person asked their assistant.
 *
 * Runs beside the broker and never talks to it. Claude Code already keeps
 * every tenant session's transcript under ~/.claude/projects/; this reads the
 * DingTalk messages out of them and records each one once, so the record
 * outlives transcript cleanup, `reset`, and resumed copies of a session.
 *
 *   bun monitor.ts                       keep watching (what launchd runs)
 *   bun monitor.ts --once                catch up once and exit
 *   bun monitor.ts report [--staff <staffId|name>] [--days N]
 *
 * Writes to the state dir, which tenant sandboxes can't read:
 *   questions.jsonl   one JSON object per message
 *   questions.log     the same, one readable line each — `tail -f` it
 */

import { appendFileSync, existsSync, readFileSync, readdirSync, statSync, writeFileSync, openSync, readSync, closeSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { CONFIG_FILE, STATE_DIR, parseTenantConfig } from './shared.ts'

const PROJECTS_DIR = join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'projects')
const QUESTIONS_FILE = join(STATE_DIR, 'questions.jsonl')
const QUESTIONS_LOG = join(STATE_DIR, 'questions.log')
const OFFSETS_FILE = join(STATE_DIR, 'monitor-offsets.json')
const SCAN_MS = Number(process.env.DINGTALK_MONITOR_SCAN_MS ?? 5000)

export type Question = {
  ts: string
  staffId: string
  nick: string
  text: string
  messageId: string
  chatId?: string
  image?: string
  file?: string
  session?: string
}

function tenantsRoot(): string {
  const raw = JSON.parse(readFileSync(CONFIG_FILE, 'utf8')) as { tenants?: unknown }
  const cfg = parseTenantConfig(raw.tenants)
  if (!cfg) throw new Error(`tenant mode is off in ${CONFIG_FILE}`)
  return cfg.root
}

/** Claude Code names a project's transcript folder after its path, every non-alphanumeric turned into '-'. */
function transcriptDirs(root: string): string[] {
  const prefix = root.replace(/[^A-Za-z0-9]/g, '-') + '-'
  if (!existsSync(PROJECTS_DIR)) return []
  return readdirSync(PROJECTS_DIR).filter(d => d.startsWith(prefix)).map(d => join(PROJECTS_DIR, d))
}

const CHANNEL_TAG = /<channel ([^>]*)>\n?([\s\S]*?)\n?<\/channel>/g
const ATTR = /(\w+)="([^"]*)"/g

/** The DingTalk messages inside one transcript entry. */
export function questionsIn(entry: Record<string, unknown>): Question[] {
  if (entry.type !== 'user') return []
  const content = (entry.message as { content?: unknown } | undefined)?.content
  const texts = typeof content === 'string'
    ? [content]
    : Array.isArray(content) ? content.filter(p => p?.type === 'text').map(p => String(p.text ?? '')) : []
  const out: Question[] = []
  for (const t of texts) {
    for (const m of t.matchAll(CHANNEL_TAG)) {
      const a: Record<string, string> = {}
      for (const [, k, v] of m[1]!.matchAll(ATTR)) a[k!] = v!
      if (!a.user) continue
      out.push({
        ts: String(entry.timestamp ?? ''),
        staffId: a.user,
        nick: a.user_name ?? a.user,
        text: m[2]!.trim(),
        messageId: a.message_id ?? `${entry.timestamp}:${a.user}`,
        ...(a.chat_id ? { chatId: a.chat_id } : {}),
        ...(a.image_path ? { image: a.image_path } : {}),
        ...(a.file_path ? { file: a.file_path } : {}),
        ...(entry.sessionId ? { session: String(entry.sessionId) } : {}),
      })
    }
  }
  return out
}

function loadSeen(): Set<string> {
  const seen = new Set<string>()
  if (!existsSync(QUESTIONS_FILE)) return seen
  for (const line of readFileSync(QUESTIONS_FILE, 'utf8').split('\n')) {
    if (!line) continue
    try { seen.add((JSON.parse(line) as Question).messageId) } catch {}
  }
  return seen
}

function localTime(iso: string): string {
  const d = new Date(iso)
  if (isNaN(d.getTime())) return iso
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

function oneLine(q: Question): string {
  const extra = [q.image && '[图片]', q.file && '[文件]'].filter(Boolean).join(' ')
  return `${localTime(q.ts)}  ${q.nick} (${q.staffId})  ${q.text.replace(/\s*\n\s*/g, ' ⏎ ')}${extra ? ' ' + extra : ''}`
}

/** Read what was appended to each transcript since last time; record messages not seen before. */
export function scan(): number {
  const root = tenantsRoot()
  const offsets: Record<string, number> = existsSync(OFFSETS_FILE)
    ? JSON.parse(readFileSync(OFFSETS_FILE, 'utf8')) : {}
  const seen = loadSeen()
  let added = 0
  for (const dir of transcriptDirs(root)) {
    for (const name of readdirSync(dir).filter(n => n.endsWith('.jsonl'))) {
      const file = join(dir, name)
      const size = statSync(file).size
      let from = offsets[file] ?? 0
      if (size < from) from = 0 // rewritten: start over, the seen-set keeps it from double counting
      if (size === from) continue
      const buf = Buffer.alloc(size - from)
      const fd = openSync(file, 'r')
      try { readSync(fd, buf, 0, buf.length, from) } finally { closeSync(fd) }
      // Only whole lines; a line still being written is picked up next time.
      const end = buf.lastIndexOf(0x0a)
      if (end < 0) continue
      for (const line of buf.subarray(0, end).toString('utf8').split('\n')) {
        if (!line) continue
        let entry: Record<string, unknown>
        try { entry = JSON.parse(line) } catch { continue }
        for (const q of questionsIn(entry)) {
          if (seen.has(q.messageId)) continue
          seen.add(q.messageId)
          appendFileSync(QUESTIONS_FILE, JSON.stringify(q) + '\n', { mode: 0o600 })
          appendFileSync(QUESTIONS_LOG, oneLine(q) + '\n', { mode: 0o600 })
          added++
        }
      }
      offsets[file] = from + end + 1
    }
  }
  writeFileSync(OFFSETS_FILE, JSON.stringify(offsets), { mode: 0o600 })
  return added
}

function report(args: string[]): void {
  const flag = (n: string) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined }
  const who = flag('--staff')
  const days = Number(flag('--days') ?? 0)
  const since = days > 0 ? Date.now() - days * 86_400_000 : 0
  const rows = existsSync(QUESTIONS_FILE)
    ? readFileSync(QUESTIONS_FILE, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as Question) : []
  const byPerson = new Map<string, Question[]>()
  for (const q of rows) {
    if (since && new Date(q.ts).getTime() < since) continue
    if (who && q.staffId !== who && !q.nick.includes(who)) continue
    byPerson.set(q.staffId, [...(byPerson.get(q.staffId) ?? []), q])
  }
  if (!byPerson.size) { console.log('(no questions recorded)'); return }
  for (const [staffId, qs] of byPerson) {
    qs.sort((a, b) => a.ts.localeCompare(b.ts))
    console.log(`\n${qs.at(-1)!.nick} (${staffId}) — ${qs.length} 条`)
    for (const q of qs) {
      const extra = [q.image && '[图片]', q.file && '[文件]'].filter(Boolean).join(' ')
      console.log(`  ${localTime(q.ts)}  ${q.text.replace(/\s*\n\s*/g, ' ⏎ ')}${extra ? ' ' + extra : ''}`)
    }
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  if (args[0] === 'report') {
    report(args.slice(1))
  } else if (args.includes('--once')) {
    console.log(`recorded ${scan()} new message(s)`)
  } else {
    process.stderr.write(`dingtalk monitor: watching tenant transcripts every ${SCAN_MS / 1000}s → ${QUESTIONS_LOG}\n`)
    const tick = () => {
      try {
        const n = scan()
        if (n) process.stderr.write(`dingtalk monitor: recorded ${n} message(s)\n`)
      } catch (err) {
        process.stderr.write(`dingtalk monitor: ${err instanceof Error ? err.message : err}\n`)
      }
    }
    tick()
    setInterval(tick, SCAN_MS)
  }
}
