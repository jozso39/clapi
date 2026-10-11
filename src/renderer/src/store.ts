import { create } from 'zustand'
import type { SlashCommand } from '../../preload/api'
import {
  DEFAULT_PREFS,
  type AssistantPartial,
  type ChatItem,
  type ModelInfo,
  type ModelPerf,
  type ModelRef,
  type ModelRoles,
  type Prefs,
  type RuntimeEvent,
  type RuntimeState,
  type SessionSummary,
  type UiRequest,
  type UiResponse
} from '../../shared/types'
import { buildSidebar, titleOf, uid } from './lib'

const api = window.clapi

export interface LiveTool {
  name: string
  args: Record<string, unknown>
  intent?: string
  done: boolean
  isError: boolean
}

export interface SessionView {
  items: ChatItem[]
  start: number
  total: number
  loaded: boolean
  loading: boolean
  partial: AssistantPartial | null
  live: Record<string, LiveTool>
  /** Sent but not yet echoed back by omp. */
  pending: string[]
  busySince: number | null
  asks: UiRequest[]
}

const emptyView = (): SessionView => ({
  items: [],
  start: 0,
  total: 0,
  loaded: false,
  loading: false,
  partial: null,
  live: {},
  pending: [],
  busySince: null,
  asks: []
})

export type SettingsTab = 'accounts' | 'import'
export type Dialog =
  | { kind: 'settings'; tab: SettingsTab; provider?: string }
  | { kind: 'models'; view: 'all' | 'roles'; role?: string }
  | { kind: 'shortcuts' }
  | { kind: 'delete'; id: string }
  | { kind: 'group'; sessionId?: string; groupId?: string; name?: string }
  | null
export type Menu = { kind: 'effort'; x: number; y: number } | null
export type Ctx = { id: string; x: number; y: number } | null

export interface Toast {
  id: string
  level: 'info' | 'warning' | 'error'
  text: string
}

interface State {
  ready: boolean
  home: string
  version: string
  sessions: SessionSummary[]
  runtime: Record<string, RuntimeState>
  views: Record<string, SessionView>
  activeId: string | null
  drafts: Record<string, string>
  newSession: { cwd: string | null; model?: ModelRef; thinking?: string }
  prefs: Prefs
  models: ModelInfo[]
  perf: Record<string, ModelPerf>
  levels: string[]
  /** Option is held: sidebar rows show 1–10 for ⌥1…⌥0. */
  altHeld: boolean
  /** omp's modelRoles, kept for labels (the default model). */
  roles: ModelRoles
  commands: SlashCommand[]
  query: string
  menu: Menu
  ctx: Ctx
  dialog: Dialog
  renaming: string | null
  /** The toolbar title is being edited (⌘⇧R, double-click). */
  titleEditing: boolean
  toasts: Toast[]
}

export const useStore = create<State>(() => ({
  ready: false,
  home: '',
  version: '',
  sessions: [],
  runtime: {},
  views: {},
  activeId: null,
  drafts: {},
  newSession: { cwd: null },
  prefs: { ...DEFAULT_PREFS },
  models: [],
  perf: {},
  altHeld: false,
  roles: {},
  levels: ['off', 'low', 'medium', 'high', 'xhigh', 'max'],
  commands: [],
  query: '',
  menu: null,
  ctx: null,
  dialog: null,
  renaming: null,
  titleEditing: false,
  toasts: []
}))

const get = useStore.getState
const set = useStore.setState

// ─── small helpers ───────────────────────────────────────────────────────────

export function view(id: string | null): SessionView {
  return (id && get().views[id]) || emptyView()
}

function patchView(id: string, patch: Partial<SessionView> | ((v: SessionView) => Partial<SessionView>)): void {
  set((s) => {
    const current = s.views[id] ?? emptyView()
    const next = typeof patch === 'function' ? patch(current) : patch
    return { views: { ...s.views, [id]: { ...current, ...next } } }
  })
}

export function sessionById(id: string | null): SessionSummary | undefined {
  return id ? get().sessions.find((s) => s.id === id) : undefined
}

