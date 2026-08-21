/**
 * Out-of-band emergency stop over loopback HTTP.
 *
 * This is the path the phone page uses. Three properties are deliberate:
 *
 * - **It never touches the agent.** The model cannot observe, delay, or refuse
 *   a stop that arrives here.
 * - **A shared token is required.** The reference project exposed its camera
 *   bridge on `0.0.0.0` with no authentication at all; nothing here binds
 *   beyond the configured host and nothing answers without the token.
 * - **Bodies are bounded.** A stop endpoint must not be a memory sink.
 */

import { timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

const MAX_BODY_BYTES = 4 * 1024

export interface PanicServerOptions {
  /** Shared secret required on every request. */
  readonly token: string
  /** Interface to bind. Defaults to loopback; never bind `0.0.0.0` casually. */
  readonly host?: string
  /** Port to bind. `0` picks an ephemeral port, which tests rely on. */
  readonly port?: number
  /** Invoked for `POST /panic`. Must resolve once output has been cut. */
  readonly onPanic: (source: string) => Promise<void>
  /** Invoked for `GET /status`. Result is serialised as JSON. */
  readonly onStatus: () => unknown
  readonly onError?: (error: unknown) => void
}

function tokenMatches(expected: string, provided: string | undefined): boolean {
  if (provided === undefined) return false
  const a = Buffer.from(expected, 'utf8')
  const b = Buffer.from(provided, 'utf8')
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

function presentedToken(request: IncomingMessage): string | undefined {
  const header = request.headers.authorization
  if (typeof header === 'string' && header.startsWith('Bearer ')) return header.slice(7)
  const direct = request.headers['x-panic-token']
  if (typeof direct === 'string') return direct
  return undefined
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let total = 0
    request.on('data', (chunk: Buffer) => {
      total += chunk.length
      if (total > MAX_BODY_BYTES) {
        reject(new Error('request body too large'))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => { resolve(Buffer.concat(chunks).toString('utf8')) })
    request.on('error', reject)
  })
}

function sourceFrom(body: string): string {
  if (body.trim().length === 0) return 'remote'
  try {
    const parsed: unknown = JSON.parse(body)
    if (typeof parsed === 'object' && parsed !== null) {
      const candidate = (parsed as { source?: unknown }).source
      if (typeof candidate === 'string' && candidate.length > 0 && candidate.length <= 64) return candidate
    }
  } catch {
    // Body is optional; an unparseable one still triggers the stop.
  }
  return 'remote'
}

function send(response: ServerResponse, status: number, payload: unknown): void {
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload)
  response.writeHead(status, {
    'Content-Type': typeof payload === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  })
  response.end(body)
}

export class PanicServer {
  private server: Server | undefined

  constructor(private readonly options: PanicServerOptions) {
    if (options.token.length < 16) {
      throw new Error('panic token must be at least 16 characters')
    }
  }

  /** Bind and return the actual address, which matters when port is 0. */
  start(): Promise<{ host: string; port: number }> {
    const host = this.options.host ?? '127.0.0.1'
    const port = this.options.port ?? 0
    const server = createServer((request, response) => {
      this.handle(request, response).catch((error: unknown) => {
        this.options.onError?.(error)
        if (!response.headersSent) send(response, 500, { ok: false })
      })
    })
    this.server = server
    return new Promise((resolve, reject) => {
      const onError = (error: unknown): void => {
        server.off('listening', onListening)
        reject(error)
      }
      const onListening = (): void => {
        server.off('error', onError)
        const address = server.address() as AddressInfo | null
        resolve({ host, port: address?.port ?? port })
      }
      server.once('error', onError)
      server.once('listening', onListening)
      server.listen(port, host)
    })
  }

  async stop(): Promise<void> {
    const server = this.server
    this.server = undefined
    if (server === undefined) return
    await new Promise<void>(resolve => {
      server.close(() => { resolve() })
      server.closeAllConnections()
    })
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (!tokenMatches(this.options.token, presentedToken(request))) {
      send(response, 401, { ok: false, error: 'invalid token' })
      return
    }
    const url = request.url ?? '/'
    if (request.method === 'POST' && url === '/panic') {
      let source = 'remote'
      try {
        source = sourceFrom(await readBody(request))
      } catch {
        send(response, 413, { ok: false, error: 'body too large' })
        return
      }
      await this.options.onPanic(source)
      send(response, 200, { ok: true, stopped: true, source })
      return
    }
    if (request.method === 'GET' && url === '/status') {
      send(response, 200, { ok: true, status: this.options.onStatus() })
      return
    }
    send(response, 404, { ok: false, error: 'not found' })
  }
}
