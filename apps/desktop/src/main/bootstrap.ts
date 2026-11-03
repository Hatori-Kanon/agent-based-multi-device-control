/**
 * Host wiring: build the safety runtime, attach Node storage, expose the
 * out-of-band stop endpoint.
 *
 * Deliberately free of any Electron import so the whole bootstrap can be
 * exercised in unit tests; the Electron entry point only adds windows,
 * a global hotkey, and lifecycle hooks on top.
 */

import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { inflateRawSync } from 'node:zlib'
import {
  AuditLog,
  AnkniBackend,
  ButtplugBackend,
  CoyoteBackend,
  DeviceRegistry,
  ENGINE_VERSION,
  MockBackend,
  MonsterPartyBackend,
  PackRegistry,
  PackRegistryError,
  parsePolicySnapshot,
  PolicyStore,
  RegionStore,
  DEFAULT_SESSION_CEILING,
  SensorRegistry,
  serializePolicySnapshot,
  WaveformLibrary,
  XhtkjBackend,
  systemClock,
  type BleTransport,
  type Clock,
  type DeviceBackend,
  type DeviceLifecycle,
  type FeatureSample,
  type FetchLike,
  type LlmConfig,
  type ModelConfig,
  type ModelRunner,
  type PolicySnapshot,
  type RawInflate,
  type RegistrySnapshot,
  type SensorStatus,
  type SerializedWaveform,
  type Snapshot,
} from '@embodied/core'
import { IntifaceProcess, type IntifaceAvailability } from './intiface.ts'
import { DashboardServer, type DashboardDeps, type PackRegionVocabulary } from './dashboard.ts'
import { log, recentLogs } from './log.ts'
import { NodeTextSocketTransport } from './node-socket.ts'
import { FileAppendOnlyStore, FileDocumentStore, readAuditTail } from './node-storage.ts'
import { FsPackStore } from './pack-store.ts'
import { RegistryPackSource } from './pack-source.ts'
import { PanicServer } from './panic-server.ts'
import { PlayHost, regionVocabularyOf } from './play.ts'
import { audioSensorSource, type AudioHost } from './sensors/audio-host.ts'
import { cameraSensorSource, DEFAULT_CAMERA_FPS, type CameraHost } from './sensors/camera-host.ts'
import {
  buildLlmSettingsPayload,
  buildSettingsPayload,
  loadSensorPreferences,
  mergeSensorPreferences,
  saveSensorPreferences,
  SettingsError,
  unsupportedSensorState,
  type LlmSettingsPatch,
  type SensorCaptureState,
  type SensorDeviceInfo,
  type SensorPreferences,
  type SensorPreferencesPatch,
  type SensorPreference,
  type SettingsDeps,
  type SettingsPayload,
} from './host-settings.ts'
import {
  createModelRunner,
  DEFAULT_LLM_CONFIG,
  LLM_SETTINGS_KEY,
  llmSummaryOf,
  loadLlmSettings,
  saveLlmConfig,
  settingsFromConfig,
  singleCallModel,
  storedApiKeyOf,
} from './llm.ts'
import type { LlmSettings } from './llm.ts'
import { resolveApiKey } from './settings.ts'
import type { LlmSummary, SettingsEnv } from './settings.ts'

export interface HostRuntimeOptions {
  /** Root for the audit log, session state, and the panic token. */
  readonly dataDir: string
  /** Reuse an existing token; a fresh one is generated when omitted. */
  readonly panicToken?: string
  readonly panicHost?: string
  readonly panicPort?: number
  /** Skip the HTTP endpoint entirely (used by tests that do not need it). */
  readonly withPanicServer?: boolean
  /** Reuse an existing dashboard token; a fresh one is generated when omitted. */
  readonly dashboardToken?: string
  readonly dashboardHost?: string
  readonly dashboardPort?: number
  /** Absolute directory of the static console files. */
  readonly dashboardStaticDir?: string
  /** In-memory console files (bundled by the headless dev server). */
  readonly dashboardStaticFiles?: Readonly<Record<string, string>>
  /** Skip the control console entirely (used by tests that do not need it). */
  readonly withDashboard?: boolean
  /**
   * Register the two simulated devices (`mock-pulse`, `mock-hold`).
   *
   * Defaults to true for **fixtures and tests only**. Every product entry
   * point passes an explicit value (Electron `main/index.ts` and the headless
   * dev-server only when `EMBODIED_MOCK_DEVICES=1`): a user-facing device page
   * must never contain fake hardware, and the console does not offer
   * "模拟设备" as an addable protocol. The backend type stays because the mock
   * pair is the cheapest way to drive the safety runtime in tests.
   */
  readonly withMockDevices?: boolean
  /**
   * When present, real BLE backends are registered and connected.
   *
   * A connect failure is reported rather than fatal: the operator may simply
   * not have the box powered on, and the rest of the runtime is still useful.
   * Which BLE units exist is the operator's manifest (state/devices.json),
   * edited through the console (添加/移除设备); a missing manifest is seeded
   * with one Coyote and one 谜姬 on first BLE run.
   */
  readonly bleTransport?: BleTransport
  /**
   * Camera capture host (the Electron hidden-window worker).
   *
   * Omitted in headless runs: the sensor registry then simply has no image
   * source. When supplied, the wiring registers one `SensorSource` and starts
   * capture unless {@link withCamera} is false (tests, camera disabled).
   */
  readonly cameraHost?: CameraHost
  /**
   * Start camera capture on boot. Defaults to the persisted preference
   * (`state/settings.json`, camera on for a fresh install).
   *
   * `false` is a host-level override for tests/headless runs: the capture host
   * is still wired (so the settings view can report it), but nothing starts
   * until a human enables it through `POST /api/settings/sensors`.
   */
  readonly withCamera?: boolean
  /** Camera feature push rate; the capture host clamps it to 1-2 Hz. */
  readonly cameraFps?: number
  /**
   * Microphone capture host (the Electron hidden worker's audio path).
   *
   * Omitted in headless runs: the settings payload then reports the microphone
   * as `supported: false`. When supplied, one `audio` sensor source is
   * registered and capture starts only if the human enabled it (default off).
   */
  readonly audioHost?: AudioHost
  /**
   * In-memory LLM config override (tests, embedded hosts).
   *
   * Omitted, the host reads `<dataDir>/state/llm.json` and falls back to the
   * built-in DeepSeek single-call default. The API key is never part of this
   * object: `LlmConfig` has no key field.
   */
  readonly llmConfig?: LlmConfig
  /** Environment map for API-key lookup. Defaults to `process.env`. */
  readonly llmEnv?: SettingsEnv
  /** Network boundary for the model gateway. Defaults to `globalThis.fetch`. */
  readonly llmFetch?: FetchLike
  /**
   * MonsterParty share-link token.
   *
   * Operator configuration only. It never becomes a tool argument, a tool
   * result, or part of an error message a model can read.
   */
  readonly monsterPartyToken?: string
  /**
   * Look for an Intiface engine and register the Buttplug hub when one is
   * available. Defaults to true; tests turn it off to avoid a port probe.
   */
  readonly withButtplug?: boolean
  readonly onError?: (error: unknown) => void
  readonly clock?: Clock
}

