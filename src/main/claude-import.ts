// Import Claude Code transcripts (~/.claude/projects/<project>/<id>.jsonl) as
// omp sessions.
//
// The conversion is a port of omp's own ClaudeSessionStore
// (packages/coding-agent/src/session/claude-session-store.ts, MIT): same block
// mapping, same synthetic entry ids, same `model_change` entries, same
// `foreign_session_import` marker. omp only exposes it through an interactive
// picker (`--from-claude` refuses RPC mode), so Clapi carries the logic itself.
import { existsSync } from 'node:fs'
import { open, readdir, readFile, stat, utimes } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join, sep } from 'node:path'
import type { ClaudeSessionInfo } from '../shared/types'
import { CLAPI_HOME, SESSIONS_ROOT } from './env'
import { bucketFor, fileSafeTimestamp, jsonlLines, uuidv7, writeSessionFile, type SessionHeader } from './session-files'

const IMPORTS_FILE = join(CLAPI_HOME, 'imports.json')

function claudeRoot(): string {
  return process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
}

const str = (r: any, k: string): string | undefined => (typeof r?.[k] === 'string' && r[k].length > 0 ? r[k] : undefined)
const num = (r: any, k: string): number => (typeof r?.[k] === 'number' && Number.isFinite(r[k]) ? r[k] : 0)

function tsMs(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const t = Date.parse(value)
    if (Number.isFinite(t)) return t
  }
  return fallback
}

// ─── listing ─────────────────────────────────────────────────────────────────

async function registeredProjects(root: string): Promise<string[]> {
  const config = root === join(homedir(), '.claude') ? join(homedir(), '.claude.json') : join(root, '..', '.claude.json')
  try {
    const parsed = JSON.parse(await readFile(config, 'utf8'))
    return Object.keys(parsed?.projects ?? {}).filter((p) => p.startsWith('/'))
  } catch {
    return []
  }
}

function projectCwd(encoded: string, registered: string[]): string {
  const exact = registered.find((p) => p.split(sep).join('-') === encoded)
  if (exact) return exact
  return encoded.startsWith('-') ? encoded.split('-').join(sep) : encoded
}

async function firstMessages(root: string): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  try {
    for await (const { value } of jsonlLines(join(root, 'history.jsonl'))) {
      const id = str(value, 'sessionId') ?? str(value, 'session_id')
      const text = str(value, 'display') ?? str(value, 'text')
      if (id && text && !out.has(id)) out.set(id, text.replace(/\s+/g, ' ').trim().slice(0, 200))
    }
  } catch {
    // optional index
  }
  return out
}

/** Title from the transcript tail: the last `custom-title`, else the last `ai-title`. */
async function tailTitle(path: string, size: number): Promise<string | undefined> {
  const window = Math.min(size, 512 * 1024)
  const fh = await open(path, 'r')
  try {
    const buf = Buffer.alloc(window)
    await fh.read(buf, 0, window, size - window)
    let custom: string | undefined
    let ai: string | undefined
    for (const line of buf.toString('utf8').split('\n')) {
      if (!line.includes('-title"')) continue
      try {
        const v = JSON.parse(line)
        if (v.type === 'custom-title' && typeof v.customTitle === 'string') custom = v.customTitle
        if (v.type === 'ai-title' && typeof v.aiTitle === 'string') ai = v.aiTitle
      } catch {
        // the window may start mid-line
      }
    }
    return custom ?? ai
  } finally {
    await fh.close()
  }
}

async function readImports(): Promise<Record<string, string>> {
  try {
    return JSON.parse(await readFile(IMPORTS_FILE, 'utf8'))
  } catch {
    return {}
  }
}

export async function listClaudeSessions(): Promise<ClaudeSessionInfo[]> {
  const root = claudeRoot()
  const [registered, firsts, imports] = await Promise.all([registeredProjects(root), firstMessages(root), readImports()])
  const out: ClaudeSessionInfo[] = []
  const projectsDir = join(root, 'projects')
  for (const project of await readdir(projectsDir, { withFileTypes: true }).catch(() => [])) {
    if (!project.isDirectory()) continue
    const dir = join(projectsDir, project.name)
    const cwd = projectCwd(project.name, registered)
    for (const f of await readdir(dir).catch(() => [] as string[])) {
      if (!f.endsWith('.jsonl')) continue
      const path = join(dir, f)
      const st = await stat(path).catch(() => null)
      if (!st || st.size === 0) continue
      const id = basename(f, '.jsonl')
      out.push({
        id,
        path,
        cwd,
        title: await tailTitle(path, st.size).catch(() => undefined),
        firstMessage: firsts.get(id),
        modified: st.mtimeMs,
        size: st.size,
        imported: imports[id]
      })
    }
  }
  return out.sort((a, b) => b.modified - a.modified)
}

