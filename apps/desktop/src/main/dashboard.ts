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
import { isSensorError, probeDirectorJson } from '@embodied/core'
import type { FeatureSample, ProbeRecord, SensorQuality, SensorStatus, Snapshot } from '@embodied/core'
import type { DeviceManagerEntry, DeviceProtocol } from './bootstrap.ts'
import { isSessionError } from './play.ts'
import type { PlayHostStartRequest } from './play.ts'

const here = dirname(fileURLToPath(import.meta.url))

const MAX_BODY_BYTES = 256 * 1024

/** Protocols the operator may add through the console. */
const ADDABLE_PROTOCOLS: readonly string[] = ['coyote', 'xhtkj', 'mock']

/** Every capability the console needs; satisfied by HostRuntime plus audit. */
export interface DashboardDeps {
  snapshot(): unknown
  /**
   * The session service (B1-T16). Optional so a console-only host (or an older
   * test double) keeps working; the session routes answer 404 without it.
   */
  readonly session?: DashboardSession
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
  /** Human protocol experiment: one raw frame to the device transport. */
  rawWrite(deviceId: string, hex: string, channel: 'live' | 'setup'): Promise<void>
  listWaveforms(): unknown[]
  importWaveform(name: string, frames: string[]): Promise<{ id: string; name: string; frames: number }>
  promoteWaveform(id: string): Promise<unknown[]>
  setWaveform(deviceId: string, channelId: string, waveformId: string | undefined): Promise<void>
  auditTail(limit: number): Promise<unknown[]>
  /** Recent runtime errors, so the console can show why something failed. */
  recentErrors(): { ts: number; message: string }[]
  /** Background diagnostic log ring buffer (newest last). */
  recentLogs(): string[]
  /** Perception sources + derived quality + freshness (A1-T6). */
  sensorsStatus(): readonly SensorStatus[]
  /**
   * Settled probe records, newest last (A2-T7).
   *
   * Optional: the console-only host (and every test double written before
   * A2) has no recorder, and the debug route must answer an empty list
   * instead of failing. The default-off path never calls it at all, so a
   * console with the switch off cannot read probe numbers even by accident.
   */
  readonly probes?: () => readonly ProbeRecord[]
  /** Newest JPEG of one image source; undefined when none is available. */
  sensorFrame(sourceId?: string): Promise<Snapshot | undefined>
  /** Store one externally captured feature sample (unknown source → 400). */
  pushFeatures(sample: FeatureSample): void
}

