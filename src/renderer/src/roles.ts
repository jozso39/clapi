// omp's model roles (packages/coding-agent/src/config/model-roles.ts) plus the
// judge role, and the Jev models that only the judge can use.
import type { ModelInfo, ModelPerf } from '../../shared/types'

export const ROLES: { id: string; name: string; desc: string }[] = [
  { id: 'default', name: 'Default', desc: 'New sessions start here' },
  { id: 'smol', name: 'Fast', desc: 'Quick, cheap work' },
  { id: 'slow', name: 'Thinking', desc: 'Hard reasoning' },
  { id: 'plan', name: 'Architect', desc: 'Plan mode' },
  { id: 'task', name: 'Subtask', desc: 'Subagents' },
  { id: 'commit', name: 'Commit', desc: 'Commit messages' },
  { id: 'vision', name: 'Vision', desc: 'Reading images' },
  { id: 'designer', name: 'Designer', desc: 'UI and design work' },
  { id: 'tiny', name: 'Tiny', desc: 'Trivial decisions' },
  { id: 'advisor', name: 'Advisor', desc: 'Second opinion' },
  { id: 'judge', name: 'Judge', desc: 'Typed decisions — Jev' }
]

export const roleName = (id: string): string => ROLES.find((r) => r.id === id)?.name ?? id

/** Jev is a decisions model, not a chat model: omp only uses it as the judge. */
export const JEV: { value: string; name: string; note: string }[] = [
  { value: 'openrouter/typesafe/jev-1.13', name: 'Jev 1.13', note: 'pinned · via OpenRouter' },
  { value: 'openrouter/~typesafe/jev-latest', name: 'Jev (latest)', note: 'via OpenRouter' },
  { value: 'typesafe/jev-latest', name: 'Jev (latest)', note: 'TypeSafe direct' }
]
export const isJev = (value: string): boolean => JEV.some((j) => j.value === value) || /typesafe\/.*jev/.test(value)

export const LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

/** "provider/model:level" → parts; the suffix only counts when it is a thinking level. */
export function splitRole(value: string | undefined): { model: string; level: string } {
  if (!value) return { model: '', level: '' }
  const at = value.lastIndexOf(':')
  if (at > 0 && LEVELS.includes(value.slice(at + 1))) return { model: value.slice(0, at), level: value.slice(at + 1) }
  return { model: value, level: '' }
}

export const keyOf = (m: { provider: string; id: string }): string => `${m.provider}/${m.id}`

export function fmtCtx(n?: number): string {
  if (!n) return ''
  if (n >= 1_000_000) return `${+(n / 1_000_000).toFixed(1)}M`
  return `${Math.round(n / 1000)}k`
}

const money = (n: number): string => (n >= 1 ? `${+n.toFixed(2)}` : `${+n.toFixed(3)}`)

export function fmtPrice(m: ModelInfo): string {
  if (!m.costIn && !m.costOut) return 'free'
  return `$${money(m.costIn ?? 0)}/${money(m.costOut ?? 0)}`
}

/** Measured speed when omp has samples ("2.5s 87t/s"), else its estimate ("~77t/s"). */
export function fmtSpeed(m: ModelInfo, perf?: ModelPerf): string {
  if (perf && perf.tps > 0) return `${perf.ttftSec ? `${perf.ttftSec.toFixed(1)}s ` : ''}${Math.round(perf.tps)}t/s`
  return m.tps ? `~${Math.round(m.tps)}t/s` : ''
}

/** The thinking choices a model accepts: inherit, then off, then its own efforts. */
export function thinkingChoices(m?: ModelInfo): string[] {
  if (!m?.reasoning) return []
  const efforts = m.efforts?.length ? m.efforts : ['low', 'medium', 'high']
  return ['inherit', 'off', ...efforts.filter((e) => e !== 'off')]
}
