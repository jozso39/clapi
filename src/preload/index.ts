import { contextBridge, ipcRenderer } from 'electron'
import type { ClapiApi } from './api'

const invoke = (channel: string, ...args: unknown[]): Promise<any> => ipcRenderer.invoke(channel, ...args)

function subscribe(channel: string, cb: (payload: any) => void): () => void {
  const listener = (_e: Electron.IpcRendererEvent, payload: any): void => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api: ClapiApi = {
  sessions: {
    list: () => invoke('sessions:list'),
    transcript: (path, opts) => invoke('sessions:transcript', path, opts),
    runtimes: () => invoke('sessions:runtimes'),
    open: (id, path, cwd) => invoke('sessions:open', id, path, cwd),
    create: (cwd) => invoke('sessions:create', cwd),
    prompt: (id, text) => invoke('sessions:prompt', id, text),
    abort: (id) => invoke('sessions:abort', id),
    setModel: (id, model) => invoke('sessions:setModel', id, model),
    setThinking: (id, level) => invoke('sessions:setThinking', id, level),
    respond: (id, requestId, response) => invoke('sessions:respond', id, requestId, response),
    stop: (id) => invoke('sessions:stop', id),
    rename: (id, path, title) => invoke('sessions:rename', id, path, title),
    remove: (id, path) => invoke('sessions:delete', id, path),
    fork: (path, entryId, title) => invoke('sessions:fork', path, entryId, title),
    openIn: (target, cwd, id) => invoke('sessions:openIn', target, cwd, id)
  },
  models: {
    list: (force) => invoke('models:list', force),
    thinkingLevels: () => invoke('models:thinkingLevels'),
    commands: () => invoke('models:commands'),
    perf: () => invoke('models:perf')
  },
  roles: {
    get: () => invoke('roles:get'),
    set: (roles) => invoke('roles:set', roles)
  },
  auth: {
    providers: () => invoke('auth:providers'),
    keys: () => invoke('auth:keys'),
    stored: () => invoke('auth:stored'),
    logout: (providerId) => invoke('auth:logout', providerId),
    setKey: (name, value) => invoke('auth:setKey', name, value),
    login: (providerId) => invoke('auth:login', providerId),
    respond: (requestId, response) => invoke('auth:respond', requestId, response),
    cancel: () => invoke('auth:cancel')
  },
  claude: {
    list: () => invoke('claude:list'),
    import: (info) => invoke('claude:import', info)
  },
  prefs: {
    load: () => invoke('prefs:load'),
    save: (prefs) => invoke('prefs:save', prefs)
  },
  app: {
    info: () => invoke('app:info'),
    pickFolder: () => invoke('app:pickFolder'),
    openExternal: (url) => invoke('app:openExternal', url)
  },
  on: {
    runtime: (cb) => subscribe('runtime:event', cb),
    sessionsChanged: (cb) => subscribe('sessions:changed', cb),
    auth: (cb) => subscribe('auth:event', cb)
  }
}

contextBridge.exposeInMainWorld('clapi', api)
