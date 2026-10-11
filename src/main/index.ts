import { watch, type FSWatcher } from 'node:fs'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { app, BrowserWindow, Menu, shell } from 'electron'
import type { RuntimeEvent } from '../shared/types'
import { Control } from './control'
import { childEnv, SESSIONS_ROOT } from './env'
import { registerIpc } from './ipc'
import { Runtimes } from './runtimes'

let win: BrowserWindow | null = null
let sessionsWatcher: FSWatcher | null = null

const send = (channel: string, payload?: unknown): void => {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
}

const runtimes = new Runtimes((event: RuntimeEvent) => send('runtime:event', event))
const control = new Control()

function createWindow(): void {
  win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 880,
    minHeight: 560,
    show: false,
    title: 'Clapi',
    backgroundColor: '#0f161e',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 18, y: 18 },
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  // Under the test driver the window must never take focus from the user —
  // their keystrokes would land in it.
  win.once('ready-to-show', () => (process.env.CLAPI_E2E ? win?.showInactive() : win?.show()))
  win.on('closed', () => {
    win = null
  })
  // Links in chat open in the browser, never inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url) && !process.env.CLAPI_E2E) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e, url) => {
    if (url !== win?.webContents.getURL()) {
      e.preventDefault()
      if (/^https?:\/\//.test(url)) void shell.openExternal(url)
    }
  })
  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void win.loadFile(join(__dirname, '../renderer/index.html'))
}

/** One recursive watch (FSEvents: a single descriptor) for the sidebar. */
function watchSessions(): void {
  mkdirSync(SESSIONS_ROOT, { recursive: true })
  let timer: NodeJS.Timeout | null = null
  sessionsWatcher = watch(SESSIONS_ROOT, { recursive: true }, (_event, file) => {
    // Whole project folders can appear or vanish (moved, trashed), so only
    // omp's lock files and our own temp files are noise.
    const name = String(file ?? '')
    if (/\.lock(\.os)?$|\.tmp-\d+$/.test(name)) return
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => send('sessions:changed'), 400)
  })
  sessionsWatcher.on('error', () => undefined)
}

function buildMenu(): void {
  // No accelerators that collide with the app's own shortcuts (⌘W, ⌘N, ⌘K…):
  // the renderer owns those, like Claude Desktop's Code tab.
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: 'Clapi',
      submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' }]
    },
    { label: 'Edit', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    {
      label: 'View',
      submenu: [
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        ...(app.isPackaged ? [] : [{ role: 'reload' as const }, { role: 'toggleDevTools' as const }])
      ]
    },
    { label: 'Window', submenu: [{ role: 'minimize' }, { role: 'zoom' }, { type: 'separator' }, { role: 'front' }] }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

// The test driver runs beside an installed copy: give it its own profile and
// skip the single-instance lock, or it would just hand over to the real app.
if (process.env.CLAPI_E2E) app.setPath('userData', join(app.getPath('temp'), 'clapi-e2e'))

if (!process.env.CLAPI_E2E && !app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore()
      win.focus()
    }
  })
  app.whenReady().then(() => {
    app.setName('Clapi')
    if (process.env.CLAPI_E2E) app.dock?.hide()
    void childEnv() // warm the login-shell environment while the window loads
    buildMenu()
    registerIpc(() => win, runtimes, control)
    watchSessions()
    createWindow()
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })
}

let quitting = false
app.on('before-quit', (e) => {
  if (quitting) return
  quitting = true
  e.preventDefault()
  sessionsWatcher?.close()
  // omp drains and exits on stdin EOF; give it a moment, then go.
  void Promise.race([Promise.all([runtimes.stopAll(), control.restart()]), new Promise((r) => setTimeout(r, 5000))]).finally(() => app.exit(0))
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
