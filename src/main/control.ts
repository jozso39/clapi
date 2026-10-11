// A session-less omp process for everything that isn't a conversation: the
// model catalogue, slash commands, and provider login (omp's own /login, over
// the RPC `get_login_providers` + `login` commands).
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { AuthEvent, LoginProvider, ModelInfo, UiResponse } from '../shared/types'
import { CLAPI_HOME, childEnv, ompBinary } from './env'
import { OmpRpc, type Frame } from './omp-rpc'

export interface SlashCommand {
  name: string
  description: string
  hint?: string
}

export class Control {
  private rpc: OmpRpc | null = null
  private starting: Promise<OmpRpc> | null = null
  private models: ModelInfo[] | null = null
  private loginListener: ((e: AuthEvent) => void) | null = null

  private async ensure(): Promise<OmpRpc> {
    if (this.rpc && !this.rpc.exited) return this.rpc
    this.starting ??= (async () => {
      const cwd = join(CLAPI_HOME, 'control')
      mkdirSync(cwd, { recursive: true })
      const rpc = new OmpRpc(await ompBinary(), ['--mode', 'rpc', '--no-session'], cwd, await childEnv())
      rpc.on('frame', (f: Frame) => this.onFrame(f))
      await rpc.start()
      this.rpc = rpc
      return rpc
    })().finally(() => {
      this.starting = null
    })
    return this.starting
  }

  private onFrame(f: Frame): void {
    if (f.type !== 'extension_ui_request' || !this.loginListener) return
    if (f.method === 'notify') this.loginListener({ type: 'progress', text: String(f.message ?? '') })
    else if (['open_url', 'input', 'select', 'confirm', 'editor'].includes(f.method)) {
      this.loginListener({
        type: 'ui',
        request: {
          id: f.id,
          method: f.method,
          title: f.title,
          message: f.message,
          options: f.options,
          placeholder: f.placeholder,
          url: f.url,
          launchUrl: f.launchUrl,
          instructions: f.instructions
        }
      })
    }
  }

  async listModels(force = false): Promise<ModelInfo[]> {
    if (this.models && !force) return this.models
    const rpc = await this.ensure()
    const data = await rpc.request<{ models: any[] }>({ type: 'get_available_models' }, 90_000)
    this.models = (data.models ?? []).map((m) => ({
      provider: m.provider,
      id: m.id,
      name: m.name ?? m.id,
      reasoning: m.reasoning === true,
      contextWindow: m.contextWindow,
      maxTokens: m.maxTokens,
      costIn: m.cost?.input,
      costOut: m.cost?.output,
      int: typeof m.int === 'number' ? m.int : undefined,
      tps: typeof m.tps === 'number' ? m.tps : undefined,
      vision: Array.isArray(m.input) && m.input.includes('image'),
      efforts: Array.isArray(m.thinking?.efforts) ? m.thinking.efforts : undefined
    }))
    return this.models
  }

  async thinkingLevels(): Promise<string[]> {
    const rpc = await this.ensure()
    const data = await rpc.request<{ levels: string[] }>({ type: 'get_available_thinking_levels' })
    return data.levels ?? []
  }

  async commands(): Promise<SlashCommand[]> {
    const rpc = await this.ensure()
    const data = await rpc.request<{ commands: any[] }>({ type: 'get_available_commands' })
    return (data.commands ?? []).map((c) => ({
      name: String(c.name),
      description: String(c.description ?? ''),
      hint: c.input?.hint ?? c.inlineHint
    }))
  }

  async loginProviders(): Promise<LoginProvider[]> {
    const rpc = await this.ensure()
    const data = await rpc.request<{ providers: any[] }>({ type: 'get_login_providers' })
    return (data.providers ?? []).map((p) => ({ id: p.id, name: p.name, authenticated: p.authenticated === true }))
  }

  /** Run omp's OAuth login. Progress and prompts stream to `listener` until it settles. */
  async login(providerId: string, listener: (e: AuthEvent) => void): Promise<void> {
    const rpc = await this.ensure()
    this.loginListener = listener
    try {
      await rpc.request({ type: 'login', providerId }, 15 * 60_000)
      this.models = null
      listener({ type: 'done', providerId, ok: true })
    } catch (err) {
      listener({ type: 'done', providerId, ok: false, error: (err as Error).message })
    } finally {
      this.loginListener = null
    }
  }

  respond(requestId: string, response: UiResponse): void {
    this.rpc?.respondUi(requestId, response as Record<string, unknown>)
  }

  /** Abandon an in-flight login: omp only gives up when its process goes. */
  async restart(): Promise<void> {
    const rpc = this.rpc
    this.rpc = null
    this.models = null
    await rpc?.stop()
  }
}
