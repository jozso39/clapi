// Every renderer → main call. The renderer never touches the filesystem or
// spawns anything; it asks here, and arguments are checked before use.
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { homedir } from 'node:os'
import { DEFAULT_PREFS, type ModelRef, type ModelRoles, type OpenTarget, type Prefs, type UiResponse } from '../shared/types'
import { logout, modelPerf, storedLogins } from './agent-db'
import { importClaudeSession, listClaudeSessions } from './claude-import'
import { getRoles, keyStatus, setKey, setRoles } from './config'
import type { Control } from './control'
import { CLAPI_HOME, SESSIONS_ROOT } from './env'
import { forkAt } from './fork'
import type { Runtimes } from './runtimes'
import { deleteSessionFiles, getTranscript, listSessions, renameInFile, summarize } from './session-files'

const PREFS_FILE = join(CLAPI_HOME, 'state.json')

function str(v: unknown, what: string): string {
  if (typeof v !== 'string' || !v) throw new Error(`${what} is required`)
  return v
}

function sessionPath(v: unknown): string {
  const p = str(v, 'session path')
  if (!p.startsWith(SESSIONS_ROOT + '/') || !p.endsWith('.jsonl')) throw new Error('not an omp session file')
  return p
}

async function loadPrefs(): Promise<Prefs> {
  try {
    return { ...DEFAULT_PREFS, ...JSON.parse(await readFile(PREFS_FILE, 'utf8')) }
  } catch {
    return { ...DEFAULT_PREFS }
  }
}

async function savePrefs(prefs: Prefs): Promise<void> {
  await mkdir(CLAPI_HOME, { recursive: true })
  const tmp = `${PREFS_FILE}.tmp`
  await writeFile(tmp, JSON.stringify(prefs, null, 2))
  await rename(tmp, PREFS_FILE)
}

