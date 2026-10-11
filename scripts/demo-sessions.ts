// Write a handful of made-up omp sessions for screenshots and demos.
//   npx tsx scripts/demo-sessions.ts <sessionsRoot>
// Then: CLAPI_SESSIONS_ROOT=<sessionsRoot> CLAPI_HOME=<dir> npm run dev
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { bucketFor, fileSafeTimestamp, serializeTitleSlot, uuidv7 } from '../src/main/session-files'

const root = process.argv[2]
if (!root) throw new Error('usage: demo-sessions.ts <sessionsRoot>')
const HOME = '/Users/alice'
const now = Date.now()

type Turn = { user: string; tools?: { cmd: string; intent: string; out: string }[]; answer: string }

function session(o: { cwd: string; title: string; minutesAgo: number; turns: Turn[]; parentSession?: string }): { id: string; path: string } {
  const start = now - o.minutesAgo * 60_000 - o.turns.length * 120_000
  const id = uuidv7(start)
  const ts = (n: number) => new Date(start + n * 20_000).toISOString()
  const lines: object[] = []
  let parent: string | null = null
  let n = 0
  const push = (e: Record<string, unknown>) => {
    const eid = `e${(++n).toString(16).padStart(7, '0')}`
    lines.push({ ...e, id: eid, parentId: parent, timestamp: ts(n) })
    parent = eid
  }
  push({ type: 'model_change', model: 'anthropic/claude-opus-5-5' })
  for (const t of o.turns) {
    push({ type: 'message', message: { role: 'user', content: [{ type: 'text', text: t.user }], timestamp: start + n * 20_000 } })
    if (t.tools?.length) {
      const callIds = t.tools.map((_, i) => `call_${n}_${i}`)
      push({
        type: 'message',
        message: {
          role: 'assistant',
          provider: 'anthropic',
          model: 'claude-opus-5-5',
          stopReason: 'toolUse',
          content: t.tools.map((x, i) => ({ type: 'toolCall', id: callIds[i], name: 'bash', arguments: { command: x.cmd }, intent: x.intent })),
          timestamp: start + n * 20_000
        }
      })
      t.tools.forEach((x, i) =>
        push({ type: 'message', message: { role: 'toolResult', toolCallId: callIds[i], toolName: 'bash', isError: false, content: [{ type: 'text', text: x.out }], timestamp: start + n * 20_000 } })
      )
    }
    push({ type: 'message', message: { role: 'assistant', provider: 'anthropic', model: 'claude-opus-5-5', stopReason: 'stop', content: [{ type: 'text', text: t.answer }], timestamp: start + n * 20_000 } })
  }
  const header = { type: 'session', version: 3, id, timestamp: new Date(start).toISOString(), cwd: o.cwd, title: o.title, titleSource: 'user', ...(o.parentSession ? { parentSession: o.parentSession } : {}) }
  const dir = join(root, bucketFor(o.cwd, HOME))
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `${fileSafeTimestamp(header.timestamp)}_${id}.jsonl`)
  writeFileSync(path, serializeTitleSlot(o.title, 'user', header.timestamp) + [header, ...lines].map((l) => JSON.stringify(l)).join('\n') + '\n')
  return { id, path }
}

const web = `${HOME}/Projects/acme-web`
const api = `${HOME}/Projects/api-gateway`

const flaky = session({
  cwd: web,
  title: '🐛 Fix the flaky checkout test',
  minutesAgo: 3,
  turns: [
    {
      user: 'The checkout e2e test fails about one run in five on CI. Can you find out why and fix it?',
      tools: [
        { cmd: 'npx vitest run checkout --repeat 20', intent: 'Reproduce the flake locally', out: ' ✓ 16 passed\n ✗ 4 failed: expected "Order placed" — received "Processing…"' },
        { cmd: 'rg -n "waitFor|setTimeout" src/checkout', intent: 'Look for timing assumptions', out: 'src/checkout/submit.ts:41:  await sleep(300) // wait for the order to settle' }
      ],
      answer:
        'Found it. `submit.ts` waits a fixed **300 ms** for the order to settle, and on a busy CI runner the API takes longer, so the assertion sees `Processing…`.\n\nI replaced the sleep with a poll on the order status:\n\n```ts\nawait waitFor(() => getOrder(id).status === "placed", { timeout: 5_000 })\n```\n\n20 out of 20 runs now pass locally. Want me to open a PR?'
    },
    { user: 'Yes, open the PR against main.', answer: 'Opened **#482 — Poll order status instead of sleeping in checkout**. CI is green on the first run.' }
  ]
})

const dark = session({
  cwd: web,
  title: '🌙 Dark mode for the settings page',
  minutesAgo: 45,
  turns: [
    {
      user: 'Add a dark mode toggle to the settings page. Respect the system setting by default.',
      tools: [{ cmd: 'rg -l "prefers-color-scheme" src', intent: 'Check for existing theme handling', out: 'src/styles/tokens.css' }],
      answer:
        'There is already a `prefers-color-scheme` block in `tokens.css`, so the toggle only needs to override it.\n\n- **System** (default): no attribute, the media query decides\n- **Light / Dark**: `data-theme` on `<html>` wins over the media query\n\nThe choice is stored in `localStorage` under `theme`. Want the toggle in the header too?'
    }
  ]
})

session({ cwd: web, title: '🌙 Dark mode for the settings page (fork)', minutesAgo: 30, parentSession: dark.path, turns: [{ user: 'Instead of a toggle, make it a three-way segmented control.', answer: 'Done — `System · Light · Dark` as a segmented control, keyboard accessible with ← and →.' }] })

session({
  cwd: web,
  title: '📦 Upgrade to React 19',
  minutesAgo: 60 * 26,
  turns: [{ user: 'What breaks if we upgrade to React 19?', tools: [{ cmd: 'npx react-codemod --dry react-19/replace-reactdom-render src', intent: 'Dry-run the React 19 codemods', out: '3 files would change' }], answer: 'Only three call sites use `ReactDOM.render`; the codemod rewrites them to `createRoot`. Nothing else in the tree depends on removed APIs.' }]
})

session({
  cwd: api,
  title: '🔍 Why is /orders slow?',
  minutesAgo: 120,
  turns: [
    {
      user: 'p95 for GET /orders went from 80 ms to 900 ms yesterday. Find out why.',
      tools: [{ cmd: 'git log --since=2.days --oneline -- src/orders', intent: 'See what changed in orders', out: 'a1c9e07 Include line items in order list' }],
      answer: 'Commit `a1c9e07` added line items to the list endpoint and loads them **one query per order** (N+1). Batching them into a single `WHERE order_id IN (…)` brings p95 back to ~85 ms locally.'
    }
  ]
})

const notes = session({ cwd: api, title: '📝 Draft the 2.4 release notes', minutesAgo: 200, turns: [{ user: 'Draft release notes for 2.4 from the merged PRs.', answer: '**2.4** — faster order lists, idempotent webhooks, and a new `/health/ready` probe. Full list below.' }] })

console.log(JSON.stringify({ root, pinned: [flaky.id, notes.id] }))
