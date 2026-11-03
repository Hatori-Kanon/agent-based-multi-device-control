import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  BF_LENGTH,
  COYOTE_BLE_NAME,
  FakeClock,
  MockBleTransport,
  percentToStrength,
  type AuditRecord,
} from '@embodied/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHostRuntime, type HostRuntime } from '../src/main/bootstrap.ts'

let root: string
let runtime: HostRuntime | undefined

beforeEach(async () => {
  await mkdir(join(process.cwd(), '.test-tmp'), { recursive: true })
  root = await mkdtemp(join(process.cwd(), '.test-tmp', 'host-'))
})

afterEach(async () => {
  await runtime?.shutdown()
  runtime = undefined
  await rm(root, { recursive: true, force: true })
})

async function auditRecords(): Promise<AuditRecord[]> {
  const raw = await readFile(join(root, 'audit', 'device.jsonl'), 'utf8')
  return raw.trimEnd().split('\n').map(line => JSON.parse(line) as AuditRecord)
}

describe('host runtime', () => {
  it('registers both mock control models disconnected until a human connects them', async () => {
    const clock = new FakeClock()
    runtime = await createHostRuntime({ dataDir: root, clock, withPanicServer: false })

    const snapshot = runtime.snapshot()
    expect(snapshot.locked).toBe(false)
    expect(snapshot.devices.map(device => device.id)).toEqual(['mock-pulse', 'mock-hold'])
    // Nothing connects or scans on start; the 连接 button drives it.
    for (const device of snapshot.devices) {
      expect(device.lifecycle).toBe('disconnected')
    }
    // Two channels on the streaming box, one on the stateful toy.
    expect(snapshot.devices[0]?.channels).toHaveLength(2)
    expect(snapshot.devices[1]?.channels).toHaveLength(1)

    await runtime.registry.connect('mock-pulse', new AbortController().signal)
    await runtime.registry.connect('mock-hold', new AbortController().signal)
    expect(runtime.snapshot().devices.every(device => device.lifecycle === 'ready')).toBe(true)
  })

  it('writes an append-only audit trail to disk', async () => {
    const clock = new FakeClock()
    runtime = await createHostRuntime({ dataDir: root, clock, withPanicServer: false })
    await runtime.registry.connect('mock-pulse', new AbortController().signal)
    await runtime.registry.runPattern('model', {
      deviceId: 'mock-pulse',
      channelId: 'a',
      envelope: { preset: 'wave', minPercent: 5, maxPercent: 20, periodMs: 1_000, jitter: 0 },
      durationSec: 10,
    })
    clock.advance(100)
    await runtime.registry.settled()

    const records = await auditRecords()
    expect(records.some(record => record.action === 'connect' && record.result === 'ok')).toBe(true)
    const pattern = records.find(record => record.action === 'run_pattern')
    expect(pattern?.actor).toBe('model')
    expect(pattern?.result).toBe('ok')
  })

  it('cuts output and latches on a panic from the HTTP endpoint', async () => {
    const clock = new FakeClock()
    runtime = await createHostRuntime({ dataDir: root, clock, panicPort: 0 })
    const address = runtime.panicAddress
    expect(address).toBeDefined()
    await runtime.registry.connect('mock-pulse', new AbortController().signal)

    await runtime.registry.runPattern('model', {
      deviceId: 'mock-pulse',
      channelId: 'a',
      envelope: { preset: 'steady', minPercent: 20, maxPercent: 20, periodMs: 1_000, jitter: 0 },
      durationSec: 30,
    })
    clock.advance(100)
    await runtime.registry.settled()
    expect(runtime.snapshot().devices[0]?.channels[0]?.percent).toBe(20)

    const response = await fetch(`http://${address!.host}:${address!.port}/panic`, {
      method: 'POST',
      headers: { 'x-panic-token': runtime.panicToken, 'content-type': 'application/json' },
      body: JSON.stringify({ source: 'phone' }),
    })
    expect(response.status).toBe(200)
    await runtime.registry.settled()

    const after = runtime.snapshot()
    expect(after.locked).toBe(true)
    expect(after.devices[0]?.channels[0]?.percent).toBe(0)

    const records = await auditRecords()
    const panic = records.find(record => record.action === 'panic')
    expect(panic?.actor).toBe('human')
    expect(panic?.detail).toMatchObject({ source: 'phone' })
  })

  it('publishes the panic credentials so the phone page can reach the endpoint', async () => {
    const clock = new FakeClock()
    runtime = await createHostRuntime({ dataDir: root, clock, panicPort: 0 })
    const raw = await runtime.documents.read('panic')
    expect(raw).toBeDefined()
    const parsed = JSON.parse(raw!) as { token: string; host: string; port: number }
    expect(parsed.token).toBe(runtime.panicToken)
    expect(parsed.host).toBe('127.0.0.1')
    expect(parsed.port).toBeGreaterThan(0)
  })

  it('shuts down output, transports, and the endpoint exactly once', async () => {
    const clock = new FakeClock()
    runtime = await createHostRuntime({ dataDir: root, clock, panicPort: 0 })
    const address = runtime.panicAddress!
    await runtime.registry.connect('mock-hold', new AbortController().signal)

    await runtime.registry.runPattern('model', {
      deviceId: 'mock-hold',
      channelId: 'main',
      envelope: { preset: 'steady', minPercent: 15, maxPercent: 15, periodMs: 1_000, jitter: 0 },
      durationSec: 30,
    })
    clock.advance(100)
    await runtime.registry.settled()

    await runtime.shutdown()
    await runtime.shutdown()

    expect(runtime.snapshot().devices.every(device => device.lifecycle === 'disconnected')).toBe(true)
    expect(runtime.snapshot().devices.flatMap(device => device.channels).every(channel => channel.percent === 0)).toBe(true)
    await expect(fetch(`http://${address.host}:${address.port}/status`, {
      headers: { 'x-panic-token': runtime.panicToken },
    })).rejects.toThrow()

    const records = await auditRecords()
    expect(records.filter(record => record.action === 'shutdown')).toHaveLength(1)
    runtime = undefined
  })
})

