// The environment omp runs in. A Finder-launched app inherits launchd's bare
// environment, so tools omp spawns (git, node, bun…) would be missing from PATH.
// We capture the user's login-shell environment once, the way editors do.
import { execFile } from 'node:child_process'
import { accessSync, constants } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const MARKER = '__CLAPI_ENV_BEGIN__'
const DROP = ['ELECTRON_RUN_AS_NODE', 'ELECTRON_NO_ATTACH_CONSOLE', 'ELECTRON_ENABLE_LOGGING', 'CLAPI_ENV_PROBE']

let envPromise: Promise<NodeJS.ProcessEnv> | null = null

function readLoginShellEnv(): Promise<NodeJS.ProcessEnv | null> {
  const shell = process.env.SHELL || '/bin/zsh'
  return new Promise((resolve) => {
    execFile(
      shell,
      ['-ilc', `printf '%s' ${MARKER}; env -0`],
      { timeout: 8000, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, CLAPI_ENV_PROBE: '1' } },
      (err, stdout) => {
        // Interactive rc files may print banners before the marker; anything
        // after it is the NUL-separated environment.
        const at = stdout ? stdout.indexOf(MARKER) : -1
        if (err || at < 0) return resolve(null)
        const env: NodeJS.ProcessEnv = {}
        for (const pair of stdout.slice(at + MARKER.length).split('\0')) {
          const eq = pair.indexOf('=')
          if (eq > 0) env[pair.slice(0, eq)] = pair.slice(eq + 1)
        }
        resolve(env)
      }
    )
  })
}

/** process.env overlaid with the login shell's, plus the usual user bin dirs on PATH. */
export function childEnv(): Promise<NodeJS.ProcessEnv> {
  envPromise ??= readLoginShellEnv().then((shellEnv) => {
    const env: NodeJS.ProcessEnv = { ...process.env, ...(shellEnv ?? {}) }
    const parts = (env.PATH ?? '/usr/bin:/bin:/usr/sbin:/sbin').split(':').filter(Boolean)
    for (const dir of ['/usr/local/bin', '/opt/homebrew/bin', join(homedir(), '.bun', 'bin')]) {
      if (!parts.includes(dir)) parts.unshift(dir)
    }
    env.PATH = parts.join(':')
    for (const key of DROP) delete env[key]
    return env
  })
  return envPromise
}

function executable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** Locate the omp binary: $CLAPI_OMP, the bun global bin, Homebrew, then PATH. */
export async function ompBinary(): Promise<string> {
  const env = await childEnv()
  const candidates = [
    process.env.CLAPI_OMP,
    join(homedir(), '.bun', 'bin', 'omp'),
    '/opt/homebrew/bin/omp',
    '/usr/local/bin/omp',
    ...(env.PATH ?? '').split(':').map((dir) => join(dir, 'omp'))
  ].filter((p): p is string => !!p)
  const found = candidates.find(executable)
  if (!found) throw new Error('omp was not found. Install oh-my-pi (bun install -g @oh-my-pi/pi-coding-agent) and restart Clapi.')
  return found
}

// Overridable so tests never touch the real ~/.clapi or ~/.omp.
export const CLAPI_HOME = process.env.CLAPI_HOME || join(homedir(), '.clapi')
export const OMP_HOME = process.env.CLAPI_OMP_HOME || join(homedir(), '.omp')
export const SESSIONS_ROOT = process.env.CLAPI_SESSIONS_ROOT || join(OMP_HOME, 'agent', 'sessions')
