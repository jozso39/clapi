import { TMP } from './helpers'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { before, test } from 'node:test'

// omp's own schema for the parts Clapi touches, including the revision triggers.
const SCHEMA = `
CREATE TABLE auth_credentials (id INTEGER PRIMARY KEY AUTOINCREMENT, provider TEXT NOT NULL, credential_type TEXT NOT NULL,
  data TEXT NOT NULL, disabled_cause TEXT DEFAULT NULL, identity_key TEXT DEFAULT NULL,
  created_at INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL DEFAULT 0);
CREATE TABLE auth_change_revision (id INTEGER PRIMARY KEY CHECK (id = 1), revision INTEGER NOT NULL);
INSERT INTO auth_change_revision VALUES (1, 7);
CREATE TRIGGER rev_upd AFTER UPDATE ON auth_credentials BEGIN UPDATE auth_change_revision SET revision = revision + 1 WHERE id = 1; END;
CREATE TABLE model_perf (model_key TEXT PRIMARY KEY, samples REAL NOT NULL DEFAULT 0, output_tokens REAL NOT NULL DEFAULT 0,
  gen_ms REAL NOT NULL DEFAULT 0, ttft_samples REAL NOT NULL DEFAULT 0, ttft_ms REAL NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL DEFAULT 0);
INSERT INTO auth_credentials (provider, credential_type, data) VALUES ('anthropic','oauth','{}'), ('anthropic','oauth','{}'), ('openai-codex','oauth','{}');
INSERT INTO auth_credentials (provider, credential_type, data, disabled_cause) VALUES ('kimi-code','oauth','{}','expired');
INSERT INTO model_perf VALUES ('anthropic/claude-opus-4-8', 181, 260081.15, 4459174.87, 181, 1495507.16, 0);
`
const db = join(TMP, 'omp-home', 'agent', 'agent.db')
const sql = (q: string): string => execFileSync('/usr/bin/sqlite3', [db, q], { encoding: 'utf8' }).trim()

let agentDb: typeof import('../src/main/agent-db')
before(async () => {
  mkdirSync(join(TMP, 'omp-home', 'agent'), { recursive: true })
  execFileSync('/usr/bin/sqlite3', [db, SCHEMA])
  agentDb = await import('../src/main/agent-db')
})

test('stored logins: active credentials only, counted per provider', async () => {
  assert.deepEqual(await agentDb.storedLogins(), { anthropic: 2, 'openai-codex': 1 })
})

test('logout marks exactly that provider deleted, like omp /logout, and bumps the revision', async () => {
  assert.equal(await agentDb.logout('anthropic'), 2)
  assert.equal(sql("SELECT COUNT(*) FROM auth_credentials WHERE provider='anthropic' AND disabled_cause='deleted by user'"), '2')
  assert.equal(sql("SELECT disabled_cause IS NULL FROM auth_credentials WHERE provider='openai-codex'"), '1')
  assert.equal(sql("SELECT disabled_cause FROM auth_credentials WHERE provider='kimi-code'"), 'expired', 'an earlier cause is kept')
  assert.ok(Number(sql('SELECT revision FROM auth_change_revision')) > 7, 'running omp processes notice via the revision')
  assert.deepEqual(await agentDb.storedLogins(), { 'openai-codex': 1 })
  assert.equal(await agentDb.logout('anthropic'), 0, 'logging out twice is a no-op')
  await assert.rejects(agentDb.logout("x'; DROP TABLE auth_credentials; --"), /Invalid provider id/)
})

test('measured speed matches omp: 8.3s to first token, 58 tokens/s', async () => {
  const perf = (await agentDb.modelPerf())['anthropic/claude-opus-4-8']
  assert.equal(perf.ttftSec.toFixed(1), '8.3')
  assert.equal(Math.round(perf.tps), 58)
})