describe('host runtime with a BLE transport', () => {
  it('registers a Coyote disconnected and connects it on demand', async () => {
    const clock = new FakeClock()
    const transport = new MockBleTransport({ clock, name: COYOTE_BLE_NAME })
    runtime = await createHostRuntime({ dataDir: root, clock, withPanicServer: false, bleTransport: transport })

    const devices = runtime.snapshot().devices
    const coyote = devices.find(device => device.id === 'coyote')
    expect(coyote?.lifecycle).toBe('disconnected')
    expect(coyote?.channels.map(channel => channel.id)).toEqual(['a', 'b'])
    expect(coyote?.channels.every(channel => channel.supportsWaveform)).toBe(true)

    // Nothing scanned during startup; the operator's 连接 does.
    expect(transport.peripheralFor(filter => filter.name === COYOTE_BLE_NAME)).toBeUndefined()
    await runtime.registry.connect('coyote', new AbortController().signal)
    expect(runtime.snapshot().devices.find(device => device.id === 'coyote')?.lifecycle).toBe('ready')

    // The hardware ceiling was written from policy before anything else.
    const peripheral = transport.peripheralFor(filter => filter.name === COYOTE_BLE_NAME)!
    const first = peripheral.writes[0]
    expect(first?.data).toHaveLength(BF_LENGTH)
    expect(first?.data[1]).toBe(percentToStrength(runtime.policy.get('coyote', 'a').maxPercent))
  })

  it('registers the direct-BLE 谜姬 backend on the same transport', async () => {
    const clock = new FakeClock()
    const transport = new MockBleTransport({ clock, name: COYOTE_BLE_NAME })
    const errors: unknown[] = []
    runtime = await createHostRuntime({
      dataDir: root,
      clock,
      withPanicServer: false,
      bleTransport: transport,
      onError: error => { errors.push(error) },
    })

    const xhtkj = runtime.snapshot().devices.find(device => device.id === 'xhtkj')
    expect(xhtkj).toBeDefined()
    // The shared mock transport has no PnP value, so it degrades to main-output
    // only rather than failing the connect.
    expect(xhtkj?.channels.map(channel => channel.id)).toEqual(['primary'])
  })

  it('seeds coyote + 谜姬 from the manifest and persists removals', async () => {
    const clock = new FakeClock()
    const transport = new MockBleTransport({ clock, name: COYOTE_BLE_NAME })
    runtime = await createHostRuntime({
      dataDir: root,
      clock,
      withPanicServer: false,
      bleTransport: transport,
    })
    expect(runtime.snapshot().devices.map(device => device.id)).toContain('coyote')
    expect(runtime.snapshot().devices.map(device => device.id)).toContain('xhtkj')
    // The well-known rotation unit is seeded with its pinned name.
    const zkrxb = runtime.snapshot().devices.find(device => device.id === 'zkrxb')
    expect(zkrxb).toBeDefined()
    expect(zkrxb?.name).toContain('ANKNI ZKRXB')

    // Removing 谜姬 persists: the next run on the same data dir starts without it.
    await runtime.removeDevice('xhtkj')
    await runtime.shutdown()
    runtime = await createHostRuntime({
      dataDir: root,
      clock,
      withPanicServer: false,
      bleTransport: transport,
    })
    const ids = runtime.snapshot().devices.map(device => device.id)
    expect(ids).toContain('coyote')
    expect(ids).not.toContain('xhtkj')
    expect(ids).toContain('mock-pulse')
    expect(ids).toContain('mock-hold')
    expect(runtime.listDevices().map(entry => entry.key)).toEqual(['coyote', 'zkrxb'])
  })

  it('adds a second unit of a protocol with a fresh key and registers it', async () => {
    const clock = new FakeClock()
    const transport = new MockBleTransport({ clock, name: COYOTE_BLE_NAME })
    runtime = await createHostRuntime({
      dataDir: root,
      clock,
      withPanicServer: false,
      bleTransport: transport,
    })

    const added = await runtime.addDevice('coyote')
    expect(added.key).toBe('coyote-2')
    // Add registers only; the operator connects afterwards.
    expect(added.lifecycle).toBe('disconnected')
    expect(runtime.snapshot().devices.map(device => device.id)).toContain('coyote-2')

    await runtime.registry.connect('coyote-2', new AbortController().signal)
    expect(runtime.snapshot().devices.find(device => device.id === 'coyote-2')?.lifecycle).toBe('ready')
    // The transport addresses each unit by its own filter name.
    expect(transport.peripheralFor(filter => filter.name === COYOTE_BLE_NAME)).toBeDefined()
    expect(runtime.listDevices().map(entry => entry.key)).toEqual(['coyote', 'xhtkj', 'zkrxb', 'coyote-2'])
  })

  it('binds a coyote card to the chosen platform id and pins reconnects', async () => {
    const clock = new FakeClock()
    const transport = new MockBleTransport({ clock, name: COYOTE_BLE_NAME, platformId: 'unit-a-1f2e' })
    runtime = await createHostRuntime({ dataDir: root, clock, withPanicServer: false, bleTransport: transport })

    expect(runtime.listDevices().find(device => device.key === 'coyote')?.bound).toBe(false)
    await runtime.connectDevice('coyote')
    // First pairing: no pin on the filter (the chooser picks a free unit), then
    // the host records which physical box the card got.
    expect(transport.requests.at(-1)?.deviceId).toBeUndefined()
    expect(runtime.listDevices().find(device => device.key === 'coyote')?.bound).toBe(true)
    expect(runtime.listDevices().find(device => device.key === 'coyote')?.pairedId).toBe('unit-a-1f2e')
    expect(runtime.snapshot().devices.find(device => device.id === 'coyote')?.lifecycle).toBe('ready')

    const manifest = JSON.parse(await readFile(join(root, 'state', 'devices.json'), 'utf8')) as {
      devices: Array<{ key: string; bleId?: string }>
    }
    expect(manifest.devices.find(device => device.key === 'coyote')?.bleId).toBe('unit-a-1f2e')

    // Reconnect sends the stored platform id as a chooser pin, so two
    // same-named units cannot swap cards.
    await runtime.registry.disconnect('coyote')
    await runtime.connectDevice('coyote')
    expect(transport.requests.at(-1)?.deviceId).toBe('unit-a-1f2e')
  })

  it('loads a hand-edited manifest and falls back to default names when a label is cleared', async () => {
    const clock = new FakeClock()
    const transport = new MockBleTransport({ clock, name: COYOTE_BLE_NAME })
    await mkdir(join(root, 'state'), { recursive: true })
    await writeFile(join(root, 'state', 'devices.json'), JSON.stringify({
      version: 3,
      devices: [
        // A blank bleId must read as "not paired"; a null label must not drop
        // the card (it used to disappear and then be persisted as removed).
        { key: 'coyote', protocol: 'coyote', label: '左', bleId: '' },
        { key: 'xhtkj', protocol: 'xhtkj', label: null },
      ],
    }))
    runtime = await createHostRuntime({ dataDir: root, clock, withPanicServer: false, bleTransport: transport })

    const coyote = runtime.listDevices().find(entry => entry.key === 'coyote')
    expect(coyote?.label).toBe('左')
    expect(coyote?.bound).toBe(false)
    expect(coyote?.canRebind).toBe(true)
    expect(runtime.listDevices().find(entry => entry.key === 'xhtkj')?.label).toBe('谜姬 / XHTKJ 直连')
    expect(runtime.snapshot().devices.find(device => device.id === 'coyote')?.name).toBe('左')

    // Clearing goes back to the protocol default, not to the boot-time name.
    await runtime.setDeviceLabel('coyote', '')
    expect(runtime.listDevices().find(entry => entry.key === 'coyote')?.label).toBe('DG-LAB Coyote 3.0')
    expect(runtime.snapshot().devices.find(device => device.id === 'coyote')?.name).toBe('DG-LAB Coyote 3.0')
  })

  it('reserves units paired with other cards and refuses a duplicate pairing', async () => {
    const clock = new FakeClock()
    const transport = new MockBleTransport({ clock, name: COYOTE_BLE_NAME, platformId: 'unit-shared' })
    runtime = await createHostRuntime({ dataDir: root, clock, withPanicServer: false, bleTransport: transport })

    await runtime.connectDevice('coyote')
    expect(runtime.listDevices().find(entry => entry.key === 'coyote')?.bound).toBe(true)
    const second = await runtime.addDevice('coyote')

    // The unbound card excludes the unit already persisted on the first card.
    await expect(runtime.connectDevice(second.key)).rejects.toThrow(/already paired/)
    expect(transport.requests.at(-1)?.excludeDeviceIds).toContain('unit-shared')
    // The duplicate pin was not persisted and the wrong link was released.
    expect(runtime.listDevices().find(entry => entry.key === second.key)?.bound).toBe(false)
    expect(runtime.snapshot().devices.find(device => device.id === second.key)?.lifecycle).not.toBe('ready')
  })

  it('allows adding and removing a mock device without a BLE transport (start-dev)', async () => {
    const clock = new FakeClock()
    runtime = await createHostRuntime({ dataDir: root, clock, withPanicServer: false })
    expect(runtime.listDevices()).toEqual([])
    const added = await runtime.addDevice('mock')
    expect(added.key).toBe('mock')
    expect(runtime.snapshot().devices.map(device => device.id)).toContain('mock')
    const second = await runtime.addDevice('mock')
    expect(second.key).toBe('mock-2')
    await runtime.removeDevice('mock')
    expect(runtime.snapshot().devices.map(device => device.id)).not.toContain('mock')
    expect(runtime.snapshot().devices.map(device => device.id)).toContain('mock-2')
  })

  it('lets a failed device reconnect through the registry', async () => {
    const clock = new FakeClock()
    const transport = new MockBleTransport({ clock, name: COYOTE_BLE_NAME })
    const errors: unknown[] = []
    runtime = await createHostRuntime({
      dataDir: root,
      clock,
      withPanicServer: false,
      bleTransport: transport,
      onError: error => { errors.push(error) },
    })
    await runtime.registry.connect('coyote', new AbortController().signal)
    const coyote = runtime.snapshot().devices.find(device => device.id === 'coyote')
    expect(coyote?.lifecycle).toBe('ready')

    // Drop the link, then reconnect without recreating anything.
    transport.peripheralFor(filter => filter.name === COYOTE_BLE_NAME)!.simulateDisconnect()
    expect(runtime.snapshot().devices.find(device => device.id === 'coyote')?.lifecycle).toBe('failed')

    await runtime.registry.connect('coyote', new AbortController().signal)
    expect(runtime.snapshot().devices.find(device => device.id === 'coyote')?.lifecycle).toBe('ready')
  })

  it('registers the relay backend only when a share token is configured', async () => {
    const clock = new FakeClock()
    const without = await createHostRuntime({ dataDir: root, clock, withPanicServer: false })
    expect(without.snapshot().devices.some(device => device.id === 'monsterparty')).toBe(false)
    await without.shutdown()

    const errors: unknown[] = []
    runtime = await createHostRuntime({
      dataDir: root,
      clock,
      withPanicServer: false,
      monsterPartyToken: 'not-a-real-token',
      onError: error => { errors.push(error) },
    })
    const relay = runtime.snapshot().devices.find(device => device.id === 'monsterparty')
    expect(relay).toBeDefined()
    // Registered but not connected: nothing dials out until the operator asks.
    expect(relay?.lifecycle).toBe('disconnected')
    // A human-driven connect fails without a reachable relay, and the app
    // keeps serving everything else.
    await expect(runtime.registry.connect('monsterparty', new AbortController().signal)).rejects.toThrow()
    expect(runtime.snapshot().devices.find(device => device.id === 'monsterparty')?.lifecycle).toBe('failed')
    expect(runtime.snapshot().devices.find(device => device.id === 'mock-pulse')?.lifecycle).toBe('disconnected')
    await runtime.registry.connect('mock-pulse', new AbortController().signal)
    expect(runtime.snapshot().devices.find(device => device.id === 'mock-pulse')?.lifecycle).toBe('ready')
  })

  it('drives a real waveform through the registry to the transport', async () => {
    const clock = new FakeClock()
    const transport = new MockBleTransport({ clock, name: COYOTE_BLE_NAME })
    runtime = await createHostRuntime({ dataDir: root, clock, withPanicServer: false, bleTransport: transport })
    await runtime.registry.connect('coyote', new AbortController().signal)

    await runtime.registry.runPattern('model', {
      deviceId: 'coyote',
      channelId: 'a',
      envelope: { preset: 'steady', minPercent: 20, maxPercent: 20, periodMs: 1_000, jitter: 0 },
      durationSec: 30,
      waveformId: 'breathing',
    })
    clock.advance(300)
    await runtime.registry.settled()

    const peripheral = transport.peripheralFor(filter => filter.name === COYOTE_BLE_NAME)!
    const frames = peripheral.writes.filter(write => write.data.length === 20)
    expect(frames.length).toBeGreaterThan(1)
    expect(runtime.snapshot().devices.find(device => device.id === 'coyote')?.channels[0]?.waveform?.id).toBe('breathing')
  })

  it('keeps the runtime usable when the box is not connectable', async () => {
    const clock = new FakeClock()
    const transport = new MockBleTransport({
      clock,
      name: COYOTE_BLE_NAME,
      failRequest: new Error('no device chosen'),
    })
    const errors: unknown[] = []
    runtime = await createHostRuntime({
      dataDir: root,
      clock,
      withPanicServer: false,
      bleTransport: transport,
      onError: error => { errors.push(error) },
    })

    // Nothing tried to connect at startup: no scan, no error.
    expect(errors.length).toBe(0)
    expect(runtime.snapshot().devices.find(device => device.id === 'coyote')?.lifecycle).toBe('disconnected')

    // The operator's 连接 hits the dead box: refused, marked failed, and
    // everything else stays usable.
    await expect(runtime.registry.connect('coyote', new AbortController().signal)).rejects.toThrow()
    expect(runtime.snapshot().devices.find(device => device.id === 'coyote')?.lifecycle).toBe('failed')
    await runtime.registry.connect('mock-pulse', new AbortController().signal)
    expect(runtime.snapshot().devices.find(device => device.id === 'mock-pulse')?.lifecycle).toBe('ready')
  })
})