function appleScriptString(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

async function openIn(target: OpenTarget, cwd: string, sessionId: string): Promise<void> {
  if (!existsSync(cwd)) throw new Error(`${cwd} no longer exists`)
  if (target === 'finder') {
    await shell.openPath(cwd)
  } else if (target === 'vscode') {
    spawn('open', ['-a', 'Visual Studio Code', cwd], { detached: true, stdio: 'ignore' }).unref()
  } else {
    if (!/^[0-9a-f-]+$/i.test(sessionId)) throw new Error('bad session id')
    const sh = `cd '${cwd.replace(/'/g, `'\\''`)}' && omp --resume ${sessionId}`
    spawn('osascript', ['-e', 'tell application "Terminal" to activate', '-e', `tell application "Terminal" to do script ${appleScriptString(sh)}`], {
      detached: true,
      stdio: 'ignore'
    }).unref()
  }
}

export function registerIpc(win: () => BrowserWindow | null, runtimes: Runtimes, control: Control): void {
  const handle = (channel: string, fn: (...args: any[]) => unknown): void => {
    ipcMain.handle(channel, (_e, ...args) => fn(...args))
  }

  // sessions
  handle('sessions:list', () => listSessions())
  handle('sessions:transcript', (path, opts) => getTranscript(sessionPath(path), opts ?? {}))
  handle('sessions:runtimes', () => runtimes.states())
  handle('sessions:open', async (id, path, cwd) => (await runtimes.ensure(str(id, 'id'), sessionPath(path), str(cwd, 'cwd'))).state)
  handle('sessions:create', (cwd) => {
    const dir = str(cwd, 'folder')
    if (!existsSync(dir)) throw new Error(`${dir} does not exist`)
    return runtimes.create(dir)
  })
  const live = (id: unknown) => {
    const rt = runtimes.get(str(id, 'id'))
    if (!rt) throw new Error('This session is not running')
    return rt
  }
  handle('sessions:prompt', (id, text) => runtimes.prompt(live(id), str(text, 'message')))
  handle('sessions:abort', (id) => live(id).rpc.request({ type: 'abort' }))
  handle('sessions:setModel', (id, model: ModelRef) => runtimes.setModel(live(id), model))
  handle('sessions:setThinking', (id, level) => runtimes.setThinking(live(id), str(level, 'level')))
  handle('sessions:respond', (id, requestId, response: UiResponse) => live(id).rpc.respondUi(str(requestId, 'request'), response as Record<string, unknown>))
  handle('sessions:stop', (id) => runtimes.stop(str(id, 'id')))
  handle('sessions:rename', async (id, path, title) => {
    const t = str(title, 'title').trim()
    const rt = runtimes.get(str(id, 'id'))
    // A running omp owns its file; ask it, so its in-memory title agrees.
    if (rt) await rt.rpc.request({ type: 'set_session_name', name: t })
    else await renameInFile(sessionPath(path), t)
  })
  handle('sessions:delete', async (id, path) => {
    await runtimes.stop(str(id, 'id'))
    await deleteSessionFiles(sessionPath(path))
  })
  handle('sessions:fork', async (path, entryId, title) => {
    const res = await forkAt(sessionPath(path), typeof entryId === 'string' ? entryId : null, typeof title === 'string' && title.trim() ? title.trim() : undefined)
    return summarize(res.path)
  })
  handle('sessions:openIn', (target: OpenTarget, cwd, id) => openIn(target, str(cwd, 'cwd'), str(id, 'id')))

  // models, commands
  handle('models:list', (force) => control.listModels(force === true))
  handle('models:thinkingLevels', () => control.thinkingLevels())
  handle('models:commands', () => control.commands())
  handle('models:perf', () => modelPerf())

  // roles
  handle('roles:get', () => getRoles())
  handle('roles:set', async (roles: ModelRoles) => {
    const saved = await setRoles(roles)
    await runtimes.restartAll()
    return saved
  })

  // accounts
  handle('auth:providers', () => control.loginProviders())
  handle('auth:keys', () => keyStatus())
  handle('auth:stored', () => storedLogins())
  handle('auth:logout', async (providerId) => {
    const n = await logout(str(providerId, 'provider'))
    // Running omp sessions reload credentials on their own (auth_change_revision);
    // the control process is restarted so the provider list is fresh at once.
    await control.restart()
    return n
  })
  handle('auth:setKey', async (name, value) => {
    await setKey(str(name, 'name'), typeof value === 'string' ? value : '')
    // omp loads ~/.omp/.env at process start only.
    await control.restart()
    await runtimes.restartAll()
  })
  handle('auth:login', (providerId) => {
    const id = str(providerId, 'provider')
    void control
      .login(id, (event) => win()?.webContents.send('auth:event', event))
      .then(() => runtimes.restartAll())
  })
  handle('auth:respond', (requestId, response: UiResponse) => control.respond(str(requestId, 'request'), response))
  handle('auth:cancel', () => control.restart())

  // Claude Code import
  handle('claude:list', () => listClaudeSessions())
  handle('claude:import', async (info) => {
    const res = await importClaudeSession({ id: str(info?.id, 'id'), path: str(info?.path, 'path'), cwd: String(info?.cwd ?? '') })
    return summarize(res.path)
  })

  // app
  handle('app:info', () => ({ home: homedir(), version: app.getVersion() }))
  handle('prefs:load', () => loadPrefs())
  handle('prefs:save', (prefs: Prefs) => savePrefs(prefs))
  handle('app:pickFolder', async () => {
    const w = win()
    const res = w
      ? await dialog.showOpenDialog(w, { properties: ['openDirectory', 'createDirectory'], title: 'Choose a project folder' })
      : await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] })
    return res.canceled ? null : res.filePaths[0] ?? null
  })
  handle('app:openExternal', (url) => {
    const u = new URL(str(url, 'url'))
    if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('Only web links can be opened')
    if (process.env.CLAPI_E2E) {
      console.log(`[e2e] would open ${u.origin}${u.pathname}`)
      return
    }
    return shell.openExternal(u.toString())
  })
}
