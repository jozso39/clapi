// Reading and writing omp session files directly.
//
// Layout (omp session v3): line 1 is a fixed-width 256-byte `title` slot, line 2
// the `session` header, then one entry per line. Entries carry `id` + `parentId`
// and form a tree; the leaf is the last physical entry, and the conversation is
// the parent chain from the leaf back to a root.
import { randomBytes } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'
import { mkdir, open, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, relative, sep } from 'node:path'
import type { Block, ChatItem, SessionSummary, TitleSource, Transcript } from '../shared/types'
import { SESSIONS_ROOT } from './env'

export const TITLE_SLOT_BYTES = 256
export const SESSION_VERSION = 3

export interface Entry {
  type: string
  id: string
  parentId: string | null
  timestamp?: string
  [key: string]: any
}

export interface SessionHeader {
  type: 'session'
  version?: number
  id: string
  timestamp: string
  cwd: string
  title?: string
  titleSource?: TitleSource
  parentSession?: string
  additionalDirectories?: string[]
  [key: string]: any
}

interface TitleSlot {
  type: 'title'
  v: 1
  title: string
  source?: TitleSource
  updatedAt: string
}

// ─── ids, names, buckets ─────────────────────────────────────────────────────

/** UUIDv7, the id format omp mints for new sessions. */
export function uuidv7(now = Date.now()): string {
  const b = randomBytes(16)
  b.writeUIntBE(now, 0, 6)
  b[6] = (b[6] & 0x0f) | 0x70
  b[8] = (b[8] & 0x3f) | 0x80
  const h = b.toString('hex')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}

export function fileSafeTimestamp(iso: string): string {
  return iso.replace(/[:.]/g, '-')
}

/** omp's per-cwd bucket name: `-rel-path` under home, `--abs-path--` elsewhere. */
export function bucketFor(cwd: string, home = homedir()): string {
  const rel = relative(home, cwd)
  if (rel === '') return '-'
  if (!rel.startsWith('..') && !rel.startsWith(sep)) return `-${rel.split(sep).join('-')}`
  return `--${cwd.replace(/^\/+/, '').split(sep).join('-')}--`
}

// ─── title slot ──────────────────────────────────────────────────────────────

function slotLine(title: string, source: TitleSource | undefined, updatedAt: string, pad: string): string {
  const slot = source ? { type: 'title', v: 1, title, source, updatedAt, pad } : { type: 'title', v: 1, title, updatedAt, pad }
  return `${JSON.stringify(slot)}\n`
}

/** Exactly 256 UTF-8 bytes including the newline; long titles are cut by code point. */
export function serializeTitleSlot(title: string, source: TitleSource | undefined, updatedAt: string): string {
  const chars = [...title]
  let lo = 0
  let hi = chars.length
  let best = ''
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1
    const candidate = chars.slice(0, mid).join('')
    if (Buffer.byteLength(slotLine(candidate, source, updatedAt, '')) <= TITLE_SLOT_BYTES) {
      best = candidate
      lo = mid + 1
    } else hi = mid - 1
  }
  const unpadded = slotLine(best, source, updatedAt, '')
  const line = slotLine(best, source, updatedAt, ' '.repeat(TITLE_SLOT_BYTES - Buffer.byteLength(unpadded)))
  if (Buffer.byteLength(line) !== TITLE_SLOT_BYTES) throw new Error('title slot is not 256 bytes')
  return line
}

function parseSlot(line: string): TitleSlot | undefined {
  try {
    const v = JSON.parse(line)
    if (v?.type === 'title' && v.v === 1 && typeof v.title === 'string') return v
  } catch {
    // not a slot
  }
  return undefined
}

// ─── head: slot + header ─────────────────────────────────────────────────────

export interface Head {
  slot?: TitleSlot
  header: SessionHeader
}

/** Read just the first two lines (slot + header) without loading the file. */
export async function readHead(path: string): Promise<Head | null> {
  const fh = await open(path, 'r')
  try {
    let text = ''
    let pos = 0
    const buf = Buffer.alloc(8192)
    // Headers are small, but `additionalDirectories` can make one longer than a page.
    while (pos < 256 * 1024) {
      const { bytesRead } = await fh.read(buf, 0, buf.length, pos)
      if (bytesRead === 0) break
      pos += bytesRead
      text += buf.subarray(0, bytesRead).toString('utf8')
      const lines = text.split('\n')
      if (lines.length >= 3) break
    }
    const lines = text.split('\n')
    const slot = parseSlot(lines[0] ?? '')
    const headerLine = slot ? lines[1] : lines[0]
    if (!headerLine) return null
    const header = JSON.parse(headerLine)
    if (header?.type !== 'session' || typeof header.id !== 'string') return null
    return { slot, header }
  } catch {
    return null
  } finally {
    await fh.close()
  }
}

