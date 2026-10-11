// Build, ad-hoc sign and install Clapi.app into /Applications.
//   npm run install-app            build + install
//   npm run install-app -- --open  …and launch it in the background
import { execFileSync, execSync } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dirname, '..')
const run = (cmd) => execSync(cmd, { cwd: root, stdio: 'inherit' })

// Never quit a Clapi that has session agents running: an in-flight turn
// would be cut off. Close those sessions (⌘W) or pass --force.
function runningSessionAgents() {
  try {
    const pid = execSync('pgrep -f "/Applications/Clapi.app/Contents/MacOS/Clapi"', { encoding: 'utf8' }).trim().split('\n')[0]
    if (!pid) return 0
    const ps = execSync('ps -eo ppid=,args=', { encoding: 'utf8' })
    return ps.split('\n').filter((l) => l.trim().startsWith(`${pid} `) && l.includes('omp --mode rpc --session')).length
  } catch {
    return 0
  }
}
const busy = runningSessionAgents()
if (busy > 0 && !process.argv.includes('--force')) {
  console.error(`Clapi has ${busy} session agent${busy > 1 ? 's' : ''} running. Close them (⌘W) or rerun with --force.`)
  process.exit(1)
}

run('npm run package')
const built = join(root, 'release', process.arch === 'arm64' ? 'mac-arm64' : 'mac', 'Clapi.app')
if (!existsSync(built)) throw new Error(`no app at ${built}`)

// electron-builder skips signing without a certificate, which leaves an
// invalid signature that macOS refuses to launch; an ad-hoc one is enough locally.
execFileSync('codesign', ['--force', '--deep', '--sign', '-', built], { stdio: 'inherit' })
execFileSync('codesign', ['--verify', '--deep', '--strict', built], { stdio: 'inherit' })

try {
  execFileSync('osascript', ['-e', 'tell application "Clapi" to quit'], { stdio: 'ignore' })
} catch {
  // not running
}
const target = '/Applications/Clapi.app'
rmSync(target, { recursive: true, force: true })
execFileSync('cp', ['-R', built, target])
try {
  execFileSync('xattr', ['-dr', 'com.apple.quarantine', target])
} catch {
  // no quarantine attribute
}
console.log(`Installed ${target}`)
if (process.argv.includes('--open')) execFileSync('open', ['-g', '-a', target])
