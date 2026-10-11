import { useEffect, useState, type ReactNode } from 'react'
import { buildSidebar } from './lib'
import { abort, closeSession, cycleViewMode, forkSession, init, newSessionScreen, select, step, useStore } from './store'
import { Chat } from './components/Chat'
import { Composer } from './components/Composer'
import { AskDialog, DeleteDialog, GroupDialog, ShortcutsDialog, Toasts } from './components/Dialogs'
import { ContextMenu, EffortMenu } from './components/Menus'
import { ModelPanel } from './components/ModelPanel'
import { SettingsDialog } from './components/Settings'
import { Sidebar } from './components/Sidebar'
import { TopBar } from './components/TopBar'

function openMenuAt(kind: 'effort'): void {
  const btn = document.querySelector<HTMLElement>(`.composer-bar .bar-btn[data-menu="${kind}"]`)
  const r = btn?.getBoundingClientRect()
  useStore.setState({ menu: { kind, x: r?.left ?? window.innerWidth / 2 - 180, y: r?.top ?? window.innerHeight - 120 } })
}

export function App(): ReactNode {
  const activeId = useStore((s) => s.activeId)
  const dialog = useStore((s) => s.dialog)
  const menu = useStore((s) => s.menu)
  const ask = useStore((s) => (s.activeId ? s.views[s.activeId]?.asks[0] : undefined))
  const [scrolled, setScrolled] = useState(false)
  const [sidebarHidden, setSidebarHidden] = useState(false)

  useEffect(() => {
    void init()
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const st = useStore.getState()
      if (e.key === 'Alt' && !st.altHeld) useStore.setState({ altHeld: true })
      if (e.altKey && !e.metaKey && !e.ctrlKey && /^Digit[0-9]$/.test(e.code)) {
        const n = Number(e.code.slice(5))
        const target = buildSidebar(st.sessions, st.prefs, st.query, st.home).flat[n === 0 ? 9 : n - 1]
        e.preventDefault() // otherwise ⌥digit types ¡™£… into the composer
        if (target) select(target.id)
        return
      }
      const cmd = e.metaKey
      const k = e.key.toLowerCase()
      const take = (fn: () => void): void => {
        e.preventDefault()
        fn()
      }
      if (cmd && !e.shiftKey && k === 'n') return take(() => newSessionScreen())
      if (cmd && !e.shiftKey && k === 'w') return take(() => void closeSession())
      if (cmd && !e.shiftKey && k === 'k') {
        return take(() => {
          setSidebarHidden(false)
          setTimeout(() => document.getElementById('side-search')?.focus(), 0)
        })
      }
      if (cmd && k === '/') return take(() => useStore.setState({ dialog: { kind: 'shortcuts' } }))
      if (cmd && k === ',') return take(() => useStore.setState({ dialog: { kind: 'settings', tab: 'accounts' } }))
      if (cmd && k === '\\') return take(() => setSidebarHidden((h) => !h))
      if (e.ctrlKey && e.key === 'Tab') return take(() => step(e.shiftKey ? -1 : 1))
      if (cmd && e.shiftKey && (e.code === 'BracketRight' || e.code === 'BracketLeft')) return take(() => step(e.code === 'BracketRight' ? 1 : -1))
      if (cmd && e.shiftKey && k === 'i') return take(() => useStore.setState({ dialog: { kind: 'models', view: 'all' }, menu: null }))
      if (cmd && e.shiftKey && k === 'e') return take(() => openMenuAt('effort'))
      if (cmd && e.shiftKey && k === 'f' && st.activeId) return take(() => void forkSession(st.activeId!, null))
      if (cmd && e.shiftKey && k === 'r' && st.activeId) return take(() => useStore.setState({ titleEditing: true, renaming: null }))
      if (e.ctrlKey && !cmd && k === 'o') return take(cycleViewMode)
      if (cmd && !e.shiftKey && /^[1-9]$/.test(e.key)) {
        const pinned = buildSidebar(st.sessions, st.prefs, '', st.home).pinned
        const target = pinned[Number(e.key) - 1]
        if (target) return take(() => select(target.id))
      }
      if (e.key === 'Escape' && !st.menu && !st.ctx) {
        if (st.dialog) return take(() => useStore.setState({ dialog: null }))
        if (st.renaming || st.titleEditing) return take(() => useStore.setState({ renaming: null, titleEditing: false }))
        if (st.activeId && st.runtime[st.activeId]?.status === 'busy') return take(() => void abort())
      }
    }
    const onUp = (e: KeyboardEvent): void => {
      if (e.key === 'Alt') useStore.setState({ altHeld: false })
    }
    const onBlur = (): void => useStore.setState({ altHeld: false })
    window.addEventListener('keydown', onKey)
    window.addEventListener('keyup', onUp)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('keyup', onUp)
      window.removeEventListener('blur', onBlur)
    }
  }, [])

  return (
    <div className="app">
      {!sidebarHidden && <Sidebar onToggle={() => setSidebarHidden(true)} />}
      <main className="main">
        <TopBar scrolled={scrolled && !!activeId} sidebarHidden={sidebarHidden} onToggleSidebar={() => setSidebarHidden(false)} />
        {activeId ? (
          <>
            <Chat onScrolled={setScrolled} />
            <Composer />
          </>
        ) : (
          <div className="hero">
            <h1>
              <span className="mark">✻</span> What should we work on?
            </h1>
            <Composer />
          </div>
        )}
      </main>
      {menu?.kind === 'effort' && <EffortMenu x={menu.x} y={menu.y} />}
      <ContextMenu />
      {dialog?.kind === 'settings' && <SettingsDialog tab={dialog.tab} provider={dialog.provider} />}
      {dialog?.kind === 'models' && <ModelPanel view={dialog.view} role={dialog.role} />}
      {dialog?.kind === 'shortcuts' && <ShortcutsDialog />}
      {dialog?.kind === 'delete' && <DeleteDialog id={dialog.id} />}
      {dialog?.kind === 'group' && <GroupDialog sessionId={dialog.sessionId} groupId={dialog.groupId} name={dialog.name} />}
      {ask && activeId && !dialog && <AskDialog key={ask.id} sessionId={activeId} ask={ask} />}
      <Toasts />
    </div>
  )
}
