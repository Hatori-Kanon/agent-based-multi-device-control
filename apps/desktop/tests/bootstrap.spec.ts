import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
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
  it('connects both mock control models and exposes a snapshot', async () => {
    const clock = new FakeClock()
    runtime = await createHostRuntime({ dataDir: root, clock, withPanicServer: false })

    const snapshot = runtime.snapshot()
    expect(snapshot.locked).toBe(false)
    expect(snapshot.devices.map(device => device.id)).toEqual(['mock-pulse', 'mock-hold'])
    for (const device of snapshot.devices) {
      expect(device.lifecycle).toBe('ready')
    }
    // Two channels on the streaming box, one on the stateful toy.
    expect(snapshot.devices[0]?.channels).toHaveLength(2)
    expect(snapshot.devices[1]?.channels).toHaveLength(1)
  })

  it('writes an append-only audit trail to disk', async () => {
    const clock = new FakeClock()
    runtime = await createHostRuntime({ dataDir: root, clock, withPanicServer: false })
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
  it('registers and connects a real Coyote alongside the mocks', async () => {
    const clock = new FakeClock()
    const transport = new MockBleTransport({ clock, name: COYOTE_BLE_NAME })
    runtime = await createHostRuntime({ dataDir: root, clock, withPanicServer: false, bleTransport: transport })

    const devices = runtime.snapshot().devices
    const coyote = devices.find(device => device.id === 'coyote')
    expect(coyote?.lifecycle).toBe('ready')
    expect(coyote?.channels.map(channel => channel.id)).toEqual(['a', 'b'])
    expect(coyote?.channels.every(channel => channel.supportsWaveform)).toBe(true)

    // The hardware ceiling was written from policy before anything else.
    // Two BLE backends share the adapter, so pick the Coyote's own peripheral.
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

  it('honours the per-backend enable flags', async () => {
    const clock = new FakeClock()
    const transport = new MockBleTransport({ clock, name: COYOTE_BLE_NAME })
    runtime = await createHostRuntime({
      dataDir: root,
      clock,
      withPanicServer: false,
      bleTransport: transport,
      withCoyote: false,
      withXhtkj: false,
    })

    const ids = runtime.snapshot().devices.map(device => device.id)
    expect(ids).not.toContain('coyote')
    expect(ids).not.toContain('xhtkj')
    // The mocks are unaffected.
    expect(ids).toContain('mock-pulse')
    expect(ids).toContain('mock-hold')
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
    // With no reachable relay it lands in `failed`, and the app still starts.
    expect(relay?.lifecycle).toBe('failed')
    expect(runtime.snapshot().devices.find(device => device.id === 'mock-pulse')?.lifecycle).toBe('ready')
  })

  it('drives a real waveform through the registry to the transport', async () => {
    const clock = new FakeClock()
    const transport = new MockBleTransport({ clock, name: COYOTE_BLE_NAME })
    runtime = await createHostRuntime({ dataDir: root, clock, withPanicServer: false, bleTransport: transport })

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

    // A box that is off must not stop the app from starting.
    expect(errors.length).toBeGreaterThan(0)
    expect(runtime.snapshot().devices.find(device => device.id === 'coyote')?.lifecycle).toBe('failed')
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
