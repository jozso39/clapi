import { AlertTriangle, ChevronRight, GitBranch, PencilLine, X } from 'lucide-react'
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { AssistantPartial, ChatItem, Prefs } from '../../../shared/types'
import { clockTime, elapsed, toolSummary } from '../lib'
import { forkSession, loadTranscript, newSessionScreen, sessionById, useStore, type LiveTool } from '../store'
import { CopyButton, Markdown } from './Markdown'

type UserItem = Extract<ChatItem, { kind: 'user' }>
type ToolResultItem = Extract<ChatItem, { kind: 'toolResult' }>

interface Call {
  id: string
  name: string
  args: Record<string, unknown>
  intent?: string
}

type Node =
  | { k: 'text'; text: string }
  | { k: 'thinking'; text: string }
  | { k: 'tools'; calls: Call[] }
  | { k: 'notice'; text: string; level: 'info' | 'warning' | 'error' }
  | { k: 'compaction'; text: string }
  | { k: 'error'; text: string }

interface Turn {
  key: string
  user?: UserItem
  /** Entry to fork at for "Edit in a new session": the one before the user message. */
  userParent?: string | null
  nodes: Node[]
  finalEntryId?: string
  finalText: string
  ts: number
}

function pushCall(nodes: Node[], call: Call): void {
  const last = nodes[nodes.length - 1]
  if (last?.k === 'tools') last.calls.push(call)
  else nodes.push({ k: 'tools', calls: [call] })
}

function buildTurns(items: ChatItem[], start: number, mode: Prefs['viewMode']): { turns: Turn[]; results: Map<string, ToolResultItem> } {
  const turns: Turn[] = []
  const results = new Map<string, ToolResultItem>()
  let cur: Turn | null = null
  let lastEntry: string | null | undefined = start === 0 ? null : undefined
  items.forEach((item, i) => {
    if (item.kind === 'toolResult') {
      results.set(item.toolCallId, item)
    } else if (item.kind === 'user') {
      cur = { key: item.entryId ?? `u${i}`, user: item, userParent: lastEntry, nodes: [], finalText: '', ts: item.timestamp }
      turns.push(cur)
    } else {
      // Nodes this view mode hides must not open an (empty, invisible) turn.
      const hidden =
        (item.kind === 'notice' && mode !== 'verbose' && item.text.startsWith('Model →')) ||
        (item.kind === 'assistant' && mode === 'normal' && item.blocks.every((b) => b.type === 'thinking') && !item.errorMessage && item.stopReason !== 'error' && item.stopReason !== 'aborted')
      if (hidden) {
        if (item.entryId) lastEntry = item.entryId
        return
      }
      if (!cur) {
        cur = { key: item.entryId ?? `t${i}`, nodes: [], finalText: '', ts: item.timestamp }
        turns.push(cur)
      }
      const t: Turn = cur
      if (item.kind === 'assistant') {
        let hasText = false
        let hasCall = false
        for (const b of item.blocks) {
          if (b.type === 'text' && b.text.trim()) {
            t.nodes.push({ k: 'text', text: b.text })
            hasText = true
          } else if (b.type === 'thinking') t.nodes.push({ k: 'thinking', text: b.thinking })
          else if (b.type === 'toolCall') {
            pushCall(t.nodes, { id: b.id, name: b.name, args: b.arguments, intent: b.intent })
            hasCall = true
          }
        }
        if (item.stopReason === 'aborted') t.nodes.push({ k: 'notice', text: 'Interrupted', level: 'warning' })
        else if (item.errorMessage || item.stopReason === 'error') t.nodes.push({ k: 'error', text: item.errorMessage || 'The provider returned an error.' })
        // Only a turn-final answer is a clean fork point: forking after a tool
        // call but before its result would leave the call unanswered.
        if (hasText && !hasCall) {
          t.finalEntryId = item.entryId
          t.finalText = item.blocks.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('\n\n')
        }
        t.ts = item.timestamp || t.ts
      } else if (item.kind === 'notice') t.nodes.push({ k: 'notice', text: item.text, level: item.level })
      else if (item.kind === 'compaction') t.nodes.push({ k: 'compaction', text: item.summary })
    }
    if (item.entryId) lastEntry = item.entryId
  })
  return { turns, results }
}

const PLURAL: Record<string, [string, string]> = {
  Ran: ['command', 'commands'],
  Read: ['file', 'files'],
  Edited: ['file', 'files'],
  Wrote: ['file', 'files'],
  Searched: ['time', 'times'],
  Fetched: ['page', 'pages'],
  Delegated: ['task', 'tasks']
}