function patchSession(id: string, patch: Partial<SessionSummary>): void {
  set((s) => ({ sessions: s.sessions.map((x) => (x.id === id ? { ...x, ...patch } : x)) }))
}

export function toast(level: Toast['level'], text: string): void {
  const id = uid()
  set((s) => ({ toasts: [...s.toasts.slice(-3), { id, level, text }] }))
  setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), level === 'error' ? 9000 : 5000)
}

export function reportError(err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err)
  // Electron prefixes IPC errors with the channel; the message after it is ours.
  toast('error', msg.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
}

let prefsTimer: ReturnType<typeof setTimeout> | null = null
export function updatePrefs(fn: (p: Prefs) => Prefs): void {
  set((s) => ({ prefs: fn(s.prefs) }))
  if (prefsTimer) clearTimeout(prefsTimer)
  prefsTimer = setTimeout(() => void api.prefs.save(get().prefs), 250)
}

const toggle = (list: string[], id: string, on: boolean): string[] => (on ? (list.includes(id) ? list : [...list, id]) : list.filter((x) => x !== id))

// ─── loading ─────────────────────────────────────────────────────────────────

export async function refreshSessions(): Promise<void> {
  const list = await api.sessions.list()
  set((s) => {
    // Keep sessions created here whose file omp has not written yet.
    const onDisk = new Set(list.map((x) => x.id))
    const unsaved = s.sessions.filter((x) => !x.path && !onDisk.has(x.id))
    const sessions = [...unsaved, ...list]
    // The open session's file is gone (deleted, trashed elsewhere): leave it.
    const activeGone = s.activeId !== null && !sessions.some((x) => x.id === s.activeId)
    return activeGone ? { sessions, activeId: null } : { sessions }
  })
}

export async function loadModels(force = false): Promise<void> {
  try {
    const [models, levels, perf] = await Promise.all([api.models.list(force), api.models.thinkingLevels(), api.models.perf().catch(() => ({}))])
    set({ models, levels, perf })
  } catch (err) {
    reportError(err)
  }
}

let initialized = false

export async function init(): Promise<void> {
  // StrictMode mounts twice in dev; subscribing twice would duplicate every event.
  if (initialized) return
  initialized = true
  const [info, prefs] = await Promise.all([api.app.info(), api.prefs.load()])
  set({ home: info.home, version: info.version, prefs })
  api.on.runtime(onRuntimeEvent)
  api.on.sessionsChanged(() => void refreshSessions())
  await refreshSessions()
  set((s) => ({ newSession: { ...s.newSession, cwd: s.newSession.cwd ?? s.sessions[0]?.cwd ?? null } }))
  for (const st of await api.sessions.runtimes()) set((s) => ({ runtime: { ...s.runtime, [st.sessionId]: st } }))
  set({ ready: true })
  // The catalogue needs a running omp; fetch it after first paint.
  void loadModels()
  void api.models.commands().then((commands) => set({ commands })).catch(() => undefined)
  void api.roles.get().then((roles) => set({ roles })).catch(() => undefined)
}

export async function loadTranscript(id: string, earlier = false): Promise<void> {
  const s = sessionById(id)
  if (!s?.path) {
    patchView(id, { loaded: true })
    return
  }
  const v = view(id)
  if (v.loading) return
  patchView(id, { loading: true })
  try {
    if (earlier) {
      const t = await api.sessions.transcript(s.path, { end: v.start, limit: 400 })
      patchView(id, (cur) => ({ items: [...t.items, ...cur.items], start: t.start, loading: false }))
    } else {
      const t = await api.sessions.transcript(s.path)
      patchView(id, { items: t.items, start: t.start, total: t.total, loaded: true, loading: false })
    }
  } catch (err) {
    patchView(id, { loading: false, loaded: true })
    reportError(err)
  }
}

// ─── selection ───────────────────────────────────────────────────────────────

export function select(id: string | null): void {
  set({ activeId: id, menu: null, ctx: null, renaming: null, titleEditing: false })
  if (!id) return
  if (get().prefs.unread.includes(id)) updatePrefs((p) => ({ ...p, unread: p.unread.filter((x) => x !== id) }))
  if (!view(id).loaded) void loadTranscript(id)
}

