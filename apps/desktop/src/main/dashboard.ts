/**
 * The control console: one HTTP server for the UI and its JSON API.
 *
 * This is the shape of the final terminal, not a debug affordance. Everything
 * the console can do goes through here, which keeps the surface small enough
 * to reason about and — in M4b — lets the same static UI be served to an
 * Android WebView or a phone browser without any changes.
 *
 * Split from the panic endpoint deliberately: `POST /panic` must stay reachable
 * even if this server misbehaves, and it has its own token.
 */

import { readFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { dirname, join, normalize, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ChannelPolicy } from '@embodied/core'
import type { DeviceManagerEntry, DeviceProtocol } from './bootstrap.ts'

const here = dirname(fileURLToPath(import.meta.url))

const MAX_BODY_BYTES = 256 * 1024

/** Protocols the operator may add through the console. */
const ADDABLE_PROTOCOLS: readonly string[] = ['coyote', 'xhtkj', 'mock']

/** Every capability the console needs; satisfied by HostRuntime plus audit. */
export interface DashboardDeps {
  snapshot(): unknown
  panic(source: string): Promise<void>
  unlock(note?: string): Promise<void>
  setCap(deviceId: string, channelId: string, patch: Partial<ChannelPolicy>): Promise<void>
  demo(deviceId: string, channelId: string): Promise<void>
  /** Run a full envelope on a channel — the console's primary gesture. */
  pattern(
    deviceId: string,
    channelId: string,
    envelope: { preset: string; minPercent: number; maxPercent: number; periodMs: number; jitter: number },
    durationSec: number,
  ): Promise<void>
  stop(deviceId?: string, channelId?: string): Promise<void>
  connect(deviceId: string): Promise<void>
  scan(deviceId: string, durationMs: number): Promise<void>
  listDevices(): DeviceManagerEntry[]
  addDevice(protocol: DeviceProtocol): Promise<DeviceManagerEntry>
  removeDevice(key: string): Promise<void>
  listWaveforms(): unknown[]
  importWaveform(name: string, frames: string[]): Promise<{ id: string; name: string; frames: number }>
  promoteWaveform(id: string): Promise<unknown[]>
  setWaveform(deviceId: string, channelId: string, waveformId: string | undefined): Promise<void>
  auditTail(limit: number): Promise<unknown[]>
  /** Recent runtime errors, so the console can show why something failed. */
  recentErrors(): { ts: number; message: string }[]
  /** Background diagnostic log ring buffer (newest last). */
  recentLogs(): string[]
}

export interface DashboardServerOptions {
  readonly deps: DashboardDeps
  /** Shared secret. The UI receives it once and sends it on every request. */
  readonly token: string
  readonly host?: string
  readonly port?: number
  /** Absolute directory containing index.html / app.js / style.css. */
  readonly staticDir?: string
  /** In-memory static content; takes precedence over `staticDir`. */
  readonly staticFiles?: Readonly<Record<string, string>>
  readonly onError?: (error: unknown) => void
}

function tokenMatches(expected: string, request: IncomingMessage, url: URL): boolean {
  const provided = request.headers['x-control-token']
  if (typeof provided === 'string' && provided.length === expected.length) {
    const a = Buffer.from(expected, 'utf8')
    const b = Buffer.from(provided, 'utf8')
    if (a.length === b.length && a.equals(b)) return true
  }
  // A browser cannot set headers on a page navigation, so the console URL
  // itself carries the token; its fetch() calls then use the header.
  const query = url.searchParams.get('token')
  return typeof query === 'string' && query === expected
}

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload)
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  })
  response.end(body)
}

function sendError(response: ServerResponse, status: number, message: string): void {
  sendJson(response, status, { ok: false, error: message })
}

async function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let total = 0
    request.on('data', (chunk: Buffer) => {
      total += chunk.length
      if (total > MAX_BODY_BYTES) {
        reject(new Error('body too large'))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => { resolve(Buffer.concat(chunks).toString('utf8')) })
    request.on('error', reject)
  })
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const raw = await readBody(request)
  if (raw.trim().length === 0) return {}
  const parsed: unknown = JSON.parse(raw)
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('expected a JSON object')
  }
  return parsed as Record<string, unknown>
}

function asString(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function asNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function asNumberArray(value: unknown): number[] | undefined {
  if (!Array.isArray(value)) return undefined
  const out: number[] = []
  for (const item of value) {
    if (typeof item !== 'number' || !Number.isFinite(item)) return undefined
    out.push(item)
  }
  return out
}

function asPolicyPatch(value: unknown): Partial<ChannelPolicy> | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const raw = value as Record<string, unknown>
  const patch: { maxPercent?: number; maxWaveIntensity?: number; maxDurationSec?: number } = {}
  if (typeof raw.maxPercent === 'number') patch.maxPercent = raw.maxPercent
  if (typeof raw.maxWaveIntensity === 'number') patch.maxWaveIntensity = raw.maxWaveIntensity
  if (typeof raw.maxDurationSec === 'number') patch.maxDurationSec = raw.maxDurationSec
  return Object.keys(patch).length === 0 ? undefined : patch
}

