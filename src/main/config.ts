// omp configuration Clapi edits: model roles (config.yml, through omp's own
// `omp config` CLI) and API keys (~/.omp/.env, which omp loads at startup).
import { execFile } from 'node:child_process'
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { ApiKeyStatus, ModelRoles } from '../shared/types'
import { OMP_HOME, childEnv, ompBinary } from './env'

async function omp(args: string[]): Promise<string> {
  const [bin, env] = await Promise.all([ompBinary(), childEnv()])
  return new Promise((resolve, reject) => {
    execFile(bin, args, { env, cwd: homedir(), timeout: 30_000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || err.message).trim()))
      else resolve(stdout)
    })
  })
}

export async function getRoles(): Promise<ModelRoles> {
  const out = (await omp(['config', 'get', 'modelRoles'])).trim()
  try {
    const parsed = JSON.parse(out)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

/** `modelRoles` is a record; omp only accepts it whole (dotted keys are "Unknown setting"). */
export async function setRoles(roles: ModelRoles): Promise<ModelRoles> {
  const clean: ModelRoles = {}
  for (const [role, model] of Object.entries(roles)) {
    if (/^[a-z][a-z0-9_-]*$/i.test(role) && typeof model === 'string' && model.trim()) clean[role] = model.trim()
  }
  await omp(['config', 'set', 'modelRoles', JSON.stringify(clean)])
  return getRoles()
}

// ─── API keys in ~/.omp/.env ─────────────────────────────────────────────────

export const ENV_FILE = join(OMP_HOME, '.env')

/** The keys Clapi offers in Accounts; omp reads each from its environment. */
export const KNOWN_KEYS = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'TYPESAFE_API_KEY', 'OPENROUTER_API_KEY']

async function envFileLines(): Promise<string[]> {
  try {
    return (await readFile(ENV_FILE, 'utf8')).split('\n')
  } catch {
    return []
  }
}

const keyOf = (line: string): string | null => /^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=/.exec(line)?.[1] ?? null

export async function keyStatus(): Promise<ApiKeyStatus[]> {
  const [lines, env] = await Promise.all([envFileLines(), childEnv()])
  const inFile = new Set(lines.map(keyOf).filter(Boolean) as string[])
  return KNOWN_KEYS.map((name) => {
    if (inFile.has(name)) return { env: name, present: true, source: 'omp-env' as const }
    if (env[name]) return { env: name, present: true, source: 'process' as const }
    return { env: name, present: false }
  })
}

/** Add, replace, or (empty value) remove one KEY=value line. Never logs the value. */
export async function setKey(name: string, value: string): Promise<void> {
  if (!/^[A-Z][A-Z0-9_]*$/.test(name)) throw new Error('Invalid variable name')
  if (/[\r\n]/.test(value)) throw new Error('A key cannot contain line breaks')
  const lines = (await envFileLines()).filter((l) => keyOf(l) !== name)
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  if (value.trim()) lines.push(`${name}=${value.trim()}`)
  await mkdir(OMP_HOME, { recursive: true })
  await writeFile(ENV_FILE, lines.length ? `${lines.join('\n')}\n` : '', { mode: 0o600 })
  await chmod(ENV_FILE, 0o600)
}
