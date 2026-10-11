import { ChevronDown, Code2, FolderOpen, GitBranch, PanelLeft, SquareTerminal } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { basename, shortPath, titleOf } from '../lib'
import { forkSession, renameSession, reportError, useStore } from '../store'
import { SessionMenu } from './Menus'

export function TopBar({ scrolled, sidebarHidden, onToggleSidebar }: { scrolled: boolean; sidebarHidden: boolean; onToggleSidebar: () => void }): ReactNode {
  const id = useStore((s) => s.activeId)
  const s = useStore((st) => st.sessions.find((x) => x.id === id))
  const renaming = useStore((st) => st.titleEditing)
  const home = useStore((st) => st.home)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)

  return (
    <header className={`topbar drag${scrolled ? ' scrolled' : ''}`} style={sidebarHidden ? { paddingLeft: 88 } : undefined}>
      {sidebarHidden && (
        <button className="icon-btn" title="Show sidebar (⌘\\)" onClick={onToggleSidebar}>
          <PanelLeft size={16} />
        </button>
      )}
      {s ? (
        <>
          {renaming ? (
            <input
              className="title-input"
              autoFocus
              defaultValue={titleOf(s)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void renameSession(s.id, e.currentTarget.value)
                if (e.key === 'Escape') useStore.setState({ titleEditing: false })
              }}
              onBlur={(e) => void renameSession(s.id, e.currentTarget.value)}
            />
          ) : (
            <button
              className="title-btn"
              title="Session menu — double-click to rename"
              onDoubleClick={() => useStore.setState({ titleEditing: true })}
              onClick={(e) => {
                const r = e.currentTarget.getBoundingClientRect()
                setMenu({ x: r.left, y: r.bottom + 4 })
              }}
            >
              <span>{titleOf(s)}</span>
              <ChevronDown size={13} className="dim" />
            </button>
          )}
          <span className="chip" title={shortPath(s.cwd, home)}>
            {basename(s.cwd)}
          </span>
          {s.parentSession && <span className="crumb" title={s.parentSession}>forked</span>}
          <span className="spacer" />
          <button className="icon-btn" title="Fork this session" onClick={() => void forkSession(s.id, null)}>
            <GitBranch size={16} />
          </button>
          <button className="icon-btn" title="Open in Terminal (omp --resume)" onClick={() => void window.clapi.sessions.openIn('terminal', s.cwd, s.id).catch(reportError)}>
            <SquareTerminal size={16} />
          </button>
          <button className="icon-btn" title="Open in VS Code" onClick={() => void window.clapi.sessions.openIn('vscode', s.cwd, s.id).catch(reportError)}>
            <Code2 size={16} />
          </button>
          <button className="icon-btn" title="Show in Finder" onClick={() => void window.clapi.sessions.openIn('finder', s.cwd, s.id).catch(reportError)}>
            <FolderOpen size={16} />
          </button>
        </>
      ) : (
        <span className="spacer" />
      )}
      {menu && s && (
        <>
          <div className="scrim" onMouseDown={() => setMenu(null)} />
          <div className="pop" style={{ left: menu.x, top: menu.y }} onClick={() => setMenu(null)}>
            <SessionMenu id={s.id} />
          </div>
        </>
      )}
    </header>
  )
}
