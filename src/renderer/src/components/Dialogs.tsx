import { AlertTriangle, Info, X } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import type { UiRequest } from '../../../shared/types'
import { titleOf } from '../lib'
import { answerAsk, createGroup, deleteSession, renameGroup, sessionById, useStore } from '../store'

function Modal({ title, children, foot, onClose }: { title: ReactNode; children: ReactNode; foot?: ReactNode; onClose: () => void }): ReactNode {
  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <div className="modal-head">
          <h2>{title}</h2>
          <button className="icon-btn" onClick={onClose} title="Close (Esc)">
            <X size={16} />
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {foot && <div className="modal-foot">{foot}</div>}
      </div>
    </div>
  )
}

/** omp asking the user something mid-turn (tool approval, a question, a URL). */
export function AskDialog({ sessionId, ask }: { sessionId: string; ask: UiRequest }): ReactNode {
  const [value, setValue] = useState(ask.prefill ?? '')
  const [sel, setSel] = useState(0)
  const cancel = (): void => void answerAsk(sessionId, ask, { cancelled: true })
  const pick = (o: string): void => void answerAsk(sessionId, ask, { value: o })

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (ask.method !== 'select' || !ask.options) return
      if (/^[1-9]$/.test(e.key) && ask.options[Number(e.key) - 1] && (e.target as HTMLElement).tagName !== 'INPUT') {
        e.preventDefault()
        pick(ask.options[Number(e.key) - 1])
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        setSel((x) => (x + (e.key === 'ArrowDown' ? 1 : -1) + ask.options!.length) % ask.options!.length)
      } else if (e.key === 'Enter') {
        e.preventDefault()
        pick(ask.options[sel])
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const s = sessionById(sessionId)
  const title = ask.method === 'open_url' ? 'omp wants to open a link' : ask.title || 'omp needs your input'
  return (
    <Modal title={title} onClose={cancel}>
      {s && <div className="dim" style={{ fontSize: 12, marginBottom: 8 }}>{titleOf(s)}</div>}
      {ask.message && <div style={{ whiteSpace: 'pre-wrap', marginBottom: 10 }}>{ask.message}</div>}
      {ask.method === 'select' &&
        ask.options?.map((o, i) => (
          <button key={o} className={`opt${i === sel ? ' on' : ''}`} onMouseEnter={() => setSel(i)} onClick={() => pick(o)}>
            <kbd>{i < 9 ? i + 1 : ''}</kbd>
            <span>{o}</span>
          </button>
        ))}
      {ask.method === 'confirm' && (
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 8 }}>
          <button className="btn" onClick={() => void answerAsk(sessionId, ask, { confirmed: false })}>
            No
          </button>
          <button className="btn primary" autoFocus onClick={() => void answerAsk(sessionId, ask, { confirmed: true })}>
            Yes
          </button>
        </div>
      )}
      {(ask.method === 'input' || ask.method === 'editor') && (
        <>
          {ask.method === 'editor' ? (
            <textarea className="field" autoFocus value={value} onChange={(e) => setValue(e.target.value)} />
          ) : (
            <input className="field" autoFocus placeholder={ask.placeholder} value={value} onChange={(e) => setValue(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && pick(value)} />
          )}
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 10 }}>
            <button className="btn ghost" onClick={cancel}>
              Cancel
            </button>
            <button className="btn primary" onClick={() => pick(value)}>
              Submit
            </button>
          </div>
        </>
      )}
      {ask.method === 'open_url' && (
        <>
          {ask.instructions && <div className="dim" style={{ marginBottom: 8 }}>{ask.instructions}</div>}
          <div className="mono dim" style={{ fontSize: 12, wordBreak: 'break-all' }}>{ask.url}</div>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 12 }}>
            <button className="btn ghost" onClick={cancel}>
              Not now
            </button>
            <button
              className="btn primary"
              onClick={() => {
                void window.clapi.app.openExternal(ask.launchUrl || ask.url!)
                void answerAsk(sessionId, ask, { confirmed: true })
              }}
            >
              Open in browser
            </button>
          </div>
        </>
      )}
    </Modal>
  )
}

