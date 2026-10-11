import type { Prefs, SessionSummary } from '../../shared/types'

export const basename = (p: string): string => p.replace(/\/+$/, '').split('/').pop() || p

export function shortPath(p: string, home: string): string {
  return home && p.startsWith(home) ? `~${p.slice(home.length)}` : p
}

export function relTime(ms: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ms) / 1000))
  if (s < 60) return 'now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h`
  const d = Math.round(h / 24)
  if (d < 7) return `${d}d`
  const w = Math.round(d / 7)
  if (w < 5) return `${w}w`
  return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

export function clockTime(ms: number): string {
  if (!ms) return ''
  const d = new Date(ms)
  const today = new Date()
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  return d.toDateString() === today.toDateString() ? time : `${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} ${time}`
}

export function elapsed(since: number, now = Date.now()): string {
  const s = Math.max(0, Math.floor((now - since) / 1000))
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`
}

export const titleOf = (s: SessionSummary): string => s.title?.trim() || s.preview || basename(s.cwd) || 'Untitled'

export interface Group {
  key: string
  label: string
  title: string
  cwd?: string
  custom?: boolean
  sessions: SessionSummary[]
}

export interface SidebarModel {
  pinned: SessionSummary[]
  groups: Group[]
  archived: SessionSummary[]
  /** Every visible session in on-screen order (for Ctrl+Tab). */
  flat: SessionSummary[]
}

function ordered(list: SessionSummary[], order: string[] | undefined): SessionSummary[] {
  const byTime = [...list].sort((a, b) => b.modified - a.modified)
  if (!order?.length) return byTime
  const pos = new Map(order.map((id, i) => [id, i]))
  const known = byTime.filter((s) => pos.has(s.id)).sort((a, b) => pos.get(a.id)! - pos.get(b.id)!)
  const fresh = byTime.filter((s) => !pos.has(s.id))
  // New sessions surface at the top of their group, above the hand-ordered ones.
  return [...fresh, ...known]
}

export function buildSidebar(sessions: SessionSummary[], prefs: Prefs, query: string, home: string): SidebarModel {
  const q = query.trim().toLowerCase()
  const match = (s: SessionSummary): boolean =>
    !q || titleOf(s).toLowerCase().includes(q) || s.cwd.toLowerCase().includes(q)
  const archivedSet = new Set(prefs.archived)
  const pinnedSet = new Set(prefs.pinned)
  const byId = new Map(sessions.map((s) => [s.id, s]))

  const pinned = prefs.pinned.map((id) => byId.get(id)).filter((s): s is SessionSummary => !!s && !archivedSet.has(s.id) && match(s))
  const rest = sessions.filter((s) => !archivedSet.has(s.id) && !pinnedSet.has(s.id) && match(s))

  const custom = new Map(prefs.customGroups.map((g) => [g.id, { key: `g:${g.id}`, label: g.name, title: g.name, custom: true, sessions: [] as SessionSummary[] }]))
  const projects = new Map<string, Group>()
  for (const s of rest) {
    const gid = prefs.groupOf[s.id]
    const g = gid ? custom.get(gid) : undefined
    if (g) {
      g.sessions.push(s)
      continue
    }
    const key = `p:${s.cwd}`
    let p = projects.get(key)
    if (!p) {
      p = { key, label: basename(s.cwd) || s.cwd, title: shortPath(s.cwd, home), cwd: s.cwd, sessions: [] }
      projects.set(key, p)
    }
    p.sessions.push(s)
  }
  // Two projects with the same folder name get their parent appended.
  const labels = new Map<string, number>()
  for (const p of projects.values()) labels.set(p.label, (labels.get(p.label) ?? 0) + 1)
  for (const p of projects.values()) {
    if ((labels.get(p.label) ?? 0) > 1 && p.cwd) p.label = `${p.label} · ${basename(p.cwd.slice(0, -p.label.length - 1))}`
  }

  const projectGroups = [...projects.values()].sort(
    (a, b) => Math.max(...b.sessions.map((s) => s.modified)) - Math.max(...a.sessions.map((s) => s.modified))
  )
  const groups = [...custom.values(), ...projectGroups]
    .filter((g) => g.sessions.length > 0 || (g.custom && !q))
    .map((g) => ({ ...g, sessions: ordered(g.sessions, prefs.order[g.key]) }))

  const archived = sessions.filter((s) => archivedSet.has(s.id) && match(s)).sort((a, b) => b.modified - a.modified)
  const collapsed = new Set(prefs.collapsed)
  const flat = [...pinned, ...groups.flatMap((g) => (collapsed.has(g.key) && !q ? [] : g.sessions))]
  return { pinned, groups, archived, flat }
}

/** One-line description of a tool call, the way Claude Desktop collapses them. */
export function toolSummary(name: string, args: Record<string, unknown>, intent?: string): { verb: string; arg: string } {
  const a = args ?? {}
  const pick = (...keys: string[]): string => {
    for (const k of keys) if (typeof a[k] === 'string' && a[k]) return String(a[k])
    return ''
  }
  const n = name.toLowerCase()
  if (/bash|shell|exec|command/.test(n)) return { verb: 'Ran', arg: pick('command', 'cmd', 'script') }
  if (/^read|view|cat/.test(n)) return { verb: 'Read', arg: pick('path', 'file_path', 'file', 'uri') }
  if (/edit|patch|replace/.test(n)) return { verb: 'Edited', arg: pick('path', 'file_path', 'file') }
  if (/write|create/.test(n)) return { verb: 'Wrote', arg: pick('path', 'file_path', 'file') }
  if (/grep|search|find|glob/.test(n)) return { verb: 'Searched', arg: pick('pattern', 'query', 'glob', 'path') }
  if (/fetch|web|browse|url/.test(n)) return { verb: 'Fetched', arg: pick('url', 'query') }
  if (/task|agent/.test(n)) return { verb: 'Delegated', arg: pick('description', 'prompt', 'task') }
  if (/todo/.test(n)) return { verb: 'Updated todos', arg: '' }
  const first = Object.values(a).find((v) => typeof v === 'string') as string | undefined
  return { verb: name, arg: intent || first || '' }
}

export function capitalize(s: string): string {
  return s ? s[0].toUpperCase() + s.slice(1) : s
}

export function uid(): string {
  return Math.random().toString(36).slice(2, 10)
}
