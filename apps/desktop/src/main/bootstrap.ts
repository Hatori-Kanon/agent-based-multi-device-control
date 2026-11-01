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
  type ModelRunner,
  type PolicySnapshot,
  type RawInflate,
  type RegistrySnapshot,
  type SensorStatus,
  type SerializedWaveform,
  type Snapshot,
} from '@embodied/core'
import { IntifaceProcess, type IntifaceAvailability } from './intiface.ts'
import { DashboardServer, type DashboardDeps } from './dashboard.ts'
import { log, recentLogs } from './log.ts'
import { NodeTextSocketTransport } from './node-socket.ts'
import { FileAppendOnlyStore, FileDocumentStore, readAuditTail } from './node-storage.ts'
import { FsPackStore } from './pack-store.ts'
import { RegistryPackSource } from './pack-source.ts'
import { PanicServer } from './panic-server.ts'
import { PlayHost } from './play.ts'
import { cameraSensorSource, DEFAULT_CAMERA_FPS, type CameraHost } from './sensors/camera-host.ts'
import { createModelRunner, llmSummaryOf, loadLlmSettings, settingsFromConfig, singleCallModel } from './llm.ts'
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
  /** Register the simulated devices. Defaults to true. */
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
  /** Start camera capture on boot. Defaults to true when a host is supplied. */
  readonly withCamera?: boolean
  /** Camera feature push rate; the capture host clamps it to 1-2 Hz. */
  readonly cameraFps?: number
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
   */
  readonly modelRunner: ModelRunner
  /** Effective LLM config (by construction it carries no API key). */
  readonly llm: LlmConfig
  /** Key-free LLM status — the only LLM shape the console may display. */
  llmSummary(): LlmSummary
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
  /** Stop, close, and forget a device. */
  removeDevice(key: string): Promise<void>
}

/** Protocols an operator can add at run time. */
export const DEVICE_PROTOCOLS = ['coyote', 'xhtkj', 'ankni', 'mock'] as const
export type DeviceProtocol = (typeof DEVICE_PROTOCOLS)[number]

/** One entry of the persisted device manifest. */
export interface DeviceManifestEntry {
  readonly key: string
  readonly protocol: DeviceProtocol
  /** Display name override; the backend default is used when omitted. */
  readonly label?: string
  /** Scan filter override (Coyote family name); use when several units share a name. */
  readonly bleName?: string
}

