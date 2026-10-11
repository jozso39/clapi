import { Archive, ChevronDown, Download, KeyRound, PanelLeft, Pencil, Plus, Search, Settings, SlidersHorizontal, Trash2 } from 'lucide-react'
import { useEffect, useMemo, useRef, type ReactNode } from 'react'
import type { SessionSummary } from '../../../shared/types'
import { buildSidebar, relTime, titleOf, type Group } from '../lib'
import { deleteGroup, newSessionScreen, renameSession, select, toggleCollapsed, useStore } from '../store'

function Dot({ id }: { id: string }): ReactNode {
  const status = useStore((s) => s.runtime[id]?.status)
  const asking = useStore((s) => (s.views[id]?.asks.length ?? 0) > 0)
  const unread = useStore((s) => s.prefs.unread.includes(id))
  const cls = asking ? 'waiting' : status === 'busy' ? 'busy' : status === 'error' ? 'error' : unread ? 'unread' : status === 'idle' ? 'live' : ''
  const title = asking ? 'Waiting for you' : status === 'busy' ? 'Working' : status === 'error' ? 'omp stopped with an error' : unread ? 'Unread' : status === 'idle' ? 'Running' : ''
  return <span className={`dot ${cls}`} title={title} />
}

function Row({ s, pos }: { s: SessionSummary; pos?: number }): ReactNode {
  const active = useStore((st) => st.activeId === s.id)
  // While Option is held the first ten rows show 1–10 (⌥1…⌥0 jumps there).
  const optNum = useStore((st) => (st.altHeld && pos !== undefined && pos < 10 ? pos + 1 : undefined))
  const renaming = useStore((st) => st.renaming === s.id)
  const inputRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (renaming) inputRef.current?.select()
  }, [renaming])
  return (
    <div
      className={`row${active ? ' active' : ''}`}
      onClick={() => !renaming && select(s.id)}
      onDoubleClick={() => useStore.setState({ renaming: s.id })}
      onContextMenu={(e) => {
        e.preventDefault()
        useStore.setState({ ctx: { id: s.id, x: e.clientX, y: e.clientY } })
      }}
      title={titleOf(s)}
    >
      <span className="lead">{optNum !== undefined ? <span className="num opt">{optNum}</span> : <Dot id={s.id} />}</span>
      {renaming ? (
        <input
          ref={inputRef}
          defaultValue={titleOf(s)}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void renameSession(s.id, e.currentTarget.value)
            if (e.key === 'Escape') useStore.setState({ renaming: null })
          }}
          onBlur={(e) => void renameSession(s.id, e.currentTarget.value)}
        />
      ) : (
        <span className="title">{titleOf(s)}</span>
      )}
      {!renaming && <span className="meta">{relTime(s.modified)}</span>}
    </div>
  )
}

function GroupView({ g, pos }: { g: Group; pos: Map<string, number> }): ReactNode {
  const collapsed = useStore((s) => s.prefs.collapsed.includes(g.key))
  const searching = useStore((s) => s.query.trim().length > 0)
  const open = !collapsed || searching
  return (
    <div className="group">
      <div className={`group-head${open ? '' : ' collapsed'}`} title={g.title} onClick={() => toggleCollapsed(g.key)}>
        <ChevronDown size={12} className="chev" />
        <span className="name">{g.label}</span>
        <span className="acts" onClick={(e) => e.stopPropagation()}>
          {g.custom ? (
            <>
              <button className="icon-btn" title="Rename group" onClick={() => useStore.setState({ dialog: { kind: 'group', groupId: g.key.slice(2), name: g.label } })}>
                <Pencil size={12} />
              </button>
              <button className="icon-btn" title="Delete group (sessions go back to their projects)" onClick={() => deleteGroup(g.key.slice(2))}>
                <Trash2 size={12} />
              </button>
            </>
          ) : (
            <button className="icon-btn" title={`New session in ${g.label}`} onClick={() => newSessionScreen(g.cwd)}>
              <Plus size={13} />
            </button>
          )}
        </span>
      </div>
      {open && g.sessions.map((s) => <Row key={s.id} s={s} pos={pos.get(s.id)} />)}
      {open && g.sessions.length === 0 && <div className="row dim" style={{ fontSize: 12 }}>Empty — use “Move to group”</div>}
    </div>
  )
}

export function Sidebar({ onToggle }: { onToggle: () => void }): ReactNode {
  const sessions = useStore((s) => s.sessions)
  const prefs = useStore((s) => s.prefs)
  const query = useStore((s) => s.query)
  const home = useStore((s) => s.home)
  const ready = useStore((s) => s.ready)
  const model = useMemo(() => buildSidebar(sessions, prefs, query, home), [sessions, prefs, query, home])
  const pos = useMemo(() => new Map(model.flat.map((s, i) => [s.id, i])), [model])
  const showArchived = prefs.collapsed.includes('archived:open')

  return (
    <aside className="sidebar">
      <div className="side-top drag">
        <button className="icon-btn" title="Hide sidebar (⌘\\)" onClick={onToggle}>
          <PanelLeft size={16} />
        </button>
      </div>
      <label className="side-search">
        <Search size={14} />
        <input id="side-search" placeholder="Search" value={query} onChange={(e) => useStore.setState({ query: e.target.value })} onKeyDown={(e) => e.key === 'Escape' && useStore.setState({ query: '' })} />
        {!query && <kbd>⌘K</kbd>}
      </label>
      <button className="side-new" onClick={() => newSessionScreen()}>
        <Plus size={15} /> New session <kbd>⌘N</kbd>
      </button>
      <div className="side-list">
        {model.pinned.length > 0 && (
          <div className="group">
            <div className="group-head">
              <span className="name">Pinned</span>
            </div>
            {model.pinned.map((s) => (
              <Row key={s.id} s={s} pos={pos.get(s.id)} />
            ))}
          </div>
        )}
        {model.groups.map((g) => (
          <GroupView key={g.key} g={g} pos={pos} />
        ))}
        {ready && model.groups.length === 0 && model.pinned.length === 0 && <div className="empty-side">{query ? 'No sessions match' : 'No sessions yet'}</div>}
        {model.archived.length > 0 && (
          <div className="group">
            <div className={`group-head${showArchived ? '' : ' collapsed'}`} onClick={() => toggleCollapsed('archived:open')}>
              <ChevronDown size={12} className="chev" />
              <Archive size={12} />
              <span className="name">Archived</span>
              <span>{model.archived.length}</span>
            </div>
            {showArchived && model.archived.map((s) => <Row key={s.id} s={s} />)}
          </div>
        )}
      </div>
      <div className="side-foot">
        <div className="who">Clapi · omp</div>
        <button className="icon-btn" title="Import from Claude Code" onClick={() => useStore.setState({ dialog: { kind: 'settings', tab: 'import' } })}>
          <Download size={15} />
        </button>
        <button className="icon-btn" title="Accounts & login" onClick={() => useStore.setState({ dialog: { kind: 'settings', tab: 'accounts' } })}>
          <KeyRound size={15} />
        </button>
        <button className="icon-btn" title="Models & roles (⌘⇧I)" onClick={() => useStore.setState({ dialog: { kind: 'models', view: 'roles' } })}>
          <SlidersHorizontal size={15} />
        </button>
        <button className="icon-btn" title="Settings (⌘,)" onClick={() => useStore.setState({ dialog: { kind: 'settings', tab: 'accounts' } })}>
          <Settings size={15} />
        </button>
      </div>
    </aside>
  )
}
