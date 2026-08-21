/**
 * Intiface Engine process management.
 *
 * The discipline worth copying from the reference implementation is **not** the
 * download: it is *"connect first, and only ever stop what you started."* An
 * operator may already be running Intiface Central with their own configuration,
 * and killing it out from under them would be rude and confusing.
 *
 * ## Why the verified auto-download is deliberately not here
 *
 * The reference pins `intiface-engine-4.0.2` with a per-platform SHA-256 and a
 * hand-written ZIP reader. That is careful work, but a pinned artifact goes
 * stale — 4.1.0 is current while that pin sits two releases back — and it is
 * roughly 150 lines of supply-chain code serving hardware this deployment does
 * not yet have. If Intiface is wanted, installing Intiface Central is one step
 * and also supplies the Android path in M4b.
 *
 * So: use an engine already on `PATH`, or an already-running server, and say so
 * clearly when neither exists.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { createConnection } from 'node:net'

export const INTIFACE_DEFAULT_EXECUTABLE = 'intiface-engine'
export const INTIFACE_DEFAULT_PORT = 12_345

/** Arguments the engine needs to serve every transport we care about. */
export function intifaceArguments(port: number): string[] {
  return ['--websocket-port', String(port), '--use-bluetooth-le', '--use-serial', '--use-hid']
}

/** True when something is accepting connections at `host:port`. */
export function isPortOpen(host: string, port: number, timeoutMs = 500): Promise<boolean> {
  return new Promise(resolve => {
    const socket = createConnection({ host, port })
    let settled = false
    const finish = (open: boolean): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.removeAllListeners()
      socket.destroy()
      resolve(open)
    }
    const timer = setTimeout(() => { finish(false) }, timeoutMs)
    socket.once('connect', () => { finish(true) })
    socket.once('error', () => { finish(false) })
  })
}

/** Poll until the port opens or the budget runs out. */
export async function waitForPort(host: string, port: number, budgetMs: number, stepMs = 100): Promise<boolean> {
  const deadline = Date.now() + budgetMs
  for (;;) {
    if (await isPortOpen(host, port, Math.min(stepMs * 2, 500))) return true
    if (Date.now() >= deadline) return false
    await new Promise<void>(resolve => { setTimeout(resolve, stepMs) })
  }
}

/** Outcome of trying to make an engine available. */
export type IntifaceAvailability =
  /** Something was already listening; we did not start it and will not stop it. */
  | 'already-running'
  /** We started the engine and own its lifetime. */
  | 'started'
  /** No engine on PATH and nothing listening. */
  | 'unavailable'

export interface IntifaceProcessOptions {
  readonly executable?: string
  readonly host?: string
  readonly port?: number
  readonly startupTimeoutMs?: number
  readonly onError?: (error: unknown) => void
}

export class IntifaceProcess {
  private child: ChildProcess | undefined
  private ownsProcess = false

  constructor(private readonly options: IntifaceProcessOptions = {}) {}

  get host(): string {
    return this.options.host ?? '127.0.0.1'
  }

  get port(): number {
    return this.options.port ?? INTIFACE_DEFAULT_PORT
  }

  get url(): string {
    return `ws://${this.host}:${this.port}`
  }

  /** True when this object started the engine and is responsible for stopping it. */
  get owned(): boolean {
    return this.ownsProcess
  }

  /**
   * Make an engine available without disturbing one that already is.
   *
   * Never throws: an absent engine is an ordinary situation for a deployment
   * with no Buttplug hardware, and it must not stop the app from starting.
   */
  async ensure(): Promise<IntifaceAvailability> {
    if (await isPortOpen(this.host, this.port)) return 'already-running'

    let child: ChildProcess
    try {
      child = spawn(this.options.executable ?? INTIFACE_DEFAULT_EXECUTABLE, intifaceArguments(this.port), {
        // Ignored rather than piped: nothing reads it, and a filled pipe buffer
        // would eventually stall the engine.
        stdio: 'ignore',
        windowsHide: true,
      })
    } catch (error) {
      this.options.onError?.(error)
      return 'unavailable'
    }

    const spawned = await new Promise<boolean>(resolve => {
      let settled = false
      const finish = (ok: boolean): void => {
        if (settled) return
        settled = true
        child.off('spawn', onSpawn)
        child.off('error', onError)
        resolve(ok)
      }
      const onSpawn = (): void => { finish(true) }
      const onError = (error: Error): void => {
        // ENOENT here just means no engine is installed.
        this.options.onError?.(error)
        finish(false)
      }
      child.once('spawn', onSpawn)
      child.once('error', onError)
    })

    if (!spawned) return 'unavailable'

    // Keep a listener so a later crash cannot raise an unhandled error event.
    child.on('error', error => { this.options.onError?.(error) })
    this.child = child
    this.ownsProcess = true

    if (await waitForPort(this.host, this.port, this.options.startupTimeoutMs ?? 10_000)) return 'started'

    this.options.onError?.(new Error(`Intiface Engine did not open ${this.url} in time`))
    await this.stop()
    return 'unavailable'
  }

  /** Stop only a process this object started. */
  async stop(): Promise<void> {
    const child = this.child
    this.child = undefined
    this.ownsProcess = false
    if (child === undefined || child.exitCode !== null || child.signalCode !== null) return
    child.kill('SIGTERM')
    await new Promise<void>(resolve => {
      let settled = false
      const finish = (): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        child.off('exit', finish)
        resolve()
      }
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        finish()
      }, 2_000)
      child.once('exit', finish)
    })
  }
}
