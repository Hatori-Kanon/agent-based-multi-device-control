/**
 * Host wiring: build the safety runtime, attach Node storage, expose the
 * out-of-band stop endpoint.
 *
 * Deliberately free of any Electron import so the whole bootstrap can be
 * exercised in unit tests; the Electron entry point only adds windows,
 * a global hotkey, and lifecycle hooks on top.
 */

import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import {
  AuditLog,
  ButtplugBackend,
  CoyoteBackend,
  DeviceRegistry,
  MockBackend,
  MonsterPartyBackend,
  PolicyStore,
  WaveformLibrary,
  XhtkjBackend,
  systemClock,
  type BleTransport,
  type Clock,
  type DeviceBackend,
  type DeviceLifecycle,
  type RegistrySnapshot,
  type SerializedWaveform,
} from '@embodied/core'
import { IntifaceProcess, type IntifaceAvailability } from './intiface.ts'
import { DashboardServer, type DashboardDeps } from './dashboard.ts'
import { log, recentLogs } from './log.ts'
import { NodeTextSocketTransport } from './node-socket.ts'
import { FileAppendOnlyStore, FileDocumentStore, readAuditTail } from './node-storage.ts'
import { PanicServer } from './panic-server.ts'

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
  readonly panicToken: string
  readonly panicAddress: { host: string; port: number } | undefined
  /** The control console's token and bind address. */
  readonly dashboardToken: string
  readonly dashboardAddress: { host: string; port: number } | undefined
  /** Whether an Intiface engine was found, and who owns it. */
  readonly intiface: { availability: IntifaceAvailability; url: string; owned: boolean }
  snapshot(): RegistrySnapshot
  /** Human emergency stop from any out-of-band source. */
  panic(source: string): Promise<void>
  /** Persist the durable waveform library. */
  saveWaveforms(): Promise<void>
  shutdown(): Promise<void>
  /** Devices the operator added (protocol + label + live lifecycle). */
  listDevices(): DeviceManagerEntry[]
  /** Add one device of the chosen protocol; registers and connects it. */
  addDevice(protocol: DeviceProtocol): Promise<DeviceManagerEntry>
  /** Stop, close, and forget a device. */
  removeDevice(key: string): Promise<void>
}

/** Protocols an operator can add at run time. */
export const DEVICE_PROTOCOLS = ['coyote', 'xhtkj', 'mock'] as const
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
const MANIFEST_VERSION = 2

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
  { key: 'zkrxb', protocol: 'xhtkj', bleName: 'ANKNI ZKRXB', label: 'ANKNI ZKRXB（旋转）' },
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

  const registry = new DeviceRegistry({ clock, audit, policy, waveforms, onError: recordError })
  const controller = new AbortController()

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
        // Introduce units that postdate the file (e.g. the rotation toy) once;
        // the bumped version keeps later removals in place.
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
          maxPercent: channel => policy.get(entry.key, channel).maxPercent,
          maxWaveIntensity: channel => policy.get(entry.key, channel).maxWaveIntensity,
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

  const panic = async (source: string): Promise<void> => { await registry.emergencyStop(source) }

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
    panic,
    unlock: async note => { await registry.unlock('human', note) },
    listDevices,
    addDevice: async protocol => addDevice(protocol),
    removeDevice: async key => removeDevice(key),
    rawWrite: async (deviceId, hex) => registry.rawWrite('human', deviceId, hex),
    setCap: async (deviceId, channelId, patch) => {
      await registry.setPolicyByHuman(deviceId, channelId, patch)
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
    recentLogs,
  }

  if (options.withDashboard !== false) {
    dashboardServer = new DashboardServer({
      deps: dashboardDeps,
      token: dashboardToken,
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
    panic,
    saveWaveforms,
    listDevices,
    addDevice,
    removeDevice,
    async shutdown(): Promise<void> {
      if (stopped) return
      stopped = true
      controller.abort()
      await panicServer?.stop()
      await dashboardServer?.stop()
      await registry.shutdown()
      // Only stops an engine this process started.
      await intifaceProcess.stop()
      try {
        await saveWaveforms()
      } catch (error) {
        onError(error)
      }
      waveforms.clearSession()
    },
  }
}
