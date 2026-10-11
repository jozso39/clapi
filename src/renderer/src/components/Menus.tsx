import { Check, ChevronRight } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { capitalize } from '../lib'
import {
  chooseThinking,
  forkSession,
  moveToGroup,
  move,
  reportError,
  sessionById,
  setArchived,
  setPinned,
  setUnread,
  useStore
} from '../store'

function Popover({ x, y, children, above = true, width }: { x: number; y: number; children: ReactNode; above?: boolean; width?: number }): ReactNode {
  const close = (): void => useStore.setState({ menu: null, ctx: null })
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        close()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])
  const style: React.CSSProperties = above
    ? { left: Math.min(x, window.innerWidth - (width ?? 260) - 12), bottom: window.innerHeight - y + 8 }
    : { left: Math.min(x, window.innerWidth - (width ?? 240) - 12), top: Math.min(y, window.innerHeight - 380) }
  return (
    <>
      <div className="scrim" onMouseDown={close} onContextMenu={(e) => (e.preventDefault(), close())} />
      <div className="pop" style={style}>
        {children}
      </div>
    </>
  )
}

export function EffortMenu({ x, y }: { x: number; y: number }): ReactNode {
  const levels = useStore((s) => s.levels)
  const id = useStore((s) => s.activeId)
  const cur = useStore((s) => (id ? s.runtime[id]?.thinkingLevel : s.newSession.thinking))
  const [sel, setSel] = useState(Math.max(0, levels.indexOf(cur ?? '')))
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        setSel((x) => (x + (e.key === 'ArrowDown' ? 1 : -1) + levels.length) % levels.length)
      } else if (e.key === 'Enter') {
        e.preventDefault()
        void chooseThinking(levels[sel])
      } else if (/^[1-9]$/.test(e.key) && levels[Number(e.key) - 1]) {
        e.preventDefault()
        void chooseThinking(levels[Number(e.key) - 1])
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [levels, sel])
  return (
    <Popover x={x} y={y} width={220}>
      <div className="menu-label">Thinking effort</div>
      {levels.map((l, i) => (
        <button key={l} className={`menu-item${i === sel ? ' on' : ''}`} onMouseEnter={() => setSel(i)} onClick={() => void chooseThinking(l)}>
          {capitalize(l)}
          {cur === l && <Check size={14} className="check" style={{ color: 'var(--accent)' }} />}
          <span className="k">{i + 1}</span>
        </button>
      ))}
    </Popover>
  )
}

function Item({ label, k, onClick, danger, children }: { label: string; k?: string; onClick?: () => void; danger?: boolean; children?: ReactNode }): ReactNode {
  return (
    <button
      className={`menu-item${danger ? ' danger' : ''}`}
      onClick={() => {
        if (!onClick) return
        useStore.setState({ ctx: null, menu: null })
        onClick()
      }}
    >
      {label}
      {children ? <ChevronRight size={13} className="k" /> : k ? <span className="k">{k}</span> : null}
      {children && <div className="pop submenu">{children}</div>}
    </button>
  )
}

/** The per-session menu: right-click in the sidebar, or the title dropdown. */
export function SessionMenu({ id }: { id: string }): ReactNode {
  const s = useStore((st) => st.sessions.find((x) => x.id === id))
  const prefs = useStore((st) => st.prefs)
  if (!s) return null
  const pinned = prefs.pinned.includes(id)
  const archived = prefs.archived.includes(id)
  const unread = prefs.unread.includes(id)
  const inGroup = prefs.groupOf[id]
  const openIn = (target: 'vscode' | 'terminal' | 'finder') => () => void window.clapi.sessions.openIn(target, s.cwd, s.id).catch(reportError)
  return (
    <>
      <Item label="Open in">
        <Item label="VS Code" onClick={openIn('vscode')} />
        <Item label="Terminal (omp --resume)" onClick={openIn('terminal')} />
        <Item label="Finder" onClick={openIn('finder')} />
      </Item>
      <div className="menu-sep" />
      <Item label={pinned ? 'Unpin' : 'Pin'} k="P" onClick={() => setPinned(id, !pinned)} />
      <Item label={unread ? 'Mark as read' : 'Mark as unread'} k="U" onClick={() => setUnread(id, !unread)} />
      <Item label="Rename" k="R" onClick={() => useStore.setState({ renaming: id })} />
      <Item label="Fork" k="F" onClick={() => void forkSession(id, null)} />
      <div className="menu-sep" />
      <Item label="Move up" onClick={() => move(id, -1)} />
      <Item label="Move down" onClick={() => move(id, 1)} />
      <Item label="Move to group">
        {prefs.customGroups.map((g) => (
          <Item key={g.id} label={inGroup === g.id ? `✓ ${g.name}` : g.name} onClick={() => moveToGroup(id, g.id)} />
        ))}
        {prefs.customGroups.length > 0 && <div className="menu-sep" />}
        <Item label="New group…" onClick={() => useStore.setState({ dialog: { kind: 'group', sessionId: id } })} />
        {inGroup && <Item label="Back to its project" onClick={() => moveToGroup(id, null)} />}
      </Item>
      <div className="menu-sep" />
      <Item label={archived ? 'Unarchive' : 'Archive'} k="A" onClick={() => setArchived(id, !archived)} />
      <Item label="Delete…" k="D" danger onClick={() => useStore.setState({ dialog: { kind: 'delete', id } })} />
    </>
  )
}

export function ContextMenu(): ReactNode {
  const ctx = useStore((s) => s.ctx)
  useEffect(() => {
    if (!ctx) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.metaKey || e.ctrlKey || e.altKey) return
      const id = ctx.id
      const st = useStore.getState()
      const act: Record<string, () => void> = {
        p: () => setPinned(id, !st.prefs.pinned.includes(id)),
        u: () => setUnread(id, !st.prefs.unread.includes(id)),
        r: () => useStore.setState({ renaming: id }),
        f: () => void forkSession(id, null),
        a: () => setArchived(id, !st.prefs.archived.includes(id)),
        d: () => useStore.setState({ dialog: { kind: 'delete', id } })
      }
      const fn = act[e.key.toLowerCase()]
      if (fn && sessionById(id)) {
        e.preventDefault()
        useStore.setState({ ctx: null })
        fn()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [ctx])
  if (!ctx) return null
  return (
    <Popover x={ctx.x} y={ctx.y} above={false}>
      <SessionMenu id={ctx.id} />
    </Popover>
  )
}
