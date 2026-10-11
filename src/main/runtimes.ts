// One omp process per open session (`omp --mode rpc --session <file>`), started
// lazily on the first thing that needs a live agent. Parallel sessions are
// separate processes, so one crash never takes another session down.
import { homedir } from 'node:os'
import type { AssistantPartial, ModelRef, RuntimeEvent, RuntimeState, UiRequest } from '../shared/types'
import { childEnv, ompBinary } from './env'
import { OmpRpc, type Frame } from './omp-rpc'
import { assistantBlocks, findSessionPath, messageToItem } from './session-files'

type Sink = (event: RuntimeEvent) => void

const PARTIAL_INTERVAL_MS = 50
const ASKING = new Set(['select', 'confirm', 'input', 'editor', 'open_url'])

class Runtime {
  readonly rpc: OmpRpc
  sessionId = ''
  path: string | null
  state: RuntimeState
  restartPending = false
  private partial: AssistantPartial | null = null
  private partialTimer: NodeJS.Timeout | null = null

  constructor(
    bin: string,
    env: NodeJS.ProcessEnv,
    readonly cwd: string,
    path: string | null,
    private readonly sink: Sink,
    private readonly onIdle: (rt: Runtime) => void
  ) {
    this.path = path
    const args = ['--mode', 'rpc', ...(path ? ['--session', path] : [])]
    this.rpc = new OmpRpc(bin, args, cwd, env)
    this.state = { sessionId: '', status: 'starting' }
    this.rpc.on('frame', (f: Frame) => this.onFrame(f))
    this.rpc.on('exit', (info: { code: number | null; stderr: string }) => {
      const failed = info.code !== 0 && info.code !== null
      this.setState({ status: failed ? 'error' : 'exited', error: failed ? lastLines(info.stderr) : undefined })
    })
  }

  async start(): Promise<void> {
    await this.rpc.start()
    const st = await this.rpc.request<any>({ type: 'get_state' })
    this.sessionId = st.sessionId
    this.state = { sessionId: st.sessionId, status: st.isStreaming ? 'busy' : 'idle' }
    this.applyState(st)
    this.sink({ type: 'state', state: this.state })
  }

  private applyState(st: any): void {
    if (st?.model) this.state.model = { provider: st.model.provider, id: st.model.id, name: st.model.name }
    if (typeof st?.thinkingLevel === 'string') this.state.thinkingLevel = st.thinkingLevel
    const pct = st?.contextUsage?.percent ?? st?.contextUsage?.percentage
    if (typeof pct === 'number') this.state.contextPercent = pct
  }

  setState(patch: Partial<RuntimeState>): void {
    this.state = { ...this.state, ...patch }
    this.sink({ type: 'state', state: this.state })
  }

  async refreshState(): Promise<void> {
    try {
      this.applyState(await this.rpc.request({ type: 'get_state' }, 15_000))
      this.sink({ type: 'state', state: this.state })
    } catch {
      // the process may be going away; its exit handler reports that
    }
  }

  private flushPartial = (): void => {
    this.partialTimer = null
    if (this.partial) this.sink({ type: 'partial', sessionId: this.sessionId, partial: this.partial })
  }

  private onFrame(f: Frame): void {
    const sid = this.sessionId
    switch (f.type) {
      case 'agent_start':
        this.setState({ status: 'busy', error: undefined })
        break
      case 'message_update': {
        const m = f.message
        if (m?.role !== 'assistant') break
        this.partial = { blocks: assistantBlocks(m.content), model: m.model, provider: m.provider }
        this.partialTimer ??= setTimeout(this.flushPartial, PARTIAL_INTERVAL_MS)
        break
      }
      case 'message_end': {
        if (this.partialTimer) clearTimeout(this.partialTimer)
        this.partialTimer = null
        this.partial = null
        const item = messageToItem(f.message, undefined, Date.now())
        if (item) this.sink({ type: 'message', sessionId: sid, item })
        break
      }
      case 'tool_execution_start':
        this.sink({ type: 'toolStart', sessionId: sid, toolCallId: f.toolCallId, toolName: f.toolName, args: f.args, intent: f.intent })
        break
      case 'tool_execution_end':
        this.sink({ type: 'toolEnd', sessionId: sid, toolCallId: f.toolCallId, isError: f.isError === true })
        break
      case 'agent_end':
        this.setState({ status: 'idle' })
        this.sink({ type: 'agentEnd', sessionId: sid })
        void this.afterTurn()
        break
      case 'model_changed':
      case 'thinking_level_changed':
        void this.refreshState()
        break
      case 'auto_retry_start':
        this.sink({ type: 'notify', sessionId: sid, level: 'warning', text: `Retrying: ${f.errorMessage ?? f.reason ?? 'provider error'}` })
        break
      case 'auto_compaction_start':
        this.sink({ type: 'notify', sessionId: sid, level: 'info', text: 'Compacting context…' })
        break
      case 'notice':
        this.sink({ type: 'notify', sessionId: sid, level: f.level === 'error' ? 'error' : f.level === 'warning' ? 'warning' : 'info', text: String(f.message ?? f.text ?? '') })
        break
      case 'extension_ui_request':
        this.onUiRequest(f)
        break
    }
  }

