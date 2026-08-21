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
  type RegistrySnapshot,
  type SerializedWaveform,
} from '@embodied/core'
import { IntifaceProcess, type IntifaceAvailability } from './intiface.ts'
import { NodeTextSocketTransport } from './node-socket.ts'
import { FileAppendOnlyStore, FileDocumentStore } from './node-storage.ts'
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
  /** Register the simulated devices. Defaults to true. */
  readonly withMockDevices?: boolean
  /**
   * When present, real BLE backends are registered and connected.
   *
   * A connect failure is reported rather than fatal: the operator may simply
   * not have the box powered on, and the rest of the runtime is still useful.
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
  /** Whether an Intiface engine was found, and who owns it. */
  readonly intiface: { availability: IntifaceAvailability; url: string; owned: boolean }
  snapshot(): RegistrySnapshot
  /** Human emergency stop from any out-of-band source. */
  panic(source: string): Promise<void>
  /** Persist the durable waveform library. */
  saveWaveforms(): Promise<void>
  shutdown(): Promise<void>
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

  // Restore anything the operator promoted in an earlier session.
  const savedWaveforms = await documents.read('waveforms')
  if (savedWaveforms !== undefined) {
    try {
      waveforms.loadLibrary(JSON.parse(savedWaveforms) as SerializedWaveform[])
    } catch (error) {
      onError(error)
    }
  }

  const registry = new DeviceRegistry({ clock, audit, policy, waveforms, onError })

  const connectIds: string[] = []
  if (options.withMockDevices !== false) {
    for (const backend of createMockDevices(clock)) {
      registry.register(backend)
      connectIds.push(backend.id)
    }
  }
  if (options.bleTransport !== undefined) {
    const coyote = new CoyoteBackend({
      clock,
      transport: options.bleTransport,
      // Read fresh on every call so a cap change reaches the hardware.
      maxPercent: channel => policy.get('coyote', channel).maxPercent,
      maxWaveIntensity: channel => policy.get('coyote', channel).maxWaveIntensity,
      onError,
    })
    registry.register(coyote)
    connectIds.push(coyote.id)

    // Direct BLE to the 谜姬 family: no share link, no vendor server.
    const xhtkj = new XhtkjBackend({ clock, transport: options.bleTransport, onError })
    registry.register(xhtkj)
    connectIds.push(xhtkj.id)
  }

  if (options.monsterPartyToken !== undefined && options.monsterPartyToken.trim().length > 0) {
    const relay = new MonsterPartyBackend({
      clock,
      sockets: new NodeTextSocketTransport(),
      sessionToken: options.monsterPartyToken,
      userAgent: 'embodied-roleplay/0.0 (+local)',
      onError,
    })
    registry.register(relay)
    connectIds.push(relay.id)
  }

  const intifaceProcess = new IntifaceProcess({ onError })
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
        onError,
      })
      registry.register(buttplug)
      connectIds.push(buttplug.id)
    }
  }

  const controller = new AbortController()
  for (const id of connectIds) {
    try {
      await registry.connect(id, controller.signal)
    } catch (error) {
      onError(error)
    }
  }

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
      onError,
    })
    panicAddress = await panicServer.start()
    // The phone page needs this to reach /panic. It is gitignored.
    await documents.write('panic', JSON.stringify({ token: panicToken, ...panicAddress }, null, 2))
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
    intiface: {
      availability: intifaceAvailability,
      url: intifaceProcess.url,
      owned: intifaceProcess.owned,
    },
    snapshot: () => registry.snapshot(),
    panic,
    saveWaveforms,
    async shutdown(): Promise<void> {
      if (stopped) return
      stopped = true
      controller.abort()
      await panicServer?.stop()
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