export interface HostRuntime {
  readonly registry: DeviceRegistry
  readonly policy: PolicyStore
  readonly waveforms: WaveformLibrary
  readonly documents: FileDocumentStore
  /**
   * Named perception sources (A1-T6).
   *
   * Always present and usable: without a camera host it is simply empty, so
   * `sensors_list` and the console degrade to "no sources" instead of a
   * missing dependency.
   */
  readonly sensors: SensorRegistry
  /**
   * Assembled model gateway (B1-T15).
   *
   * Construction performs no network IO; the first request happens when a turn
   * actually runs. Built from the single-call model (director role, `null` →
   * default) for the M2 pipeline; split mode builds role runners from
   * {@link llm} without changing this field's meaning.
   *
   * A getter: `saveLlmSettings` rebuilds the runner, and the next turn picks it
   * up through the session's runner provider — no restart.
   */
  readonly modelRunner: ModelRunner
  /** Effective LLM config in force now (by construction it carries no API key). */
  readonly llm: LlmConfig
  /** Key-free LLM status — the only LLM shape the console may display. */
  llmSummary(): LlmSummary
  /**
   * 设置页数据（产品需求 #5）：无密钥的模型视图 + 摄像头/麦克风的实时采集状态。
   *
   * Device lists are re-read on every call, so the page's refresh button just
   * calls it again. Reading never starts capture.
   */
  settingsSnapshot(): Promise<SettingsPayload>
  /**
   * Persist a model change and swap the runner used by the next turn.
   *
   * Refused with {@link SettingsError} `FIXED_LLM_CONFIG` when this host was
   * started from an in-memory config: there would be no file to persist to.
   */
  saveLlmSettings(patch: LlmSettingsPatch): Promise<SettingsPayload>
  /**
   * Persist camera/microphone preferences and apply them to the live capture
   * hosts. Capture failures are reported in the returned payload, never thrown
   * as a host fault.
   */
  saveSensorSettings(patch: SensorPreferencesPatch): Promise<SettingsPayload>
  /**
   * Host session service (B1-T16): one pack-backed session per process.
   *
   * Exposed for embedded hosts and tests; the console drives it through the
   * `/api/session/*` routes. Its `panic`/`unlock` methods are wired into the
   * runtime's own stop path so the engine's LOCKED latch and the registry's
   * latch move together.
   */
  readonly play: PlayHost
  /**
   * 已安装内容包注册表（B2-T14）。
   *
   * 只读暴露给嵌入式宿主/测试；控制台通过 `/api/packs/*` 使用它，会话服务
   * 通过 `RegistryPackSource` 读取当前 active 版本。注册表没有需要关闭的
   * 句柄，`shutdown` 只等待排队中的导入/切换落盘。
   */
  readonly packs: PackRegistry
  readonly panicToken: string
  readonly panicAddress: { host: string; port: number } | undefined
  /** The control console's token and bind address. */
  readonly dashboardToken: string
  readonly dashboardAddress: { host: string; port: number } | undefined
  /** Whether an Intiface engine was found, and who owns it. */
  readonly intiface: { availability: IntifaceAvailability; url: string; owned: boolean }
  snapshot(): RegistrySnapshot
  /** Source list + derived quality + freshness (console `GET /api/sensors`). */
  sensorsStatus(): readonly SensorStatus[]
  /** Newest JPEG of one image source, or the first image source when omitted. */
  sensorFrame(sourceId?: string): Promise<Snapshot | undefined>
  /** Store one externally captured feature sample (HTTP ingest). */
  pushFeatures(sample: FeatureSample): void
  /** Human emergency stop from any out-of-band source. */
  panic(source: string): Promise<void>
  /** Persist the durable waveform library. */
  saveWaveforms(): Promise<void>
  /**
   * Persist human cap changes and the session ceiling to `state/policy.json`.
   *
   * Exposed for tests and for the shutdown path; human UI changes already
   * persist themselves through the console's `setCap` dependency.
   */
  savePolicy(): Promise<void>
  shutdown(): Promise<void>
  /** Devices the operator added (protocol + label + live lifecycle). */
  listDevices(): DeviceManagerEntry[]
  /** Add one device of the chosen protocol; registers and connects it. */
  addDevice(protocol: DeviceProtocol): Promise<DeviceManagerEntry>
  /**
   * Connect one card, then persist the physical unit the chooser picked.
   *
   * Two units can share one advertised name; recording the chooser's platform
   * id keeps the card (and its label) bound to the same box on later connects.
   */
  connectDevice(key: string): Promise<void>
  /** Stop, close, and forget a device. */
  removeDevice(key: string): Promise<void>
  /** Rename one device card; `undefined`/empty clears the override. */
  setDeviceLabel(key: string, label: string | undefined): Promise<DeviceManagerEntry[]>
  /** Forget the paired physical unit; the next connect scans again. */
  rebindDevice(key: string): Promise<DeviceManagerEntry[]>
}

/** Protocols an operator can add at run time. */
export const DEVICE_PROTOCOLS = ['coyote', 'xhtkj', 'ankni', 'mock'] as const
export type DeviceProtocol = (typeof DEVICE_PROTOCOLS)[number]

/**
 * Backend-default display names.
 *
 * These are the names a card falls back to when its manifest `label` is absent
 * (or cleared): the backend name is fixed at construction time, so a cleared
 * label must not leave the old override behind (see `decoratedSnapshot`).
 */
const DEFAULT_DEVICE_NAMES: Readonly<Record<DeviceProtocol, string>> = {
  coyote: 'DG-LAB Coyote 3.0',
  xhtkj: '谜姬 / XHTKJ 直连',
  ankni: '安可尼 流式玩具',
  mock: 'Mock 设备',
}

/** BLE protocols whose pairing can be reset through the chooser. */
const REBINDABLE_PROTOCOLS: ReadonlySet<DeviceProtocol> = new Set(['coyote', 'xhtkj', 'ankni'])

/** One entry of the persisted device manifest. */
export interface DeviceManifestEntry {
  readonly key: string
  readonly protocol: DeviceProtocol
  /** Display name override; the backend default is used when omitted. */
  readonly label?: string
  /** Scan filter override (e.g. an ANKNI family name); raw name only. */
  readonly bleName?: string
  /**
   * Platform device id the card is paired with.
   *
   * This is the **chooser's** id (Electron `deviceId`; on Windows the BLE
   * address), *not* Web Bluetooth's `BluetoothDevice.id` (an origin-scoped hash
   * that cannot be matched against later candidate lists). Coyote units
   * advertise the same name, so the first successful connect records which
   * physical box this card got; later connects pin the chooser to it. Cleared
   * by "重新配对".
   */
  readonly bleId?: string
}

/** Manifest entry merged with live registry state, for the UI. */
export interface DeviceManagerEntry {
  readonly key: string
  readonly protocol: DeviceProtocol
  readonly label: string
  readonly lifecycle: DeviceLifecycle | 'unregistered'
  readonly canScan: boolean
  readonly channels: readonly string[]
  /** True once the card is paired with one physical unit (`bleId`). */
  readonly bound: boolean
  /** True when "重新配对" is meaningful (BLE backends with a chooser). */
  readonly canRebind: boolean
  /**
   * The paired unit's chooser id (BLE address on Windows), when bound — shown
   * in the console so the operator can match a card to the OS/Chrome listing.
   */
  readonly pairedId?: string
}

/** File format version; bumped when the well-known device list changes. */
const MANIFEST_VERSION = 3

interface DeviceManifestFile {
  readonly version?: number
  readonly devices?: unknown
}

/**
 * Well-known units baked into new manifests (and introduced once into old ones
 * by the version migration). Fresh installs get these cards; the migration runs
 * exactly once per manifest, so a later 移除 sticks.
 */
const WELL_KNOWN_DEVICES: readonly DeviceManifestEntry[] = [
  { key: 'coyote', protocol: 'coyote' },
  { key: 'xhtkj', protocol: 'xhtkj' },
  { key: 'zkrxb', protocol: 'ankni', bleName: 'ANKNI ZKRXB', label: 'ANKNI ZKRXB（旋转）' },
]

function isDeviceProtocol(value: unknown): value is DeviceProtocol {
  return typeof value === 'string' && (DEVICE_PROTOCOLS as readonly string[]).includes(value)
}

/**
 * Coerce one manifest record, dropping corrupt optional fields instead of the
 * whole card.
 *
 * `key`/`protocol` are structural and a bad value really does make the entry
 * unusable; `label`/`bleName`/`bleId` are metadata, and a hand-edited `null`
 * there must not make a device disappear (and then be persisted as removed).
 * Empty strings are treated as absent: a blank `bleId` would otherwise mark a
 * card "paired" with a unit that can never match.
 */
function normalizeManifestEntry(value: unknown): DeviceManifestEntry | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const entry = value as Record<string, unknown>
  if (typeof entry.key !== 'string' || entry.key.length === 0) return undefined
  if (!isDeviceProtocol(entry.protocol)) return undefined
  const optional = (field: 'label' | 'bleName' | 'bleId'): string | undefined => {
    const raw = entry[field]
    if (typeof raw !== 'string') return undefined
    const trimmed = raw.trim()
    return trimmed.length === 0 ? undefined : trimmed
  }
  const label = optional('label')
  const bleName = optional('bleName')
  const bleId = optional('bleId')
  return {
    key: entry.key,
    protocol: entry.protocol,
    ...(label === undefined ? {} : { label }),
    ...(bleName === undefined ? {} : { bleName }),
    ...(bleId === undefined ? {} : { bleId }),
  }
}

/**
 * M0 stand-ins for the two real control models.
 *
 * `mock-pulse` streams (Coyote, Ankni JH1) and therefore zeroes itself when
 * the host stops refreshing. `mock-hold` is stateful (Buttplug) and keeps
 * running after a host crash — the reason a host-side timer alone is not a
 * safety guarantee.
 */
function createMockDevices(clock: Clock): MockBackend[] {
  return [
    new MockBackend({
      id: 'mock-pulse',
      name: 'Mock Pulse Box (streaming)',
      clock,
      keepAliveMs: 400,
      refreshMs: 100,
      channels: [
        { id: 'a', kind: 'level', label: 'A 通道' },
        { id: 'b', kind: 'level', label: 'B 通道' },
      ],
    }),
    new MockBackend({
      id: 'mock-hold',
      name: 'Mock Vibrator (stateful)',
      clock,
      channels: [{ id: 'main', kind: 'level', label: '主马达' }],
    }),
  ]
}

/**
 * The subset of a capture host the settings wiring drives.
 *
 * Camera and microphone hosts share this shape, so boot/save handling lives in
 * one place. The optional `fps` is honoured by the camera host and ignored by
 * the audio host (its cadence is fixed at 2 Hz).
 */
interface CaptureHostLike {
  readonly sourceId: string
  readonly label: string
  listDevices(): Promise<readonly SensorDeviceInfo[]>
  start(deviceId: string, options?: { readonly fps?: number }): Promise<void>
  stop(): Promise<void>
  onFeatures(listener: (sample: FeatureSample) => void): () => void
}

/**
 * Live state of one capture source.
 *
 * `preference` mirrors the persisted human choice; `status`/`error` describe
 * what the host is actually doing and are never written to disk (a stale
 * "running" from the previous process would lie).
 */