export function newSessionScreen(cwd?: string | null): void {
  set((s) => ({ activeId: null, newSession: { ...s.newSession, cwd: cwd ?? s.newSession.cwd ?? s.sessions[0]?.cwd ?? null } }))
}

/** Live runtime for a session, starting omp for it on first use. */
async function ensureRuntime(id: string): Promise<boolean> {
  const rt = get().runtime[id]
  if (rt && (rt.status === 'idle' || rt.status === 'busy')) return true
  const s = sessionById(id)
  if (!s?.path) return false
  try {
    const st = await api.sessions.open(s.id, s.path, s.cwd)
    set((x) => ({ runtime: { ...x.runtime, [id]: st } }))
    return true
  } catch (err) {
    reportError(err)
    return false
  }
}

// ─── sending ─────────────────────────────────────────────────────────────────

/** Clapi's own slash commands. omp has /model too, but here it opens the panel. */
export const LOCAL_COMMANDS: SlashCommand[] = [
  { name: 'login', description: 'Log in to a model provider', hint: '[provider]' },
  { name: 'logout', description: 'Log out of a model provider' },
  { name: 'model', description: 'Pick a model, its thinking, and which roles use it' },
  { name: 'roles', description: 'See and change which model each role uses' },
  { name: 'import', description: 'Import conversations from Claude Code' }
]

function runLocalCommand(body: string): boolean {
  const m = /^\/(login|logout|model|models|roles|import)(?:\s+(\S+))?\s*$/.exec(body)
  if (!m) return false
  const [, cmd, arg] = m
  if (cmd === 'login') set({ dialog: { kind: 'settings', tab: 'accounts', provider: arg } })
  else if (cmd === 'logout') set({ dialog: { kind: 'settings', tab: 'accounts' } })
  else if (cmd === 'roles') set({ dialog: { kind: 'models', view: 'roles' } })
  else if (cmd === 'import') set({ dialog: { kind: 'settings', tab: 'import' } })
  else set({ dialog: { kind: 'models', view: 'all' } })
  const key = get().activeId ?? 'new'
  set((s) => ({ drafts: { ...s.drafts, [key]: '' } }))
  return true
}

export async function send(text: string): Promise<void> {
  const body = text.trim()
  if (!body) return
  if (runLocalCommand(body)) return
  const id = get().activeId
  if (!id) return startNewSession(body)
  patchView(id, (v) => ({ pending: [...v.pending, body], busySince: v.busySince ?? Date.now() }))
  set((s) => ({ drafts: { ...s.drafts, [id]: '' } }))
  if (!(await ensureRuntime(id))) {
    patchView(id, (v) => ({ pending: v.pending.slice(0, -1), busySince: null }))
    return
  }
  try {
    await api.sessions.prompt(id, body)
  } catch (err) {
    patchView(id, (v) => ({ pending: v.pending.filter((p) => p !== body), busySince: null }))
    reportError(err)
  }
}

async function startNewSession(body: string): Promise<void> {
  const { newSession } = get()
  let cwd = newSession.cwd
  if (!cwd) {
    cwd = await api.app.pickFolder()
    if (!cwd) return
  }
  set((s) => ({ drafts: { ...s.drafts, new: '' } }))
  try {
    const st = await api.sessions.create(cwd)
    const id = st.sessionId
    const now = Date.now()
    const summary: SessionSummary = { id, path: null, cwd, title: body.split('\n')[0].slice(0, 70), created: new Date(now).toISOString(), modified: now, size: 0 }
    set((s) => ({
      sessions: [summary, ...s.sessions],
      runtime: { ...s.runtime, [id]: st },
      views: { ...s.views, [id]: { ...emptyView(), loaded: true, pending: [body], busySince: now } },
      activeId: id
    }))
    if (newSession.model) await api.sessions.setModel(id, newSession.model).catch(reportError)
    if (newSession.thinking) await api.sessions.setThinking(id, newSession.thinking).catch(reportError)
    await api.sessions.prompt(id, body)
  } catch (err) {
    reportError(err)
  }
}