function groupLabel(calls: Call[]): string {
  if (calls.length === 1) {
    if (calls[0].intent) return calls[0].intent
    const { verb, arg } = toolSummary(calls[0].name, calls[0].args, calls[0].intent)
    return arg ? `${verb} ${arg.split('\n')[0]}` : verb
  }
  const counts = new Map<string, number>()
  for (const c of calls) {
    const { verb } = toolSummary(c.name, c.args, c.intent)
    counts.set(verb, (counts.get(verb) ?? 0) + 1)
  }
  return [...counts.entries()]
    .map(([verb, n], i) => {
      const noun = PLURAL[verb]
      const v = i === 0 ? verb : verb.toLowerCase()
      return noun ? `${v} ${n} ${n === 1 ? noun[0] : noun[1]}` : `${v} ×${n}`
    })
    .join(', ')
}

function ToolGroup({ calls, results, live, open: defaultOpen }: { calls: Call[]; results: Map<string, ToolResultItem>; live: Record<string, LiveTool>; open: boolean }): ReactNode {
  const [open, setOpen] = useState(defaultOpen)
  useEffect(() => setOpen(defaultOpen), [defaultOpen])
  const running = calls.find((c) => live[c.id] && !live[c.id].done) ?? calls.find((c) => !results.has(c.id) && live[c.id])
  const failed = calls.some((c) => results.get(c.id)?.isError || live[c.id]?.isError)
  return (
    <div className={`tools${open ? ' open' : ''}`}>
      <button className="tools-head" onClick={() => setOpen(!open)}>
        {running ? <span className="spinner" /> : failed ? <AlertTriangle size={13} className="warn" /> : null}
        <span className="label">{groupLabel(calls)}</span>
        <ChevronRight size={14} className="chev" />
      </button>
      {open && (
        <div className="tool-list">
          {calls.map((c) => {
            const r = results.get(c.id)
            const l = live[c.id]
            const { arg } = toolSummary(c.name, c.args, c.intent)
            return (
              <div className="tool" key={c.id}>
                <div className="tool-line">
                  <span className="name">{c.name}</span>
                  <span className="arg" title={arg}>
                    {arg.split('\n')[0]}
                  </span>
                  <span className="state">{l && !l.done ? <span className="spinner" /> : r?.isError ? <X size={13} className="err" /> : null}</span>
                </div>
                {c.intent && <div className="dim" style={{ fontSize: 12.5, margin: '0 0 4px' }}>{c.intent}</div>}
                {r && r.text && (
                  <div className={`tool-out${r.isError ? ' error' : ''}`}>
                    {r.text}
                    {r.truncated ? '\n…' : ''}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

function Notice({ text, level }: { text: string; level: 'info' | 'warning' | 'error' }): ReactNode {
  const [open, setOpen] = useState(false)
  const long = text.length > 160 || text.includes('\n')
  if (!long) return <div className={`notice ${level}`}>{text}</div>
  const first = text.replace(/<[^>]+>/g, ' ').trim().split('\n')[0].slice(0, 140)
  return (
    <div className={`tools${open ? ' open' : ''}`}>
      <button className={`tools-head ${level === 'info' ? '' : level}`} onClick={() => setOpen(!open)}>
        <span className="label">{first || 'Notice'}</span>
        <ChevronRight size={14} className="chev" />
      </button>
      {open && <div className="tool-out">{text}</div>}
    </div>
  )
}

function Thinking({ text }: { text: string }): ReactNode {
  const [full, setFull] = useState(false)
  const long = text.length > 600
  return (
    <div className={`thinking${long && !full ? ' clipped' : ''}`} onClick={() => long && setFull(!full)}>
      {text}
    </div>
  )
}

function Nodes({ nodes, results, live, mode }: { nodes: Node[]; results: Map<string, ToolResultItem>; live: Record<string, LiveTool>; mode: Prefs['viewMode'] }): ReactNode {
  return (
    <>
      {nodes.map((n, i) => {
        switch (n.k) {
          case 'text':
            return <Markdown key={i} text={n.text} />
          case 'thinking':
            return mode === 'normal' ? null : <Thinking key={i} text={n.text} />
          case 'tools':
            return <ToolGroup key={i} calls={n.calls} results={results} live={live} open={mode === 'verbose'} />
          case 'notice':
            if (mode !== 'verbose' && n.text.startsWith('Model →')) return null
            return <Notice key={i} text={n.text} level={n.level} />
          case 'compaction':
            return (
              <div key={i} className="compaction" title={n.text}>
                Context compacted
              </div>
            )
          case 'error':
            return (
              <div key={i} className="err-box">
                {n.text}
              </div>
            )
        }
      })}
    </>
  )
}

const History = memo(function History({
  sessionId,
  items,
  start,
  live,
  mode
}: {
  sessionId: string
  items: ChatItem[]
  start: number
  live: Record<string, LiveTool>
  mode: Prefs['viewMode']
}) {
  const { turns, results } = useMemo(() => buildTurns(items, start, mode), [items, start, mode])
  return (
    <>
      {turns.map((t) => (
        <div key={t.key}>
          {t.user && (
            <div className="msg-user">
              <div className="bubble">
                {t.user.text}
                {t.user.images > 0 && <div className="dim" style={{ fontSize: 12, marginTop: 4 }}>{t.user.images === 1 ? '1 image' : `${t.user.images} images`}</div>}
              </div>
              <div className="msg-actions">
                <span className="when">{clockTime(t.user.timestamp)}</span>
                <CopyButton text={t.user.text} tip />
                {t.userParent !== undefined && (
                  <button
                    className="icon-btn"
                    data-tip="Edit in a new session"
                    onClick={() => {
                      if (t.userParent) void forkSession(sessionId, t.userParent, t.user!.text)
                      else {
                        newSessionScreen(sessionById(sessionId)?.cwd)
                        useStore.setState((s) => ({ drafts: { ...s.drafts, new: t.user!.text } }))
                      }
                    }}
                  >
                    <PencilLine size={14} />
                  </button>
                )}
              </div>
            </div>
          )}
          {t.nodes.length > 0 && (
            <div className="turn">
              <div className="msg-assistant">
                <Nodes nodes={t.nodes} results={results} live={live} mode={mode} />
              </div>
              {t.finalEntryId && (
                <div className="msg-actions">
                  <CopyButton text={t.finalText} tip />
                  <button className="icon-btn" data-tip="Fork from here" aria-label="Fork from here" onClick={() => void forkSession(sessionId, t.finalEntryId!)}>
                    <GitBranch size={14} className="flip-y" />
                  </button>
                  <span className="when">{clockTime(t.ts)}</span>
                </div>
              )}
            </div>
          )}
        </div>
      ))}
    </>
  )
})

function Partial({ partial, live, mode }: { partial: AssistantPartial; live: Record<string, LiveTool>; mode: Prefs['viewMode'] }): ReactNode {
  const nodes: Node[] = []
  for (const b of partial.blocks) {
    if (b.type === 'text' && b.text) nodes.push({ k: 'text', text: b.text })
    else if (b.type === 'thinking') nodes.push({ k: 'thinking', text: b.thinking })
    else if (b.type === 'toolCall') pushCall(nodes, { id: b.id, name: b.name, args: b.arguments, intent: b.intent })
  }
  return (
    <div className="msg-assistant">
      <Nodes nodes={nodes} results={new Map()} live={live} mode={mode} />
    </div>
  )
}

function Working({ since, live, partial }: { since: number; live: Record<string, LiveTool>; partial: AssistantPartial | null }): ReactNode {
  const [, tick] = useState(0)
  useEffect(() => {
    const t = setInterval(() => tick((x) => x + 1), 1000)
    return () => clearInterval(t)
  }, [])
  const running = Object.values(live).find((l) => !l.done)
  let label = 'Thinking…'
  if (running) {
    const { verb, arg } = toolSummary(running.name, running.args, running.intent)
    label = `${verb === 'Ran' ? 'Running' : verb === 'Read' ? 'Reading' : verb === 'Edited' ? 'Editing' : verb} ${arg.split('\n')[0]}`.trim()
  } else if (partial?.blocks.some((b) => b.type === 'text' && b.text)) label = 'Writing…'
  return (
    <div className="working">
      <span className="sparkle">✻</span>
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
      <span className="dim">· {elapsed(since)}</span>
    </div>
  )
}

export function Chat({ onScrolled }: { onScrolled: (scrolled: boolean) => void }): ReactNode {
  const id = useStore((s) => s.activeId)!
  const v = useStore((s) => s.views[id])
  const mode = useStore((s) => s.prefs.viewMode)
  const status = useStore((s) => s.runtime[id]?.status)
  const ref = useRef<HTMLDivElement>(null)
  const stick = useRef(true)

  useLayoutEffect(() => {
    stick.current = true
    const el = ref.current
    if (el) el.scrollTop = el.scrollHeight
  }, [id])

  useLayoutEffect(() => {
    const el = ref.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  })

  if (!v) return <div className="chat" ref={ref} />
  const busy = v.busySince !== null && status !== 'exited' && status !== 'error'

  return (
    <div
      className="chat"
      ref={ref}
      onScroll={(e) => {
        const el = e.currentTarget
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
        onScrolled(el.scrollTop > 4)
      }}
    >
      <div className="column">
        {v.start > 0 && (
          <div className="earlier">
            <button className="btn sm ghost" onClick={() => void loadTranscript(id, true)}>
              Show {Math.min(400, v.start)} earlier messages
            </button>
          </div>
        )}
        {!v.loaded && v.loading && <div className="working dim">Loading…</div>}
        <History sessionId={id} items={v.items} start={v.start} live={v.live} mode={mode} />
        {v.pending.map((p, i) => (
          <div className="msg-user" key={`p${i}`}>
            <div className="bubble pending">{p}</div>
          </div>
        ))}
        {v.partial && <Partial partial={v.partial} live={v.live} mode={mode} />}
        {busy && <Working since={v.busySince!} live={v.live} partial={v.partial} />}
      </div>
    </div>
  )
}