interface CaptureControl {
  readonly host: CaptureHostLike | undefined
  preference: SensorPreference
  status: 'running' | 'stopped' | 'unavailable' | 'error'
  error: string | undefined
  devices: SensorDeviceInfo[]
  /** Device capture actually opened, or `null` when not capturing. */
  runningDeviceId: string | null
}

export async function createHostRuntime(options: HostRuntimeOptions): Promise<HostRuntime> {
  const clock = options.clock ?? systemClock
  const onError = options.onError ?? ((): void => {})
  const documents = new FileDocumentStore(join(options.dataDir, 'state'))
  const audit = new AuditLog(
    new FileAppendOnlyStore(join(options.dataDir, 'audit', 'device.jsonl')),
    clock,
    error => { onError(error) },
  )
  const policy = new PolicyStore()
  const waveforms = new WaveformLibrary()

  // Keep the most recent failures visible to the console UI. Errors otherwise
  // only reach the terminal, which an operator looking at the window never sees.
  const recentErrors: { ts: number; message: string }[] = []
  const recordError = (error: unknown): void => {
    recentErrors.push({ ts: clock.now(), message: error instanceof Error ? error.message : String(error) })
    if (recentErrors.length > 20) recentErrors.shift()
    onError(error)
  }

  // Restore anything the operator promoted in an earlier session.
  const savedWaveforms = await documents.read('waveforms')
  if (savedWaveforms !== undefined) {
    try {
      waveforms.loadLibrary(JSON.parse(savedWaveforms) as SerializedWaveform[])
    } catch (error) {
      recordError(error)
    }
  }

  // Restore human caps (D4). A cap change has to survive a restart, but a
  // corrupt or hand-edited file must never widen them: parsePolicySnapshot
  // fails closed and we keep the conservative defaults.
  const savedPolicy = await documents.read('policy')
  let policyMigrated = false
  let restoredSnapshot: PolicySnapshot | undefined
  if (savedPolicy !== undefined) {
    let restored: PolicySnapshot | undefined
    try {
      restored = parsePolicySnapshot(JSON.parse(savedPolicy))
      policy.restore(restored)
      policyMigrated = restored.migrated === true
      restoredSnapshot = restored
    } catch (error) {
      restored = undefined
      recordError(error)
    }
    if (restored !== undefined
      && (Object.keys(restored.channels).length > 0 || restored.sessionCeiling !== DEFAULT_SESSION_CEILING)) {
      // Restoring human-set state is not a cap change, but a hand-edited file
      // must leave a trace: the audit records what came back from disk.
      await audit.record({
        actor: 'system',
        action: 'policy_change',
        result: 'ok',
        detail: {
          scope: 'restore',
          channels: Object.keys(restored.channels).length,
          sessionCeiling: restored.sessionCeiling,
        },
      })
    }
  }

  const savePolicy = async (): Promise<void> => {
    await documents.write('policy', serializePolicySnapshot(policy.snapshot()))
  }

  // A v1 file (pulse-width era) is valid but old-shaped: write it back once so
  // the on-disk state is v2 and the next start does not migrate again.
  if (policyMigrated) await savePolicy()

  // v3 removes the global session ceiling from the UI: the human bounds output
  // per device/channel instead. A ceiling persisted by an older build is
  // translated once into each explicit channel's `maxPercent` and then released,
  // so it can never silently squeeze the new per-channel ranges (or create an
  // inverted interval). The translation is audited; it only ever narrows.
  const legacyCeiling = restoredSnapshot?.sessionCeiling
  if (legacyCeiling !== undefined && legacyCeiling !== DEFAULT_SESSION_CEILING) {
    for (const key of Object.keys(restoredSnapshot?.channels ?? {})) {
      // Persisted keys are `device:channel` (the snapshot shape), not the
      // internal NUL-joined key.
      const separator = key.indexOf(':')
      if (separator <= 0) continue
      const deviceId = key.slice(0, separator)
      const channelId = key.slice(separator + 1)
      const current = policy.get(deviceId, channelId)
      const narrowed = Math.max(current.minPercent + 1, Math.min(current.maxPercent, legacyCeiling))
      if (narrowed !== current.maxPercent) {
        policy.setByHuman(deviceId, channelId, { maxPercent: narrowed })
      }
    }
    policy.setSessionCeilingByHuman(DEFAULT_SESSION_CEILING)
    await savePolicy()
    await audit.record({
      actor: 'system',
      action: 'policy_change',
      result: 'ok',
      detail: { scope: 'ceiling-migration', previous: legacyCeiling, next: DEFAULT_SESSION_CEILING },
    })
  }

  // ── Model gateway (B1-T15) ──────────────────────────────────────────────
  // Settings come from `state/llm.json`; the API key is resolved
  // environment-first and is never copied into the config object. Assembling
  // the runner performs NO network IO — the first request happens on the first
  // turn, so booting offline (or without a key) is a supported state.
  //
  // `llmSettings`/`llm`/`modelRunner` are mutable because the settings view can
  // replace the model at run time: `saveLlmSettings` persists, rebuilds the
  // runner and swaps it in. The session reads the runner through the provider
  // passed to `PlayHost` below, so the *next* turn uses the new model.
  const llmEnv = options.llmEnv ?? process.env
  let llmSettings: LlmSettings = options.llmConfig === undefined
    ? await loadLlmSettings(options.dataDir, llmEnv)
    : settingsFromConfig(options.llmConfig, llmEnv)
  let llm: LlmConfig = llmSettings.config
  const buildModelRunner = (settings: LlmSettings): ModelRunner => createModelRunner({
    model: singleCallModel(settings.config),
    ...(settings.apiKey === undefined ? {} : { apiKey: settings.apiKey }),
    fetch: options.llmFetch ?? globalThis.fetch,
    clock,
    env: llmEnv,
  })
  /** Can the gateway construct a runner for this model? Constructor only — no IO. */
  const runnerBuilds = (model: ModelConfig): boolean => {
    try {
      createModelRunner({
        model,
        fetch: options.llmFetch ?? globalThis.fetch,
        clock,
        env: llmEnv,
      })
      return true
    } catch {
      return false
    }
  }

  /**
   * Drop `director`/`writer` roles the gateway cannot construct.
   *
   * A hand-edited split-mode file can name an unrunnable role; the single-call
   * lane resolves `director` first, so keeping such a role would either fail
   * boot or make every later settings save fail. The invalid role is ignored in
   * memory (and dropped on the next save, which repairs the file) instead.
   */
  const sanitizeLlmConfig = (config: LlmConfig): {
    readonly config: LlmConfig
    readonly dropped: ReadonlyArray<'director' | 'writer'>
  } => {
    const dropped: Array<'director' | 'writer'> = []
    let director = config.director ?? null
    if (director !== null && !runnerBuilds(director)) {
      dropped.push('director')
      director = null
    }
    let writer = config.writer ?? null
    if (writer !== null && !runnerBuilds(writer)) {
      dropped.push('writer')
      writer = null
    }
    return { config: { default: config.default, director, writer }, dropped }
  }

  /** Terse, key-free reasons shown by the settings page after a degraded boot. */
  let llmWarning: string[] = []

  // A hand-edited `state/llm.json` can name a provider with no default endpoint
  // (e.g. provider "acme" and no `baseUrl`): the runner constructor throws, and
  // failing here would make the whole console unbootable. The host falls back to
  // the built-in default **in memory**, leaves the operator's file untouched (so
  // they can see what they wrote), records the degradation and surfaces a
  // warning in the settings payload.
  let modelRunner: ModelRunner
  try {
    modelRunner = buildModelRunner(llmSettings)
  } catch (error) {
    recordError(error)
    const reason = error instanceof Error ? error.message : String(error)
    log(`[llm] configured model is unusable (${reason}); falling back in memory`)
    const configuredDefault = llmSettings.config.default
    const nextDefault = runnerBuilds(configuredDefault) ? configuredDefault : DEFAULT_LLM_CONFIG.default
    const sanitized = sanitizeLlmConfig({
      default: nextDefault,
      director: llmSettings.config.director ?? null,
      writer: llmSettings.config.writer ?? null,
    })
    const rawFile = await documents.read(LLM_SETTINGS_KEY)
    const resolved = resolveApiKey(llmEnv, sanitized.config.default, storedApiKeyOf(rawFile))
    llmSettings = {
      config: sanitized.config,
      apiKey: resolved.apiKey,
      apiKeySource: resolved.source,
    }
    llm = llmSettings.config
    modelRunner = buildModelRunner(llmSettings)
    llmWarning = [
      ...(nextDefault === configuredDefault ? [] : ['当前模型配置无效，已临时使用内置默认模型']),
      ...(sanitized.dropped.length === 0 ? [] : [`已忽略无效的 ${sanitized.dropped.join('/')} 配置`]),
      '在设置页保存一次即可修复',
    ]
    await audit.record({
      actor: 'system',
      action: 'settings_change',
      result: 'ok',
      detail: {
        scope: 'llm-boot-fallback',
        reason,
        droppedRoles: sanitized.dropped,
        usedDefaultModel: nextDefault !== configuredDefault,
      },
    })
  }
  const llmSummary = (): LlmSummary => llmSummaryOf(llmSettings)

  // Region labels: manifest defaults live in the registry snapshot; the
  // override layer persists separately so a cleared label stays cleared.
  const regionStore = new RegionStore()
  const savedRegions = await documents.read('regions')
  if (savedRegions !== undefined) {
    try {
      const parsed: unknown = JSON.parse(savedRegions)
      if (typeof parsed === 'object' && parsed !== null) regionStore.restore(parsed as Record<string, string>)
    } catch (error) {
      recordError(error)
    }
  }
  const registry = new DeviceRegistry({ clock, audit, policy, waveforms, regions: regionStore, onError: recordError })
  const controller = new AbortController()

  // ── Perception sources (A1-T6) ──────────────────────────────────────────
  // One registry always exists, camera or not: the console API and the model
  // tools then have a single place to read perception from, and "no source"
  // is a supported state rather than a missing dependency.
  const sensors = new SensorRegistry({ clock, onError: recordError })
  // ── Capture state for the settings view (product requirement #5) ────────
  // Preferences live in `state/settings.json`; capture status is live and never
  // persisted. A host that is not wired (headless dev-server, no camera) is
  // `supported: false`, which the settings page renders as 不可用.
  let sensorPreferences: SensorPreferences = await loadSensorPreferences(documents)
  /** One-shot `unavailable` sample: a stopped source must not read as healthy. */
  const pushUnavailableSample = (sourceId: string): void => {
    try {
      sensors.push({ sourceId, ts: clock.now(), frameAgeMs: 0, quality: 'unavailable' })
    } catch (error) {
      recordError(error)
    }
  }
  const shortError = (error: unknown): string => {
    const message = error instanceof Error ? error.message : String(error)
    return message.length > 120 ? `${message.slice(0, 117)}…` : message
  }
  interface CaptureDeviceList {
    readonly devices: SensorDeviceInfo[]
    /** Short reason when enumeration itself failed (distinct from "no hardware"). */
    readonly error?: string
  }
  const listCaptureDevices = async (host: CaptureHostLike | undefined): Promise<CaptureDeviceList> => {
    if (host === undefined) return { devices: [] }
    try {
      return { devices: [...await host.listDevices()] }
    } catch (error) {
      recordError(error)
      return { devices: [], error: shortError(error) }
    }
  }
  /**
   * Open the preferred device (or the first available one) and start capture.
   *
   * A start failure is state, not a host fault: the settings payload reports
   * `status: 'error'` with a short reason and the caller still persists the
   * preference. That is what a permission refusal or an unplugged device should
   * look like in the UI.
   */
  const startCapture = async (control: CaptureControl, preferred: string | null): Promise<void> => {
    const host = control.host
    if (host === undefined) {
      control.status = 'unavailable'
      return
    }
    const listed = await listCaptureDevices(host)
    control.devices = listed.devices
    if (listed.error !== undefined) {
      control.runningDeviceId = null
      control.status = 'error'
      control.error = listed.error
      pushUnavailableSample(host.sourceId)
      return
    }
    const stored = preferred !== null && control.devices.some(device => device.deviceId === preferred)
      ? preferred
      : undefined
    const chosen = stored ?? control.devices[0]?.deviceId
    if (chosen === undefined) {
      control.runningDeviceId = null
      control.status = 'unavailable'
      control.error = '没有可用的设备'
      log(`[${host.sourceId}] no capture device found`)
      pushUnavailableSample(host.sourceId)
      return
    }
    if (control.runningDeviceId === chosen && control.status === 'running') {
      control.error = undefined
      return
    }
    try {
      await host.start(chosen, { fps: options.cameraFps ?? DEFAULT_CAMERA_FPS })
      control.runningDeviceId = chosen
      control.status = 'running'
      control.error = undefined
    } catch (error) {
      recordError(error)
      control.runningDeviceId = null
      control.status = 'error'
      control.error = shortError(error)
      // A refused stream still leaves a registered source; make its loss
      // explicit instead of letting it read as "camera fine, no data".
      pushUnavailableSample(host.sourceId)
    }
  }
  /** Stop capture; emits one `unavailable` sample so the registry stops lying. */
  const stopCapture = async (control: CaptureControl): Promise<void> => {
    const host = control.host
    if (host === undefined) {
      control.status = 'unavailable'
      return
    }
    let stopError: unknown
    if (control.runningDeviceId !== null) {
      try {
        await host.stop()
      } catch (error) {
        // A failing bridge stop must not block disabling the source, but the
        // status must not claim a clean stop either.
        stopError = error
        recordError(error)
      }
    }
    control.runningDeviceId = null
    control.status = stopError === undefined ? 'stopped' : 'error'
    control.error = stopError === undefined ? undefined : shortError(stopError)
    pushUnavailableSample(host.sourceId)
  }
  /** Apply one persisted preference to a live capture host. */
  const applyCapturePreference = async (control: CaptureControl, preference: SensorPreference): Promise<void> => {
    control.preference = preference
    if (control.host === undefined) return
    if (!preference.enabled) {
      await stopCapture(control)
      return
    }
    await startCapture(control, preference.deviceId)
  }
  /** Project one live control into the settings payload. */
  const captureState = (control: CaptureControl): SensorCaptureState => {
    if (control.host === undefined) return unsupportedSensorState()
    return {
      supported: true,
      enabled: control.preference.enabled,
      // What capture is using right now, falling back to the stored preference
      // when nothing is running (stopped/disabled/error).
      deviceId: control.runningDeviceId ?? control.preference.deviceId,
      devices: control.devices,
      status: control.status,
      ...(control.error === undefined ? {} : { error: control.error }),
    }
  }
  /** Fan one camera/microphone sample into the registry and the status line. */
  const wireCaptureFeatures = (control: CaptureControl): ((sample: FeatureSample) => void) => sample => {
    try {
      sensors.push(sample)
    } catch (error) {
      recordError(error)
    }
    // The capture end owns the `unavailable` signal (plan §8.7 ruling 5): when
    // a stream ends on its own, the settings view must stop claiming `running`.
    if (sample.quality === 'unavailable' && control.runningDeviceId !== null) {
      control.runningDeviceId = null
      control.status = 'unavailable'
      control.error = '采集已中断'
    }
  }

  const cameraControl: CaptureControl = {
    host: options.cameraHost,
    preference: sensorPreferences.camera,
    status: 'stopped',
    error: undefined,
    devices: [],
    runningDeviceId: null,
  }
  const microphoneControl: CaptureControl = {
    host: options.audioHost,
    preference: sensorPreferences.microphone,
    status: 'stopped',
    error: undefined,
    devices: [],
    runningDeviceId: null,
  }

  if (options.cameraHost !== undefined) {
    const camera = options.cameraHost
    sensors.register(cameraSensorSource(camera))
    camera.onFeatures(wireCaptureFeatures(cameraControl))
  }
  if (options.audioHost !== undefined) {
    const audio = options.audioHost
    sensors.register(audioSensorSource(audio))
    audio.onFeatures(wireCaptureFeatures(microphoneControl))
  }

  // Boot-time application of the persisted preferences. Camera on is the old
  // behaviour (and the documented default); microphone on only if a human
  // enabled it earlier — a fresh install never records room audio.
  if (options.cameraHost !== undefined && sensorPreferences.camera.enabled && options.withCamera !== false) {
    await startCapture(cameraControl, sensorPreferences.camera.deviceId)
  }
  if (options.audioHost !== undefined && sensorPreferences.microphone.enabled) {
    await startCapture(microphoneControl, sensorPreferences.microphone.deviceId)
  }

  // ── Settings service (product requirement #5) ──────────────────────────
  // The console's 设置 view is a thin client of these three operations. The API
  // key never crosses this boundary: `LlmSettings` is its only carrier and it
  // goes straight into the runner's auth header.
  /** Degraded-config warnings the settings page shows (terse, key-free). */
  const llmWarnings = (): string[] => [
    ...llmWarning,
    ...(llm.director !== null || llm.writer !== null
      ? ['文件里另有 director/writer 配置；设置页只修改默认模型']
      : []),
  ]
  /** Base URL safe for the audit trail: query/hash may carry operator secrets. */
  const redactBaseUrl = (value: string | undefined): string | null =>
    value === undefined ? null : value.replace(/[?#].*$/u, '')

  const settingsSnapshot = async (): Promise<SettingsPayload> => {
    // The page's refresh buttons re-list devices by calling this again.
    const cameraDevices = await listCaptureDevices(options.cameraHost)
    const microphoneDevices = await listCaptureDevices(options.audioHost)
    cameraControl.devices = cameraDevices.devices
    microphoneControl.devices = microphoneDevices.devices
    // An enumeration fault is not "no hardware": show it instead of turning it
    // into an empty dropdown with a misleading 没有可用的设备.
    if (cameraDevices.error !== undefined && cameraControl.status !== 'running') {
      cameraControl.status = 'error'
      cameraControl.error = cameraDevices.error
    }
    if (microphoneDevices.error !== undefined && microphoneControl.status !== 'running') {
      microphoneControl.status = 'error'
      microphoneControl.error = microphoneDevices.error
    }
    return buildSettingsPayload({
      llm: buildLlmSettingsPayload(llmSummary(), llm, { warning: llmWarnings() }),
      sensors: { camera: captureState(cameraControl), microphone: captureState(microphoneControl) },
    })
  }

  /**
   * Serialise settings read-modify-write operations.
   *
   * Each operation reads the persisted state, applies a patch and writes it
   * back. Two quick toggles — or a model save racing a sensor save — must not
   * interleave, or one side would be silently dropped.
   */
  let settingsOps: Promise<unknown> = Promise.resolve()
  const runSettingsOp = <T>(operation: () => Promise<T>): Promise<T> => {
    const next = settingsOps.then(operation, operation)
    settingsOps = next.catch(() => {})
    return next
  }

  const saveLlmSettings = (patch: LlmSettingsPatch): Promise<SettingsPayload> =>
    runSettingsOp(async () => {
      if (options.llmConfig !== undefined) {
        throw new SettingsError(
          'FIXED_LLM_CONFIG',
          'this host was started with an in-memory model config; start it from state/llm.json to change the model here',
        )
      }
      // Re-read the file: a hand-edit between boot and save must not be silently
      // dropped from the fields this patch does not mention.
      const before = await loadLlmSettings(options.dataDir, llmEnv)
      const previousDefault = before.config.default
      const baseUrl = patch.baseUrl === undefined ? previousDefault.baseUrl : (patch.baseUrl ?? undefined)
      const { baseUrl: _previousBaseUrl, ...restDefault } = previousDefault
      const nextDefault: ModelConfig = {
        ...restDefault,
        ...(patch.provider === undefined ? {} : { provider: patch.provider }),
        ...(patch.model === undefined ? {} : { model: patch.model }),
        ...(baseUrl === undefined ? {} : { baseUrl }),
      }
      const nextConfig: LlmConfig = {
        default: nextDefault,
        director: before.config.director ?? null,
        writer: before.config.writer ?? null,
      }
      // Key semantics: omitted = keep the key already *in the file* (the
      // resolved value can be an environment variable that shadows it), `''` =
      // clear, anything else = replace. An env-resolved key is never copied in.
      const rawBefore = await documents.read(LLM_SETTINGS_KEY)
      const storedKey = patch.apiKey === undefined
        ? storedApiKeyOf(rawBefore)
        : (patch.apiKey.trim() === '' ? undefined : patch.apiKey.trim())
      // The default model is what this page edits: it must be constructible
      // exactly as typed (an unknown provider without a `baseUrl` is a 400
      // here, not a file that bricks every later boot).
      try {
        createModelRunner({
          model: nextDefault,
          fetch: options.llmFetch ?? globalThis.fetch,
          clock,
          env: llmEnv,
        })
      } catch (error) {
        throw new SettingsError('INVALID_LLM', shortError(error))
      }
      // `director`/`writer` are file-level configuration. Drop an unrunnable
      // one so this save succeeds *and* repairs the file instead of preserving
      // a config that makes the UI unable to save anything later.
      const sanitized = sanitizeLlmConfig(nextConfig)
      const savedConfig = sanitized.config
      await saveLlmConfig(options.dataDir, savedConfig, storedKey === undefined ? {} : { apiKey: storedKey })
      const next = await loadLlmSettings(options.dataDir, llmEnv)
      // Build the real runner before publishing the new settings: a failure
      // would otherwise leave the host showing a config it cannot run.
      const nextRunner = buildModelRunner(next)
      llmSettings = next
      llm = next.config
      modelRunner = nextRunner
      // A successful save has just repaired the file (invalid roles are
      // dropped above), so the degraded-boot warning no longer applies.
      llmWarning = []
      await audit.record({
        actor: 'human',
        action: 'settings_change',
        result: 'ok',
        detail: {
          scope: 'llm',
          provider: next.config.default.provider,
          model: next.config.default.model,
          // Audit is a durable file: never copy a query/hash that may be secret.
          baseUrl: redactBaseUrl(next.config.default.baseUrl),
          apiKeySource: next.apiKeySource,
          apiKeyChanged: patch.apiKey !== undefined,
        },
      })
      return settingsSnapshot()
    })

  /** A mentioned device id must exist on that capture host right now. */
  const assertKnownCaptureDevice = async (
    control: CaptureControl,
    designation: { readonly deviceId?: string | null },
  ): Promise<void> => {
    const deviceId = designation.deviceId
    if (deviceId === undefined || deviceId === null) return
    // Re-list before judging: a device plugged in after boot is selectable.
    const listed = await listCaptureDevices(control.host)
    control.devices = listed.devices
    if (listed.error !== undefined) {
      throw new SettingsError('INVALID_SENSOR', `could not list capture devices: ${listed.error}`)
    }
    if (!control.devices.some(device => device.deviceId === deviceId)) {
      throw new SettingsError('INVALID_SENSOR', `unknown capture device "${deviceId}"`)
    }
  }

  const saveSensorSettings = (patch: SensorPreferencesPatch): Promise<SettingsPayload> =>
    runSettingsOp(async () => {
      if (patch.camera !== undefined) await assertKnownCaptureDevice(cameraControl, patch.camera)
      if (patch.microphone !== undefined) await assertKnownCaptureDevice(microphoneControl, patch.microphone)
      const nextPreferences = mergeSensorPreferences(sensorPreferences, patch)
      sensorPreferences = nextPreferences
      // Capture failures are reported, never thrown: the preference is saved and
      // the payload carries `status: 'error'` plus a short reason.
      if (patch.camera !== undefined) await applyCapturePreference(cameraControl, nextPreferences.camera)
      if (patch.microphone !== undefined) await applyCapturePreference(microphoneControl, nextPreferences.microphone)
      await saveSensorPreferences(documents, nextPreferences)
      await audit.record({
        actor: 'human',
        action: 'settings_change',
        result: 'ok',
        detail: {
          scope: 'sensors',
          camera: { enabled: nextPreferences.camera.enabled, deviceId: nextPreferences.camera.deviceId },
          microphone: { enabled: nextPreferences.microphone.enabled, deviceId: nextPreferences.microphone.deviceId },
        },
      })
      return settingsSnapshot()
    })

  /** The seam the console's settings routes are driven through. */
  const settingsDeps: SettingsDeps = {
    snapshot: settingsSnapshot,
    saveLlm: saveLlmSettings,
    saveSensors: saveSensorSettings,
  }

  const firstImageSourceId = (): string | undefined =>
    sensors.statuses().find(status => status.kind === 'image')?.id
  const sensorsStatus = (): readonly SensorStatus[] => sensors.statuses()
  const sensorFrame = async (sourceId?: string): Promise<Snapshot | undefined> => {
    const target = sourceId ?? firstImageSourceId()
    if (target === undefined) return undefined
    return sensors.latestSnapshot(target)
  }
  const pushFeatures = (sample: FeatureSample): void => { sensors.push(sample) }

  // ── Content-pack registry (B2-T14) ──────────────────────────────────────
  // The registry owns `<dataDir>/content/registry.json` and
  // `content/packs/<id>/<version>/`; `core` stays platform-free, so the host
  // supplies the filesystem port and Node's zip decompressor. This is the only
  // writer of installed packs (the session reads through `RegistryPackSource`).
  const packStore = new FsPackStore(options.dataDir)
  const inflateRaw: RawInflate = (data, inflateOptions) =>
    new Uint8Array(inflateRawSync(data, inflateOptions))
  const packRegistry = new PackRegistry({
    store: packStore,
    clock,
    engineVersion: ENGINE_VERSION,
    inflateRaw,
  })
  // 导入/切换都是 read-modify-write 同一份 registry.json；并发 HTTP 请求若
  // 交错会互相覆盖，所以全部串行化。shutdown 会等这个队列排空再退出，
  // 避免进程在“文件写完、注册表未写”的中间态退出。
  let packOps: Promise<unknown> = Promise.resolve()
  const runPackOp = <T>(operation: () => Promise<T>): Promise<T> => {
    const next = packOps.then(operation, operation)
    packOps = next.catch(() => {})
    return next
  }
  /** Region vocabulary per `packId@version`; loading a pack validates every file. */
  const regionCache = new Map<string, PackRegionVocabulary>()

  // ── Host session service (B1-T16) ───────────────────────────────────────
  // One session per process. Packs resolve through the installed-pack registry
  // (B2-T14): the active version chosen in `content/registry.json` wins, so
  // switching a pack at a session boundary changes what the next start loads
  // without touching this service's interface.
  const play = new PlayHost({
    clock,
    audit,
    registry,
    policy,
    waveforms,
    sensors,
    // Provider, not a snapshot: a model change in the settings view must reach
    // the next turn without restarting the session or the host.
    runner: () => modelRunner,
    savePolicy,
    packs: new RegistryPackSource({ registry: packRegistry, store: packStore, engineVersion: ENGINE_VERSION }),
    // B2-T7/T8: every settled turn writes a snapshot, every session one ledger
    // line. The ledger is append-only and lives outside `state/` on purpose.
    archive: {
      state: documents,
      memory: new FileDocumentStore(join(options.dataDir, 'memory')),
      ledger: new FileAppendOnlyStore(join(options.dataDir, 'memory', 'ledger.jsonl')),
      ledgerText: async (): Promise<string | undefined> => {
        try {
          return await readFile(join(options.dataDir, 'memory', 'ledger.jsonl'), 'utf8')
        } catch {
          return undefined
        }
      },
    },
  })

  // ── Device manifest: which units exist and how to reach them ────────────
  // New manifests are seeded with the well-known units; older files are
  // migrated once by the manifest version. From then on the persisted list is
  // the operator's, added to and removed from through the console.
  let manifest: DeviceManifestEntry[] = []
  let manifestVersion = 0
  const saveManifest = async (): Promise<void> => {
    const file: { version: number; devices: DeviceManifestEntry[] } = { version: MANIFEST_VERSION, devices: manifest }
    await documents.write('devices', JSON.stringify(file, null, 2))
  }
  {
    const raw = await documents.read('devices')
    if (raw !== undefined) {
      try {
        const parsed: unknown = JSON.parse(raw)
        if (Array.isArray(parsed)) {
          // v1 files were a bare array.
          manifest = parsed.map(normalizeManifestEntry).filter((entry): entry is DeviceManifestEntry => entry !== undefined)
        } else if (typeof parsed === 'object' && parsed !== null) {
          const file = parsed as DeviceManifestFile
          manifest = Array.isArray(file.devices) ? file.devices.map(normalizeManifestEntry).filter((entry): entry is DeviceManifestEntry => entry !== undefined) : []
          manifestVersion = typeof file.version === 'number' ? file.version : 1
        }
      } catch (error) {
        recordError(error)
      }
    }
    // The v3 console let operators add "模拟设备"; those entries are not part
    // of the product any more. Drop them from the loaded manifest (and rewrite
    // the file) instead of registering fake hardware again on an upgraded data
    // directory.
    const mockEntries = manifest.filter(entry => entry.protocol === 'mock')
    const cleanedMockManifest = mockEntries.length > 0
    if (cleanedMockManifest) {
      manifest = manifest.filter(entry => entry.protocol !== 'mock')
      await audit.record({
        actor: 'system',
        action: 'settings_change',
        result: 'ok',
        detail: { scope: 'mock-manifest-cleanup', removed: mockEntries.map(entry => entry.key) },
      })
    }
    if (options.bleTransport !== undefined) {
      if (manifest.length === 0) {
        manifest = [...WELL_KNOWN_DEVICES]
        await saveManifest()
      } else if (manifestVersion < MANIFEST_VERSION) {
        // v2 → v3: the ZKRXB rotation unit speaks the ANKNI stream protocol.
        if (manifestVersion < 3) {
          manifest = manifest.map(entry =>
            entry.key === 'zkrxb' && entry.protocol === 'xhtkj' ? { ...entry, protocol: 'ankni' } : entry,
          )
        }
        // Introduce units that postdate the file; the bumped version keeps
        // later removals (and this migration) from running again.
        manifest = [...manifest, ...WELL_KNOWN_DEVICES.filter(entry => !manifest.some(existing => existing.key === entry.key))]
        await saveManifest()
      }
    }
    // Persist the mock removal even when no BLE transport runs (dev-server), so
    // the upgrade happens once instead of on every boot.
    if (cleanedMockManifest && options.bleTransport === undefined) await saveManifest()
  }

  // Tests and fixtures keep the two simulated devices; product entry points
  // (Electron main, dev-server) pass `withMockDevices: false` unless the
  // operator explicitly asked for a hardware-free demo run.
  if (options.withMockDevices !== false) {
    for (const backend of createMockDevices(clock)) {
      registry.register(backend)
    }
  }

  /**
   * Live backend per manifest key.
   *
   * The registry keeps its own map, but the host needs the backend instance to
   * read the platform id chosen by the BLE chooser and to rebuild one on
   * "重新配对".
   */
  const backends = new Map<string, DeviceBackend>()

  /** Register one manifest entry's backend (used by boot, add and rebind). */
  const registerDeviceBackend = (entry: DeviceManifestEntry): DeviceBackend => {
    const backend = createBackend(entry)
    backends.set(entry.key, backend)
    registry.register(backend)
    return backend
  }

  /** Build the backend for one manifest entry. */
  const createBackend = (entry: DeviceManifestEntry): DeviceBackend => {
    // Read the pairing pin fresh on every connect: "重新配对" clears `bleId`
    // without rebuilding the backend.
    const boundDeviceId = (): string | undefined => manifest.find(candidate => candidate.key === entry.key)?.bleId
    // Unpinned pairings must not take a unit another card has persisted — after
    // a restart no link is live yet, so "connected" alone is not enough.
    const reservedDeviceIds = (): readonly string[] => {
      const ids = new Set<string>()
      for (const candidate of manifest) {
        if (candidate.key === entry.key || candidate.bleId === undefined) continue
        ids.add(candidate.bleId)
      }
      return [...ids]
    }
    switch (entry.protocol) {
      case 'coyote': {
        const transport = options.bleTransport
        if (transport === undefined) throw new Error('coyote needs a BLE transport')
        return new CoyoteBackend({
          clock,
          transport,
          id: entry.key,
          name: entry.label ?? DEFAULT_DEVICE_NAMES.coyote,
          ...(entry.bleName === undefined ? {} : { bleName: entry.bleName }),
          bleDeviceId: boundDeviceId,
          bleReservedIds: reservedDeviceIds,
          // Read fresh on every call so a cap change reaches the hardware.
          // `effective` is the session ceiling applied on top of the channel
          // cap, so `BF <= X` holds by construction (D4, rule 4).
          maxPercent: channel => policy.effective(entry.key, channel).maxPercent,
          // The human's frequency band, read on every frame: a band change
          // re-shapes the waveform texture live without touching the amplitude.
          frequencyRange: channel => {
            const effective = policy.effective(entry.key, channel)
            return { min: effective.minFreq, max: effective.maxFreq }
          },
          // Internal pulse-width ceiling (default 80, v1 value preserved). It is
          // deliberately NOT exposed through /api/cap: the human configures the
          // frequency band, while this stays a fixed safety bound against the
          // vendor's "stinging" pulse width.
          maxWaveIntensity: channel => policy.effective(entry.key, channel).maxWaveIntensity,
          onError: recordError,
        })
      }
      case 'xhtkj': {
        const transport = options.bleTransport
        if (transport === undefined) throw new Error('xhtkj needs a BLE transport')
        return new XhtkjBackend({
          clock,
          transport,
          id: entry.key,
          name: entry.label ?? DEFAULT_DEVICE_NAMES.xhtkj,
          ...(entry.bleName === undefined ? {} : { bleName: entry.bleName }),
          bleDeviceId: boundDeviceId,
          bleReservedIds: reservedDeviceIds,
          onError: recordError,
        })
      }
      case 'ankni': {
        const transport = options.bleTransport
        if (transport === undefined) throw new Error('ankni needs a BLE transport')
        return new AnkniBackend({
          clock,
          transport,
          id: entry.key,
          name: entry.label ?? DEFAULT_DEVICE_NAMES.ankni,
          ...(entry.bleName === undefined ? {} : { bleName: entry.bleName }),
          bleDeviceId: boundDeviceId,
          bleReservedIds: reservedDeviceIds,
          onError: recordError,
        })
      }
      case 'mock':
        return new MockBackend({
          id: entry.key,
          name: entry.label ?? DEFAULT_DEVICE_NAMES.mock,
          clock,
          keepAliveMs: 400,
          refreshMs: 100,
          channels: [
            { id: 'a', kind: 'level', label: 'A 通道' },
            { id: 'b', kind: 'level', label: 'B 通道' },
          ],
        })
    }
  }

  for (const entry of manifest) {
    // BLE protocols need a transport; on start-dev (none) they are skipped but
    // stay in the manifest so a later BLE run picks them back up.
    if (entry.protocol !== 'mock' && options.bleTransport === undefined) {
      log(`[devices] skipping ${entry.key} (${entry.protocol}): no BLE transport configured`)
      continue
    }
    try {
      registerDeviceBackend(entry)
    } catch (error) {
      recordError(error)
    }
  }

  if (options.monsterPartyToken !== undefined && options.monsterPartyToken.trim().length > 0) {
    const relay = new MonsterPartyBackend({
      clock,
      sockets: new NodeTextSocketTransport(),
      sessionToken: options.monsterPartyToken,
      userAgent: 'embodied-roleplay/0.0 (+local)',
      onError: recordError,
    })
    registry.register(relay)
  }

  // The probe is expected to fail when no engine is installed; that lives in
  // the background log buffer, not the terminal (noise for most operators).
  const intifaceProcess = new IntifaceProcess({
    onError: error => { log(`[embodied] Intiface probe: ${error instanceof Error ? error.message : String(error)}`) },
  })
  let intifaceAvailability: IntifaceAvailability = 'unavailable'
  if (options.withButtplug !== false) {
    intifaceAvailability = await intifaceProcess.ensure()
    if (intifaceAvailability !== 'unavailable') {
      const buttplug = new ButtplugBackend({
        clock,
        sockets: new NodeTextSocketTransport(),
        url: intifaceProcess.url,
        version: 4,
        // Give plugged-in toys a chance to appear without an explicit scan.
        scanOnConnectMs: 3_000,
        onError: recordError,
      })
      registry.register(buttplug)
    }
  }

  // ── Device management: the operator adds and removes units at run time ──
  let deviceOps: Promise<unknown> = Promise.resolve()
  const runDeviceOp = <T>(op: () => Promise<T>): Promise<T> => {
    const next = deviceOps.then(op, op)
    deviceOps = next.catch(() => {})
    return next
  }

  const listDevices = (): DeviceManagerEntry[] => {
    const byId = new Map(registry.snapshot().devices.map(device => [device.id, device]))
    return manifest.map(entry => {
      const live = byId.get(entry.key)
      return {
        key: entry.key,
        protocol: entry.protocol,
        // The backend name is fixed at construction time; a cleared label must
        // fall back to the protocol default, not to the old override.
        label: entry.label ?? DEFAULT_DEVICE_NAMES[entry.protocol],
        lifecycle: live?.lifecycle ?? 'disconnected',
        canScan: live?.canScan ?? false,
        channels: live === undefined ? [] : live.channels.map(channel => channel.id),
        bound: entry.bleId !== undefined,
        canRebind: REBINDABLE_PROTOCOLS.has(entry.protocol),
        ...(entry.bleId === undefined ? {} : { pairedId: entry.bleId }),
      }
    })
  }

  const nextDeviceKey = (protocol: DeviceProtocol): string => {
    const taken = new Set<string>([...manifest.map(entry => entry.key), 'mock-pulse', 'mock-hold'])
    for (let n = taken.has(protocol) ? 2 : 1; n < 100; n += 1) {
      const key = n === 1 ? protocol : `${protocol}-${n}`
      if (!taken.has(key)) return key
    }
    return `${protocol}-${Date.now()}`
  }

  const addDevice = async (protocol: DeviceProtocol): Promise<DeviceManagerEntry> => {
    if (protocol !== 'mock' && options.bleTransport === undefined) {
      throw new Error(`${protocol} needs a BLE transport; start-dev configures none`)
    }
    return runDeviceOp(async () => {
      const entry: DeviceManifestEntry = { key: nextDeviceKey(protocol), protocol }
      registerDeviceBackend(entry)
      manifest = [...manifest, entry]
      await saveManifest()
      // Registered but not connected: the operator drives the connection with
      // the 连接 button, so nothing scans on add.
      return listDevices().find(device => device.key === entry.key)!
    })
  }

  const removeDevice = async (key: string): Promise<void> => {
    await runDeviceOp(async () => {
      await registry.unregister(key)
      backends.delete(key)
      manifest = manifest.filter(entry => entry.key !== key)
      await saveManifest()
    })
  }

  /** Strip one optional field without leaving `undefined` in the JSON file. */
  const dropField = (entry: DeviceManifestEntry, field: 'label' | 'bleId'): DeviceManifestEntry => {
    const copy: Record<string, unknown> = { ...entry }
    delete copy[field]
    return copy as unknown as DeviceManifestEntry
  }

  /** Validate and normalise a human device name; empty clears the override. */
  const cleanDeviceLabel = (value: unknown): string | undefined => {
    if (value === undefined) return undefined
    if (typeof value !== 'string') throw new Error('label must be a string')
    const label = value.trim().replace(/\s+/gu, ' ')
    if (label.length === 0) return undefined
    if (label.length > 40) throw new Error('label must be at most 40 characters')
    return label
  }

  /**
   * Rename one device card.
   *
   * The name is stored on the manifest and overlaid on the registry snapshot,
   * so two same-named units become "左"/"右" without rebuilding the backend
   * (a rebuild would drop an open BLE link).
   */
  const setDeviceLabel = async (key: string, value: unknown): Promise<DeviceManagerEntry[]> => {
    return runDeviceOp(async () => {
      if (!manifest.some(entry => entry.key === key)) throw new Error(`no such device: ${key}`)
      const label = cleanDeviceLabel(value)
      manifest = manifest.map(entry => {
        if (entry.key !== key) return entry
        return label === undefined ? dropField(entry, 'label') : { ...entry, label }
      })
      await saveManifest()
      await audit.record({
        actor: 'human',
        action: 'settings_change',
        result: 'ok',
        detail: { scope: 'device-label', deviceId: key, label: label ?? null },
      })
      return listDevices()
    })
  }

  /**
   * Forget which physical unit a card was paired with.
   *
   * Drops the live link (if any) and clears `bleId`; the next 连接 pairs
   * whichever free unit answers. This is how an operator swaps which box a
   * card drives without removing and re-adding it.
   */
  const rebindDevice = async (key: string): Promise<DeviceManagerEntry[]> => {
    return runDeviceOp(async () => {
      const entry = manifest.find(candidate => candidate.key === key)
      if (entry === undefined) throw new Error(`no such device: ${key}`)
      if (backends.has(key)) {
        try {
          await registry.disconnect(key)
        } catch (error) {
          recordError(error)
          // The link may still be live; clearing the pin now could bind this
          // card to a different box while the old one keeps running.
          throw new Error(
            `could not disconnect ${key}: ${error instanceof Error ? error.message : String(error)}; `
            + 'the pairing was not cleared',
          )
        }
      }
      manifest = manifest.map(candidate => (candidate.key === key ? dropField(candidate, 'bleId') : candidate))
      await saveManifest()
      await audit.record({
        actor: 'human',
        action: 'settings_change',
        result: 'ok',
        detail: { scope: 'device-rebind', deviceId: key },
      })
      return listDevices()
    })
  }

  /**
   * Connect a card, then remember the physical unit the chooser picked.
   *
   * Persisting `bleId` is what keeps "左" pointing at the same box after a
   * reconnect or a restart: the next connect passes it back as a chooser pin.
   *
   * Serialised with the other device operations: the Electron chooser holds a
   * single pending selection, so two simultaneous scans would overwrite each
   * other's candidates (and could answer the wrong request).
   */
  const connectDevice = async (key: string): Promise<void> => {
    return runDeviceOp(async () => {
      await registry.connect(key, controller.signal)
      const platformId = backends.get(key)?.platformDeviceId
      const entry = manifest.find(candidate => candidate.key === key)
      if (platformId === undefined || entry === undefined) return
      // The chooser already excludes other cards' saved units; this is the
      // defensive check for a transport/backends that still returned one. Do
      // not persist a duplicate pin (it would lock both cards out later).
      const owner = manifest.find(candidate => candidate.key !== key && candidate.bleId === platformId)
      if (owner !== undefined) {
        try {
          await registry.disconnect(key)
        } catch (error) {
          recordError(error)
        }
        throw new Error(
          `Bluetooth device ${platformId} is already paired with "${owner.key}"; `
          + 'press 重新配对 on one of the cards to unpair it first',
        )
      }
      if (entry.bleId === platformId) return
      manifest = manifest.map(candidate => (candidate.key === key ? { ...candidate, bleId: platformId } : candidate))
      await saveManifest()
      await audit.record({
        actor: 'system',
        action: 'settings_change',
        result: 'ok',
        detail: { scope: 'device-paired', deviceId: key, platformId },
      })
    })
  }

  /**
   * Registry snapshot with manifest device names overlaid.
   *
   * Backends carry the name they were built with; the rename UI lives on the
   * manifest, and overlaying here keeps renames live without touching a
   * connected backend (or making the prompt/audit see an inconsistent name).
   * A manifest entry with no label (cleared / never set) shows the protocol
   * default rather than the name baked in at boot.
   */
  const decoratedSnapshot = (): RegistrySnapshot => {
    const snapshot = registry.snapshot()
    return {
      ...snapshot,
      devices: snapshot.devices.map(device => {
        const entry = manifest.find(candidate => candidate.key === device.id)
        if (entry === undefined) return device
        const name = entry.label ?? DEFAULT_DEVICE_NAMES[entry.protocol]
        return name === device.name ? device : { ...device, name }
      }),
    }
  }

  // Devices register disconnected; nothing connects or scans until the operator
  // presses 连接 in the console.
  const panicToken = options.panicToken ?? randomBytes(24).toString('base64url')
  let panicServer: PanicServer | undefined
  let panicAddress: { host: string; port: number } | undefined

  const panic = async (source: string): Promise<void> => {
    // The session engine's P0 path locks its own latch and its hook cuts the
    // devices; with no session this still reaches `registry.emergencyStop`.
    await play.panic(source)
  }

  if (options.withPanicServer !== false) {
    panicServer = new PanicServer({
      token: panicToken,
      ...(options.panicHost === undefined ? {} : { host: options.panicHost }),
      ...(options.panicPort === undefined ? {} : { port: options.panicPort }),
      onPanic: panic,
      onStatus: () => registry.snapshot(),
      onError: recordError,
    })
    panicAddress = await panicServer.start()
    // The phone page needs this to reach /panic. It is gitignored.
    await documents.write('panic', JSON.stringify({ token: panicToken, ...panicAddress }, null, 2))
  }

  // ── Control console (the UI and its JSON API) ──────────────────────────
  const dashboardToken = options.dashboardToken ?? randomBytes(24).toString('base64url')
  let dashboardServer: DashboardServer | undefined
  let dashboardAddress: { host: string; port: number } | undefined

  const dashboardDeps: DashboardDeps = {
    snapshot: decoratedSnapshot,
    // Model-requested band percent per channel, shown by the console instead
    // of the mapped output; the session owns this state.
    requestedPercents: () => play.requestedPercents(),
    session: {
      start: async input => await play.start(input),
      message: async text => await play.message(text),
      end: async reason => await play.end(reason),
      snapshot: () => play.snapshot(),
      pause: async () => await play.pause(),
      resume: async () => await play.resume(),
      choose: async (choiceId: string) => await play.choice(choiceId),
      setAutopilot: async input => await play.setAutopilot(input),
      transcript: () => play.transcript(),
    },
    ledger: async (limit?: number) => await play.ledger(limit),
    // 内容包管理（B2-T14）：导入即激活，版本切换走 activatePack。每次调用都
    // 经过 `runPackOp`，避免并发的 read-modify-write 覆盖 registry.json。
    listPacks: async () => await runPackOp(async () => await packRegistry.list()),
    // 部位词表只读：加载目标版本的内容包，取 scenario.regions（freeform 由
    // `regionVocabularyOf` 补上 whole-body）。显式 version 用于运行中的会话：
    // 后台激活别的版本不能改变它正在用的词表。走同一个 `runPackOp` 队列，
    // 避免与安装/激活的 read-modify-write 交叠；按 id@version 缓存，因为一次
    // 加载会校验 pack.json/scenario/波形等全部文件。
    packRegions: async (packId, version) => await runPackOp(async () => {
      const resolved = version ?? await packRegistry.activeVersion(packId)
      if (resolved === undefined) {
        throw new PackRegistryError('no-active-version', `content pack "${packId}" has no active version`)
      }
      const key = `${packId}@${resolved}`
      const cached = regionCache.get(key)
      if (cached !== undefined) return cached
      const vocabulary: PackRegionVocabulary = {
        version: resolved,
        regions: regionVocabularyOf(await packRegistry.load(packId, resolved)),
      }
      regionCache.set(key, vocabulary)
      return vocabulary
    }),
    importPack: async bytes => {
      const installed = await runPackOp(async () => await packRegistry.install(bytes, { activate: true }))
      // Re-importing the same id@version now overwrites the files in place (the
      // product's "同名文件覆盖" import rule), so a cache entry keyed by
      // `id@version` may point at the *previous* bytes even though the id@version
      // did not change. The region vocabularies are tiny; clear them all.
      regionCache.clear()
      return {
        id: installed.id,
        version: installed.version,
        active: installed.active,
        replaced: installed.replaced,
      }
    },
    activatePack: async (id, version) => {
      await runPackOp(async () => { await packRegistry.activate(id, version) })
    },
    panic,
    unlock: async note => {
      await registry.unlock('human', note)
      // Unlocking is human-only; the engine's LATCH is released by the same
      // gesture so a panicked session does not stay deaf forever.
      play.unlock(note)
    },
    listDevices,
    addDevice: async protocol => addDevice(protocol),
    removeDevice: async key => removeDevice(key),
    setDeviceLabel: async (key, label) => setDeviceLabel(key, label),
    rebindDevice: async key => rebindDevice(key),
    rawWrite: async (deviceId, hex, channel) => registry.rawWrite('human', deviceId, hex, channel),
    setCap: async (deviceId, channelId, patch) => {
      await registry.setPolicyByHuman(deviceId, channelId, patch)
      // Human cap changes persist; the audit line was already written by the
      // registry, so this call cannot add or alter audit records.
      await savePolicy()
    },
    demo: async (deviceId, channelId) => {
      await registry.runPattern('human', {
        deviceId,
        channelId,
        envelope: { preset: 'wave', minPercent: 5, maxPercent: 20, periodMs: 2_000, jitter: 10 },
        durationSec: 15,
      })
    },
    pattern: async (deviceId, channelId, envelope, durationSec) => {
      const presets = ['steady', 'pulse', 'wave', 'random', 'ramp'] as const
      if (!presets.includes(envelope.preset as (typeof presets)[number])) {
        throw new Error(`unknown envelope preset: ${envelope.preset}`)
      }
      await registry.runPattern('human', {
        deviceId,
        channelId,
        envelope: { ...envelope, preset: envelope.preset as (typeof presets)[number] },
        durationSec,
      })
    },
    stop: async (deviceId, channelId) => { await registry.stop('human', deviceId, channelId) },
    level: async (deviceId, channelId, percent, durationSec) => {
      // Direct human control from the strength bar: an *absolute* percentage,
      // clamped by the registry into the channel's [min,max] interval and the
      // session ceiling. The default duration keeps the "no indefinite output"
      // rule; the UI renews while the slider is non-zero.
      const capacity = policy.effective(deviceId, channelId).maxDurationSec
      await registry.setLevel('human', {
        deviceId,
        channelId,
        percent: Math.round(percent),
        durationSec: durationSec === undefined ? capacity : Math.min(Math.round(durationSec), capacity),
      })
    },
    connect: async deviceId => { await connectDevice(deviceId) },
    scan: async (deviceId, durationMs) => { await registry.scan('human', deviceId, durationMs, controller.signal) },
    listWaveforms: () => waveforms.list(),
    waveformPreview: id => {
      const waveform = waveforms.get(id)
      if (waveform === undefined) return undefined
      const freq: number[] = []
      const intensity: number[] = []
      for (const frame of waveform.frames) {
        for (let slot = 0; slot < 4; slot += 1) {
          freq.push(frame.freq[slot] ?? 0)
          intensity.push(frame.intensity[slot] ?? 0)
        }
      }
      return {
        id: waveform.id,
        name: waveform.name,
        loop: waveform.loop,
        durationMs: waveform.frames.length * 100,
        freq,
        intensity,
      }
    },
    importWaveform: async (name, frames) => {
      const imported = waveforms.importFrames(name, frames)
      await saveWaveforms()
      return { id: imported.id, name: imported.name, frames: imported.frames.length }
    },
    promoteWaveform: async id => {
      waveforms.promoteByHuman(id)
      await saveWaveforms()
      return waveforms.list()
    },
    setWaveform: async (deviceId, channelId, waveformId) => {
      await registry.setWaveform('human', deviceId, channelId, waveformId)
    },
    auditTail: async limit => readAuditTail(join(options.dataDir, 'audit', 'device.jsonl'), limit),
    recentErrors: () => recentErrors,
    sensorsStatus,
    sensorFrame,
    pushFeatures,
    probes: () => play.probes(),
    setSessionCeiling: async percent => await play.setCeiling(percent),
    setRegion: async (deviceId, channelId, region) => {
      await play.setRegion(deviceId, channelId, region)
      // Durable override layer: a cleared label must stay cleared after a
      // restart instead of reviving the manifest default.
      await documents.write('regions', JSON.stringify(regionStore.snapshot(), null, 2))
    },
    regions: () => play.regions(),
    recentLogs,
    settings: settingsDeps,
  }

  if (options.withDashboard !== false) {
    dashboardServer = new DashboardServer({
      deps: dashboardDeps,
      token: dashboardToken,
      // Ingested samples are stamped on the runtime's clock, never Date.now.
      now: () => clock.now(),
      ...(options.dashboardHost === undefined ? {} : { host: options.dashboardHost }),
      ...(options.dashboardPort === undefined ? {} : { port: options.dashboardPort }),
      ...(options.dashboardStaticDir === undefined ? {} : { staticDir: options.dashboardStaticDir }),
      ...(options.dashboardStaticFiles === undefined ? {} : { staticFiles: options.dashboardStaticFiles }),
      onError,
    })
    dashboardAddress = await dashboardServer.start()
    await documents.write('dashboard', JSON.stringify({ token: dashboardToken, ...dashboardAddress }, null, 2))
  }

  let stopped = false
  const saveWaveforms = async (): Promise<void> => {
    await documents.write('waveforms', JSON.stringify(waveforms.exportLibrary(), null, 2))
  }

  return {
    registry,
    policy,
    waveforms,
    documents,
    sensors,
    // Getter pairs: the settings view can replace the runner/config in place.
    get modelRunner(): ModelRunner { return modelRunner },
    get llm(): LlmConfig { return llm },
    play,
    packs: packRegistry,
    panicToken,
    panicAddress,
    dashboardToken,
    dashboardAddress,
    intiface: {
      availability: intifaceAvailability,
      url: intifaceProcess.url,
      owned: intifaceProcess.owned,
    },
    snapshot: decoratedSnapshot,
    sensorsStatus,
    sensorFrame,
    pushFeatures,
    llmSummary,
    settingsSnapshot,
    saveLlmSettings,
    saveSensorSettings,
    panic,
    saveWaveforms,
    savePolicy,
    listDevices,
    addDevice,
    removeDevice,
    setDeviceLabel,
    rebindDevice,
    connectDevice,
    async shutdown(): Promise<void> {
      if (stopped) return
      stopped = true
      controller.abort()
      // Cancel the session's engine timers/queued turns before the devices go.
      play.dispose()
      await panicServer?.stop()
      await dashboardServer?.stop()
      // Capture streams belong to the hidden worker window, not to the
      // registry: stop them here so a graceful quit cannot leave the camera or
      // the microphone light on after the console is gone.
      try {
        await cameraControl.host?.stop()
      } catch (error) {
        onError(error)
      }
      try {
        await microphoneControl.host?.stop()
      } catch (error) {
        onError(error)
      }
      // 注册表没有需要释放的句柄；等排队中的导入/切换写完（或回滚完），
      // 避免进程在“包文件已写、registry.json 未写”的中间态退出。
      await packOps.catch(() => {})
      await registry.shutdown()
      // Only stops an engine this process started.
      await intifaceProcess.stop()
      try {
        await saveWaveforms()
      } catch (error) {
        onError(error)
      }
      // Caps are already persisted on every change; this covers a session
      // whose ceiling was set but whose last write failed.
      try {
        await savePolicy()
      } catch (error) {
        onError(error)
      }
      waveforms.clearSession()
    },
  }
}