export async function abort(): Promise<void> {
  const id = get().activeId
  if (id && get().runtime[id]?.status === 'busy') await api.sessions.abort(id).catch(reportError)
}

export async function chooseModel(model: ModelRef): Promise<void> {
  set({ menu: null })
  const id = get().activeId
  if (!id) {
    set((s) => ({ newSession: { ...s.newSession, model } }))
    return
  }
  if (!(await ensureRuntime(id))) return
  await api.sessions.setModel(id, model).catch(reportError)
}

/**
 * Apply a pick from the model panel: write it into the chosen roles (one
 * omp config write) and/or switch the open session (or the next new one).
 */
export async function applyModelChoice(opts: { value: string; name?: string; level: string; roles: string[]; switchSession: boolean }): Promise<void> {
  const { value, level, roles, switchSession } = opts
  const selector = level && level !== 'inherit' ? `${value}:${level}` : value
  if (roles.length > 0) {
    const current: ModelRoles = await api.roles.get()
    for (const r of roles) current[r] = selector
    set({ roles: await api.roles.set(current) })
  }
  if (switchSession) {
    const slash = value.indexOf('/')
    await chooseModel({ provider: value.slice(0, slash), id: value.slice(slash + 1), name: opts.name })
    if (level && level !== 'inherit') await chooseThinking(level)
  }
  const parts = [roles.length ? `role${roles.length > 1 ? 's' : ''} ${roles.join(', ')}` : '', switchSession ? (get().activeId ? 'this session' : 'the next session') : '']
  toast('info', `${opts.name ?? value}${level && level !== 'inherit' ? ` (${level})` : ''} → ${parts.filter(Boolean).join(' and ')}`)
}

export async function chooseThinking(level: string): Promise<void> {
  set({ menu: null })
  const id = get().activeId
  if (!id) {
    set((s) => ({ newSession: { ...s.newSession, thinking: level } }))
    return
  }
  if (!(await ensureRuntime(id))) return
  await api.sessions.setThinking(id, level).catch(reportError)
}

export async function answerAsk(sessionId: string, request: UiRequest, response: UiResponse): Promise<void> {
  patchView(sessionId, (v) => ({ asks: v.asks.filter((a) => a.id !== request.id) }))
  await api.sessions.respond(sessionId, request.id, response).catch(reportError)
}

// ─── runtime events ──────────────────────────────────────────────────────────

function notifyDesktop(title: string, body: string): void {
  if (document.hasFocus()) return
  try {
    new Notification(title, { body, silent: false })
  } catch {
    // notifications unavailable
  }
}

const reloadTimers: Record<string, ReturnType<typeof setTimeout>> = {}

/** After a turn, re-read the file: it carries the entry ids that forking needs. */
function scheduleReload(id: string, attempt = 0): void {
  clearTimeout(reloadTimers[id])
  reloadTimers[id] = setTimeout(async () => {
    const s = sessionById(id)
    if (!s?.path) return
    const before = view(id)
    try {
      const t = await api.sessions.transcript(s.path)
      // omp may still be flushing the turn's last entries; if the file is behind
      // what streamed live, look again shortly rather than dropping messages.
      if (t.total < before.start + before.items.length && attempt < 3) return scheduleReload(id, attempt + 1)
      patchView(id, (cur) => ({ items: t.items, start: t.start, total: t.total, loaded: true, partial: cur.busySince ? cur.partial : null }))
    } catch {
      // keep the live items
    }
  }, 250 + attempt * 400)
}