/** Static file allowlist with traversal containment. */
function resolveStatic(staticDir: string, safeName: string): string | undefined {
  const resolved = join(staticDir, safeName)
  if (!resolved.startsWith(normalize(staticDir) + sep)) return undefined
  return resolved
}

const STATIC_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
}

export class DashboardServer {
  private server: Server | undefined

  constructor(private readonly options: DashboardServerOptions) {
    if (options.token.length < 16) throw new Error('dashboard token must be at least 16 characters')
  }

  start(): Promise<{ host: string; port: number }> {
    const host = this.options.host ?? '127.0.0.1'
    const port = this.options.port ?? 0
    const server = createServer((request, response) => {
      this.handle(request, response).catch((error: unknown) => {
        this.options.onError?.(error)
        if (!response.headersSent) sendError(response, 500, error instanceof Error ? error.message : 'internal error')
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

  private async readStaticFile(safeName: string): Promise<Buffer | undefined> {
    // Explicit directory first; otherwise probe the likely locations because
    // `here` depends on how this module was loaded (src/ under vitest, dist/
    // inside the Electron bundle, dev-server bundle).
    const candidates: string[] = []
    if (this.options.staticDir !== undefined) candidates.push(this.options.staticDir)
    candidates.push(
      join(here, '..', '..', 'src', 'ui'),   // running from src/main (tests)
      join(here, '..', 'src', 'ui'),         // running from dist/ (Electron)
      join(process.cwd(), 'src', 'ui'),      // cwd is the app root
    )
    for (const staticDir of candidates) {
      const file = resolveStatic(staticDir, safeName)
      if (file === undefined) continue
      try {
        return await readFile(file)
      } catch {
        // keep probing
      }
    }
    return undefined
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`)
    const pathname = url.pathname

    // Static console files are exempt from the token: a <script src> tag cannot
    // carry headers, and the token is already visible in the page URL anyway —
    // it protects the DATA endpoints, not the UI text. Without this exemption
    // the 401 JSON blocks app.js (wrong MIME type) and the whole console is
    // silent, which is exactly the "controls missing" bug this prevents.
    const isApi = pathname.startsWith('/api/')
    if (isApi && !tokenMatches(this.options.token, request, url)) {
      sendError(response, 401, 'missing or invalid x-control-token')
      return
    }

    // Static console files.
    if (request.method === 'GET' && !isApi) {
      const safeName = normalize(pathname === '/' ? '/index.html' : pathname).replace(/^([/\\])+/u, '')
      if (!new Set(['index.html', 'app.js', 'style.css']).has(safeName)) {
        sendError(response, 404, 'not found')
        return
      }
      const inMemory = this.options.staticFiles?.[safeName]
      let content: Buffer | undefined
      if (inMemory !== undefined) {
        content = Buffer.from(inMemory, 'utf8')
      } else {
        content = await this.readStaticFile(safeName)
      }
      if (content === undefined) {
        sendError(response, 404, 'not found')
        return
      }
      const type = STATIC_TYPES[safeName.slice(safeName.lastIndexOf('.'))] ?? 'application/octet-stream'
      response.writeHead(200, {
        'Content-Type': type,
        'Content-Length': content.length,
        'Cache-Control': 'no-store',
      })
      response.end(content)
      return
    }

    if (request.method === 'GET' && pathname === '/api/snapshot') {
      sendJson(response, 200, this.options.deps.snapshot())
      return
    }

    if (request.method === 'GET' && pathname === '/api/waveforms') {
      sendJson(response, 200, this.options.deps.listWaveforms())
      return
    }

    if (request.method === 'GET' && pathname === '/api/audit') {
      sendJson(response, 200, await this.options.deps.auditTail(150))
      return
    }

    if (request.method === 'GET' && pathname === '/api/errors') {
      sendJson(response, 200, this.options.deps.recentErrors())
      return
    }

    if (request.method === 'GET' && pathname === '/api/logs') {
      sendJson(response, 200, { lines: this.options.deps.recentLogs() })
      return
    }

    if (request.method === 'GET' && pathname === '/api/devices') {
      sendJson(response, 200, { devices: this.options.deps.listDevices() })
      return
    }

    if (request.method === 'POST' && pathname === '/api/devices') {
      const body = await readJsonBody(request)
      const protocol = body.protocol
      if (typeof protocol !== 'string' || !ADDABLE_PROTOCOLS.includes(protocol)) {
        sendError(response, 400, `protocol must be one of: ${ADDABLE_PROTOCOLS.join(', ')}`)
        return
      }
      const device = await this.options.deps.addDevice(protocol as DeviceProtocol)
      sendJson(response, 200, {
        device,
        devices: this.options.deps.listDevices(),
        snapshot: this.options.deps.snapshot(),
      })
      return
    }

    if (request.method === 'POST' && pathname === '/api/devices/remove') {
      const body = await readJsonBody(request)
      await this.options.deps.removeDevice(asString(body.key, ''))
      sendJson(response, 200, { devices: this.options.deps.listDevices(), snapshot: this.options.deps.snapshot() })
      return
    }

    if (request.method === 'POST' && pathname === '/api/panic') {
      const body = await readJsonBody(request)
      await this.options.deps.panic(asString(body.source, 'web-ui'))
      sendJson(response, 200, this.options.deps.snapshot())
      return
    }

    if (request.method === 'POST' && pathname === '/api/unlock') {
      await this.options.deps.unlock(asOptionalString(await readJsonBody(request).then(body => body.note)))
      sendJson(response, 200, this.options.deps.snapshot())
      return
    }

    if (request.method === 'POST' && pathname === '/api/cap') {
      const body = await readJsonBody(request)
      const patch = asPolicyPatch(body.patch)
      if (patch === undefined) {
        sendError(response, 400, 'patch must set maxPercent, maxWaveIntensity, or maxDurationSec')
        return
      }
      await this.options.deps.setCap(asString(body.deviceId, ''), asString(body.channelId, ''), patch)
      sendJson(response, 200, this.options.deps.snapshot())
      return
    }

    if (request.method === 'POST' && pathname === '/api/demo') {
      const body = await readJsonBody(request)
      await this.options.deps.demo(asString(body.deviceId, ''), asString(body.channelId, ''))
      sendJson(response, 200, this.options.deps.snapshot())
      return
    }

    if (request.method === 'POST' && pathname === '/api/stop') {
      const body = await readJsonBody(request)
      await this.options.deps.stop(asOptionalString(body.deviceId), asOptionalString(body.channelId))
      sendJson(response, 200, this.options.deps.snapshot())
      return
    }

    if (request.method === 'POST' && pathname === '/api/connect') {
      const body = await readJsonBody(request)
      await this.options.deps.connect(asString(body.deviceId, ''))
      sendJson(response, 200, this.options.deps.snapshot())
      return
    }

    if (request.method === 'POST' && pathname === '/api/scan') {
      const body = await readJsonBody(request)
      await this.options.deps.scan(asString(body.deviceId, ''), asNumber(body.durationMs, 5_000))
      sendJson(response, 200, this.options.deps.snapshot())
      return
    }

    if (request.method === 'POST' && pathname === '/api/waveforms/import') {
      const body = await readJsonBody(request)
      const frames = body.frames
      if (typeof frames !== 'string' || frames.trim().length === 0) {
        sendError(response, 400, 'frames text is required (hex per line or whitespace/comma separated)')
        return
      }
      const parsed = frames.split(/[\s,]+/u).filter(frame => frame.length > 0)
      const imported = await this.options.deps.importWaveform(asString(body.name, ''), parsed)
      sendJson(response, 200, { imported, waveforms: this.options.deps.listWaveforms() })
      return
    }

    if (request.method === 'POST' && pathname === '/api/waveforms/promote') {
      const body = await readJsonBody(request)
      sendJson(response, 200, { waveforms: await this.options.deps.promoteWaveform(asString(body.id, '')) })
      return
    }

    if (request.method === 'POST' && pathname === '/api/waveforms/select') {
      const body = await readJsonBody(request)
      await this.options.deps.setWaveform(
        asString(body.deviceId, ''),
        asString(body.channelId, ''),
        asOptionalString(body.waveformId),
      )
      sendJson(response, 200, this.options.deps.snapshot())
      return
    }

    if (request.method === 'POST' && pathname === '/api/pattern') {
      const body = await readJsonBody(request)
      const envelope = {
        preset: asString(body.preset, 'wave'),
        minPercent: asNumber(body.minPercent, 5),
        maxPercent: asNumber(body.maxPercent, 20),
        periodMs: asNumber(body.periodMs, 2_000),
        jitter: asNumber(body.jitter, 0),
      }
      const durationSec = asNumber(body.durationSec, 15)
      await this.options.deps.pattern(
        asString(body.deviceId, ''),
        asString(body.channelId, ''),
        envelope,
        durationSec,
      )
      sendJson(response, 200, this.options.deps.snapshot())
      return
    }

    sendError(response, 404, 'unknown endpoint')
  }
}
