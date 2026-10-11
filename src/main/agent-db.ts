// Reads and the one write Clapi makes against omp's agent.db, through the
// system sqlite3 (every Mac has /usr/bin/sqlite3; no native module to rebuild).
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { ModelPerf } from '../shared/types'
import { OMP_HOME } from './env'

const DB = (): string => join(OMP_HOME, 'agent', 'agent.db')
const PROVIDER_ID = /^[a-z0-9][a-z0-9._-]*$/i

function sqlite(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('/usr/bin/sqlite3', args, { timeout: 15_000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || err.message).trim()))
      else resolve(stdout)
    })
  })
}

async function query<T>(sql: string): Promise<T[]> {
  if (!existsSync(DB())) return []
  const out = await sqlite(['-readonly', '-json', '-cmd', '.timeout 5000', DB(), sql])
  return out.trim() ? (JSON.parse(out) as T[]) : []
}

/** omp's measured time-to-first-token and throughput per model ("provider/id"). */
export async function modelPerf(): Promise<Record<string, ModelPerf>> {
  const rows = await query<{ model_key: string; samples: number; output_tokens: number; gen_ms: number; ttft_samples: number; ttft_ms: number }>(
    'SELECT model_key, samples, output_tokens, gen_ms, ttft_samples, ttft_ms FROM model_perf WHERE samples > 0'
  )
  const out: Record<string, ModelPerf> = {}
  for (const r of rows) {
    if (r.gen_ms <= 0) continue
    out[r.model_key] = {
      samples: r.samples,
      tps: r.output_tokens / (r.gen_ms / 1000),
      ttftSec: r.ttft_samples > 0 ? r.ttft_ms / r.ttft_samples / 1000 : 0
    }
  }
  return out
}

/** Providers with an active credential stored by `omp login` (not env keys). */
export async function storedLogins(): Promise<Record<string, number>> {
  const rows = await query<{ provider: string; n: number }>(
    'SELECT provider, COUNT(*) AS n FROM auth_credentials WHERE disabled_cause IS NULL GROUP BY provider'
  )
  return Object.fromEntries(rows.map((r) => [r.provider, r.n]))
}

/**
 * Log out exactly like omp's `/logout` (AuthStorage.remove →
 * deleteAuthCredentialsForProvider): mark the provider's credentials
 * "deleted by user". The table's triggers bump auth_change_revision, which is
 * how running omp processes notice and reload.
 */
export async function logout(provider: string): Promise<number> {
  if (!PROVIDER_ID.test(provider)) throw new Error('Invalid provider id')
  if (!existsSync(DB())) return 0
  const out = await sqlite([
    '-cmd',
    '.timeout 5000',
    DB(),
    `UPDATE auth_credentials SET disabled_cause = 'deleted by user', updated_at = CAST(strftime('%s','now') AS INTEGER) WHERE provider = '${provider}' AND disabled_cause IS NULL; SELECT changes();`
  ])
  return Number(out.trim()) || 0
}
