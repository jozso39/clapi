import { Check, ChevronDown, Download, KeyRound, LoaderCircle, SlidersHorizontal, X } from 'lucide-react'
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import type { ApiKeyStatus, AuthEvent, ClaudeSessionInfo, LoginProvider, UiRequest } from '../../../shared/types'
import { basename, relTime } from '../lib'
import { loadModels, refreshSessions, reportError, select, toast, useStore, type SettingsTab } from '../store'

const api = window.clapi

// ─── Accounts ────────────────────────────────────────────────────────────────

interface Featured {
  name: string
  blurb: string
  oauth: { id: string; label: string }[]
  keys: { env: string; label: string; help?: string }[]
}

const FEATURED: Featured[] = [
  {
    name: 'Claude',
    blurb: 'Anthropic',
    oauth: [{ id: 'anthropic', label: 'Claude Pro / Max subscription' }],
    keys: [{ env: 'ANTHROPIC_API_KEY', label: 'Anthropic API key', help: 'console.anthropic.com' }]
  },
  {
    name: 'OpenAI',
    blurb: 'GPT models',
    oauth: [{ id: 'openai-codex', label: 'ChatGPT Plus / Pro (Codex)' }],
    keys: [{ env: 'OPENAI_API_KEY', label: 'OpenAI API key', help: 'platform.openai.com' }]
  },
  {
    name: 'Gemini',
    blurb: 'Google',
    oauth: [
      { id: 'google-gemini-cli', label: 'Google account (Gemini CLI)' },
      { id: 'google-antigravity', label: 'Antigravity (Gemini 3)' }
    ],
    keys: [{ env: 'GEMINI_API_KEY', label: 'Gemini API key', help: 'aistudio.google.com' }]
  },
  {
    name: 'Jev',
    blurb: 'TypeSafe — the judge model for omp’s typed decisions',
    oauth: [],
    keys: [
      { env: 'OPENROUTER_API_KEY', label: 'Through OpenRouter', help: 'openrouter.ai/keys — any OpenRouter key can call Jev' },
      { env: 'TYPESAFE_API_KEY', label: 'TypeSafe directly', help: 'typesafe.ai' }
    ]
  }
]

/** omp's own CLI aliases (auth-gateway-cli.ts), plus the names people type. */
const LOGIN_ALIASES: Record<string, string> = {
  claude: 'anthropic',
  codex: 'openai-codex',
  openai: 'openai-codex',
  chatgpt: 'openai-codex',
  gpt: 'openai-codex',
  gemini: 'google-gemini-cli',
  'gemini-cli': 'google-gemini-cli',
  google: 'google-gemini-cli',
  antigravity: 'google-antigravity',
  jev: 'jev',
  typesafe: 'jev'
}

interface LoginState {
  providerId: string
  url?: string
  instructions?: string
  ask?: UiRequest
  progress: string[]
  error?: string
}

function KeyLine({ env, label, help, status, onSaved }: { env: string; label: string; help?: string; status?: ApiKeyStatus; onSaved: () => void }): ReactNode {
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const save = async (v: string): Promise<void> => {
    setBusy(true)
    try {
      await api.auth.setKey(env, v)
      toast('info', v ? `${env} saved to ~/.omp/.env` : `${env} removed`)
      setEditing(false)
      setValue('')
      onSaved()
    } catch (err) {
      reportError(err)
    } finally {
      setBusy(false)
    }
  }
  return (
    <div>
      <div className="auth-line">
        <KeyRound size={14} className="dim" />
        <span className="lbl">
          {label}
          <small className="mono">
            {env}
            {help ? ` · ${help}` : ''}
          </small>
        </span>
        {status?.present ? (
          <span className="badge ok">
            <Check size={12} /> {status.source === 'process' ? 'from shell env' : 'saved'}
          </span>
        ) : (
          <span className="badge">not set</span>
        )}
        {!editing && (
          <button className="btn sm" onClick={() => setEditing(true)}>
            {status?.present ? 'Replace' : 'Add key'}
          </button>
        )}
        {status?.present && status.source === 'omp-env' && !editing && (
          <button className="btn sm ghost" title="Remove from ~/.omp/.env" onClick={() => void save('')}>
            Remove
          </button>
        )}
      </div>
      {editing && (
        <div className="key-row">
          <input
            className="field mono"
            type="password"
            autoFocus
            placeholder={`Paste ${env}`}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && value.trim() && void save(value)}
          />
          <button className="btn primary" disabled={!value.trim() || busy} onClick={() => void save(value)}>
            Save
          </button>
          <button className="btn ghost" onClick={() => setEditing(false)}>
            Cancel
          </button>
        </div>
      )}
    </div>
  )
}