// ─── conversion ──────────────────────────────────────────────────────────────

const EMPTY_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
}

function image(b: any): any {
  if (b?.type !== 'image' || !b.source) return undefined
  const data = str(b.source, 'data')
  const mimeType = str(b.source, 'media_type')
  return data && mimeType ? { type: 'image', data, mimeType } : undefined
}

function textAndImages(value: unknown): any[] {
  if (typeof value === 'string') return [{ type: 'text', text: value }]
  if (!Array.isArray(value)) return []
  const out: any[] = []
  for (const b of value) {
    if (b?.type === 'text' && typeof b.text === 'string') out.push({ type: 'text', text: b.text })
    else {
      const img = image(b)
      if (img) out.push(img)
    }
  }
  return out
}

function assistantContent(value: unknown, toolNames: Map<string, string>): any[] {
  if (!Array.isArray(value)) return []
  const out: any[] = []
  for (const b of value) {
    if (b?.type === 'text' && typeof b.text === 'string') out.push({ type: 'text', text: b.text })
    else if (b?.type === 'thinking' && typeof b.thinking === 'string') {
      const t: any = { type: 'thinking', thinking: b.thinking }
      if (typeof b.signature === 'string') t.thinkingSignature = b.signature
      out.push(t)
    } else if (b?.type === 'tool_use') {
      const id = str(b, 'id')
      const name = str(b, 'name')
      if (!id || !name) continue
      out.push({ type: 'toolCall', id, name, arguments: b.input && typeof b.input === 'object' ? b.input : {} })
      toolNames.set(id, name)
    }
  }
  return out
}

function stopReason(v: unknown): string {
  if (v === 'tool_use') return 'toolUse'
  if (v === 'max_tokens') return 'length'
  if (v === 'end_turn' || v === 'stop_sequence' || v === 'pause_turn') return 'stop'
  return v == null ? 'stop' : 'error'
}

function convert(record: any, fallback: number, toolNames: Map<string, string>): { message: any; suffix: string }[] {
  if ((record.type !== 'user' && record.type !== 'assistant') || record.isSidechain === true || record.isMeta === true) return []
  if (!record.message || typeof record.message !== 'object') return []
  const timestamp = tsMs(record.timestamp, fallback)
  if (record.type === 'assistant') {
    const content = assistantContent(record.message.content, toolNames)
    const errorMessage = str(record, 'error')
    if (content.length === 0 && !errorMessage) return []
    const u = record.message.usage
    const usage = u
      ? (() => {
          const input = num(u, 'input_tokens')
          const output = num(u, 'output_tokens')
          const cacheRead = num(u, 'cache_read_input_tokens')
          const cacheWrite = num(u, 'cache_creation_input_tokens')
          return { input, output, cacheRead, cacheWrite, totalTokens: input + output + cacheRead + cacheWrite, cost: EMPTY_USAGE.cost }
        })()
      : EMPTY_USAGE
    const message: any = {
      role: 'assistant',
      content,
      api: 'anthropic-messages',
      provider: 'anthropic',
      model: str(record.message, 'model') ?? 'unknown',
      usage,
      stopReason: stopReason(record.message.stop_reason),
      timestamp
    }
    const responseId = str(record.message, 'id')
    if (responseId) message.responseId = responseId
    if (errorMessage) message.errorMessage = errorMessage
    return [{ message, suffix: 'message' }]
  }
  const raw = record.message.content
  if (Array.isArray(raw)) {
    const results: { message: any; suffix: string }[] = []
    raw.forEach((b: any, index: number) => {
      if (b?.type !== 'tool_result') return
      const toolCallId = str(b, 'tool_use_id')
      if (!toolCallId) return
      results.push({
        message: {
          role: 'toolResult',
          toolCallId,
          toolName: toolNames.get(toolCallId) ?? 'unknown',
          content: textAndImages(b.content),
          isError: b.is_error === true,
          timestamp
        },
        suffix: `tool-${index}`
      })
    })
    if (results.length > 0) return results
  }
  const content = typeof raw === 'string' ? raw : textAndImages(raw)
  if ((typeof content === 'string' && content.length === 0) || (Array.isArray(content) && content.length === 0)) return []
  return [{ message: { role: 'user', content, timestamp }, suffix: 'message' }]
}

export interface ImportResult {
  id: string
  path: string
  messages: number
}

