import type {
  ApiKeyStatus,
  AuthEvent,
  ClaudeSessionInfo,
  LoginProvider,
  ModelInfo,
  ModelPerf,
  ModelRef,
  ModelRoles,
  OpenTarget,
  Prefs,
  RuntimeEvent,
  RuntimeState,
  SessionSummary,
  Transcript,
  UiResponse
} from '../shared/types'

export interface SlashCommand {
  name: string
  description: string
  hint?: string
}

export interface ClapiApi {
  sessions: {
    list(): Promise<SessionSummary[]>
    transcript(path: string, opts?: { limit?: number; end?: number }): Promise<Transcript>
    runtimes(): Promise<RuntimeState[]>
    open(id: string, path: string, cwd: string): Promise<RuntimeState>
    create(cwd: string): Promise<RuntimeState>
    prompt(id: string, text: string): Promise<void>
    abort(id: string): Promise<void>
    setModel(id: string, model: ModelRef): Promise<void>
    setThinking(id: string, level: string): Promise<void>
    respond(id: string, requestId: string, response: UiResponse): Promise<void>
    stop(id: string): Promise<void>
    rename(id: string, path: string | null, title: string): Promise<void>
    remove(id: string, path: string): Promise<void>
    fork(path: string, entryId: string | null, title?: string): Promise<SessionSummary | null>
    openIn(target: OpenTarget, cwd: string, id: string): Promise<void>
  }
  models: {
    list(force?: boolean): Promise<ModelInfo[]>
    thinkingLevels(): Promise<string[]>
    commands(): Promise<SlashCommand[]>
    perf(): Promise<Record<string, ModelPerf>>
  }
  roles: {
    get(): Promise<ModelRoles>
    set(roles: ModelRoles): Promise<ModelRoles>
  }
  auth: {
    providers(): Promise<LoginProvider[]>
    keys(): Promise<ApiKeyStatus[]>
    /** Providers with an active credential from `omp login`, with counts. */
    stored(): Promise<Record<string, number>>
    /** Same as omp's /logout: marks the provider's stored credentials deleted. */
    logout(providerId: string): Promise<number>
    setKey(name: string, value: string): Promise<void>
    login(providerId: string): Promise<void>
    respond(requestId: string, response: UiResponse): Promise<void>
    cancel(): Promise<void>
  }
  claude: {
    list(): Promise<ClaudeSessionInfo[]>
    import(info: Pick<ClaudeSessionInfo, 'id' | 'path' | 'cwd'>): Promise<SessionSummary | null>
  }
  prefs: {
    load(): Promise<Prefs>
    save(prefs: Prefs): Promise<void>
  }
  app: {
    info(): Promise<{ home: string; version: string }>
    pickFolder(): Promise<string | null>
    openExternal(url: string): Promise<void>
  }
  on: {
    runtime(cb: (event: RuntimeEvent) => void): () => void
    sessionsChanged(cb: () => void): () => void
    auth(cb: (event: AuthEvent) => void): () => void
  }
}

declare global {
  interface Window {
    clapi: ClapiApi
  }
}
