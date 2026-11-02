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
import type { ChannelPolicy, PackRegistryEntry } from '@embodied/core'
import {
  ContentPackError,
  codeToHz,
  frequencyBandToHz,
  hzToCode,
  isSafetyError,
  isSensorError,
  MAX_FREQ_CODE,
  MAX_FREQ_HZ,
  MAX_ZIP_BYTES,
  MIN_FREQ_CODE,
  MIN_FREQ_HZ,
  PackRegistryError,
  probeDirectorJson,
  ZipError,
} from '@embodied/core'
import type { FeatureSample, ProbeRecord, SensorQuality, SensorStatus, Snapshot } from '@embodied/core'
import type { DeviceManagerEntry, DeviceProtocol } from './bootstrap.ts'
import type { SettingsDeps } from './host-settings.ts'
import { isSessionError } from './play.ts'
import type { PlayAutopilotInput, PlayHostStartRequest } from './play.ts'
import { handleSettingsRequest, isSettingsPath } from './settings-routes.ts'

const here = dirname(fileURLToPath(import.meta.url))

const MAX_BODY_BYTES = 256 * 1024

/**
 * Protocols the operator may add through the console.
 *
 * Matches the add-device dialog (coyote / xhtkj / ankni). Mock devices are
 * deliberately absent: fake hardware is not a product feature, and the demo
 * path is `EMBODIED_MOCK_DEVICES=1` at the host level.
 */
const ADDABLE_PROTOCOLS: readonly string[] = ['coyote', 'xhtkj', 'ankni']

/**
 * One body region a pack declares (`scenario.regions[]`).
 *
 * The console shows `label`; `id` is the stable key the plan and the resolver
 * speak. A freeform pack declares only `{ id: 'whole-body', label: '全身' }`.
 * `whole-body` is always returned first by the host, even when the pack file
 * omits it, because the resolver treats it as a universal wildcard.
 */
export interface PackRegionOption {
  readonly id: string
  readonly label: string
}

/** One pack version's region vocabulary, resolved for the play view. */
export interface PackRegionVocabulary {
  /** Concrete installed version the vocabulary was read from. */
  readonly version: string
  readonly regions: readonly PackRegionOption[]
}

/** 一次导入的结果，只含 UI 需要的小字段（`LoadedPack` 不可序列化）。 */
export interface PackImportSummary {
  readonly id: string
  readonly version: string
  /** 本次导入是否立即成为 active 版本。 */
  readonly active: boolean
}

/** Every capability the console needs; satisfied by HostRuntime plus audit. */
export interface DashboardDeps {
  snapshot(): unknown
  /**
   * The session service (B1-T16). Optional so a console-only host (or an older
   * test double) keeps working; the session routes answer 404 without it.
   */
  readonly session?: DashboardSession
  /** 已安装内容包与 active 版本（B2-T14）；`GET /api/packs`。 */
  listPacks(): Promise<readonly PackRegistryEntry[]>
  /**
   * 一个已安装内容包声明的叙事部位（`scenario.regions`，freeform 为
   * `whole-body`）；`GET /api/packs/regions`。
   *
   * `version` 缺省时读取 active 版本；显式传入时读取该版本（会话中途激活了
   * 别的版本时，游玩页仍要用会话启动时那一版的词表）。返回值必须带上实际
   * 解析到的版本，UI 用它做词表缓存键。
   *
   * 可选：控制台测试替身没有包仓库时，路由回答 404 即可。
   */
  readonly packRegions?: (packId: string, version?: string) => Promise<PackRegionVocabulary>
  /** 校验并安装一个 zip；成功后返回被安装的版本（通常同时激活）。 */
  importPack(bytes: Uint8Array): Promise<PackImportSummary>
  /** 切换下一次会话使用的 active 版本；会话中途不生效。 */
  activatePack(id: string, version: string): Promise<void>
  panic(source: string): Promise<void>
  unlock(note?: string): Promise<void>
  setCap(deviceId: string, channelId: string, patch: Partial<ChannelPolicy>): Promise<void>
  /**
   * Human direct control from the strength bar.
   *
   * `percent` is an *absolute* level (not the model's relative scale); the
   * registry clamps it into the channel interval and the session ceiling.
   */
  level(deviceId: string, channelId: string, percent: number, durationSec?: number): Promise<void>
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
  /**
   * Move the session ceiling as a human (B2-T9). Optional: the console-only
   * host has no session, and the route answers 404 in that case.
   */
  readonly setSessionCeiling?: (percent: number) => Promise<unknown>
  /** Move one channel's narrative region label (B2-T10). */
  readonly setRegion?: (deviceId: string, channelId: string, region: string | undefined) => Promise<void>
  /** Region labels in force, keyed `device:channel` (B2-T10). */
  readonly regions?: () => Readonly<Record<string, string>>
  /**
   * 设置页 API（产品需求 #5）。
   *
   * 可选：只有控制台、没有采集宿主的测试替身仍然启动，`/api/settings*`
   * 回答 404（而不是让整个服务器起不来）。实现见 `settings-routes.ts`。
   */
  readonly settings?: SettingsDeps
  /** Cross-session ledger entries, newest last (B2-T8/B2-T11). */
  readonly ledger?: (limit?: number) => Promise<readonly unknown[]>
}