export async function importClaudeSession(info: Pick<ClaudeSessionInfo, 'id' | 'path' | 'cwd'>): Promise<ImportResult> {
  const st = await stat(info.path)
  const parents = new Map<string, string | null>()
  const tails = new Map<string, string>()
  const used = new Set<string>()
  const toolNames = new Map<string, string>()
  const lines: string[] = []
  let sourceCwd: string | undefined
  let customTitle: string | undefined
  let aiTitle: string | undefined
  let firstUser: string | undefined
  let lastModel: string | undefined
  let synthetic = 0
  let lastId: string | null = null

  const unique = (base: string): string => {
    let id = base
    for (let n = 2; used.has(id); n++) id = `${base}-${n}`
    used.add(id)
    return id
  }
  const resolveParent = (sourceId: string | undefined): string | null => {
    const seen = new Set<string>()
    let cursor = sourceId
    while (cursor && !seen.has(cursor)) {
      seen.add(cursor)
      const kept = tails.get(cursor)
      if (kept) return kept
      cursor = parents.get(cursor) ?? undefined
    }
    return null
  }
  const push = (entry: Record<string, unknown>): void => {
    lines.push(JSON.stringify(entry))
    lastId = entry.id as string
  }

  // Claude writes parents before children, so one streaming pass suffices.
  for await (const { value, line } of jsonlLines(info.path)) {
    const uuid = str(value, 'uuid')
    if (uuid) parents.set(uuid, str(value, 'parentUuid') ?? null)
    sourceCwd ??= str(value, 'cwd')
    if (value.type === 'custom-title') customTitle = str(value, 'customTitle') ?? customTitle
    if (value.type === 'ai-title') aiTitle = str(value, 'aiTitle') ?? aiTitle

    const converted = convert(value, st.mtimeMs, toolNames)
    if (converted.length === 0) continue
    const sourceUuid = uuid ?? `line-${line}`
    let parentId = resolveParent(str(value, 'parentUuid'))
    const timestamp = new Date(tsMs(value.timestamp, st.mtimeMs)).toISOString()

    if (value.type === 'assistant') {
      const model = str(value.message, 'model')
      if (model && model !== lastModel) {
        const id = unique(`claude-${sourceUuid}-model`)
        push({ type: 'model_change', id, parentId, timestamp, model: `anthropic/${model}` })
        parentId = id
        lastModel = model
      }
    }
    for (const item of converted) {
      synthetic++
      const id = unique(`claude-${sourceUuid}-${item.suffix}-${synthetic}`)
      push({ type: 'message', id, parentId, timestamp, message: item.message })
      parentId = id
      if (!firstUser && item.message.role === 'user') {
        const c = item.message.content
        firstUser = (typeof c === 'string' ? c : c.find((b: any) => b.type === 'text')?.text ?? '').replace(/\s+/g, ' ').trim()
      }
    }
    if (parentId) tails.set(sourceUuid, parentId)
  }
  const messages = lines.length
  if (messages === 0) throw new Error('This Claude Code session has no messages to import.')

  push({
    type: 'custom',
    id: unique('clapi-import'),
    parentId: lastId,
    timestamp: new Date().toISOString(),
    customType: 'foreign_session_import',
    data: { source: 'claude', sourceId: info.id, sourcePath: info.path, sourceCwd: sourceCwd ?? info.cwd, importedBy: 'clapi' }
  })

  const cwdCandidate = sourceCwd ?? info.cwd
  const cwd = cwdCandidate && existsSync(cwdCandidate) ? cwdCandidate : homedir()
  const timestamp = new Date().toISOString()
  const id = uuidv7()
  const title = customTitle ?? aiTitle ?? (firstUser ? firstUser.slice(0, 80) : 'Imported from Claude Code')
  const header: SessionHeader = { type: 'session', version: 3, id, timestamp, cwd, title, titleSource: customTitle ? 'user' : 'auto' }
  const path = join(SESSIONS_ROOT, bucketFor(cwd), `${fileSafeTimestamp(timestamp)}_${id}.jsonl`)
  await writeSessionFile(path, header, lines)
  // Carry the conversation's last activity over, so the sidebar orders and
  // dates the import by when it was used, not when it was converted.
  await utimes(path, new Date(), new Date(st.mtimeMs))

  const imports = await readImports()
  imports[info.id] = id
  const { mkdir, writeFile } = await import('node:fs/promises')
  await mkdir(CLAPI_HOME, { recursive: true })
  await writeFile(IMPORTS_FILE, JSON.stringify(imports, null, 2))
  return { id, path, messages }
}