function summaryOf(path: string, head: Head, size: number, mtimeMs: number): SessionSummary {
  const { slot, header } = head
  return {
    id: header.id,
    path,
    cwd: header.cwd,
    title: slot?.title || header.title || '',
    titleSource: slot?.source ?? header.titleSource,
    created: header.timestamp,
    modified: mtimeMs,
    size,
    parentSession: typeof header.parentSession === 'string' ? header.parentSession : undefined
  }
}

/** First user message within the first 256 KB — the title for sessions omp never named. */
async function firstUserText(path: string): Promise<string | undefined> {
  const fh = await open(path, 'r')
  try {
    const buf = Buffer.alloc(256 * 1024)
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0)
    for (const line of buf.subarray(0, bytesRead).toString('utf8').split('\n')) {
      if (!line.includes('"role":"user"')) continue
      try {
        const e = JSON.parse(line)
        if (e.type !== 'message' || e.message?.role !== 'user') continue
        const { text } = textOf(e.message.content)
        const clean = text.replace(/<[^>]+>[\s\S]*?<\/[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
        if (clean) return clean.slice(0, 90)
      } catch {
        // a line cut at the buffer edge
      }
    }
  } finally {
    await fh.close()
  }
  return undefined
}

export async function summarize(path: string): Promise<SessionSummary | null> {
  const [head, st] = await Promise.all([readHead(path), stat(path).catch(() => null)])
  if (!head || !st) return null
  const summary = summaryOf(path, head, st.size, st.mtimeMs)
  if (!summary.title) summary.preview = await firstUserText(path).catch(() => undefined)
  return summary
}

/** Every omp session on disk, newest first. Files without a valid header are skipped. */
export async function listSessions(root = SESSIONS_ROOT): Promise<SessionSummary[]> {
  const buckets = await readdir(root, { withFileTypes: true }).catch(() => [])
  const files: string[] = []
  for (const bucket of buckets) {
    if (!bucket.isDirectory()) continue
    const dir = join(root, bucket.name)
    for (const f of await readdir(dir).catch(() => [] as string[])) {
      if (f.endsWith('.jsonl')) files.push(join(dir, f))
    }
  }
  const out: SessionSummary[] = []
  // Bounded parallelism: 150 files is instant, 5 000 should not open 5 000 fds.
  for (let i = 0; i < files.length; i += 32) {
    const batch = await Promise.all(files.slice(i, i + 32).map(summarize))
    for (const s of batch) if (s) out.push(s)
  }
  return out.sort((a, b) => b.modified - a.modified)
}

export async function findSessionPath(id: string, root = SESSIONS_ROOT): Promise<string | null> {
  const buckets = await readdir(root, { withFileTypes: true }).catch(() => [])
  for (const bucket of buckets) {
    if (!bucket.isDirectory()) continue
    const dir = join(root, bucket.name)
    const hit = (await readdir(dir).catch(() => [] as string[])).find((f) => f.endsWith(`_${id}.jsonl`))
    if (hit) return join(dir, hit)
  }
  return null
}

// ─── entries, with an incremental cache ──────────────────────────────────────

interface Loaded {
  size: number
  mtimeMs: number
  /** Bytes consumed so far; a trailing partial line is re-read next time. */
  offset: number
  header: SessionHeader | null
  slot?: TitleSlot
  byId: Map<string, Entry>
  raw: Map<string, string>
  lastId: string | null
  lineNo: number
}

const cache = new Map<string, Loaded>()

function ingest(state: Loaded, text: string): void {
  for (const line of text.split('\n')) {
    if (!line) continue
    state.lineNo++
    let value: any
    try {
      value = JSON.parse(line)
    } catch {
      continue
    }
    if (state.lineNo === 1 && value?.type === 'title') {
      state.slot = parseSlot(line)
      continue
    }
    if (!state.header && value?.type === 'session') {
      state.header = value
      continue
    }
    if (typeof value?.id !== 'string') continue
    state.byId.set(value.id, value)
    state.raw.set(value.id, line)
    state.lastId = value.id
  }
}

/** Parse a session file, reusing the previous parse and reading only appended bytes. */
export async function loadEntries(path: string): Promise<Loaded> {
  const st = await stat(path)
  let state = cache.get(path)
  if (state && st.size === state.size && st.mtimeMs === state.mtimeMs) return state
  if (!state || st.size < state.offset) {
    state = { size: 0, mtimeMs: 0, offset: 0, header: null, byId: new Map(), raw: new Map(), lastId: null, lineNo: 0 }
  }
  const fh = await open(path, 'r')
  try {
    const length = st.size - state.offset
    if (length > 0) {
      const buf = Buffer.alloc(length)
      await fh.read(buf, 0, length, state.offset)
      const lastNl = buf.lastIndexOf(0x0a)
      if (lastNl >= 0) {
        ingest(state, buf.subarray(0, lastNl + 1).toString('utf8'))
        state.offset += lastNl + 1
      }
    }
  } finally {
    await fh.close()
  }
  state.size = st.size
  state.mtimeMs = st.mtimeMs
  cache.set(path, state)
  return state
}

export function forgetCache(path: string): void {
  cache.delete(path)
}

/** Root → leaf chain ending at `leafId`. */
export function branchOf(byId: Map<string, Entry>, leafId: string | null): Entry[] {
  const out: Entry[] = []
  const seen = new Set<string>()
  let cursor = leafId
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor)
    const entry = byId.get(cursor)
    if (!entry) break
    out.push(entry)
    cursor = entry.parentId
  }
  return out.reverse()
}