/** The one-session API the play routes drive (implemented by `PlayHost`). */
export interface DashboardSession {
  start(input: PlayHostStartRequest): Promise<unknown>
  message(text: string): Promise<unknown>
  end(reason: string): Promise<unknown>
  snapshot(): unknown | undefined
  /** B2-T11: pause/resume queue behind the current turn; a choice is a P1 input. */
  pause?(): Promise<unknown>
  resume?(): Promise<unknown>
  choose?(choiceId: string): Promise<unknown>
  /** Human autopilot toggle/interval while playing (`POST /api/session/autopilot`). */
  setAutopilot?(input: PlayAutopilotInput): Promise<unknown>
  /** Recent spoken lines, newest last. */
  transcript?(): readonly unknown[]
  /** Cross-session ledger entries, newest last (B2-T8). */
  ledger?(limit?: number): Promise<readonly unknown[]>
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

/**
 * 内容包路由的错误映射。
 *
 * `not-found`/`not-installed` 是 404（包或版本不存在），`store-failure`/
 * `invalid-registry` 是宿主侧故障（500），其余注册表错误与 zip/包校验失败
 * 都是调用方可修复的 400。未知错误继续冒泡成 500，交给错误日志。
 */
function sendPackFailure(response: ServerResponse, error: unknown): void {
  if (error instanceof PackRegistryError) {
    const status = error.code === 'not-found' || error.code === 'not-installed'
      ? 404
      : error.code === 'store-failure' || error.code === 'invalid-registry'
        ? 500
        : 400
    sendJson(response, status, { ok: false, error: error.message, code: error.code })
    return
  }
  if (error instanceof ZipError) {
    sendJson(response, 400, { ok: false, error: error.message, code: error.code })
    return
  }
  if (error instanceof ContentPackError) {
    // 包校验错误自带出错文件与 JSON 路径，原样展示给导入 UI。
    sendJson(response, 400, { ok: false, error: error.message, code: 'PACK_INVALID', file: error.file })
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

/**
 * 读取原始二进制请求体（`POST /api/packs/import` 的 zip）。
 *
 * 与 JSON 的 `readBody` 分开：zip 上限是 `MAX_ZIP_BYTES`（64 MB），远超
 * 控制台普通 JSON 的 256 KiB。超限时用 `resume()` 把剩余数据排空再返回
 * 可读错误，而不是像 JSON 路径那样直接 destroy 连接——导入失败必须能
 * 在控制台看到 400 的原因。
 */
async function readBinaryBody(request: IncomingMessage, limit: number): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let total = 0
    let settled = false
    const fail = (message: string): void => {
      if (settled) return
      settled = true
      reject(new Error(message))
      request.resume()
    }
    request.on('data', (chunk: Buffer) => {
      if (settled) return
      total += chunk.length
      if (total > limit) {
        fail(`zip upload exceeds the ${limit}-byte limit`)
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => {
      if (settled) return
      settled = true
      resolve(new Uint8Array(Buffer.concat(chunks)))
    })
    request.on('error', (error: Error) => {
      if (settled) return
      settled = true
      reject(error)
    })
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

/** A JSON object response shape; the dashboard deps deliberately return `unknown`. */
function asJsonObject(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

/**
 * Whole-Hz display band for a stored protocol code band.
 *
 * The policy keeps frequency in Coyote protocol units; only the console shows
 * physical pulse frequency. Absent or out-of-range codes produce no fields
 * rather than a fabricated band (an empty waveform summarises as `0`/`0`).
 */
function hzBandFields(minCode: unknown, maxCode: unknown): { minHz: number; maxHz: number } | undefined {
  if (typeof minCode !== 'number' || !Number.isFinite(minCode)) return undefined
  if (typeof maxCode !== 'number' || !Number.isFinite(maxCode)) return undefined
  if (minCode < MIN_FREQ_CODE || minCode > MAX_FREQ_CODE) return undefined
  if (maxCode < MIN_FREQ_CODE || maxCode > MAX_FREQ_CODE) return undefined
  return frequencyBandToHz({ minCode, maxCode })
}

/**
 * One channel plus the units the console renders it in.
 *
 * Additive only: `minFreq`/`maxFreq` (protocol codes) and every percentage
 * field stay exactly as the safety runtime published them, so the model-facing
 * projections and older clients keep working. A Coyote channel reports native
 * strength 0-200; every other backend drives percentages 0-100.
 */
function decorateChannel(
  channel: Record<string, unknown>,
  protocol: DeviceProtocol | undefined,
): Record<string, unknown> {
  const nativeStrength = protocol === 'coyote'
  const decorated: Record<string, unknown> = {
    ...channel,
    intensityUnit: nativeStrength ? 'strength' : 'percent',
    intensityMax: nativeStrength ? 200 : 100,
  }
  const hz = hzBandFields(channel.minFreq, channel.maxFreq)
  if (hz !== undefined) {
    decorated.minFreqHz = hz.minHz
    decorated.maxFreqHz = hz.maxHz
  }
  return decorated
}

/**
 * Registry snapshot plus per-device protocol and per-channel native units.
 *
 * `protocol` is omitted for devices the operator manifest does not know (hub
 * backends, the mock pair in tests); the console then falls back to percentage
 * units, which is the safe default for anything that is not a Coyote.
 */
function decorateSnapshot(snapshot: unknown, protocols: ReadonlyMap<string, DeviceProtocol>): unknown {
  const root = asJsonObject(snapshot)
  if (root === undefined || !Array.isArray(root.devices)) return snapshot
  const devices = root.devices.map(entry => {
    const device = asJsonObject(entry)
    if (device === undefined) return entry
    const id = typeof device.id === 'string' ? device.id : undefined
    const protocol = id === undefined ? undefined : protocols.get(id)
    const channels = Array.isArray(device.channels)
      ? device.channels.map(channel => {
          const record = asJsonObject(channel)
          return record === undefined ? channel : decorateChannel(record, protocol)
        })
      : device.channels
    return {
      ...device,
      ...(protocol === undefined ? {} : { protocol }),
      channels,
    }
  })
  return { ...root, devices }
}

/**
 * One waveform summary plus its whole-Hz display band.
 *
 * `minFreq`/`maxFreq` stay in protocol codes; the Hz fields are what the
 * library cards print. Absent codes are left undecorated rather than guessed.
 */
function decorateWaveform(waveform: unknown): unknown {
  const record = asJsonObject(waveform)
  if (record === undefined) return waveform
  const hz = hzBandFields(record.minFreq, record.maxFreq)
  return hz === undefined ? record : { ...record, minFreqHz: hz.minHz, maxFreqHz: hz.maxHz }
}

/**
 * The stored frequency band of one channel, in protocol codes.
 *
 * A one-sided Hz patch must leave the other end **exactly** where it is. The
 * snapshot publishes the band in rounded Hz for display, and re-encoding a
 * rounded Hz value can land on a different code (the fast end is ~9 Hz per
 * code), so this reads the raw `minFreq`/`maxFreq` codes instead of the Hz
 * decoration. The dashboard does not own the policy store, so the registry
 * snapshot is the only source.
 */
function storedFrequencyCodes(
  snapshot: unknown,
  deviceId: unknown,
  channelId: unknown,
): { minCode: number; maxCode: number } | undefined {
  const wantedDevice = asOptionalString(deviceId)
  const wantedChannel = asOptionalString(channelId)
  if (wantedDevice === undefined || wantedChannel === undefined) return undefined
  const root = asJsonObject(snapshot)
  if (root === undefined || !Array.isArray(root.devices)) return undefined
  for (const rawDevice of root.devices) {
    const device = asJsonObject(rawDevice)
    if (device?.id !== wantedDevice || !Array.isArray(device.channels)) continue
    for (const rawChannel of device.channels) {
      const channel = asJsonObject(rawChannel)
      if (channel?.id !== wantedChannel) continue
      const minCode = channel.minFreq
      const maxCode = channel.maxFreq
      if (typeof minCode !== 'number' || !Number.isInteger(minCode)) return undefined
      if (typeof maxCode !== 'number' || !Number.isInteger(maxCode)) return undefined
      if (minCode < MIN_FREQ_CODE || minCode >= maxCode || maxCode > MAX_FREQ_CODE) return undefined
      return { minCode, maxCode }
    }
  }
  return undefined
}

/** Clamp a protocol code into `[low, high]`; a degenerate window returns `low`. */
function clampCode(value: number, low: number, high: number): number {
  if (low > high) return low
  return Math.min(high, Math.max(low, value))
}

/** Every field `/api/cap` accepts; all are whole numbers. */
const CAP_PATCH_FIELDS = [
  'minPercent',
  'maxPercent',
  'minFreq',
  'maxFreq',
  'maxDurationSec',
  'minFreqHz',
  'maxFreqHz',
] as const

/** Legacy protocol-code frequency fields. */
const CAP_CODE_FREQ_FIELDS = ['minFreq', 'maxFreq'] as const
/** Native whole-Hz frequency fields; converted into a code pair before `setCap`. */
const CAP_HZ_FREQ_FIELDS = ['minFreqHz', 'maxFreqHz'] as const

/**
 * Turn one `/api/cap` body into the protocol-unit patch `setCap` takes.
 *
 * All-or-nothing: every known field is validated before anything is applied,
 * so a patch carrying one bad value cannot move half a safety bound. The new
 * client sends the frequency band in whole physical Hz (`minFreqHz`/
 * `maxFreqHz`); this helper converts it to the protocol's compressed code pair.
 * The legacy code fields (`minFreq`/`maxFreq`) are still accepted — tests and
 * tools use them — but mixing both spellings in one patch is refused, because
 * there would be no single intended band.
 *
 * A one-sided Hz patch needs the other end of the *current* band, which the
 * dashboard can only read from the registry snapshot; both endpoints are then
 * converted together and the resulting patch always carries the complete code
 * pair. Sending the supplied endpoint alone could invert the band, which the
 * policy validator would (correctly) refuse.
 *
 * @throws Error with the caller-readable reason when the patch is invalid.
 */
function capPatchFromBody(body: Record<string, unknown>, currentSnapshot: unknown): Partial<ChannelPolicy> {
  const raw = body.patch
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('patch must be an object of channel policy fields')
  }
  const record = raw as Record<string, unknown>
  // A client still sending the removed pulse-width cap gets a clean 400.
  if ('maxWaveIntensity' in record) {
    throw new Error('maxWaveIntensity is not a configurable channel bound')
  }
  const numbers: Record<string, number> = {}
  for (const key of CAP_PATCH_FIELDS) {
    if (!(key in record)) continue
    const field = record[key]
    // 任一已知字段非法就整条 patch 拒绝：静默丢弃会变成「只改了一半的边界」，
    // 而边界是安全状态，不能部分生效。
    if (typeof field !== 'number' || !Number.isFinite(field) || !Number.isInteger(field)) {
      throw new Error(`patch.${key} must be a whole number`)
    }
    numbers[key] = field
  }
  const hasCodeFreq = CAP_CODE_FREQ_FIELDS.some(key => numbers[key] !== undefined)
  const hasHzFreq = CAP_HZ_FREQ_FIELDS.some(key => numbers[key] !== undefined)
  if (hasCodeFreq && hasHzFreq) {
    throw new Error('patch cannot mix minFreq/maxFreq with minFreqHz/maxFreqHz')
  }

  const patch: Record<string, number> = {}
  for (const key of ['minPercent', 'maxPercent', 'maxDurationSec'] as const) {
    const value = numbers[key]
    if (value !== undefined) patch[key] = value
  }
  if (hasCodeFreq) {
    // Legacy path: the policy store merges a code endpoint with its own current
    // value and validates the resulting band itself.
    for (const key of CAP_CODE_FREQ_FIELDS) {
      const value = numbers[key]
      if (value !== undefined) patch[key] = value
    }
  }
  if (hasHzFreq) {
    for (const key of CAP_HZ_FREQ_FIELDS) {
      const value = numbers[key]
      if (value !== undefined && (value < MIN_FREQ_HZ || value > MAX_FREQ_HZ)) {
        throw new Error(`patch.${key} must be a whole number from ${MIN_FREQ_HZ} to ${MAX_FREQ_HZ} Hz`)
      }
    }
    // Physical mapping: `minFreqHz` is the slow end of the band and becomes the
    // *larger* protocol code; `maxFreqHz` is the fast end and becomes the
    // smaller code. A one-sided patch keeps the untouched endpoint's code
    // exactly, then clamps the changed end into a legal ordered pair; the clamp
    // only matters at protocol granularity (the code space is ~9 Hz per step at
    // the fast end), where the exact Hz value is not representable.
    //
    // This intentionally does not call `hzBandToCode`: that helper quantises
    // *both* ends from Hz, which would move the endpoint the client did not
    // touch (a rounded display value can re-encode to a neighbouring code).
    // Two-sided patches are covered by a parity test against `hzBandToCode`.
    const hasMinHz = numbers.minFreqHz !== undefined
    const hasMaxHz = numbers.maxFreqHz !== undefined
    if (hasMinHz && hasMaxHz && (numbers.minFreqHz as number) >= (numbers.maxFreqHz as number)) {
      throw new Error('minFreqHz must be less than maxFreqHz')
    }
    if (hasMinHz && hasMaxHz) {
      const minCode = clampCode(hzToCode(numbers.maxFreqHz as number), MIN_FREQ_CODE, MAX_FREQ_CODE - 1)
      const maxCode = clampCode(hzToCode(numbers.minFreqHz as number), minCode + 1, MAX_FREQ_CODE)
      patch.minFreq = minCode
      patch.maxFreq = maxCode
    } else {
      const stored = storedFrequencyCodes(currentSnapshot, body.deviceId, body.channelId)
      if (stored === undefined) {
        throw new Error('cannot resolve the other frequency endpoint: unknown device or channel')
      }
      if (hasMaxHz) {
        // Fast end: keep the stored slow code, move only the fast code. Asking
        // for a value at/below the untouched slow end is a crossing request, not
        // something to silently clamp into a nonsense band.
        const requested = numbers.maxFreqHz as number
        const currentMinHz = codeToHz(stored.maxCode)
        if (requested <= currentMinHz) {
          throw new Error(
            `maxFreqHz must be greater than the current minimum frequency (${currentMinHz.toFixed(1)} Hz)`,
          )
        }
        patch.minFreq = clampCode(hzToCode(requested), MIN_FREQ_CODE, stored.maxCode - 1)
        patch.maxFreq = stored.maxCode
      } else {
        // Slow end: keep the stored fast code, move only the slow code.
        const requested = numbers.minFreqHz as number
        const currentMaxHz = codeToHz(stored.minCode)
        if (requested >= currentMaxHz) {
          throw new Error(
            `minFreqHz must be less than the current maximum frequency (${currentMaxHz.toFixed(1)} Hz)`,
          )
        }
        patch.minFreq = stored.minCode
        patch.maxFreq = clampCode(hzToCode(requested), stored.minCode + 1, MAX_FREQ_CODE)
      }
    }
  }
  if (Object.keys(patch).length === 0) {
    throw new Error('patch must set minPercent, maxPercent, minFreq, maxFreq, minFreqHz, maxFreqHz, or maxDurationSec')
  }
  return patch as Partial<ChannelPolicy>
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

/**
 * Static console files (v3: one single-window app).
 *
 * `play.html` no longer exists: the play view and the device view live in the
 * same page, so `/` and `/play` both serve `index.html` and `shell.js` switches
 * views client-side.
 */
const STATIC_FILES = new Set(['index.html', 'app.js', 'play.js', 'shell.js', 'settings.js', 'style.css', 'phone.html'])

/**
 * Page aliases → static file name.
 *
 * `/play`, `/device`, and `/settings` are deep links into the single-window
 * app; the allowlist still decides what can be served (a request for
 * `/play.json` is a clean 404).
 */
const STATIC_ALIASES: Readonly<Record<string, string>> = {
  '/': '/index.html',
  '/phone': '/phone.html',
  '/play': '/index.html',
  '/device': '/index.html',
  '/settings': '/index.html',
}

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

  /** Protocol per registered device id, for the native-unit decorations. */
  private deviceProtocols(): ReadonlyMap<string, DeviceProtocol> {
    return new Map(this.options.deps.listDevices().map(entry => [entry.key, entry.protocol]))
  }

  /**
   * The registry snapshot as the console sees it: protocol metadata plus the
   * native units each channel/back end speaks.
   *
   * Every route that hands out a snapshot goes through here, so the decoration
   * cannot be added to one route and forgotten on another.
   */
  private snapshotPayload(): unknown {
    return decorateSnapshot(this.options.deps.snapshot(), this.deviceProtocols())
  }

  /** Waveform summaries plus their Hz display bands; every `{waveforms}` payload uses it. */
  private waveformPayload(waveforms: readonly unknown[] = this.options.deps.listWaveforms()): unknown[] {
    return waveforms.map(decorateWaveform)
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
    // Browsers ask for /favicon.ico on every page. The console ships no icon
    // (static allowlist unchanged), so answer 204 instead of leaving a 404 in
    // the console on every navigation.
    if (request.method === 'GET' && pathname === '/favicon.ico') {
      response.writeHead(204, { 'Cache-Control': 'public, max-age=86400' })
      response.end()
      return
    }

    const isApi = pathname.startsWith('/api/')
    if (isApi && !tokenMatches(this.options.token, request, url)) {
      sendError(response, 401, 'missing or invalid x-control-token')
      return
    }

    // ── Settings API (product requirement #5) ────────────────────────────
    // Model configuration + camera/microphone preferences. The handlers live in
    // `settings-routes.ts` so this router stays a router; they answer their own
    // 400s. Without the deps (console-only test doubles) the routes are absent.
    if (isSettingsPath(pathname)) {
      const settings = this.options.deps.settings
      if (settings === undefined) {
        sendError(response, 404, 'the settings service is not available')
        return
      }
      await handleSettingsRequest(request, response, settings)
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
      let autopilot: PlayAutopilotInput | undefined
      if (body.autopilot !== undefined) {
        const raw = body.autopilot
        if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
          sendError(response, 400, 'autopilot must be an object')
          return
        }
        const record = raw as Record<string, unknown>
        if (typeof record.enabled !== 'boolean') {
          sendError(response, 400, 'autopilot.enabled must be a boolean')
          return
        }
        const intervalSec = record.intervalSec
        if (intervalSec !== undefined
          && (typeof intervalSec !== 'number' || !Number.isFinite(intervalSec) || intervalSec <= 0)) {
          sendError(response, 400, 'autopilot.intervalSec must be a positive number')
          return
        }
        autopilot = {
          enabled: record.enabled,
          ...(typeof intervalSec === 'number' ? { intervalSec } : {}),
        }
      }
      const input: PlayHostStartRequest = {
        packId,
        plannedMinutes,
        ...(typeof rawCeiling === 'number' ? { ceilingPercent: rawCeiling } : {}),
        ...(autopilot === undefined ? {} : { autopilot }),
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

    // ── Session controls (B2-T11) ────────────────────────────────────────
    if (request.method === 'POST' && pathname === '/api/session/pause') {
      const session = this.options.deps.session
      if (session?.pause === undefined) {
        sendError(response, 404, 'the session service is not available')
        return
      }
      try {
        sendJson(response, 200, await session.pause())
      } catch (error) {
        sendSessionFailure(response, error)
      }
      return
    }

    if (request.method === 'POST' && pathname === '/api/session/resume') {
      const session = this.options.deps.session
      if (session?.resume === undefined) {
        sendError(response, 404, 'the session service is not available')
        return
      }
      try {
        sendJson(response, 200, await session.resume())
      } catch (error) {
        sendSessionFailure(response, error)
      }
      return
    }

    if (request.method === 'POST' && pathname === '/api/session/choice') {
      const session = this.options.deps.session
      if (session?.choose === undefined) {
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
      const choiceId = asOptionalString(body.choiceId)
      if (choiceId === undefined) {
        sendError(response, 400, 'choiceId is required')
        return
      }
      try {
        sendJson(response, 200, await session.choose(choiceId))
      } catch (error) {
        sendSessionFailure(response, error)
      }
      return
    }

    if (request.method === 'GET' && pathname === '/api/session/transcript') {
      sendJson(response, 200, { transcript: this.options.deps.session?.transcript?.() ?? [] })
      return
    }

    if (request.method === 'GET' && pathname === '/api/ledger') {
      const ledger = this.options.deps.ledger
      if (ledger === undefined) {
        sendJson(response, 200, { entries: [] })
        return
      }
      const limitParam = url.searchParams.get('limit')
      const limit = limitParam === null ? undefined : Number(limitParam)
      if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0)) {
        sendError(response, 400, 'limit must be a positive whole number')
        return
      }
      sendJson(response, 200, { entries: await ledger(limit) })
      return
    }

    // ── Session ceiling (B2-T9) ──────────────────────────────────────────
    // Human-only by construction: the route calls PlayHost.setCeiling, which
    // is the only place PolicyStore.setSessionCeilingByHuman is reached.
    if (request.method === 'POST' && pathname === '/api/session/ceiling') {
      const setSessionCeiling = this.options.deps.setSessionCeiling
      if (setSessionCeiling === undefined) {
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
      const percent = body.percent
      if (typeof percent !== 'number' || !Number.isInteger(percent)) {
        sendError(response, 400, 'percent must be a whole number from 0 to 100')
        return
      }
      try {
        sendJson(response, 200, await setSessionCeiling(percent))
      } catch (error) {
        sendSessionFailure(response, error)
      }
      return
    }

    // ── Autopilot (P3 pacing) ─────────────────────────────────────────────
    // Human pacing control, not a model write: the engine clamps the interval
    // and only the host's own session can be affected. Disabled sub-routes 404
    // so a console test double without a session keeps working.
    if (request.method === 'POST' && pathname === '/api/session/autopilot') {
      const setAutopilot = this.options.deps.session?.setAutopilot
      if (setAutopilot === undefined) {
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
      const enabled = body.enabled
      if (typeof enabled !== 'boolean') {
        sendError(response, 400, 'enabled must be a boolean')
        return
      }
      const intervalSec = body.intervalSec
      if (intervalSec !== undefined
        && (typeof intervalSec !== 'number' || !Number.isFinite(intervalSec) || intervalSec <= 0)) {
        sendError(response, 400, 'intervalSec must be a positive number')
        return
      }
      try {
        sendJson(response, 200, await setAutopilot({
          enabled,
          ...(typeof intervalSec === 'number' ? { intervalSec } : {}),
        }))
      } catch (error) {
        sendSessionFailure(response, error)
      }
      return
    }

    // ── Narrative regions (B2-T10) ───────────────────────────────────────
    // Region labels are device configuration, not session state: they apply
    // immediately and persist even when no session is open.
    if (request.method === 'GET' && pathname === '/api/region') {
      sendJson(response, 200, { regions: this.options.deps.regions?.() ?? {} })
      return
    }

    if (request.method === 'POST' && pathname === '/api/region') {
      const setRegion = this.options.deps.setRegion
      if (setRegion === undefined) {
        sendError(response, 404, 'region editing is not available')
        return
      }
      let body: Record<string, unknown>
      try {
        body = await readJsonBody(request)
      } catch (error) {
        sendError(response, 400, `invalid JSON body: ${error instanceof Error ? error.message : 'unreadable'}`)
        return
      }
      const deviceId = asOptionalString(body.deviceId)
      const channelId = asOptionalString(body.channelId)
      if (deviceId === undefined || channelId === undefined) {
        sendError(response, 400, 'deviceId and channelId are required')
        return
      }
      const rawRegion = body.region
      if (!(rawRegion === undefined || rawRegion === null || typeof rawRegion === 'string')) {
        sendError(response, 400, 'region must be a string or null')
        return
      }
      try {
        await setRegion(deviceId, channelId, rawRegion === null ? undefined : rawRegion)
        sendJson(response, 200, { regions: this.options.deps.regions?.() ?? {} })
      } catch (error) {
        sendError(response, 400, error instanceof Error ? error.message : 'region change rejected')
      }
      return
    }

    // ── Content packs (B2-T14) ───────────────────────────────────────────
    // 安装/切换只改注册表，不碰用户存档（`内容包规范.md` §6.6）。导入是原始
    // zip 字节而不是 JSON；鉴权仍走统一的 x-control-token。
    if (request.method === 'GET' && pathname === '/api/packs') {
      sendJson(response, 200, { packs: await this.options.deps.listPacks() })
      return
    }

    // Narrative region vocabulary of one installed pack. The play view renders
    // it as the per-channel "部位" picker: the player chooses a label the pack
    // author wrote, never a slug, and the id is what the plan/resolver speak.
    if (request.method === 'GET' && pathname === '/api/packs/regions') {
      const packId = asOptionalString(url.searchParams.get('packId'))
      if (packId === undefined) {
        sendError(response, 400, 'packId is required')
        return
      }
      // Optional version pin: a running session must keep the vocabulary of the
      // version it started with, even if the active version changed meanwhile.
      const version = asOptionalString(url.searchParams.get('version'))
      const packRegions = this.options.deps.packRegions
      if (packRegions === undefined) {
        sendError(response, 404, 'pack regions are not available')
        return
      }
      try {
        const vocabulary = await packRegions(packId, version)
        sendJson(response, 200, {
          packId,
          version: vocabulary.version,
          regions: vocabulary.regions,
        })
      } catch (error) {
        // "No active version" is the same player-facing situation as "not
        // installed": there is no vocabulary to show. The generic pack-failure
        // map answers 400 for it (a write-side input error), which would make
        // the picker toast instead of degrading to its empty state.
        if (error instanceof PackRegistryError && error.code === 'no-active-version') {
          sendJson(response, 404, { ok: false, error: error.message, code: error.code })
          return
        }
        sendPackFailure(response, error)
      }
      return
    }

    if (request.method === 'POST' && pathname === '/api/packs/import') {
      let bytes: Uint8Array
      try {
        bytes = await readBinaryBody(request, MAX_ZIP_BYTES)
      } catch (error) {
        sendError(response, 400, `could not read the zip upload: ${error instanceof Error ? error.message : 'unreadable'}`)
        return
      }
      try {
        // 导入即激活：新装/升级后立即可玩；要保留旧版就用 activate 切回去。
        const pack = await this.options.deps.importPack(bytes)
        sendJson(response, 200, { pack, packs: await this.options.deps.listPacks() })
      } catch (error) {
        sendPackFailure(response, error)
      }
      return
    }

    if (request.method === 'POST' && pathname === '/api/packs/activate') {
      let body: Record<string, unknown>
      try {
        body = await readJsonBody(request)
      } catch (error) {
        sendError(response, 400, `invalid JSON body: ${error instanceof Error ? error.message : 'unreadable'}`)
        return
      }
      const id = asOptionalString(body.id)
      const version = asOptionalString(body.version)
      if (id === undefined || version === undefined) {
        sendError(response, 400, 'id and version are required')
        return
      }
      try {
        await this.options.deps.activatePack(id, version)
        sendJson(response, 200, { ok: true, packs: await this.options.deps.listPacks() })
      } catch (error) {
        sendPackFailure(response, error)
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

    // Static console files. `/phone` is the phone stop/status page (A1-T9) and
    // `/play` is the play page (B2-T12): a page navigation cannot carry
    // headers, so these are exempt from the token like the console itself —
    // the page's own API calls still authenticate. The allowlist is the whole
    // static surface (no directory serving), so an unknown name is a 404.
    if (request.method === 'GET' && !isApi) {
      const requested = STATIC_ALIASES[pathname] ?? pathname
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
      sendJson(response, 200, this.snapshotPayload())
      return
    }

    if (request.method === 'GET' && pathname === '/api/waveforms') {
      sendJson(response, 200, this.waveformPayload())
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
        snapshot: this.snapshotPayload(),
      })
      return
    }

    if (request.method === 'POST' && pathname === '/api/devices/remove') {
      const body = await readJsonBody(request)
      await this.options.deps.removeDevice(asString(body.key, ''))
      sendJson(response, 200, { devices: this.options.deps.listDevices(), snapshot: this.snapshotPayload() })
      return
    }

    if (request.method === 'POST' && pathname === '/api/devices/raw') {
      const body = await readJsonBody(request)
      const channel = body.channel === 'setup' ? 'setup' : 'live'
      await this.options.deps.rawWrite(asString(body.deviceId, ''), asString(body.hex, ''), channel)
      sendJson(response, 200, this.snapshotPayload())
      return
    }

    if (request.method === 'POST' && pathname === '/api/panic') {
      const body = await readJsonBody(request)
      await this.options.deps.panic(asString(body.source, 'web-ui'))
      sendJson(response, 200, this.snapshotPayload())
      return
    }

    if (request.method === 'POST' && pathname === '/api/unlock') {
      await this.options.deps.unlock(asOptionalString(await readJsonBody(request).then(body => body.note)))
      sendJson(response, 200, this.snapshotPayload())
      return
    }

    if (request.method === 'POST' && pathname === '/api/cap') {
      const body = await readJsonBody(request)
      let patch: Partial<ChannelPolicy>
      try {
        // A one-sided Hz patch needs the current band, so conversion reads the
        // raw snapshot; the response below is the decorated one.
        patch = capPatchFromBody(body, this.options.deps.snapshot())
      } catch (error) {
        // 任一已知字段非法就整条 patch 拒绝（含 Hz/编码字段混用、Hz 越界）：
        // 边界是安全状态，不能部分生效。
        sendJson(response, 400, {
          ok: false,
          error: error instanceof Error ? error.message : 'invalid cap patch',
          code: 'INVALID_POLICY',
        })
        return
      }
      try {
        await this.options.deps.setCap(asString(body.deviceId, ''), asString(body.channelId, ''), patch)
      } catch (error) {
        // A malformed interval (min >= max, out of range) is a client error:
        // say which bound is wrong instead of turning it into a 500.
        if (isSafetyError(error)) {
          sendJson(response, 400, { ok: false, error: error.message, code: error.code })
          return
        }
        sendError(response, 400, error instanceof Error ? error.message : 'policy patch refused')
        return
      }
      sendJson(response, 200, this.snapshotPayload())
      return
    }

    // Direct human control from the strength bar (v3). Absolute percentage,
    // optional duration; both ends are clamped by the safety runtime.
    if (request.method === 'POST' && pathname === '/api/level') {
      const body = await readJsonBody(request)
      const percent = body.percent
      if (typeof percent !== 'number' || !Number.isFinite(percent) || !Number.isInteger(percent)) {
        sendError(response, 400, 'percent must be a whole number from 0 to 100')
        return
      }
      if (percent < 0 || percent > 100) {
        sendError(response, 400, 'percent must be a whole number from 0 to 100')
        return
      }
      const rawDuration = body.durationSec
      if (rawDuration !== undefined && rawDuration !== null
        && (typeof rawDuration !== 'number' || !Number.isFinite(rawDuration))) {
        sendError(response, 400, 'durationSec must be a number of seconds')
        return
      }
      try {
        await this.options.deps.level(
          asString(body.deviceId, ''),
          asString(body.channelId, ''),
          percent,
          typeof rawDuration === 'number' ? rawDuration : undefined,
        )
      } catch (error) {
        sendError(response, 400, error instanceof Error ? error.message : 'level command refused')
        return
      }
      sendJson(response, 200, this.snapshotPayload())
      return
    }

    if (request.method === 'POST' && pathname === '/api/demo') {
      const body = await readJsonBody(request)
      await this.options.deps.demo(asString(body.deviceId, ''), asString(body.channelId, ''))
      sendJson(response, 200, this.snapshotPayload())
      return
    }

    if (request.method === 'POST' && pathname === '/api/stop') {
      const body = await readJsonBody(request)
      await this.options.deps.stop(asOptionalString(body.deviceId), asOptionalString(body.channelId))
      sendJson(response, 200, this.snapshotPayload())
      return
    }

    if (request.method === 'POST' && pathname === '/api/connect') {
      const body = await readJsonBody(request)
      await this.options.deps.connect(asString(body.deviceId, ''))
      sendJson(response, 200, this.snapshotPayload())
      return
    }

    if (request.method === 'POST' && pathname === '/api/scan') {
      const body = await readJsonBody(request)
      await this.options.deps.scan(asString(body.deviceId, ''), asNumber(body.durationMs, 5_000))
      sendJson(response, 200, this.snapshotPayload())
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
      sendJson(response, 200, { imported, waveforms: this.waveformPayload() })
      return
    }

    if (request.method === 'POST' && pathname === '/api/waveforms/promote') {
      const body = await readJsonBody(request)
      const promoted = await this.options.deps.promoteWaveform(asString(body.id, ''))
      sendJson(response, 200, { waveforms: this.waveformPayload(promoted) })
      return
    }

    if (request.method === 'POST' && pathname === '/api/waveforms/select') {
      const body = await readJsonBody(request)
      await this.options.deps.setWaveform(
        asString(body.deviceId, ''),
        asString(body.channelId, ''),
        asOptionalString(body.waveformId),
      )
      sendJson(response, 200, this.snapshotPayload())
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
      sendJson(response, 200, this.snapshotPayload())
      return
    }

    sendError(response, 404, 'unknown endpoint')
  }
}