/** Manifest entry merged with live registry state, for the UI. */
export interface DeviceManagerEntry {
  readonly key: string
  readonly protocol: DeviceProtocol
  readonly label: string
  readonly lifecycle: DeviceLifecycle | 'unregistered'
  readonly canScan: boolean
  readonly channels: readonly string[]
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

function isManifestEntry(value: unknown): value is DeviceManifestEntry {
  if (typeof value !== 'object' || value === null) return false
  const entry = value as Record<string, unknown>
  return typeof entry.key === 'string' && entry.key.length > 0 && isDeviceProtocol(entry.protocol)
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
  if (savedPolicy !== undefined) {
    let restored: PolicySnapshot | undefined
    try {
      restored = parsePolicySnapshot(JSON.parse(savedPolicy))
      policy.restore(restored)
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

  // ── Model gateway (B1-T15) ──────────────────────────────────────────────
  // Settings come from `state/llm.json`; the API key is resolved
  // environment-first and is never copied into the config object. Assembling
  // the runner performs NO network IO — the first request happens on the first
  // turn, so booting offline (or without a key) is a supported state.
  const llmEnv = options.llmEnv ?? process.env
  const llmSettings = options.llmConfig === undefined
    ? await loadLlmSettings(options.dataDir, llmEnv)
    : settingsFromConfig(options.llmConfig, llmEnv)
  const llm = llmSettings.config
  const modelRunner = createModelRunner({
    model: singleCallModel(llm),
    ...(llmSettings.apiKey === undefined ? {} : { apiKey: llmSettings.apiKey }),
    fetch: options.llmFetch ?? globalThis.fetch,
    clock,
    env: llmEnv,
  })
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
  if (options.cameraHost !== undefined) {
    const camera = options.cameraHost
    sensors.register(cameraSensorSource(camera))
    // The capture end owns the `unavailable` signal (plan §8.7 ruling 5):
    // the registry derives `stale` from its clock but must not guess that a
    // camera disappeared, so the host pushes a sample that says so.
    camera.onFeatures(sample => {
      try {
        sensors.push(sample)
      } catch (error) {
        recordError(error)
      }
    })
    if (options.withCamera !== false) {
      try {
        const devices = await camera.listDevices()
        const first = devices[0]
        if (first === undefined) {
          log('[camera] no video input found; the sensor source will report unavailable')
        } else {
          await camera.start(first.deviceId, { fps: options.cameraFps ?? DEFAULT_CAMERA_FPS })
        }
      } catch (error) {
        recordError(error)
        // A refused getUserMedia still leaves a registered source; make its
        // loss explicit instead of letting it read as "camera fine, no data".
        try {
          sensors.push({ sourceId: camera.sourceId, ts: clock.now(), frameAgeMs: 0, quality: 'unavailable' })
        } catch (pushError) {
          recordError(pushError)
        }
      }
    }
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
    runner: modelRunner,
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
          manifest = parsed.filter(isManifestEntry)
        } else if (typeof parsed === 'object' && parsed !== null) {
          const file = parsed as DeviceManifestFile
          manifest = Array.isArray(file.devices) ? file.devices.filter(isManifestEntry) : []
          manifestVersion = typeof file.version === 'number' ? file.version : 1
        }
      } catch (error) {
        recordError(error)
      }
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
  }

  if (options.withMockDevices !== false) {
    for (const backend of createMockDevices(clock)) {
      registry.register(backend)
    }
  }

  /** Build the backend for one manifest entry. */
  const createBackend = (entry: DeviceManifestEntry): DeviceBackend => {
    switch (entry.protocol) {
      case 'coyote': {
        const transport = options.bleTransport
        if (transport === undefined) throw new Error('coyote needs a BLE transport')
        return new CoyoteBackend({
          clock,
          transport,
          id: entry.key,
          name: entry.label ?? 'DG-LAB Coyote 3.0',
          ...(entry.bleName === undefined ? {} : { bleName: entry.bleName }),
          // Read fresh on every call so a cap change reaches the hardware.
          // `effective` is the session ceiling applied on top of the channel
          // cap, so `BF <= X` holds by construction (D4, rule 4).
          maxPercent: channel => policy.effective(entry.key, channel).maxPercent,
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
          name: entry.label ?? '谜姬 / XHTKJ 直连',
          ...(entry.bleName === undefined ? {} : { bleName: entry.bleName }),
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
          name: entry.label ?? '安可尼 流式玩具',
          ...(entry.bleName === undefined ? {} : { bleName: entry.bleName }),
          onError: recordError,
        })
      }
      case 'mock':
        return new MockBackend({
          id: entry.key,
          name: entry.label ?? 'Mock 设备',
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
      registry.register(createBackend(entry))
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
        label: entry.label ?? live?.name ?? entry.key,
        lifecycle: live?.lifecycle ?? 'disconnected',
        canScan: live?.canScan ?? false,
        channels: live === undefined ? [] : live.channels.map(channel => channel.id),
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
      registry.register(createBackend(entry))
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
      manifest = manifest.filter(entry => entry.key !== key)
      await saveManifest()
    })
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
    snapshot: () => registry.snapshot(),
    session: {
      start: async input => await play.start(input),
      message: async text => await play.message(text),
      end: async reason => await play.end(reason),
      snapshot: () => play.snapshot(),
      pause: async () => await play.pause(),
      resume: async () => await play.resume(),
      choose: async (choiceId: string) => await play.choice(choiceId),
      transcript: () => play.transcript(),
    },
    ledger: async (limit?: number) => await play.ledger(limit),
    // 内容包管理（B2-T14）：导入即激活，版本切换走 activatePack。每次调用都
    // 经过 `runPackOp`，避免并发的 read-modify-write 覆盖 registry.json。
    listPacks: async () => await runPackOp(async () => await packRegistry.list()),
    importPack: async bytes => {
      const installed = await runPackOp(async () => await packRegistry.install(bytes, { activate: true }))
      return { id: installed.id, version: installed.version, active: installed.active }
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
    connect: async deviceId => { await registry.connect(deviceId, controller.signal) },
    scan: async (deviceId, durationMs) => { await registry.scan('human', deviceId, durationMs, controller.signal) },
    listWaveforms: () => waveforms.list(),
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
    modelRunner,
    llm,
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
    snapshot: () => registry.snapshot(),
    sensorsStatus,
    sensorFrame,
    pushFeatures,
    llmSummary,
    panic,
    saveWaveforms,
    savePolicy,
    listDevices,
    addDevice,
    removeDevice,
    async shutdown(): Promise<void> {
      if (stopped) return
      stopped = true
      controller.abort()
      // Cancel the session's engine timers/queued turns before the devices go.
      play.dispose()
      await panicServer?.stop()
      await dashboardServer?.stop()
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
