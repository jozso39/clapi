// "New session from here": a new session file whose history is the path from
// the root to one chosen entry. The source file is never touched.
//
// Mirrors omp's SessionManager.createBranchedSession: same header shape,
// `parentSession` pointing at the source file, label entries dropped. Entry
// lines are copied byte-for-byte, so whatever omp wrote is what it reads back.
import { dirname, join } from 'node:path'
import { branchOf, fileSafeTimestamp, loadEntries, uuidv7, writeSessionFile, type SessionHeader } from './session-files'

export interface ForkResult {
  id: string
  path: string
}

export async function forkAt(sourcePath: string, entryId: string | null, title?: string): Promise<ForkResult> {
  const state = await loadEntries(sourcePath)
  if (!state.header) throw new Error('Source session has no header')
  const leaf = entryId ?? state.lastId
  const path = branchOf(state.byId, leaf).filter((e) => e.type !== 'label')
  if (path.length === 0) throw new Error(`Entry ${entryId} is not in this session`)

  const timestamp = new Date().toISOString()
  const id = uuidv7()
  const sourceTitle = state.slot?.title || state.header.title || 'Untitled'
  const header: SessionHeader = {
    type: 'session',
    version: 3,
    id,
    timestamp,
    cwd: state.header.cwd,
    title: title ?? `${sourceTitle} (fork)`,
    // 'user' so omp's auto-titler leaves the fork's name alone.
    titleSource: 'user',
    parentSession: sourcePath
  }
  if (Array.isArray(state.header.additionalDirectories) && state.header.additionalDirectories.length > 0) {
    header.additionalDirectories = [...state.header.additionalDirectories]
  }
  const target = join(dirname(sourcePath), `${fileSafeTimestamp(timestamp)}_${id}.jsonl`)
  await writeSessionFile(
    target,
    header,
    path.map((e) => state.raw.get(e.id)!)
  )
  return { id, path: target }
}