export function DeleteDialog({ id }: { id: string }): ReactNode {
  const s = sessionById(id)
  const close = (): void => useStore.setState({ dialog: null })
  if (!s) return null
  return (
    <Modal
      title="Delete session"
      onClose={close}
      foot={
        <>
          <button className="btn ghost" onClick={close}>
            Cancel
          </button>
          <button className="btn danger" autoFocus onClick={() => void deleteSession(id)}>
            Delete
          </button>
        </>
      }
    >
      <p style={{ marginTop: 0 }}>
        Delete <b>{titleOf(s)}</b>?
      </p>
      <p className="dim" style={{ fontSize: 13 }}>
        This removes its transcript from <span className="mono">~/.omp/agent/sessions</span> — omp can’t open it again. Archive it instead to just hide it.
      </p>
    </Modal>
  )
}

export function GroupDialog({ sessionId, groupId, name }: { sessionId?: string; groupId?: string; name?: string }): ReactNode {
  const [value, setValue] = useState(name ?? '')
  const close = (): void => useStore.setState({ dialog: null })
  const save = (): void => {
    if (!value.trim()) return
    if (groupId) renameGroup(groupId, value.trim())
    else createGroup(value, sessionId)
    close()
  }
  return (
    <Modal
      title={groupId ? 'Rename group' : 'New group'}
      onClose={close}
      foot={
        <>
          <button className="btn ghost" onClick={close}>
            Cancel
          </button>
          <button className="btn primary" disabled={!value.trim()} onClick={save}>
            {groupId ? 'Rename' : 'Create'}
          </button>
        </>
      }
    >
      <input className="field" autoFocus placeholder="Group name" value={value} onChange={(e) => setValue(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && save()} />
      <p className="dim" style={{ fontSize: 12.5, marginBottom: 0 }}>
        Groups live in Clapi only; omp never sees them.
      </p>
    </Modal>
  )
}

const SHORTCUTS: [string, string][] = [
  ['Show keyboard shortcuts', '⌘ /'],
  ['New session', '⌘ N'],
  ['Close session (stops its agent)', '⌘ W'],
  ['Next / previous session', '⌃ Tab  ·  ⌃ ⇧ Tab'],
  ['Next / previous session', '⌘ ⇧ ]  ·  ⌘ ⇧ ['],
  ['Jump to pinned session', '⌘ 1 … 9'],
  ['Search sessions', '⌘ K'],
  ['Stop the response', 'Esc'],
  ['Cycle view: Normal / Thinking / Verbose', '⌃ O'],
  ['Model menu', '⌘ ⇧ I'],
  ['Thinking effort menu', '⌘ ⇧ E'],
  ['Pick an item in an open menu', '1 … 9'],
  ['Fork this session', '⌘ ⇧ F'],
  ['Rename this session', '⌘ ⇧ R'],
  ['Toggle sidebar', '⌘ \\'],
  ['Settings (accounts, roles, import)', '⌘ ,'],
  ['Send  ·  new line', 'Enter  ·  ⇧ Enter'],
  ['In the session menu: Pin, Unread, Rename, Fork, Archive, Delete', 'P U R F A D']
]

export function ShortcutsDialog(): ReactNode {
  const close = (): void => useStore.setState({ dialog: null })
  return (
    <Modal title="Keyboard shortcuts" onClose={close}>
      <div className="shortcut-grid">
        {SHORTCUTS.map(([what, keys], i) => (
          <div key={i} style={{ display: 'contents' }}>
            <span>{what}</span>
            <kbd>{keys}</kbd>
          </div>
        ))}
      </div>
    </Modal>
  )
}

export function Toasts(): ReactNode {
  const toasts = useStore((s) => s.toasts)
  return (
    <div className="toasts">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.level}`}>
          {t.level === 'info' ? <Info size={15} className="dim" style={{ flex: 'none', marginTop: 2 }} /> : <AlertTriangle size={15} className={t.level === 'error' ? 'err' : 'warn'} style={{ flex: 'none', marginTop: 2 }} />}
          <span style={{ flex: 1 }}>{t.text}</span>
          <button className="icon-btn" style={{ width: 20, height: 20 }} onClick={() => useStore.setState((s) => ({ toasts: s.toasts.filter((x) => x.id !== t.id) }))}>
            <X size={12} />
          </button>
        </div>
      ))}
    </div>
  )
}
