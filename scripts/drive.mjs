// Launch the built app under Playwright and run a scenario module against it.
//   node scripts/drive.mjs <scenario.mjs> <outDir>
import { _electron as electron } from 'playwright-core'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
const [scenarioPath, outDir] = process.argv.slice(2)
mkdirSync(outDir, { recursive: true })
const app = await electron.launch({ args: [resolve('.')], env: { ...process.env, CLAPI_E2E: '1' }, timeout: 60_000 })
const win = await app.firstWindow()
const errors = []
win.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
win.on('pageerror', (e) => errors.push(String(e)))
let n = 0
const shot = async (name) => { const p = `${outDir}/${String(++n).padStart(2, '0')}-${name}.png`; await win.screenshot({ path: p }); console.log('shot', p) }
try {
  await win.setViewportSize?.({ width: 1440, height: 900 }).catch(() => {})
  const { default: scenario } = await import(resolve(scenarioPath))
  await scenario({ app, win, shot, log: (...a) => console.log(...a) })
} catch (e) {
  console.log('SCENARIO ERROR', e?.message ?? e)
  await shot('error').catch(() => {})
} finally {
  if (errors.length) console.log('RENDERER ERRORS:\n' + errors.slice(0, 10).join('\n'))
  await app.close().catch(() => {})
}