function onRuntimeEvent(e: RuntimeEvent): void {
  if (e.type === 'state') {
    const st = e.state
    set((s) => ({ runtime: { ...s.runtime, [st.sessionId]: st } }))
    if (st.status === 'busy') patchView(st.sessionId, (v) => ({ busySince: v.busySince ?? Date.now() }))
    if (st.status === 'error' && st.error) toast('error', st.error)
    if (st.status === 'exited' || st.status === 'error') patchView(st.sessionId, { busySince: null, partial: null, live: {} })
    return
  }
  const id = e.sessionId
  switch (e.type) {
    case 'partial':
      patchView(id, { partial: e.partial })
      break
    case 'message':
      patchView(id, (v) => {
        if (e.item.kind === 'user') {
          return { items: [...v.items, e.item], pending: v.pending.slice(1) }
        }
        return { items: [...v.items, e.item], partial: e.item.kind === 'assistant' ? null : v.partial }
      })
      break
    case 'toolStart':
      patchView(id, (v) => ({
        live: { ...v.live, [e.toolCallId]: { name: e.toolName, args: (e.args ?? {}) as Record<string, unknown>, intent: e.intent, done: false, isError: false } }
      }))
      break
    case 'toolEnd':
      patchView(id, (v) => (v.live[e.toolCallId] ? { live: { ...v.live, [e.toolCallId]: { ...v.live[e.toolCallId], done: true, isError: e.isError } } } : {}))
      break
    case 'agentEnd': {
      patchView(id, { busySince: null, partial: null, live: {}, pending: [] })
      patchSession(id, { modified: Date.now() })
      const s = sessionById(id)
      if (id !== get().activeId) {
        updatePrefs((p) => ({ ...p, unread: toggle(p.unread, id, true) }))
      }
      if (s) notifyDesktop(titleOf(s), 'Finished')
      scheduleReload(id)
      break
    }
    case 'ui':
      patchView(id, (v) => ({ asks: [...v.asks.filter((a) => a.id !== e.request.id), e.request] }))
      {
        const s = sessionById(id)
        notifyDesktop(s ? titleOf(s) : 'Clapi', e.request.title || 'Needs your input')
      }
      break
    case 'uiCancel':
      patchView(id, (v) => ({ asks: v.asks.filter((a) => a.id !== e.targetId) }))
      break
    case 'notify':
      if (e.text) toast(e.level, e.text)
      break
    case 'title':
      patchSession(id, { title: e.title })
      break
    case 'persisted':
      patchSession(id, { path: e.path })
      scheduleReload(id)
      break
  }
}

// ─── session management ──────────────────────────────────────────────────────

export async function renameSession(id: string, title: string): Promise<void> {
  const t = title.trim()
  set({ renaming: null, titleEditing: false })
  const s = sessionById(id)
  if (!s || !t || t === s.title) return
  patchSession(id, { title: t })
  await api.sessions.rename(id, s.path, t).catch((err) => {
    patchSession(id, { title: s.title })
    reportError(err)
  })
}

export async function deleteSession(id: string): Promise<void> {
  set({ dialog: null })
  const s = sessionById(id)
  if (!s) return
  if (s.path) {
    try {
      await api.sessions.remove(id, s.path)
    } catch (err) {
      return reportError(err)
    }
  } else await api.sessions.stop(id).catch(() => undefined)
  set((x) => ({ sessions: x.sessions.filter((y) => y.id !== id), activeId: x.activeId === id ? null : x.activeId }))
  updatePrefs((p) => ({
    ...p,
    pinned: p.pinned.filter((x) => x !== id),
    archived: p.archived.filter((x) => x !== id),
    unread: p.unread.filter((x) => x !== id)
  }))
}

/** New session holding the history up to `entryId` (the whole session when null). */
export async function forkSession(id: string, entryId: string | null, prefill?: string): Promise<void> {
  const s = sessionById(id)
  if (!s?.path) return toast('info', 'This session has not been saved yet — send a message first.')
  try {
    const summary = await api.sessions.fork(s.path, entryId, `${titleOf(s)} (fork)`)
    if (!summary) throw new Error('The fork could not be read back')
    set((x) => ({ sessions: [summary, ...x.sessions.filter((y) => y.id !== summary.id)] }))
    // Forks stay next to their source when it lives in a custom group.
    const gid = get().prefs.groupOf[id]
    if (gid) updatePrefs((p) => ({ ...p, groupOf: { ...p.groupOf, [summary.id]: gid } }))
    select(summary.id)
    if (prefill) set((x) => ({ drafts: { ...x.drafts, [summary.id]: prefill } }))
    toast('info', entryId ? 'Forked from that message into a new session' : 'Session forked')
  } catch (err) {
    reportError(err)
  }
}

