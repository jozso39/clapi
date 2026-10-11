// Types shared by the main process, the preload bridge and the renderer.

export type TitleSource = 'auto' | 'user'

/** One omp session as the sidebar sees it. `path` is null until omp has persisted the file. */
export interface SessionSummary {
  id: string
  path: string | null
  cwd: string
  title: string
  titleSource?: TitleSource
  created: string
  modified: number
  size: number
  parentSession?: string
  /** First user message, for sessions omp has not titled. */
  preview?: string
}

export type Block =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string }
  | { type: 'toolCall'; id: string; name: string; arguments: Record<string, unknown>; intent?: string }
  | { type: 'image'; mimeType: string }

export interface Usage {
  input: number
  output: number
  cacheRead: number
  cost: number
}

/** A rendered transcript row. `entryId` is the omp entry id — the handle for forking. */
export type ChatItem =
  | { kind: 'user'; entryId?: string; text: string; images: number; timestamp: number }
  | {
      kind: 'assistant'
      entryId?: string
      blocks: Block[]
      model?: string
      provider?: string
      stopReason?: string
      errorMessage?: string
      usage?: Usage
      timestamp: number
    }
  | {
      kind: 'toolResult'
      entryId?: string
      toolCallId: string
      toolName: string
      text: string
      isError: boolean
      truncated: boolean
      timestamp: number
    }
  | { kind: 'notice'; entryId?: string; text: string; level: 'info' | 'warning' | 'error'; timestamp: number }
  | { kind: 'compaction'; entryId?: string; summary: string; timestamp: number }

export interface Transcript {
  items: ChatItem[]
  /** Index of items[0] within the whole branch; > 0 means earlier items exist. */
  start: number
  total: number
}

export interface ModelRef {
  provider: string
  id: string
  name?: string
}

export interface ModelInfo extends ModelRef {
  name: string
  reasoning: boolean
  contextWindow?: number
  maxTokens?: number
  costIn?: number
  costOut?: number
  /** omp's intelligence index, when it has one. */
  int?: number
  /** omp's estimated tokens/s, when it has one. */
  tps?: number
  vision: boolean
  /** Thinking efforts this model accepts (omp's `thinking.efforts`). */
  efforts?: string[]
}

/** Speed you actually got from a model, from omp's own measurements (agent.db). */
export interface ModelPerf {
  ttftSec: number
  tps: number
  samples: number
}

export type RuntimeStatus = 'starting' | 'idle' | 'busy' | 'exited' | 'error'

export interface RuntimeState {
  sessionId: string
  status: RuntimeStatus
  model?: ModelRef
  thinkingLevel?: string
  contextPercent?: number
  error?: string
}

/** omp extension UI request, forwarded verbatim (minus fire-and-forget kinds handled in main). */
export interface UiRequest {
  id: string
  method: 'select' | 'confirm' | 'input' | 'editor' | 'open_url'
  title?: string
  message?: string
  options?: string[]
  placeholder?: string
  prefill?: string
  url?: string
  launchUrl?: string
  instructions?: string
}

export type UiResponse = { value: string } | { confirmed: boolean } | { cancelled: true }

/** Streaming assistant message as it is being produced. */
export interface AssistantPartial {
  blocks: Block[]
  model?: string
  provider?: string
}

export type RuntimeEvent =
  | { type: 'state'; state: RuntimeState }
  | { type: 'partial'; sessionId: string; partial: AssistantPartial }
  | { type: 'message'; sessionId: string; item: ChatItem }
  | { type: 'toolStart'; sessionId: string; toolCallId: string; toolName: string; args: unknown; intent?: string }
  | { type: 'toolEnd'; sessionId: string; toolCallId: string; isError: boolean }
  | { type: 'agentEnd'; sessionId: string }
  | { type: 'ui'; sessionId: string; request: UiRequest }
  | { type: 'uiCancel'; sessionId: string; targetId: string }
  | { type: 'notify'; sessionId: string; level: 'info' | 'warning' | 'error'; text: string }
  | { type: 'title'; sessionId: string; title: string }
  | { type: 'persisted'; sessionId: string; path: string }

export interface LoginProvider {
  id: string
  name: string
  authenticated: boolean
}

export interface ApiKeyStatus {
  env: string
  present: boolean
  source?: 'omp-env' | 'process'
}

export type AuthEvent =
  | { type: 'ui'; request: UiRequest }
  | { type: 'progress'; text: string }
  | { type: 'done'; providerId: string; ok: boolean; error?: string }

export interface ClaudeSessionInfo {
  id: string
  path: string
  cwd: string
  title?: string
  firstMessage?: string
  modified: number
  size: number
  imported?: string
}

export type ModelRoles = Record<string, string>

export interface Prefs {
  pinned: string[]
  archived: string[]
  unread: string[]
  collapsed: string[]
  /** Manual order inside a group: groupKey -> session ids. */
  order: Record<string, string[]>
  customGroups: { id: string; name: string }[]
  /** Session -> custom group id. Sessions not listed live in their project group. */
  groupOf: Record<string, string>
  viewMode: 'normal' | 'thinking' | 'verbose'
}

export const DEFAULT_PREFS: Prefs = {
  pinned: [],
  archived: [],
  unread: [],
  collapsed: [],
  order: {},
  customGroups: [],
  groupOf: {},
  viewMode: 'normal'
}

export type OpenTarget = 'vscode' | 'terminal' | 'finder'