// ─── entries → chat items ────────────────────────────────────────────────────

const TOOL_RESULT_LIMIT = 8000

function textOf(content: unknown): { text: string; images: number } {
  if (typeof content === 'string') return { text: content, images: 0 }
  if (!Array.isArray(content)) return { text: '', images: 0 }
  let text = ''
  let images = 0
  for (const b of content) {
    if (b?.type === 'text' && typeof b.text === 'string') text += (text ? '\n' : '') + b.text
    else if (b?.type === 'image') images++
  }
  return { text, images }
}

function ms(value: unknown, fallback = 0): number {
  if (typeof value === 'number') return value
  if (typeof value === 'string') {
    const t = Date.parse(value)
    if (Number.isFinite(t)) return t
  }
  return fallback
}

export function assistantBlocks(content: unknown): Block[] {
  if (!Array.isArray(content)) return []
  const blocks: Block[] = []
  for (const b of content) {
    if (b?.type === 'text' && typeof b.text === 'string') blocks.push({ type: 'text', text: b.text })
    else if (b?.type === 'thinking' && typeof b.thinking === 'string' && b.thinking.trim()) blocks.push({ type: 'thinking', thinking: b.thinking })
    else if (b?.type === 'toolCall' && typeof b.name === 'string')
      blocks.push({
        type: 'toolCall',
        id: String(b.id ?? ''),
        name: b.name,
        arguments: b.arguments && typeof b.arguments === 'object' ? b.arguments : {},
        intent: typeof b.intent === 'string' ? b.intent : undefined
      })
    else if (b?.type === 'image') blocks.push({ type: 'image', mimeType: String(b.mimeType ?? 'image') })
  }
  return blocks
}

/** One omp agent message (from a file entry or a live RPC event) as a chat item. */
export function messageToItem(message: any, entryId?: string, fallbackTs = 0): ChatItem | null {
  if (!message || typeof message !== 'object') return null
  const timestamp = ms(message.timestamp, fallbackTs)
  switch (message.role) {
    case 'user': {
      const { text, images } = textOf(message.content)
      return { kind: 'user', entryId, text, images, timestamp }
    }
    case 'assistant': {
      const u = message.usage
      return {
        kind: 'assistant',
        entryId,
        blocks: assistantBlocks(message.content),
        model: message.model,
        provider: message.provider,
        stopReason: message.stopReason,
        errorMessage: typeof message.errorMessage === 'string' ? message.errorMessage : undefined,
        usage: u
          ? { input: u.input ?? 0, output: u.output ?? 0, cacheRead: u.cacheRead ?? 0, cost: u.cost?.total ?? 0 }
          : undefined,
        timestamp
      }
    }
    case 'toolResult': {
      const { text } = textOf(message.content)
      return {
        kind: 'toolResult',
        entryId,
        toolCallId: String(message.toolCallId ?? ''),
        toolName: String(message.toolName ?? ''),
        text: text.length > TOOL_RESULT_LIMIT ? text.slice(0, TOOL_RESULT_LIMIT) : text,
        truncated: text.length > TOOL_RESULT_LIMIT,
        isError: message.isError === true,
        timestamp
      }
    }
    case 'bashExecution': {
      const out = typeof message.output === 'string' ? message.output : ''
      return {
        kind: 'notice',
        entryId,
        level: 'info',
        text: `$ ${message.command ?? ''}${out ? `\n${out.slice(0, 2000)}` : ''}`,
        timestamp
      }
    }
    default:
      return null
  }
}

