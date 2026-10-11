import { TMP, line, sessionBody } from './helpers'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { importClaudeSession } from '../src/main/claude-import'
import { forkAt } from '../src/main/fork'
import { bucketFor, loadEntries, serializeTitleSlot, TITLE_SLOT_BYTES } from '../src/main/session-files'

const sha = (p: string): string => createHash('sha256').update(readFileSync(p)).digest('hex')

test('fork at a message: root→entry only, labels dropped, source untouched', async () => {
  const dir = join(process.env.CLAPI_SESSIONS_ROOT!, '-proj')
  mkdirSync(dir, { recursive: true })
  const src = join(dir, '2026-10-11T10-00-00-000Z_src.jsonl')
  const e = (id: string, parentId: string | null, type = 'message', extra: Record<string, unknown> = {}) => ({ type, id, parentId, timestamp: '2026-10-11T10:00:00.000Z', ...extra })
  writeFileSync(
    src,
    sessionBody(serializeTitleSlot('Source', 'auto', '2026-10-11T10:00:00.000Z'), { id: 'src', timestamp: '2026-10-11T10:00:00.000Z', cwd: '/tmp/proj', title: 'Source', additionalDirectories: ['/tmp/other'] }, [
      e('u1', null, 'message', { message: { role: 'user', content: 'q1' } }),
      e('a1', 'u1', 'message', { message: { role: 'assistant', content: [{ type: 'text', text: 'answer one' }] } }),
      e('lab', 'a1', 'label', { targetId: 'a1', label: 'keep?' }),
      e('u2', 'lab', 'message', { message: { role: 'user', content: 'q2' } }),
      e('a2', 'u2', 'message', { message: { role: 'assistant', content: [{ type: 'text', text: 'answer two' }] } })
    ])
  )
  const before = sha(src)
  const res = await forkAt(src, 'a1', 'Source (fork)')

  assert.equal(sha(src), before, 'the source file is never modified')
  assert.equal(dirname(res.path), dir, 'the fork lives in the same project bucket')
  assert.match(res.path, new RegExp(`_${res.id}\\.jsonl$`))
  const body = readFileSync(res.path, 'utf8')
  assert.equal(Buffer.byteLength(body.split('\n')[0] + '\n'), TITLE_SLOT_BYTES)
  const forked = await loadEntries(res.path)
  assert.deepEqual([...forked.byId.keys()], ['u1', 'a1'])
  assert.equal(forked.lastId, 'a1')
  assert.equal(forked.header?.parentSession, src)
  assert.deepEqual(forked.header?.additionalDirectories, ['/tmp/other'])
  assert.equal(forked.slot?.title, 'Source (fork)')
  assert.equal(forked.slot?.source, 'user')
  // entry lines are copied byte-for-byte
  const srcLine = readFileSync(src, 'utf8').split('\n').find((l) => l.includes('"id":"a1"'))
  assert.ok(body.includes(srcLine!))

  await assert.rejects(forkAt(src, 'nope'), /not in this session/)
})

test('Claude Code import: blocks, tool names, branches, sidechains, title, marker', async () => {
  const claudeDir = join(TMP, 'claude', 'projects', '-tmp-proj')
  mkdirSync(claudeDir, { recursive: true })
  const path = join(claudeDir, 'claude-1.jsonl')
  const ts = '2026-10-01T09:00:00.000Z'
  const records = [
    { type: 'user', uuid: 'c1', parentUuid: null, cwd: '/definitely/missing/dir', timestamp: ts, message: { role: 'user', content: 'Fix the bug' } },
    {
      type: 'assistant',
      uuid: 'c2',
      parentUuid: 'c1',
      timestamp: ts,
      message: {
        id: 'msg_1',
        model: 'claude-opus-4-8',
        stop_reason: 'tool_use',
        usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100 },
        content: [
          { type: 'thinking', thinking: 'look first', signature: 'sig' },
          { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls' } }
        ]
      }
    },
    { type: 'user', uuid: 'c3', parentUuid: 'c2', timestamp: ts, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'a.txt', is_error: false }] } },
    { type: 'assistant', uuid: 'side', parentUuid: 'c3', isSidechain: true, timestamp: ts, message: { model: 'claude-opus-4-8', content: [{ type: 'text', text: 'subagent noise' }] } },
    { type: 'attachment', uuid: 'att', parentUuid: 'c3', timestamp: ts },
    { type: 'assistant', uuid: 'c4', parentUuid: 'att', timestamp: ts, message: { model: 'claude-opus-4-8', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Fixed.' }] } },
    { type: 'custom-title', customTitle: 'Bug hunt', sessionId: 'claude-1' }
  ]
  writeFileSync(path, records.map(line).join('\n') + '\n')

  const res = await importClaudeSession({ id: 'claude-1', path, cwd: '/tmp/proj' })
  const state = await loadEntries(res.path)
  const entries = [...state.byId.values()]
  assert.deepEqual(
    entries.map((e) => (e.type === 'message' ? e.message.role : e.type)),
    ['user', 'model_change', 'assistant', 'toolResult', 'assistant', 'custom']
  )
  const [user, model, call, result, answer, marker] = entries
  assert.equal(user.message.content, 'Fix the bug')
  assert.equal(model.model, 'anthropic/claude-opus-4-8')
  assert.deepEqual(call.message.content[1], { type: 'toolCall', id: 'toolu_1', name: 'Bash', arguments: { command: 'ls' } })
  assert.equal(call.message.content[0].thinkingSignature, 'sig')
  assert.equal(call.message.stopReason, 'toolUse')
  assert.equal(call.message.usage.cacheRead, 100)
  assert.equal(result.message.toolName, 'Bash', 'tool results learn their tool name from the call')
  assert.equal(answer.parentId, result.id, 'a non-message record in between does not break the chain')
  assert.equal(answer.message.stopReason, 'stop')
  assert.equal(marker.customType, 'foreign_session_import')
  assert.equal(marker.data.sourceId, 'claude-1')
  assert.ok(!entries.some((e) => JSON.stringify(e).includes('subagent noise')), 'sidechains are skipped')

  assert.equal(state.slot?.title, 'Bug hunt')
  // the recorded cwd no longer exists, so the session falls back to home
  assert.notEqual(state.header?.cwd, '/definitely/missing/dir')
  assert.ok(res.path.includes(`/${bucketFor(state.header!.cwd)}/`))
  const imports = JSON.parse(readFileSync(join(process.env.CLAPI_HOME!, 'imports.json'), 'utf8'))
  assert.equal(imports['claude-1'], res.id)
  assert.ok(existsSync(res.path))
  assert.equal(Math.round(statSync(res.path).mtimeMs / 1000), Math.round(statSync(path).mtimeMs / 1000), 'dated by the Claude conversation, not the import')
})
