// Every test runs against throwaway directories. These env vars must be set
// before any src/main module is imported, because paths are resolved at load.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const TMP = mkdtempSync(join(tmpdir(), 'clapi-test-'))
process.env.CLAPI_HOME = join(TMP, 'clapi-home')
process.env.CLAPI_OMP_HOME = join(TMP, 'omp-home')
process.env.CLAPI_SESSIONS_ROOT = join(TMP, 'omp-home', 'agent', 'sessions')

export const line = (o: unknown): string => JSON.stringify(o)

/** A minimal omp v3 session: title slot, header, then the given entries. */
export function sessionBody(slot: string, header: Record<string, unknown>, entries: Record<string, unknown>[]): string {
  return slot + `${line({ type: 'session', version: 3, ...header })}\n` + entries.map((e) => `${line(e)}\n`).join('')
}
