// The model panel: omp's /model screen as a window. Left: Roles, All models,
// providers (logged in, then the rest). Right: kind filter, search, the model
// table, and a detail line. Picking a model opens the assign step: thinking
// effort, which roles use it, and whether this session switches now.
import { Check, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { LoginProvider, ModelInfo, ModelRoles } from '../../../shared/types'
import { capitalize } from '../lib'
import { JEV, ROLES, fmtCtx, fmtPrice, fmtSpeed, isJev, keyOf, roleName, splitRole, thinkingChoices } from '../roles'
import { applyModelChoice, reportError, toast, useStore } from '../store'

const api = window.clapi

type Kind = 'all' | 'reasoning' | 'vision' | 'judge'
const KINDS: Kind[] = ['all', 'reasoning', 'vision', 'judge']
const PROVIDER_ORDER = ['anthropic', 'openai-codex', 'openai', 'google-gemini-cli', 'google-antigravity', 'google', 'typesafe', 'openrouter']

interface Row {
  value: string
  provider: string
  id: string
  name: string
  model?: ModelInfo
  jevNote?: string
}

interface Assign {
  row: Row
  level: string
  roles: Set<string>
  switchSession: boolean
}

const version = (name: string): number => parseFloat(/(\d+(?:\.\d+)?)/.exec(name)?.[1] ?? '0')

export function ModelPanel({ view: initialView, role: initialRole }: { view: 'all' | 'roles'; role?: string }): ReactNode {
  const models = useStore((s) => s.models)
  const perf = useStore((s) => s.perf)
  const activeId = useStore((s) => s.activeId)
  const current = useStore((s) => (s.activeId ? s.runtime[s.activeId]?.model : s.newSession.model))
  const [view, setView] = useState<string>(initialView) // 'all' | 'roles' | provider id
  const [kind, setKind] = useState<Kind>(initialRole === 'judge' ? 'judge' : 'all')
  const [targetRole, setTargetRole] = useState<string | null>(initialRole ?? null)
  const [q, setQ] = useState('')
  const [sel, setSel] = useState(0)
  const [assign, setAssign] = useState<Assign | null>(null)
  const [roles, setRoles] = useState<ModelRoles>({})
  const [providers, setProviders] = useState<LoginProvider[]>([])
  const [busy, setBusy] = useState(false)
  const searchRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const close = (): void => useStore.setState({ dialog: null })

  const reloadRoles = (): Promise<void> => api.roles.get().then(setRoles, reportError)
  useEffect(() => {
    void reloadRoles()
    api.auth.providers().then(setProviders, () => undefined)
  }, [])

  // Which roles point at a given "provider/id" (thinking suffix ignored).
  const rolesByModel = useMemo(() => {
    const m = new Map<string, string[]>()
    for (const [role, value] of Object.entries(roles)) {
      const { model } = splitRole(value)
      m.set(model, [...(m.get(model) ?? []), role])
    }
    return m
  }, [roles])

  const authed = useMemo(() => new Set(providers.filter((p) => p.authenticated).map((p) => p.id)), [providers])
  const counts = useMemo(() => {
    const c = new Map<string, number>()
    for (const m of models) c.set(m.provider, (c.get(m.provider) ?? 0) + 1)
    return c
  }, [models])
  const liveProviders = [...counts.keys()].sort((a, b) => (PROVIDER_ORDER.indexOf(a) + 99) % 99 - (PROVIDER_ORDER.indexOf(b) + 99) % 99 || a.localeCompare(b))
  const otherProviders = providers.filter((p) => !counts.has(p.id)).sort((a, b) => Number(b.authenticated) - Number(a.authenticated) || a.id.localeCompare(b.id))
  const currentValue = current ? `${current.provider}/${current.id}` : ''

  const { rows, inUseCount } = useMemo(() => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean)
    const hit = (r: Row) => words.every((w) => `${r.value} ${r.name}`.toLowerCase().includes(w))
    let list: Row[]
    if (kind === 'judge') {
      list = JEV.map((j) => {
        const slash = j.value.indexOf('/')
        return { value: j.value, provider: j.value.slice(0, slash), id: j.value.slice(slash + 1), name: j.name, jevNote: j.note }
      })
    } else {
      list = models
        .filter((m) => (view === 'all' || view === 'roles' ? true : m.provider === view))
        .filter((m) => (kind === 'reasoning' ? m.reasoning : kind === 'vision' ? m.vision : true))
        .map((m) => ({ value: keyOf(m), provider: m.provider, id: m.id, name: m.name, model: m }))
    }
    list = list.filter(hit)
    const rank = (r: Row) => (PROVIDER_ORDER.indexOf(r.provider) + 99) % 99
    list.sort((a, b) => rank(a) - rank(b) || a.provider.localeCompare(b.provider) || version(b.name) - version(a.name) || a.name.localeCompare(b.name))
    if (q || kind === 'judge') return { rows: list, inUseCount: 0 }
    // Like omp: what you use (roles, this session, measured) first, then everything.
    const used = (r: Row) => r.value === currentValue || rolesByModel.has(r.value) || !!perf[r.value]
    const top = list.filter(used)
    return { rows: [...top, ...list.filter((r) => !used(r))], inUseCount: top.length }
  }, [models, view, kind, q, rolesByModel, perf, currentValue])

  useEffect(() => setSel(0), [q, kind, view])
  useEffect(() => {
    listRef.current?.querySelector('.mp-row.on')?.scrollIntoView({ block: 'nearest' })
  }, [sel])

  const openAssign = (row: Row): void => {
    const jev = isJev(row.value)
    const chosen = targetRole ? [targetRole] : jev ? ['judge'] : ['default']
    const existing = targetRole ? splitRole(roles[targetRole]) : { model: '', level: '' }
    setAssign({
      row,
      level: existing.model === row.value ? existing.level || 'inherit' : 'inherit',
      roles: new Set(chosen),
      switchSession: !jev && !targetRole
    })
  }

  const apply = async (): Promise<void> => {
    if (!assign) return
    if (assign.roles.size === 0 && !assign.switchSession) return toast('info', 'Pick at least one role, or switch this session')
    setBusy(true)
    try {
      await applyModelChoice({
        value: assign.row.value,
        name: assign.row.name,
        level: assign.level,
        roles: [...assign.roles],
        switchSession: assign.switchSession
      })
      close()
    } catch (err) {
      reportError(err)
      setBusy(false)
    }
  }

  const clearRole = async (role: string): Promise<void> => {
    const next = { ...roles }
    delete next[role]
    try {
      setRoles(await api.roles.set(next))
    } catch (err) {
      reportError(err)
    }
  }

  // keyboard: ↑↓ move, Enter pick/apply, Esc back/close, Tab cycles kind
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        if (assign) setAssign(null)
        else close()
        return
      }
      if (assign) {
        if (e.key === 'Enter') {
          e.preventDefault()
          void apply()
        }
        return
      }
      if (view === 'roles') {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault()
          setSel((x) => Math.max(0, Math.min(ROLES.length - 1, x + (e.key === 'ArrowDown' ? 1 : -1))))
        } else if (e.key === 'Enter') {
          e.preventDefault()
          pickRole(ROLES[sel].id)
        }
        return
      }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        setSel((x) => Math.max(0, Math.min(rows.length - 1, x + (e.key === 'ArrowDown' ? 1 : -1))))
      } else if (e.key === 'Enter' && rows[sel]) {
        e.preventDefault()
        openAssign(rows[sel])
      } else if (e.key === 'Tab') {
        e.preventDefault()
        setKind((k) => KINDS[(KINDS.indexOf(k) + (e.shiftKey ? KINDS.length - 1 : 1)) % KINDS.length])
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  })

  const pickRole = (role: string): void => {
    setTargetRole(role)
    setKind(role === 'judge' ? 'judge' : 'all')
    setView('all')
    setQ('')
    setTimeout(() => searchRef.current?.focus(), 0)
  }

  const highlighted = view !== 'roles' ? rows[sel] : undefined
  const assignedRoles = Object.keys(roles).length
  const title = view === 'roles' ? 'Roles' : targetRole ? `Choose a model for ${roleName(targetRole)}` : view === 'all' ? 'All available models' : view

  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="modal mp">
        <aside className="mp-side">
          <div className="mp-head">Models</div>
          <button className={`mp-nav${view === 'roles' ? ' on' : ''}`} onClick={() => (setView('roles'), setTargetRole(null), setSel(0))}>
            <span>Roles</span>
            <span className="n">
              {assignedRoles}/{ROLES.length}
            </span>
          </button>
          <button className={`mp-nav${view === 'all' ? ' on' : ''}`} onClick={() => setView('all')}>
            <span>All models</span>
            <span className="n">{models.length}</span>
          </button>
          <div className="mp-sep" />
          {liveProviders.map((p) => (
            <button key={p} className={`mp-nav${view === p ? ' on' : ''}`} onClick={() => setView(p)}>
              <span className="pdot on" />
              <span className="pn">{p}</span>
              <span className="n">{counts.get(p)}</span>
            </button>
          ))}
          <div className="mp-sep" />
          {otherProviders.map((p) => (
            <button
              key={p.id}
              className="mp-nav off"
              title={p.authenticated ? `${p.name} — credentials found, no chat models listed` : `Log in to ${p.name}`}
              onClick={() => useStore.setState({ dialog: { kind: 'settings', tab: 'accounts', provider: p.authenticated ? undefined : p.id } })}
            >
              <span className={`pdot${p.authenticated ? ' on' : ''}`} />
              <span className="pn">{p.id}</span>
              {!p.authenticated && <span className="n login">log in</span>}
            </button>
          ))}
        </aside>

        <section className="mp-main">
          <div className="mp-top">
            <div className="mp-title">{title}</div>
            <button className="icon-btn" onClick={close} title="Close (Esc)">
              <X size={16} />
            </button>
          </div>

          {view === 'roles' ? (
            <div className="mp-list" ref={listRef}>
              {ROLES.map((r, i) => {
                const { model, level } = splitRole(roles[r.id])
                const info = models.find((m) => keyOf(m) === model)
                const jev = JEV.find((j) => j.value === model)
                const provider = model.split('/')[0]
                const missing = model && !authed.has(provider) && providers.length > 0
                return (
                  <div key={r.id} className={`mp-role${i === sel ? ' on' : ''}`} onMouseEnter={() => setSel(i)} onClick={() => pickRole(r.id)}>
                    <span className="rn">{r.name}</span>
                    <span className="rd">{r.desc}</span>
                    <span className="rv">
                      {model ? (
                        <>
                          <span className="dim">{provider}/</span>
                          {model.slice(provider.length + 1)}
                          {level && <span className="lvl">{level}</span>}
                          {(info || jev) && <span className="dim"> · {info?.name ?? jev?.name}</span>}
                          {missing && <span className="warn"> · {provider} not logged in</span>}
                        </>
                      ) : (
                        <span className="dim">not set — uses the default</span>
                      )}
                    </span>
                    {model && (
                      <button
                        className="icon-btn"
                        title="Clear this role"
                        onClick={(e) => {
                          e.stopPropagation()
                          void clearRole(r.id)
                        }}
                      >
                        <X size={13} />
                      </button>
                    )}
                  </div>
                )
              })}
              <p className="hint" style={{ padding: '10px 12px' }}>
                Enter or click a role to choose its model. These are omp’s <span className="mono">modelRoles</span> in <span className="mono">~/.omp/agent/config.yml</span> — your terminal omp uses the same.
              </p>
            </div>
          ) : (
            <>
              <div className="mp-kinds">
                <span className="dim">Kind:</span>
                {KINDS.map((k) => (
                  <button key={k} className={`mp-kind${kind === k ? ' on' : ''}`} onClick={() => setKind(k)}>
                    {k}
                  </button>
                ))}
                <span className="dim mp-tabhint">Tab ⇥</span>
              </div>
              <input ref={searchRef} className="mp-search" autoFocus placeholder="Type to search" value={q} onChange={(e) => setQ(e.target.value)} />
              <div className="mp-list" ref={listRef}>
                {rows.map((r, i) => {
                  const m = r.model
                  const usedBy = rolesByModel.get(r.value)
                  return (
                    <div key={r.value}>
                      {i === inUseCount && inUseCount > 0 && <div className="mp-divider" />}
                      <div className={`mp-row${i === sel ? ' on' : ''}`} onMouseEnter={() => setSel(i)} onClick={() => openAssign(r)}>
                        <span className="mp-name">
                          <span className="dim">{r.provider}/</span>
                          {r.id}
                          {r.value === currentValue && <span className="mp-cur" title="This session">●</span>}
                          {usedBy?.map((role) => (
                            <span key={role} className="mp-tag">
                              {roleName(role)}
                            </span>
                          ))}
                        </span>
                        <span className="mp-int">
                          {m?.int ? `🧠 ${Math.round(m.int)}` : null}
                        </span>
                        <span className="mp-speed">{m ? fmtSpeed(m, perf[r.value]) : ''}</span>
                        <span className="mp-ctx">{m ? fmtCtx(m.contextWindow) : ''}</span>
                        <span className="mp-price">{m ? fmtPrice(m) : r.jevNote}</span>
                      </div>
                    </div>
                  )
                })}
                {rows.length === 0 && <div className="empty-side">{models.length ? 'No models match' : 'Loading models from omp…'}</div>}
              </div>
              {highlighted && !assign && (
                <div className="mp-detail">
                  <div>
                    <b>{highlighted.name}</b>
                    {highlighted.model && (
                      <>
                        {' · '}
                        {fmtCtx(highlighted.model.contextWindow)} ctx · {fmtCtx(highlighted.model.maxTokens)} out · {fmtPrice(highlighted.model)} per M
                        {highlighted.model.reasoning && ' · reasoning'}
                        {highlighted.model.vision && ' · vision'}
                        {highlighted.model.int ? ` · 🧠 ${Math.round(highlighted.model.int)}` : ''}
                        {fmtSpeed(highlighted.model, perf[highlighted.value]) && ` · ${perf[highlighted.value] ? 'measured' : 'est.'} ${fmtSpeed(highlighted.model, perf[highlighted.value])}`}
                      </>
                    )}
                    {highlighted.jevNote && ` · ${highlighted.jevNote} · decisions only, used by the judge role`}
                  </div>
                  <div className="mp-roles-line">
                    {ROLES.filter((r) => (isJev(highlighted.value) ? r.id === 'judge' : r.id !== 'judge')).map((r) => {
                      const on = splitRole(roles[r.id]).model === highlighted.value
                      return (
                        <span key={r.id} className={on ? 'on' : ''}>
                          {on ? '●' : '○'} {r.name.toLowerCase()}
                        </span>
                      )
                    })}
                  </div>
                </div>
              )}
              {assign && <AssignStep assign={assign} setAssign={setAssign} hasSession={!!activeId} busy={busy} onApply={() => void apply()} onBack={() => setAssign(null)} />}
              <div className="mp-foot">
                {assign ? 'Enter apply · Esc back' : 'Enter choose · ↑↓ move · type to search · Tab kind · Esc close'}
              </div>
            </>
          )}
        </section>
      </div>
    </div>
  )
}