/** omp's /logout for one provider, behind a second click. */
function LogoutButton({ provider, onDone }: { provider: string; onDone: () => void }): ReactNode {
  const [confirm, setConfirm] = useState(false)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (!confirm) return
    const t = setTimeout(() => setConfirm(false), 4000)
    return () => clearTimeout(t)
  }, [confirm])
  return (
    <button
      className={`btn sm ${confirm ? 'danger' : 'ghost'}`}
      disabled={busy}
      onClick={async () => {
        if (!confirm) return setConfirm(true)
        setBusy(true)
        try {
          const n = await api.auth.logout(provider)
          toast('info', n ? `Logged out of ${provider}` : `${provider} had no stored login`)
          onDone()
        } catch (err) {
          reportError(err)
        } finally {
          setBusy(false)
          setConfirm(false)
        }
      }}
    >
      {confirm ? 'Confirm log out' : 'Log out'}
    </button>
  )
}

function LoginPanel({ state, onCancel }: { state: LoginState; onCancel: () => void }): ReactNode {
  const [value, setValue] = useState('')
  const ask = state.ask
  return (
    <div className="login-panel">
      {state.error ? (
        <div className="err">{state.error}</div>
      ) : (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <LoaderCircle size={14} className="dim" style={{ animation: 'spin 1s linear infinite' }} />
          {state.url ? 'Finish signing in in your browser…' : 'Starting omp login…'}
        </div>
      )}
      {state.instructions && <div className="dim" style={{ marginTop: 6 }}>{state.instructions}</div>}
      {state.url && (
        <>
          <div className="url">{state.url}</div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn sm" onClick={() => void api.app.openExternal(state.url!)}>
              Open again
            </button>
            <button className="btn sm ghost" onClick={() => void navigator.clipboard.writeText(state.url!)}>
              Copy link
            </button>
          </div>
        </>
      )}
      {ask && (ask.method === 'input' || ask.method === 'editor') && (
        <div className="key-row">
          <input className="field mono" autoFocus placeholder={ask.placeholder || ask.title || 'Paste the code from the browser'} value={value} onChange={(e) => setValue(e.target.value)} />
          <button
            className="btn primary"
            disabled={!value.trim()}
            onClick={() => {
              void api.auth.respond(ask.id, { value: value.trim() })
              setValue('')
            }}
          >
            Submit
          </button>
        </div>
      )}
      {ask && ask.method === 'select' && (
        <div style={{ marginTop: 8 }}>
          <div className="dim">{ask.title}</div>
          {ask.options?.map((o) => (
            <button key={o} className="opt" onClick={() => void api.auth.respond(ask.id, { value: o })}>
              {o}
            </button>
          ))}
        </div>
      )}
      {ask && ask.method === 'confirm' && (
        <div style={{ marginTop: 8, display: 'flex', gap: 8, alignItems: 'center' }}>
          <span className="dim" style={{ flex: 1 }}>{ask.message || ask.title}</span>
          <button className="btn sm primary" onClick={() => void api.auth.respond(ask.id, { confirmed: true })}>
            Yes
          </button>
          <button className="btn sm" onClick={() => void api.auth.respond(ask.id, { confirmed: false })}>
            No
          </button>
        </div>
      )}
      {state.progress.length > 0 && <div className="dim" style={{ marginTop: 6, fontSize: 12 }}>{state.progress[state.progress.length - 1]}</div>}
      <div style={{ marginTop: 10 }}>
        <button className="btn sm ghost" onClick={onCancel}>
          {state.error ? 'Close' : 'Cancel'}
        </button>
      </div>
    </div>
  )
}