export function setPinned(id: string, on: boolean): void {
  updatePrefs((p) => ({ ...p, pinned: toggle(p.pinned, id, on) }))
}

export function setArchived(id: string, on: boolean): void {
  if (on && get().activeId === id) {
    const next = buildSidebar(get().sessions, get().prefs, '', get().home).flat.find((s) => s.id !== id)
    select(next?.id ?? null)
  }
  updatePrefs((p) => ({ ...p, archived: toggle(p.archived, id, on), pinned: on ? p.pinned.filter((x) => x !== id) : p.pinned }))
  if (on) void api.sessions.stop(id).catch(() => undefined)
}

export function setUnread(id: string, on: boolean): void {
  updatePrefs((p) => ({ ...p, unread: toggle(p.unread, id, on) }))
}

export function toggleCollapsed(key: string): void {
  updatePrefs((p) => ({ ...p, collapsed: toggle(p.collapsed, key, !p.collapsed.includes(key)) }))
}

/** Move a session one slot up or down inside its group (or the pinned list). */
export function move(id: string, dir: -1 | 1): void {
  const { sessions, prefs, home } = get()
  if (prefs.pinned.includes(id)) {
    const list = [...prefs.pinned]
    const i = list.indexOf(id)
    const j = i + dir
    if (j < 0 || j >= list.length) return
    ;[list[i], list[j]] = [list[j], list[i]]
    return updatePrefs((p) => ({ ...p, pinned: list }))
  }
  const model = buildSidebar(sessions, prefs, '', home)
  const group = model.groups.find((g) => g.sessions.some((s) => s.id === id))
  if (!group) return
  const ids = group.sessions.map((s) => s.id)
  const i = ids.indexOf(id)
  const j = i + dir
  if (j < 0 || j >= ids.length) return
  ;[ids[i], ids[j]] = [ids[j], ids[i]]
  updatePrefs((p) => ({ ...p, order: { ...p.order, [group.key]: ids } }))
}

export function moveToGroup(id: string, groupId: string | null): void {
  updatePrefs((p) => {
    const groupOf = { ...p.groupOf }
    if (groupId) groupOf[id] = groupId
    else delete groupOf[id]
    return { ...p, groupOf }
  })
}

export function createGroup(name: string, withSession?: string): void {
  const g = { id: uid(), name: name.trim() || 'New group' }
  updatePrefs((p) => ({
    ...p,
    customGroups: [...p.customGroups, g],
    groupOf: withSession ? { ...p.groupOf, [withSession]: g.id } : p.groupOf
  }))
}

export function renameGroup(groupId: string, name: string): void {
  updatePrefs((p) => ({ ...p, customGroups: p.customGroups.map((g) => (g.id === groupId ? { ...g, name } : g)) }))
}

export function deleteGroup(groupId: string): void {
  updatePrefs((p) => ({
    ...p,
    customGroups: p.customGroups.filter((g) => g.id !== groupId),
    groupOf: Object.fromEntries(Object.entries(p.groupOf).filter(([, g]) => g !== groupId))
  }))
}

export function cycleViewMode(): void {
  const order: Prefs['viewMode'][] = ['normal', 'thinking', 'verbose']
  const next = order[(order.indexOf(get().prefs.viewMode) + 1) % order.length]
  updatePrefs((p) => ({ ...p, viewMode: next }))
  toast('info', `View: ${next[0].toUpperCase()}${next.slice(1)}`)
}

/** Close = stop the agent and leave the session; nothing is deleted. */
export async function closeSession(): Promise<void> {
  const id = get().activeId
  if (!id) return
  await api.sessions.stop(id).catch(() => undefined)
  newSessionScreen(sessionById(id)?.cwd)
}

export function step(dir: 1 | -1): void {
  const { sessions, prefs, home, activeId } = get()
  const flat = buildSidebar(sessions, prefs, '', home).flat
  if (flat.length === 0) return
  const i = flat.findIndex((s) => s.id === activeId)
  const next = flat[(i + dir + flat.length) % flat.length] ?? flat[0]
  select(next.id)
}