export function entriesToItems(entries: Entry[]): ChatItem[] {
  const items: ChatItem[] = []
  for (const e of entries) {
    const ts = ms(e.timestamp)
    if (e.type === 'message') {
      const item = messageToItem(e.message, e.id, ts)
      if (item) items.push(item)
    } else if (e.type === 'compaction') {
      items.push({ kind: 'compaction', entryId: e.id, summary: String(e.shortSummary || e.summary || '').slice(0, 600), timestamp: ts })
    } else if (e.type === 'custom_message' && e.display !== false) {
      const { text } = textOf(e.content)
      if (text) items.push({ kind: 'notice', entryId: e.id, level: 'info', text: text.slice(0, 2000), timestamp: ts })
    } else if (e.type === 'model_change' && typeof e.model === 'string' && (!e.role || e.role === 'default')) {
      items.push({ kind: 'notice', entryId: e.id, level: 'info', text: `Model → ${e.model}`, timestamp: ts })
    }
  }
  return items
}

export async function getTranscript(path: string, opts: { limit?: number; end?: number } = {}): Promise<Transcript> {
  const state = await loadEntries(path)
  const items = entriesToItems(branchOf(state.byId, state.lastId))
  const total = items.length
  const end = Math.min(opts.end ?? total, total)
  const start = Math.max(0, end - (opts.limit ?? 400))
  return { items: items.slice(start, end), start, total }
}

// ─── writing ─────────────────────────────────────────────────────────────────

/** Write a complete session file atomically (tmp + rename). */
export async function writeSessionFile(path: string, header: SessionHeader, entryLines: string[], titleSource?: TitleSource): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const body =
    serializeTitleSlot(header.title ?? '', titleSource ?? header.titleSource, header.timestamp) +
    `${JSON.stringify(header)}\n` +
    entryLines.map((l) => `${l}\n`).join('')
  const tmp = `${path}.tmp-${process.pid}`
  await writeFile(tmp, body, { mode: 0o600 })
  await rename(tmp, path)
}

/** Rename in place: rewrite only the fixed-width first line, like omp does. */
export async function renameInFile(path: string, title: string): Promise<void> {
  const head = await readHead(path)
  if (!head?.slot) throw new Error('This session file has no title slot (older format); open it once in omp to upgrade it.')
  const line = serializeTitleSlot(title, 'user', new Date().toISOString())
  const fh = await open(path, 'r+')
  try {
    await fh.write(Buffer.from(line, 'utf8'), 0, TITLE_SLOT_BYTES, 0)
  } finally {
    await fh.close()
  }
  forgetCache(path)
}

/** Delete the transcript and its `<ts>_<id>` artifact directory. */
export async function deleteSessionFiles(path: string): Promise<void> {
  if (!path.startsWith(SESSIONS_ROOT + sep) || !path.endsWith('.jsonl')) throw new Error('refusing to delete outside the omp sessions directory')
  await rm(path, { force: true })
  await rm(path.slice(0, -'.jsonl'.length), { recursive: true, force: true })
  forgetCache(path)
}

/** Stream lines of any JSONL file (used for Claude transcripts, which can be hundreds of MB). */
export async function* jsonlLines(path: string): AsyncGenerator<{ value: any; line: number }> {
  const rl = createInterface({ input: createReadStream(path, { encoding: 'utf8' }), crlfDelay: Infinity })
  let line = 0
  for await (const text of rl) {
    line++
    if (!text.trim()) continue
    try {
      yield { value: JSON.parse(text), line }
    } catch {
      // skip a torn or partial line
    }
  }
}