function AssignStep({
  assign,
  setAssign,
  hasSession,
  busy,
  onApply,
  onBack
}: {
  assign: Assign
  setAssign: (a: Assign) => void
  hasSession: boolean
  busy: boolean
  onApply: () => void
  onBack: () => void
}): ReactNode {
  const jev = isJev(assign.row.value)
  const choices = jev ? [] : thinkingChoices(assign.row.model)
  const roleOptions = ROLES.filter((r) => (jev ? r.id === 'judge' : r.id !== 'judge'))
  const toggleRole = (id: string): void => {
    const roles = new Set(assign.roles)
    if (roles.has(id)) roles.delete(id)
    else roles.add(id)
    setAssign({ ...assign, roles })
  }
  return (
    <div className="mp-assign">
      <div className="mp-assign-title">
        Use <b>{assign.row.name}</b> <span className="dim mono">{assign.row.value}</span>
      </div>
      {choices.length > 0 && (
        <div className="mp-assign-row">
          <span className="lbl">Thinking</span>
          <div className="chips">
            {choices.map((c) => (
              <button key={c} className={`chip-btn${assign.level === c ? ' on' : ''}`} onClick={() => setAssign({ ...assign, level: c })}>
                {capitalize(c)}
              </button>
            ))}
          </div>
        </div>
      )}
      <div className="mp-assign-row">
        <span className="lbl">Roles</span>
        <div className="chips">
          {roleOptions.map((r) => (
            <button key={r.id} className={`chip-btn${assign.roles.has(r.id) ? ' on' : ''}`} title={r.desc} onClick={() => toggleRole(r.id)}>
              {assign.roles.has(r.id) && <Check size={12} />}
              {r.name}
            </button>
          ))}
        </div>
      </div>
      {!jev && (
        <label className="mp-assign-row check">
          <span className="lbl" />
          <input type="checkbox" checked={assign.switchSession} onChange={(e) => setAssign({ ...assign, switchSession: e.target.checked })} />
          {hasSession ? 'Switch this session to it now' : 'Use it for the new session'}
        </label>
      )}
      <div className="mp-assign-actions">
        <button className="btn ghost" onClick={onBack}>
          Back
        </button>
        <button className="btn primary" disabled={busy} onClick={onApply}>
          {busy ? 'Applying…' : 'Apply ⏎'}
        </button>
      </div>
    </div>
  )
}
