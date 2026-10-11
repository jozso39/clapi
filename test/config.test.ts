// Runs omp's real `omp config` CLI, pointed at a throwaway agent directory via
// PI_CODING_AGENT_DIR, so the user's ~/.omp/agent/config.yml is never touched.
import { TMP } from './helpers'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { before, test } from 'node:test'

process.env.PI_CODING_AGENT_DIR = join(TMP, 'agent')
mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true })

let cfg: typeof import('../src/main/config')
// Imported only after PI_CODING_AGENT_DIR is set above.
before(async () => {
  cfg = await import('../src/main/config')
})

test('model roles round-trip through omp, including Jev as the judge', { timeout: 60_000 }, async () => {
  const { getRoles, setRoles } = cfg
  const saved = await setRoles({
    judge: 'openrouter/typesafe/jev-1.13',
    smol: 'anthropic/claude-haiku-4-5:low',
    'not a role!': 'anthropic/x',
    empty: '  '
  })
  assert.deepEqual(saved, { judge: 'openrouter/typesafe/jev-1.13', smol: 'anthropic/claude-haiku-4-5:low' })
  assert.deepEqual(await getRoles(), saved)
  const yml = readFileSync(join(process.env.PI_CODING_AGENT_DIR!, 'config.yml'), 'utf8')
  assert.match(yml, /judge: openrouter\/typesafe\/jev-1\.13/)
  // clearing a role = saving the record without it
  assert.deepEqual(await setRoles({ judge: 'openrouter/typesafe/jev-1.13' }), { judge: 'openrouter/typesafe/jev-1.13' })
})

test('API keys: add, replace, remove — other lines kept, file private', async () => {
  const { setKey, ENV_FILE } = cfg
  mkdirSync(join(TMP, 'omp-home'), { recursive: true })
  writeFileSync(ENV_FILE, '# mine\nOTHER=1\nexport OPENROUTER_API_KEY=old\n')
  await setKey('OPENROUTER_API_KEY', 'sk-or-new')
  await setKey('TYPESAFE_API_KEY', 'ts-1')
  assert.equal(readFileSync(ENV_FILE, 'utf8'), '# mine\nOTHER=1\nOPENROUTER_API_KEY=sk-or-new\nTYPESAFE_API_KEY=ts-1\n')
  await setKey('TYPESAFE_API_KEY', '')
  assert.equal(readFileSync(ENV_FILE, 'utf8'), '# mine\nOTHER=1\nOPENROUTER_API_KEY=sk-or-new\n')
  assert.equal(statSync(ENV_FILE).mode & 0o777, 0o600)
  await assert.rejects(setKey('bad name', 'x'), /Invalid variable name/)
  await assert.rejects(setKey('GOOD_NAME', 'a\nINJECTED=1'), /line breaks/)
})