  private onUiRequest(f: Frame): void {
    const sid = this.sessionId
    if (ASKING.has(f.method)) {
      const request: UiRequest = {
        id: f.id,
        method: f.method,
        title: f.title,
        message: f.message,
        options: f.options,
        placeholder: f.placeholder,
        prefill: f.prefill,
        url: f.url,
        launchUrl: f.launchUrl,
        instructions: f.instructions
      }
      this.sink({ type: 'ui', sessionId: sid, request })
    } else if (f.method === 'cancel') {
      this.sink({ type: 'uiCancel', sessionId: sid, targetId: f.targetId })
    } else if (f.method === 'notify') {
      this.sink({ type: 'notify', sessionId: sid, level: f.notifyType ?? 'info', text: String(f.message ?? '') })
    } else if (f.method === 'setTitle' && typeof f.title === 'string') {
      this.sink({ type: 'title', sessionId: sid, title: f.title })
    }
  }

  private async afterTurn(): Promise<void> {
    if (!this.path) {
      // omp writes the file once the first assistant message exists.
      const path = await findSessionPath(this.sessionId)
      if (path) {
        this.path = path
        this.sink({ type: 'persisted', sessionId: this.sessionId, path })
      }
    }
    await this.refreshState()
    this.onIdle(this)
  }
}

function lastLines(text: string): string {
  return text.trim().split('\n').slice(-4).join('\n')
}

export class Runtimes {
  private byId = new Map<string, Runtime>()
  private starting = new Map<string, Promise<Runtime>>()

  constructor(private readonly sink: Sink) {}

  private async spawn(cwd: string, path: string | null): Promise<Runtime> {
    const [bin, env] = await Promise.all([ompBinary(), childEnv()])
    const rt = new Runtime(bin, env, cwd || homedir(), path, this.sink, (r) => this.onIdle(r))
    await rt.start()
    this.byId.set(rt.sessionId, rt)
    return rt
  }

  /** Live runtime for an existing session file, starting omp if needed. */
  async ensure(sessionId: string, path: string, cwd: string): Promise<Runtime> {
    const existing = this.byId.get(sessionId)
    if (existing && !existing.rpc.exited) return existing
    let pending = this.starting.get(sessionId)
    if (!pending) {
      this.sink({ type: 'state', state: { sessionId, status: 'starting' } })
      pending = this.spawn(cwd, path).finally(() => this.starting.delete(sessionId))
      this.starting.set(sessionId, pending)
    }
    try {
      return await pending
    } catch (err) {
      this.sink({ type: 'state', state: { sessionId, status: 'error', error: (err as Error).message } })
      throw err
    }
  }

  /** A brand-new session in `cwd`; its file appears after the first reply. */
  async create(cwd: string): Promise<RuntimeState> {
    const rt = await this.spawn(cwd, null)
    return rt.state
  }

  get(sessionId: string): Runtime | undefined {
    const rt = this.byId.get(sessionId)
    return rt && !rt.rpc.exited ? rt : undefined
  }

  states(): RuntimeState[] {
    return [...this.byId.values()].filter((r) => !r.rpc.exited).map((r) => r.state)
  }

  async prompt(rt: Runtime, text: string): Promise<void> {
    // While a turn runs, omp needs to know how to queue the message.
    if (rt.state.status === 'busy') await rt.rpc.request({ type: 'follow_up', message: text })
    else await rt.rpc.request({ type: 'prompt', message: text })
  }

  async setModel(rt: Runtime, model: ModelRef): Promise<void> {
    await rt.rpc.request({ type: 'set_model', provider: model.provider, modelId: model.id })
    await rt.refreshState()
  }

  async setThinking(rt: Runtime, level: string): Promise<void> {
    await rt.rpc.request({ type: 'set_thinking_level', level })
    await rt.refreshState()
  }

  async stop(sessionId: string): Promise<void> {
    const rt = this.byId.get(sessionId)
    this.byId.delete(sessionId)
    await rt?.rpc.stop()
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.byId.keys()].map((id) => this.stop(id)))
  }

  /**
   * A running omp never re-reads config.yml or ~/.omp/.env, so role and
   * credential changes need fresh processes. Idle ones restart now; busy ones
   * after their turn. Same file, so the conversation is unaffected.
   */
  async restartAll(): Promise<void> {
    for (const rt of [...this.byId.values()]) {
      if (rt.state.status === 'busy') rt.restartPending = true
      else await this.restart(rt)
    }
  }

  private onIdle(rt: Runtime): void {
    if (rt.restartPending) void this.restart(rt)
  }

  private async restart(rt: Runtime): Promise<void> {
    rt.restartPending = false
    const { sessionId, path, cwd } = rt
    await this.stop(sessionId)
    if (path) await this.ensure(sessionId, path, cwd).catch(() => undefined)
  }
}
