import { TMP, sessionBody } from './helpers'
import assert from 'node:assert/strict'
import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  branchOf,
  bucketFor,
  getTranscript,
  loadEntries,
  readHead,
  renameInFile,
  serializeTitleSlot,
  TITLE_SLOT_BYTES,
  uuidv7
} from '../src/main/session-files'

const msg = (id: string, parentId: string | null, role: string, content: unknown, extra: Record<string, unknown> = {}) => ({
  type: 'message',
  id,
  parentId,
  timestamp: '2026-10-11T10:00:00.000Z',
  message: { role, content, timestamp: 1, ...extra }
})

test('title slot is exactly 256 bytes, also for emoji and over-long titles', () => {
  for (const title of ['', 'AI summary', '📋 Rozpočet pro čtvrtletí — řešení', 'x'.repeat(600), '🙂'.repeat(200)]) {
    const s = serializeTitleSlot(title, 'user', '2026-10-11T10:00:00.000Z')
    assert.equal(Buffer.byteLength(s), TITLE_SLOT_BYTES)
    assert.ok(s.endsWith('\n'))
    const parsed = JSON.parse(s)
    assert.equal(parsed.type, 'title')
    assert.ok(title.startsWith(parsed.title), 'a long title is cut, never altered')
  }
})

test('bucket names match omp: -rel under home, --abs-- elsewhere', () => {
  assert.equal(bucketFor('/Users/alice', '/Users/alice'), '-')
  assert.equal(bucketFor('/Users/alice/Projects/acme-web', '/Users/alice'), '-Projects-acme-web')
  assert.equal(bucketFor('/private/tmp', '/Users/alice'), '--private-tmp--')
})

test('uuidv7: version 7, RFC variant, time-ordered prefix', () => {
  const a = uuidv7(1_700_000_000_000)
  const b = uuidv7(1_700_000_000_001)
  assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  assert.ok(a < b)
})

function writeTreeSession(path: string): void {
  // root u1 → a1 (toolCall) → t1 (toolResult) → a2 (answer) → u2 → a3
  //                                            ↘ u2b → a3b   (an abandoned branch, written earlier)
  const entries = [
    { type: 'model_change', id: 'm0', parentId: null, timestamp: '2026-10-11T10:00:00.000Z', model: 'anthropic/claude-haiku-4-5' },
    msg('u1', 'm0', 'user', [{ type: 'text', text: 'first question' }]),
    msg('a1', 'u1', 'assistant', [{ type: 'thinking', thinking: 'hmm' }, { type: 'toolCall', id: 'call1', name: 'bash', arguments: { command: 'ls' }, intent: 'List files' }], { stopReason: 'toolUse' }),
    msg('t1', 'a1', 'toolResult', [{ type: 'text', text: 'a.txt\nb.txt' }], { toolCallId: 'call1', toolName: 'bash', isError: false }),
    msg('a2', 't1', 'assistant', [{ type: 'text', text: 'first answer' }], { stopReason: 'stop', model: 'claude-haiku-4-5', provider: 'anthropic' }),
    msg('u2b', 'a2', 'user', 'abandoned follow-up'),
    msg('a3b', 'u2b', 'assistant', [{ type: 'text', text: 'abandoned answer' }]),
    { type: 'label', id: 'l1', parentId: 'a3b', timestamp: '2026-10-11T10:00:00.000Z', targetId: 'a2', label: 'good' },
    msg('u2', 'a2', 'user', 'second question'),
    msg('a3', 'u2', 'assistant', [{ type: 'text', text: 'second answer' }])
  ]
  writeFileSync(path, sessionBody(serializeTitleSlot('Tree', 'user', '2026-10-11T10:00:00.000Z'), { id: 'sess-1', timestamp: '2026-10-11T10:00:00.000Z', cwd: '/tmp/proj', title: 'Tree' }, entries))
}

test('the conversation is the parent chain from the last physical entry', async () => {
  const dir = join(TMP, 'tree')
  mkdirSync(dir, { recursive: true })
  const path = join(dir, 'tree.jsonl')
  writeTreeSession(path)
  const state = await loadEntries(path)
  assert.equal(state.header?.id, 'sess-1')
  assert.equal(state.slot?.title, 'Tree')
  assert.deepEqual(
    branchOf(state.byId, state.lastId).map((e) => e.id),
    ['m0', 'u1', 'a1', 't1', 'a2', 'u2', 'a3']
  )
  const t = await getTranscript(path)
  assert.deepEqual(
    t.items.map((i) => i.kind),
    ['notice', 'user', 'assistant', 'toolResult', 'assistant', 'user', 'assistant']
  )
  const call = t.items[2]
  assert.ok(call.kind === 'assistant' && call.blocks[1].type === 'toolCall' && call.blocks[1].intent === 'List files')
  assert.equal(t.items[4].entryId, 'a2', 'items carry entry ids — the handle for forking')
})

test('appends are picked up incrementally, a torn last line is not', async () => {
  const path = join(TMP, 'tree', 'tree.jsonl')
  const before = (await loadEntries(path)).byId.size
  appendFileSync(path, `${JSON.stringify(msg('u3', 'a3', 'user', 'third'))}\n{"type":"message","id":"half`)
  const after = await loadEntries(path)
  assert.equal(after.byId.size, before + 1)
  assert.equal(after.lastId, 'u3')
})

test('rename rewrites only the fixed-width first line', async () => {
  const dir = join(TMP, 'rename')
  mkdirSync(dir, { recursive: true })
  const path = join(dir, 'r.jsonl')
  writeTreeSession(path)
  const original = readFileSync(path)
  await renameInFile(path, 'Renamed 📋')
  const after = readFileSync(path)
  assert.equal(after.length, original.length)
  assert.ok(after.subarray(TITLE_SLOT_BYTES).equals(original.subarray(TITLE_SLOT_BYTES)))
  assert.equal((await readHead(path))?.slot?.title, 'Renamed 📋')
  assert.equal(statSync(path).size, original.length)
})
