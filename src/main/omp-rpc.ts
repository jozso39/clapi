// One `omp --mode rpc` child process and its JSONL wire protocol.
//
// Framing: one JSON object per stdout line. omp first writes a `ready` frame;
// we then negotiate protocol v2, under which frames larger than 1 MiB arrive as
// `rpc_chunk` pieces (base64) that must be reassembled — `get_available_models`
// alone is larger than that. Commands carry an `id`; the matching `response`
// frame echoes it. Everything else is an event, re-emitted as 'frame'.
import { spawn, type ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import readline from 'node:readline'

export type Frame = { type: string; [key: string]: any }

interface Pending {
  resolve: (data: any) => void
  reject: (err: Error) => void
  timer?: NodeJS.Timeout
}

export class OmpRpc extends EventEmitter {
  private child: ChildProcess | null = null
  private pending = new Map<string, Pending>()
  private chunks = new Map<string, { parts: Buffer[]; got: number; count: number }>()
  private seq = 0
  private stderrTail: string[] = []
  exited = false

  constructor(
    private readonly bin: string,
    private readonly args: string[],
    private readonly cwd: string,
    private readonly env: NodeJS.ProcessEnv
  ) {
    super()
  }

  get pid(): number | undefined {
    return this.child?.pid
  }

  /** Spawn omp, wait for its `ready` frame and switch to protocol v2. */
  async start(timeoutMs = 45_000): Promise<void> {
    const child = spawn(this.bin, this.args, {
      cwd: this.cwd,
      env: this.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      // Own process group, so stop() also reaps the tools omp spawned.
      detached: true
    })
    this.child = child

    const ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`omp did not start within ${timeoutMs / 1000}s.${this.stderrHint()}`)), timeoutMs)
      this.once('ready', () => {
        clearTimeout(timer)
        resolve()
      })
      this.once('exit', (info: { code: number | null }) => {
        clearTimeout(timer)
        reject(new Error(`omp exited during startup (code ${info.code ?? '?'}).${this.stderrHint()}`))
      })
      child.once('error', (err) => {
        clearTimeout(timer)
        reject(err)
      })
    })

    readline.createInterface({ input: child.stdout! }).on('line', (line) => this.onLine(line))
    child.stderr!.on('data', (buf: Buffer) => {
      for (const line of buf.toString('utf8').split('\n')) {
        if (!line.trim()) continue
        this.stderrTail.push(line)
        if (this.stderrTail.length > 40) this.stderrTail.shift()
      }
    })
    child.on('exit', (code, signal) => {
      this.exited = true
      for (const p of this.pending.values()) {
        if (p.timer) clearTimeout(p.timer)
        p.reject(new Error(`omp exited (code ${code ?? signal ?? '?'})`))
      }
      this.pending.clear()
      this.emit('exit', { code, signal, stderr: this.stderrTail.join('\n') })
    })
    child.stdin!.on('error', () => {
      // EPIPE after the child died; the exit handler reports it.
    })

    await ready
    await this.request({ type: 'negotiate_protocol', protocolVersion: 2 }, 10_000)
  }

  private stderrHint(): string {
    const tail = this.stderrTail.slice(-6).join('\n').trim()
    return tail ? `\n${tail}` : ''
  }

  private onLine(line: string): void {
    if (!line.trim()) return
    let frame: Frame
    try {
      frame = JSON.parse(line)
    } catch {
      return
    }
    this.onFrame(frame)
  }

  private onFrame(frame: Frame): void {
    if (frame.type === 'rpc_chunk') {
      this.onChunk(frame)
      return
    }
    if (frame.type === 'ready') {
      this.emit('ready', frame)
      return
    }
    if (frame.type === 'response' && typeof frame.id === 'string' && this.pending.has(frame.id)) {
      const p = this.pending.get(frame.id)!
      this.pending.delete(frame.id)
      if (p.timer) clearTimeout(p.timer)
      if (frame.success) p.resolve(frame.data)
      else p.reject(new Error(frame.error || `${frame.command} failed`))
      return
    }
    this.emit('frame', frame)
  }

  private onChunk(frame: Frame): void {
    const { chunkId, index, count, data } = frame
    if (typeof chunkId !== 'string' || typeof index !== 'number' || typeof count !== 'number') return
    let entry = this.chunks.get(chunkId)
    if (!entry) {
      entry = { parts: new Array(count), got: 0, count }
      this.chunks.set(chunkId, entry)
    }
    if (!entry.parts[index]) {
      entry.parts[index] = Buffer.from(String(data), 'base64')
      entry.got++
    }
    if (entry.got === entry.count) {
      this.chunks.delete(chunkId)
      try {
        this.onFrame(JSON.parse(Buffer.concat(entry.parts).toString('utf8')))
      } catch {
        // A corrupt reassembly is dropped; the request it answered times out.
      }
    }
  }

  /** Send a command and resolve with its response `data`. `timeoutMs = 0` waits forever. */
  request<T = any>(command: Record<string, unknown>, timeoutMs = 120_000): Promise<T> {
    if (!this.child || this.exited) return Promise.reject(new Error('omp is not running'))
    const id = `c${++this.seq}`
    return new Promise<T>((resolve, reject) => {
      const pending: Pending = { resolve, reject }
      if (timeoutMs > 0) {
        pending.timer = setTimeout(() => {
          this.pending.delete(id)
          reject(new Error(`omp did not answer ${String(command.type)} within ${Math.round(timeoutMs / 1000)}s`))
        }, timeoutMs)
      }
      this.pending.set(id, pending)
      this.write({ id, ...command })
    })
  }

  /** Fire-and-forget frame (extension_ui_response). */
  write(frame: Record<string, unknown>): void {
    if (!this.child || this.exited) return
    this.child.stdin!.write(`${JSON.stringify(frame)}\n`)
  }

  respondUi(id: string, response: Record<string, unknown>): void {
    this.write({ type: 'extension_ui_response', id, ...response })
  }

  /** Close stdin (omp drains and exits), then escalate to signals on the process group. */
  async stop(): Promise<void> {
    const child = this.child
    if (!child || this.exited) return
    const gone = new Promise<void>((resolve) => this.once('exit', () => resolve()))
    try {
      child.stdin!.end()
    } catch {
      // already closed
    }
    const signal = (sig: NodeJS.Signals) => {
      if (this.exited || !child.pid) return
      try {
        process.kill(-child.pid, sig)
      } catch {
        try {
          child.kill(sig)
        } catch {
          // gone
        }
      }
    }
    const term = setTimeout(() => signal('SIGTERM'), 1500)
    const kill = setTimeout(() => signal('SIGKILL'), 4000)
    await gone
    clearTimeout(term)
    clearTimeout(kill)
  }
}
