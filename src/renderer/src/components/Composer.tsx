import { ArrowUp, Brain, ChevronDown, Folder, Square } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { basename, capitalize, shortPath } from '../lib'
import { abort, LOCAL_COMMANDS, send, useStore, view } from '../store'

export function modelLabel(): string {
  const s = useStore.getState()
  const id = s.activeId
  const ref = id ? s.runtime[id]?.model : s.newSession.model
  const find = (provider?: string, mid?: string) => s.models.find((m) => m.provider === provider && m.id === mid)
  if (ref) return find(ref.provider, ref.id)?.name ?? ref.name ?? ref.id
  if (id) {
    const items = view(id).items
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i]
      if (it.kind === 'assistant' && it.model) return find(it.provider, it.model)?.name ?? it.model
    }
  }
  // Nothing chosen yet: name what omp will start with (the default role).
  const def = s.roles.default?.replace(/:[a-z]+$/, '')
  if (def) {
    const slash = def.indexOf('/')
    return find(def.slice(0, slash), def.slice(slash + 1))?.name ?? def
  }
  return 'Default model'
}

export function Composer({ autoFocus = true }: { autoFocus?: boolean }): ReactNode {
  const activeId = useStore((s) => s.activeId)
  const key = activeId ?? 'new'
  const draft = useStore((s) => s.drafts[key] ?? '')
  const rt = useStore((s) => (activeId ? s.runtime[activeId] : undefined))
  const busy = useStore((s) => (activeId ? s.views[activeId]?.busySince != null : false)) && rt?.status !== 'exited'
  const newCwd = useStore((s) => s.newSession.cwd)
  const newThinking = useStore((s) => s.newSession.thinking)
  const home = useStore((s) => s.home)
  const commands = useStore((s) => s.commands)
  useStore((s) => s.models.length) // re-render when names arrive
  useStore((s) => s.roles.default)
  useStore((s) => (s.activeId ? s.views[s.activeId]?.items.length ?? 0 : 0)) // the last-used model comes from the transcript
  const ref = useRef<HTMLTextAreaElement>(null)
  const [sel, setSel] = useState(0)

  const setDraft = (text: string): void => useStore.setState((s) => ({ drafts: { ...s.drafts, [key]: text } }))

  useEffect(() => {
    if (autoFocus) ref.current?.focus()
  }, [key, autoFocus])

  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, window.innerHeight * 0.4)}px`
  }, [draft])

  const slash = useMemo(() => {
    const m = /^\/(\S*)$/.exec(draft)
    if (!m) return []
    const q = m[1].toLowerCase()
    // Clapi's own commands first; omp's /model is replaced by the panel.
    const local = new Set(LOCAL_COMMANDS.map((c) => c.name))
    return [...LOCAL_COMMANDS, ...commands.filter((c) => !local.has(c.name))].filter((c) => c.name.toLowerCase().startsWith(q)).slice(0, 40)
  }, [draft, commands])

  useEffect(() => setSel(0), [slash.length])

  const submit = (): void => {
    if (!draft.trim()) return
    void send(draft)
    if (!activeId) setDraft('')
  }

  const openMenu = (kind: 'effort', e: React.MouseEvent): void => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
    useStore.setState({ menu: { kind, x: r.left, y: r.top } })
  }

  const thinking = activeId ? rt?.thinkingLevel : newThinking
  const ctx = rt?.contextPercent

  return (
    <div className="composer-wrap">
      <div className="composer">
        {slash.length > 0 && (
          <div className="slash">
            {slash.map((c, i) => (
              <div
                key={c.name}
                className={`slash-item${i === sel ? ' on' : ''}`}
                onMouseEnter={() => setSel(i)}
                onMouseDown={(e) => {
                  e.preventDefault()
                  setDraft(`/${c.name} `)
                }}
              >
                <span className="n">/{c.name}</span>
                <span className="d">{c.description}</span>
              </div>
            ))}
          </div>
        )}
        <textarea
          ref={ref}
          value={draft}
          rows={1}
          placeholder={activeId ? 'Reply… (type / for commands)' : 'Describe a task — Enter to start, / for commands'}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (slash.length > 0) {
              if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault()
                setSel((x) => (x + (e.key === 'ArrowDown' ? 1 : -1) + slash.length) % slash.length)
                return
              }
              if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey && draft !== `/${slash[sel].name}`)) {
                e.preventDefault()
                setDraft(`/${slash[sel].name} `)
                return
              }
            }
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              submit()
            }
          }}
        />
        <div className="composer-bar">
          {!activeId && (
            <button
              className="bar-btn"
              title={newCwd ? shortPath(newCwd, home) : 'Choose a project folder'}
              onClick={async () => {
                const dir = await window.clapi.app.pickFolder()
                if (dir) useStore.setState((s) => ({ newSession: { ...s.newSession, cwd: dir } }))
              }}
            >
              <Folder size={14} />
              <span>{newCwd ? basename(newCwd) : 'Choose folder'}</span>
              <ChevronDown size={12} />
            </button>
          )}
          <button className="bar-btn model-btn" data-menu="model" title="Models, thinking and roles (⌘⇧I)" onClick={() => useStore.setState({ dialog: { kind: 'models', view: 'all' } })}>
            <span>{modelLabel()}</span>
            <ChevronDown size={12} />
          </button>
          <button className="bar-btn" data-menu="effort" title="Thinking effort (⌘⇧E)" onClick={(e) => openMenu('effort', e)}>
            <Brain size={13} />
            <span>{thinking ? capitalize(thinking) : 'Effort'}</span>
            <ChevronDown size={12} />
          </button>
          <span className="spacer" />
          {typeof ctx === 'number' && <span className="ctx-meter" title="Context used">{Math.round(ctx)}% context</span>}
          {busy && !draft.trim() ? (
            <button className="send stop" title="Stop (Esc)" onClick={() => void abort()}>
              <Square size={12} fill="currentColor" />
            </button>
          ) : (
            <button className="send" title={busy ? 'Queue (Enter)' : 'Send (Enter)'} disabled={!draft.trim()} onClick={submit}>
              <ArrowUp size={16} strokeWidth={2.4} />
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