describe('Intiface / Buttplug wiring', () => {
  it('reports that no engine was looked for when Buttplug is disabled', async () => {
    const clock = new FakeClock()
    runtime = await createHostRuntime({ dataDir: root, clock, withPanicServer: false, withButtplug: false })

    expect(runtime.intiface.availability).toBe('unavailable')
    expect(runtime.intiface.owned).toBe(false)
    expect(runtime.intiface.url).toMatch(/^ws:\/\/127\.0\.0\.1:\d+$/)
    expect(runtime.snapshot().devices.some(device => device.id === 'buttplug')).toBe(false)
  })

  it('marks only hub-style backends as scannable', async () => {
    const clock = new FakeClock()
    const transport = new MockBleTransport({ clock, name: COYOTE_BLE_NAME })
    runtime = await createHostRuntime({
      dataDir: root,
      clock,
      withPanicServer: false,
      withButtplug: false,
      bleTransport: transport,
    })

    // A single-device backend has nothing to discover.
    for (const device of runtime.snapshot().devices) {
      expect(device.canScan, device.id).toBe(false)
    }
  })
})

describe('waveform persistence', () => {  it('carries a promoted waveform across runtimes and drops session scratch', async () => {
    const clock = new FakeClock()
    runtime = await createHostRuntime({ dataDir: root, clock, withPanicServer: false })

    const kept = runtime.waveforms.author({
      name: 'operator favourite',
      segments: [{ ms: 200, freq: 25, intensity: 55 }],
    })
    runtime.waveforms.author({ name: 'scratch', segments: [{ ms: 100, freq: 25, intensity: 55 }] })
    runtime.waveforms.promoteByHuman(kept.id)

    await runtime.shutdown()
    runtime = undefined

    const revived = await createHostRuntime({ dataDir: root, clock, withPanicServer: false })
    runtime = revived
    const ids = revived.waveforms.list().map(entry => entry.id)
    expect(ids).toContain(kept.id)
    expect(ids).not.toContain('scratch')
    expect(revived.waveforms.require(kept.id).frames).toEqual(kept.frames)
  })
})

describe('perception wiring', () => {
  it('always exposes a sensor registry and degrades to no sources without a camera', async () => {
    const clock = new FakeClock()
    runtime = await createHostRuntime({ dataDir: root, clock, withPanicServer: false, withButtplug: false })

    expect(runtime.sensorsStatus()).toEqual([])
    expect(await runtime.sensorFrame()).toBeUndefined()
    // An external capture end cannot invent a source: the registry throws its
    // typed UNKNOWN_SOURCE error, which the HTTP layer maps to 400.
    expect(() => {
      runtime!.pushFeatures({ sourceId: 'ghost-cam', ts: clock.now(), frameAgeMs: 0, quality: 'ok' })
    }).toThrow(/ghost-cam/)
    expect(runtime.sensors.statuses()).toEqual([])
  })
})