function Accounts({ autoLogin }: { autoLogin?: string }): ReactNode {
  const [providers, setProviders] = useState<LoginProvider[] | null>(null)
  const [stored, setStored] = useState<Record<string, number>>({})
  const autoStarted = useRef(false)
  const [keys, setKeys] = useState<ApiKeyStatus[]>([])
  const [login, setLogin] = useState<LoginState | null>(null)
  const [showAll, setShowAll] = useState(false)
  const [q, setQ] = useState('')

  const refresh = useCallback(async () => {
    try {
      const [p, k, st] = await Promise.all([api.auth.providers(), api.auth.keys(), api.auth.stored()])
      setProviders(p)
      setKeys(k)
      setStored(st)
    } catch (err) {
      reportError(err)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  useEffect(
    () =>
      api.on.auth((e: AuthEvent) => {
        setLogin((cur) => {
          if (!cur) return cur
          if (e.type === 'progress') return { ...cur, progress: [...cur.progress, e.text] }
          if (e.type === 'ui') {
            if (e.request.method === 'open_url' && e.request.url) {
              void api.app.openExternal(e.request.launchUrl || e.request.url)
              return { ...cur, url: e.request.url, instructions: e.request.instructions }
            }
            return { ...cur, ask: e.request }
          }
          if (e.type === 'done') {
            if (e.ok) {
              toast('info', `Logged in — ${e.providerId}`)
              void refresh()
              void loadModels(true)
              return null
            }
            return { ...cur, error: e.error ?? 'Login failed', ask: undefined }
          }
          return cur
        })
      }),
    [refresh]
  )

  const startLogin = (providerId: string): void => {
    setLogin({ providerId, progress: [] })
    void api.auth.login(providerId).catch((err) => setLogin({ providerId, progress: [], error: String(err?.message ?? err) }))
  }
  const cancel = (): void => {
    if (login && !login.error) void api.auth.cancel()
    setLogin(null)
  }
  const authed = (id: string): boolean => providers?.find((p) => p.id === id)?.authenticated === true
  const afterLogout = (): void => {
    void refresh()
    void loadModels(true)
  }

  // `/login <provider>` from the composer starts that login straight away.
  useEffect(() => {
    if (!autoLogin || !providers || autoStarted.current) return
    autoStarted.current = true
    const id = LOGIN_ALIASES[autoLogin.toLowerCase()] ?? autoLogin.toLowerCase()
    if (id === 'jev') {
      setTimeout(() => document.querySelector('.card:last-of-type')?.scrollIntoView({ block: 'center' }), 50)
      return toast('info', 'Jev uses an API key — add it on the Jev card')
    }
    const known =
      providers.find((p) => p.id === id) ??
      providers.find((p) => p.id.startsWith(id)) ??
      providers.find((p) => p.id.includes(id)) ??
      providers.find((p) => p.name.toLowerCase().includes(id))
    if (!known) return toast('warning', `omp has no login for “${autoLogin}”`)
    if (!FEATURED.some((f) => f.oauth.some((o) => o.id === known.id))) {
      setShowAll(true)
      setQ(known.id)
    }
    startLogin(known.id)
    setTimeout(() => document.querySelector('.login-panel')?.scrollIntoView({ block: 'center' }), 50)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providers, autoLogin])
  const keyOf = (env: string): ApiKeyStatus | undefined => keys.find((k) => k.env === env)
  const others = (providers ?? []).filter((p) => !FEATURED.some((f) => f.oauth.some((o) => o.id === p.id))).filter((p) => !q || `${p.id} ${p.name}`.toLowerCase().includes(q.toLowerCase()))

  return (
    <div className="pane">
      <p className="hint" style={{ marginTop: 14 }}>
        Clapi logs in and out through omp itself — the same credentials your terminal omp uses. Subscriptions open your browser; API keys are saved to <span className="mono">~/.omp/.env</span> (readable only by you), which omp loads at startup. Log out removes omp’s stored login for that provider, exactly like omp’s <span className="mono">/logout</span>; a key in <span className="mono">.env</span> keeps working until you remove it too.
      </p>
      {FEATURED.map((f) => (
        <div className="card" key={f.name}>
          <div className="card-head">
            <span className="t">{f.name}</span>
            <span className="s">{f.blurb}</span>
          </div>
          {f.oauth.map((o) => (
            <div key={o.id}>
              <div className="auth-line">
                <span className="lbl">
                  {o.label}
                  <small className="mono">omp login {o.id}</small>
                </span>
                {providers === null ? (
                  <span className="badge">…</span>
                ) : stored[o.id] ? (
                  <span className="badge ok">
                    <Check size={12} /> logged in
                  </span>
                ) : authed(o.id) ? (
                  <span className="badge">via API key</span>
                ) : (
                  <span className="badge">not logged in</span>
                )}
                {stored[o.id] ? <LogoutButton provider={o.id} onDone={afterLogout} /> : null}
                <button className={`btn sm${stored[o.id] ? '' : ' primary'}`} disabled={!!login && !login.error} onClick={() => startLogin(o.id)}>
                  {stored[o.id] ? 'Log in again' : 'Log in'}
                </button>
              </div>
              {login?.providerId === o.id && <LoginPanel state={login} onCancel={cancel} />}
            </div>
          ))}
          {f.keys.map((k) => (
            <KeyLine key={k.env} env={k.env} label={k.label} help={k.help} status={keyOf(k.env)} onSaved={() => (void refresh(), void loadModels(true))} />
          ))}
          {f.name === 'Jev' && (
            <p className="hint" style={{ margin: '10px 0 0' }}>
              Jev isn’t a chat model: pick it for the <b>judge</b> role in the model panel (⌘⇧I → Roles), and omp routes auto-thinking, stop detection, AI staging and the find tool’s gate through it.
            </p>
          )}
        </div>
      ))}
      <h3 style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'default' }} onClick={() => setShowAll(!showAll)}>
        <ChevronDown size={14} style={{ transform: showAll ? undefined : 'rotate(-90deg)' }} /> All omp providers {providers ? `(${providers.length})` : ''}
      </h3>
      {showAll && (
        <>
          <input className="field" placeholder="Filter providers" value={q} onChange={(e) => setQ(e.target.value)} style={{ marginBottom: 8 }} />
          {others.map((p) => (
            <div key={p.id}>
              <div className="auth-line" style={{ marginTop: 6 }}>
                <span className="lbl">
                  {p.name}
                  <small className="mono">{p.id}</small>
                </span>
                {stored[p.id] ? (
                  <span className="badge ok">
                    <Check size={12} /> logged in
                  </span>
                ) : p.authenticated ? (
                  <span className="badge ok">ready</span>
                ) : null}
                {stored[p.id] ? <LogoutButton provider={p.id} onDone={afterLogout} /> : null}
                <button className="btn sm" disabled={!!login && !login.error} onClick={() => startLogin(p.id)}>
                  {stored[p.id] ? 'Log in again' : 'Log in'}
                </button>
              </div>
              {login?.providerId === p.id && <LoginPanel state={login} onCancel={cancel} />}
            </div>
          ))}
          <p className="hint" style={{ marginTop: 10 }}>
            Providers that only take an API key ask for it in a hidden prompt, which omp refuses over RPC — use <span className="mono">omp</span> → <span className="mono">/login</span> in a terminal for those, or add the key above.
          </p>
        </>
      )}
    </div>
  )
}

// ─── Claude Code import ──────────────────────────────────────────────────────

function ImportPane({ onDone }: { onDone: () => void }): ReactNode {
  const [list, setList] = useState<ClaudeSessionInfo[] | null>(null)
  const [q, setQ] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const sessions = useStore((s) => s.sessions)
  const home = useStore((s) => s.home)

  useEffect(() => {
    api.claude.list().then(setList, (err) => (reportError(err), setList([])))
  }, [])

  const shown = (list ?? []).filter((c) => !q || `${c.title ?? ''} ${c.firstMessage ?? ''} ${c.cwd}`.toLowerCase().includes(q.toLowerCase()))

  const run = async (c: ClaudeSessionInfo): Promise<void> => {
    setBusy(c.id)
    try {
      const summary = await api.claude.import({ id: c.id, path: c.path, cwd: c.cwd })
      if (!summary) throw new Error('Imported, but the new session could not be read back')
      await refreshSessions()
      select(summary.id)
      toast('info', `Imported “${summary.title}” from Claude Code`)
      onDone()
    } catch (err) {
      reportError(err)
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="pane">
      <p className="hint" style={{ marginTop: 14 }}>
        Your Claude Code conversations in <span className="mono">~/.claude/projects</span>, converted into omp sessions with the same mapping omp’s own <span className="mono">--from-claude</span> uses. The original is never changed; continue the import with any model.
      </p>
      <input className="field" placeholder="Search Claude Code sessions" value={q} onChange={(e) => setQ(e.target.value)} style={{ marginBottom: 8 }} />
      {list === null && <div className="dim">Reading Claude Code sessions…</div>}
      {list !== null && shown.length === 0 && <div className="dim">No Claude Code sessions found.</div>}
      {shown.map((c) => {
        const existing = c.imported ? sessions.find((s) => s.id === c.imported) : undefined
        return (
          <div className="imp-row" key={c.path}>
            <div className="col">
              <div className="t">{c.title || c.firstMessage || c.id}</div>
              <div className="s" title={c.cwd}>
                {basename(c.cwd)} · {relTime(c.modified)} · {(c.size / 1e6).toFixed(1)} MB{c.cwd.startsWith(home) ? '' : ` · ${c.cwd}`}
              </div>
            </div>
            {existing && (
              <button className="btn sm" onClick={() => (select(existing.id), onDone())}>
                Open
              </button>
            )}
            <button className={`btn sm${existing ? ' ghost' : ' primary'}`} disabled={busy !== null} onClick={() => void run(c)}>
              {busy === c.id ? 'Importing…' : existing ? 'Import again' : 'Import'}
            </button>
          </div>
        )
      })}
    </div>
  )
}

// ─── dialog ──────────────────────────────────────────────────────────────────

export function SettingsDialog({ tab, provider }: { tab: SettingsTab; provider?: string }): ReactNode {
  const close = (): void => useStore.setState({ dialog: null })
  const setTab = (t: SettingsTab): void => useStore.setState({ dialog: { kind: 'settings', tab: t } })
  const tabs: { id: SettingsTab; label: string; icon: ReactNode }[] = [
    { id: 'accounts', label: 'Accounts', icon: <KeyRound size={15} /> },
    { id: 'import', label: 'Import from Claude Code', icon: <Download size={15} /> }
  ]
  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="modal wide">
        <div className="modal-head">
          <h2>Settings</h2>
          <button className="icon-btn" onClick={close} title="Close (Esc)">
            <X size={16} />
          </button>
        </div>
        <div className="settings">
          <nav>
            {tabs.map((t) => (
              <button key={t.id} className={tab === t.id ? 'on' : ''} onClick={() => setTab(t.id)}>
                {t.icon}
                {t.label}
              </button>
            ))}
            <button onClick={() => useStore.setState({ dialog: { kind: 'models', view: 'roles' } })}>
              <SlidersHorizontal size={15} />
              Models & roles
            </button>
          </nav>
          {tab === 'accounts' && <Accounts autoLogin={provider} />}
          {tab === 'import' && <ImportPane onDone={close} />}
        </div>
      </div>
    </div>
  )
}