/** The one-session API the play routes drive (implemented by `PlayHost`). */
export interface DashboardSession {
  start(input: PlayHostStartRequest): Promise<unknown>
  message(text: string): Promise<unknown>
  end(reason: string): Promise<unknown>
  snapshot(): unknown | undefined
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
  /** Clock used to stamp ingested feature samples. Defaults to `Date.now`. */
  readonly now?: () => number
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

/**
 * Map a session refusal to `400`.
 *
 * Only {@link SessionError} is a caller-fixable condition (no session, second
 * start, locked runtime, bad input). Anything else is a host bug and keeps
 * bubbling up as `500`, where the error log can see it.
 */
function sendSessionFailure(response: ServerResponse, error: unknown): void {
  if (isSessionError(error)) {
    sendJson(response, 400, { ok: false, error: error.message, code: error.code })
    return
  }
  throw error
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

/** Perceived qualities an external capture end may report. */
const SENSOR_QUALITIES: readonly SensorQuality[] = ['ok', 'dim', 'bright', 'blocked', 'stale', 'unavailable']

function asSensorQuality(value: unknown): SensorQuality | undefined {
  return typeof value === 'string' && (SENSOR_QUALITIES as readonly string[]).includes(value)
    ? (value as SensorQuality)
    : undefined
}

/** Optional numeric feature fields a capture end may report. */
type FeatureNumbers = Pick<
  FeatureSample,
  | 'motionEnergy'
  | 'motionPeak'
  | 'staticRatio'
  | 'centerMotionRatio'
  | 'lumaMean'
  | 'lumaStd'
  | 'overexposedRatio'
  | 'underexposedRatio'
  | 'audioLevelPct'
  | 'bpm'
>

const FEATURE_NUMBER_KEYS = [
  'motionEnergy',
  'motionPeak',
  'staticRatio',
  'centerMotionRatio',
  'lumaMean',
  'lumaStd',
  'overexposedRatio',
  'underexposedRatio',
  'audioLevelPct',
  'bpm',
] as const satisfies readonly (keyof FeatureNumbers)[]

/** Absent features stay absent — never fabricated as 0 (same rule as core). */
function asFeatureFields(body: Record<string, unknown>): Partial<FeatureNumbers> {
  const out: Partial<FeatureNumbers> = {}
  for (const key of FEATURE_NUMBER_KEYS) {
    const value = body[key]
    if (typeof value === 'number' && Number.isFinite(value)) {
      ;(out as Record<string, number>)[key] = value
    }
  }
  return out
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

/** Static console files. `/phone` is an alias for the phone stop page (A1-T9). */
const STATIC_FILES = new Set(['index.html', 'app.js', 'style.css', 'phone.html'])

export class DashboardServer {
  private server: Server | undefined
  /** Console-local debug switch (A2-T7); off by default, never persisted. */
  private debug = false

  constructor(private readonly options: DashboardServerOptions) {
    if (options.token.length < 16) throw new Error('dashboard token must be at least 16 characters')
  }

  /**
   * Whether the console's debug switch is on (A2-T7).
   *
   * Process-local and `false` by default. Off is the design rule: the UI may
   * show availability/quality, while probe numbers and the resolved command
   * targets stay in the audit log and in the model/audit projections. The
   * switch widens exactly one HTTP surface (`GET /api/debug/probes`); it is
   * never read by the engine, so the audit trail and every prompt projection
   * are byte-identical with it on or off (`M2-实施计划.md` §8.7).
   */
  debugMode(): boolean {
    return this.debug
  }

  /** Flip the debug switch. Routing only — no engine or audit side effect. */
  setDebugMode(on: boolean): void {
    this.debug = on
  }

  /** One clock for ingested samples, injectable so tests get deterministic ts. */
  private now(): number {
    return this.options.now?.() ?? Date.now()
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

    // ── Session API (B1-T16) ─────────────────────────────────────────────
    // One process, one session: `start` is refused while a session exists and
    // every player action is refused before the first start. The engine and
    // the ceiling live in `play.ts`; this layer only validates HTTP input and
    // maps a refusal to 400.
    if (request.method === 'GET' && pathname === '/api/session') {
      const session = this.options.deps.session
      if (session === undefined) {
        sendError(response, 404, 'the session service is not available')
        return
      }
      const snapshot = session.snapshot()
      if (snapshot === undefined) {
        sendError(response, 404, 'no session is open')
        return
      }
      sendJson(response, 200, snapshot)
      return
    }

    if (request.method === 'POST' && pathname === '/api/session/start') {
      const session = this.options.deps.session
      if (session === undefined) {
        sendError(response, 404, 'the session service is not available')
        return
      }
      let body: Record<string, unknown>
      try {
        body = await readJsonBody(request)
      } catch (error) {
        sendError(response, 400, `invalid JSON body: ${error instanceof Error ? error.message : 'unreadable'}`)
        return
      }
      const packId = asOptionalString(body.packId)
      if (packId === undefined) {
        sendError(response, 400, 'packId is required')
        return
      }
      const plannedMinutes = body.plannedMinutes
      if (typeof plannedMinutes !== 'number' || !Number.isFinite(plannedMinutes)) {
        sendError(response, 400, 'plannedMinutes must be a number of minutes')
        return
      }
      const rawCeiling = body.ceilingPercent
      if (rawCeiling !== undefined && rawCeiling !== null && typeof rawCeiling !== 'number') {
        sendError(response, 400, 'ceilingPercent must be a whole number from 0 to 100')
        return
      }
      const input: PlayHostStartRequest = {
        packId,
        plannedMinutes,
        ...(typeof rawCeiling === 'number' ? { ceilingPercent: rawCeiling } : {}),
      }
      try {
        sendJson(response, 200, await session.start(input))
      } catch (error) {
        sendSessionFailure(response, error)
      }
      return
    }

    if (request.method === 'POST' && pathname === '/api/session/message') {
      const session = this.options.deps.session
      if (session === undefined) {
        sendError(response, 404, 'the session service is not available')
        return
      }
      let body: Record<string, unknown>
      try {
        body = await readJsonBody(request)
      } catch (error) {
        sendError(response, 400, `invalid JSON body: ${error instanceof Error ? error.message : 'unreadable'}`)
        return
      }
      const text = asOptionalString(body.text)
      if (text === undefined) {
        sendError(response, 400, 'message text is required')
        return
      }
      try {
        sendJson(response, 200, await session.message(text))
      } catch (error) {
        sendSessionFailure(response, error)
      }
      return
    }

    if (request.method === 'POST' && pathname === '/api/session/end') {
      const session = this.options.deps.session
      if (session === undefined) {
        sendError(response, 404, 'the session service is not available')
        return
      }
      let body: Record<string, unknown>
      try {
        body = await readJsonBody(request)
      } catch (error) {
        sendError(response, 400, `invalid JSON body: ${error instanceof Error ? error.message : 'unreadable'}`)
        return
      }
      const reason = asOptionalString(body.reason)
      if (reason === undefined) {
        sendError(response, 400, 'reason is required')
        return
      }
      try {
        sendJson(response, 200, await session.end(reason))
      } catch (error) {
        sendSessionFailure(response, error)
      }
      return
    }

    // ── Debug mode (A2-T7) ───────────────────────────────────────────────
    // The console's one visibility switch. Off (the default) is the design
    // rule: the UI shows availability/quality, never probe numbers or the
    // resolved command targets. Turning it on only widens this HTTP surface;
    // the audit trail and the prompt projections are derived elsewhere and do
    // not change (§8.7), and the switch is not part of any model context.
    if (request.method === 'GET' && pathname === '/api/debug') {
      sendJson(response, 200, { enabled: this.debugMode() })
      return
    }

    if (request.method === 'POST' && pathname === '/api/debug') {
      let body: Record<string, unknown>
      try {
        body = await readJsonBody(request)
      } catch (error) {
        sendError(response, 400, `invalid JSON body: ${error instanceof Error ? error.message : 'unreadable'}`)
        return
      }
      if (typeof body.enabled !== 'boolean') {
        sendError(response, 400, 'enabled must be true or false')
        return
      }
      this.setDebugMode(body.enabled)
      sendJson(response, 200, { enabled: this.debugMode() })
      return
    }

    if (request.method === 'GET' && pathname === '/api/debug/probes') {
      if (!this.debugMode()) {
        // 403 rather than an empty list: "[]" would be a lie ("nothing settled
        // yet") and would make "off" indistinguishable from "on with no probe"
        // in the UI and in every script. The error body carries no numbers.
        sendError(response, 403, 'debug mode is off; enable it with POST /api/debug')
        return
      }
      // The structured adapter surface (A2-T4): raw deltas + magnitude band.
      // Deliberately NOT a prompt projection — the model never receives this.
      sendJson(response, 200, probeDirectorJson(this.options.deps.probes?.() ?? []))
      return
    }

    // Static console files. `/phone` is the phone stop/status page (A1-T9):
    // a page navigation cannot carry headers, so it is exempt from the token
    // like the console itself — the page's own API calls still authenticate.
    if (request.method === 'GET' && !isApi) {
      const requested = pathname === '/' ? '/index.html' : pathname === '/phone' ? '/phone.html' : pathname
      const safeName = normalize(requested).replace(/^([/\\])+/u, '')
      if (!STATIC_FILES.has(safeName)) {
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

    if (request.method === 'GET' && pathname === '/api/sensors') {
      sendJson(response, 200, { sources: this.options.deps.sensorsStatus() })
      return
    }

    if (request.method === 'GET' && pathname === '/api/sensors/frame') {
      const snapshot = await this.options.deps.sensorFrame(asOptionalString(url.searchParams.get('sourceId')))
      if (snapshot === undefined) {
        sendError(response, 404, 'no snapshot is available for that sensor source')
        return
      }
      const bytes = Buffer.from(snapshot.bytes)
      response.writeHead(200, {
        'Content-Type': snapshot.mime,
        'Content-Length': bytes.length,
        'Cache-Control': 'no-store',
        'X-Sensor-Ts': String(snapshot.ts),
      })
      response.end(bytes)
      return
    }

    if (request.method === 'POST' && pathname === '/api/sensors/features') {
      const body = await readJsonBody(request)
      const sourceId = asOptionalString(body.sourceId)
      if (sourceId === undefined) {
        sendError(response, 400, 'sourceId is required')
        return
      }
      const quality = asSensorQuality(body.quality)
      if (quality === undefined) {
        sendError(response, 400, `quality must be one of: ${SENSOR_QUALITIES.join(', ')}`)
        return
      }
      const sample: FeatureSample = {
        sourceId,
        ts: asNumber(body.ts, this.now()),
        frameAgeMs: asNumber(body.frameAgeMs, 0),
        quality,
        ...asFeatureFields(body),
      }
      try {
        this.options.deps.pushFeatures(sample)
      } catch (error) {
        // A capture end pushing for a source nobody registered is a caller
        // bug, not a server fault: answer 400 with the registry's own words.
        if (isSensorError(error) && error.code === 'UNKNOWN_SOURCE') {
          sendError(response, 400, error.message)
          return
        }
        throw error
      }
      sendJson(response, 200, { ok: true, sourceId })
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

    if (request.method === 'POST' && pathname === '/api/devices/raw') {
      const body = await readJsonBody(request)
      const channel = body.channel === 'setup' ? 'setup' : 'live'
      await this.options.deps.rawWrite(asString(body.deviceId, ''), asString(body.hex, ''), channel)
      sendJson(response, 200, this.options.deps.snapshot())
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
