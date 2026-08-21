import { describe, expect, it } from 'vitest'
import {
  AuditLog,
  COMMAND,
  DEVICE_INFORMATION_SERVICE,
  DeviceRegistry,
  FakeClock,
  MemoryAppendOnlyStore,
  MockBleTransport,
  PNP_ID_CHARACTERISTIC,
  PolicyStore,
  SafetyError,
  XHTKJ_ADVERTISING_SERVICE,
  XHTKJ_ALT_SERVICE,
  XHTKJ_ALT_WRITE_CHARACTERISTIC,
  XHTKJ_DEVICE_SERVICE,
  XHTKJ_WRITE_CHARACTERISTIC,
  XhtkjBackend,
  encodedStrength,
  outputFloorPercent,
  readU16,
  type MockBleWrite,
  type XhtkjBackendOptions,
} from '../src/index.ts'

const WRITE_REF = { service: XHTKJ_DEVICE_SERVICE, characteristic: XHTKJ_WRITE_CHARACTERISTIC }

/** Key format used by MockBlePeripheral's read table. */
const PNP_KEY = `${DEVICE_INFORMATION_SERVICE}/${PNP_ID_CHARACTERISTIC}`.toLowerCase()

/** PnP ID value whose bytes 3-4 encode the given product id, little endian. */
function pnpFor(productId: number): Uint8Array {
  return Uint8Array.from([0x02, 0x5e, 0x04, productId & 0xff, (productId >> 8) & 0xff, 0x01, 0x00])
}

async function safetyErrorFrom(promise: Promise<unknown>): Promise<SafetyError> {
  try {
    await promise
  } catch (error) {
    return error as SafetyError
  }
  throw new Error('expected the promise to reject')
}

function signal(): AbortSignal {
  return new AbortController().signal
}

function harness(productId: number | undefined, overrides: Partial<XhtkjBackendOptions> = {}) {
  const clock = new FakeClock()
  const errors: unknown[] = []
  const transport = new MockBleTransport({
    clock,
    name: 'MZ-TOY',
    ...(productId === undefined ? {} : { reads: { [PNP_KEY]: pnpFor(productId) } }),
  })
  const backend = new XhtkjBackend({
    clock,
    transport,
    onError: error => { errors.push(error) },
    ...overrides,
  })
  return { clock, transport, backend, errors }
}

function writes(transport: MockBleTransport): MockBleWrite[] {
  return transport.peripheral?.writesTo(WRITE_REF) ?? []
}

function commandsOf(transport: MockBleTransport): number[] {
  return writes(transport).map(write => write.data[2] ?? 0)
}

function strengthWrites(transport: MockBleTransport): MockBleWrite[] {
  return writes(transport).filter(write => write.data[2] === COMMAND.strength)
}

describe('XHTKJ connect', () => {
  it('matches on the advertised service and asks for access to the others', async () => {
    const h = harness(29)
    await h.backend.connect(signal())

    const filter = h.transport.requests[0]!
    // Only 0xd34e is advertised, so only it may appear in the match.
    expect(filter.services).toEqual([XHTKJ_ADVERTISING_SERVICE])
    // Every control layout is granted up front (Web Bluetooth denies access
    // to undeclared services).
    expect(filter.optionalServices).toEqual([
      XHTKJ_DEVICE_SERVICE,
      DEVICE_INFORMATION_SERVICE,
      XHTKJ_ALT_SERVICE,
    ])
  })

  it('pins the scan to a specific unit by advertised name', async () => {
    const h = harness(29, { bleName: 'ANKNI ZKRXB' })
    await h.backend.connect(signal())

    const filter = h.transport.requests[0]!
    expect(filter.name).toBe('ANKNI ZKRXB')
    expect(filter.services).toEqual([XHTKJ_ADVERTISING_SERVICE])
  })

  it('fails over to the ANKNI clone control layout (0xdddd) when 0xff10 is absent', async () => {
    const clock = new FakeClock()
    const errors: unknown[] = []
    const transport = new MockBleTransport({
      clock,
      name: 'ANKNI ZKRXB',
      reads: { [PNP_KEY]: pnpFor(0x2000) },
      // The classic 谜姬 service does not exist on the clone.
      failWrite: ref => (
        ref.service === XHTKJ_DEVICE_SERVICE
          ? new Error('NotFoundError: GATT service 0000ff10-0000-1000-8000-00805f9b34fb not found')
          : undefined
      ),
    })
    const backend = new XhtkjBackend({ clock, transport, onError: error => { errors.push(error) } })

    await backend.connect(signal())
    expect(backend.reportedProductId).toBe(0x2000)
    expect(backend.reportedCapability).toBe('vibration')

    // Output now goes through the clone's write characteristic.
    await backend.applyLevel('primary', 30)
    clock.advance(200)
    await backend.settled()
    const strength = (transport.peripheral?.writes ?? []).find(write => write.data[2] === COMMAND.strength)
    expect(strength?.service).toBe(XHTKJ_ALT_SERVICE)
    expect(strength?.characteristic).toBe(XHTKJ_ALT_WRITE_CHARACTERISTIC)
  })

  it('refuses with named errors when no control layout answers the handshake', async () => {
    const clock = new FakeClock()
    const transport = new MockBleTransport({
      clock,
      name: 'UNKNOWN TOY',
      reads: { [PNP_KEY]: pnpFor(0x2000) },
      failWrite: () => new Error('NotFoundError: no such characteristic'),
    })
    const backend = new XhtkjBackend({ clock, transport })

    const error = await safetyErrorFrom(backend.connect(signal()))
    expect(error.code).toBe('NOT_CONNECTED')
    expect(error.message).toContain('every known layout')
  })

  it('reads the product id and initialises the session', async () => {
    const h = harness(29)
    await h.backend.connect(signal())

    expect(h.transport.peripheral?.reads).toContain(PNP_KEY)
    expect(h.backend.reportedProductId).toBe(29)
    expect(h.backend.reportedCapability).toBe('heat')
    expect(commandsOf(h.transport)[0]).toBe(COMMAND.initialize)
  })

  it('degrades to main output only when the product id cannot be read', async () => {
    // No read table entry at all: the read rejects.
    const h = harness(undefined)
    await h.backend.connect(signal())

    expect(h.errors.length).toBeGreaterThan(0)
    expect(h.backend.reportedProductId).toBeUndefined()
    expect(h.backend.reportedCapability).toBe('generic')
    // Inventing a secondary channel we cannot encode would be worse.
    expect(h.backend.channels.map(channel => channel.id)).toEqual(['primary'])
  })

  it('still connects when the toy refuses notifications', async () => {
    const clock = new FakeClock()
    const transport = new MockBleTransport({ clock, reads: { [PNP_KEY]: pnpFor(94) } })
    const errors: unknown[] = []
    const backend = new XhtkjBackend({ clock, transport, onError: error => { errors.push(error) } })
    // MockBlePeripheral rejects a read with no table entry; notifications are
    // subscribed before the read, so make the write path prove connect survived.
    await backend.connect(signal())
    expect(backend.reportedCapability).toBe('shock')
  })

  it('lets go of the link when initialisation fails', async () => {
    const clock = new FakeClock()
    const transport = new MockBleTransport({
      clock,
      reads: { [PNP_KEY]: pnpFor(29) },
      failWrite: () => new Error('gatt write rejected'),
    })
    const backend = new XhtkjBackend({ clock, transport })

    await expect(backend.connect(signal())).rejects.toThrow('gatt write rejected')
    expect(transport.peripheral?.connected).toBe(false)
  })
})

describe('XHTKJ channels', () => {
  it('names the secondary output after the detected capability', async () => {
    for (const [productId, label] of [[29, '加热'], [94, '冲击'], [87, '电刺激'], [0x2000, '副震动']] as const) {
      const h = harness(productId)
      await h.backend.connect(signal())
      const secondary = h.backend.channels.find(channel => channel.id === 'secondary')
      expect(secondary?.label, `product ${productId}`).toBe(label)
    }
  })

  it('publishes the output floor so a percentage is not mistaken for linear', async () => {
    const h = harness(0x2000)
    await h.backend.connect(signal())
    const primary = h.backend.channels[0]!
    // The smallest non-zero command already produces ~30% of full output.
    expect(primary.outputFloorPercent).toBe(30)
    expect(primary.outputFloorPercent).toBe(outputFloorPercent(0x2000))
  })

  it('claims a floor for the secondary only where the encoding is an amplitude', async () => {
    const shock = harness(94)
    await shock.backend.connect(signal())
    expect(shock.backend.channels[1]?.outputFloorPercent).toBe(30)

    // Heat scales linearly from zero, so no floor is claimed.
    const heat = harness(29)
    await heat.backend.connect(signal())
    expect(heat.backend.channels[1]?.outputFloorPercent).toBe(0)

    // The electric layout's words are not a plain amplitude; guessing would be
    // worse than admitting the mapping is only partly understood.
    const electric = harness(87)
    await electric.backend.connect(signal())
    expect(electric.backend.channels[1]?.outputFloorPercent).toBe(0)
  })

  it('reports no waveform stage', async () => {
    const h = harness(29)
    await h.backend.connect(signal())
    expect(h.backend.channels.every(channel => channel.supportsWaveform !== true)).toBe(true)
  })
})

describe('XHTKJ strength writes', () => {
  it('clears the queue once, then sends only strength packets', async () => {
    const h = harness(0x2000)
    await h.backend.connect(signal())

    await h.backend.applyLevel('primary', 50)
    await h.backend.settled()
    expect(commandsOf(h.transport)).toEqual([COMMAND.initialize, COMMAND.queue, COMMAND.strength])

    h.clock.advance(200)
    await h.backend.applyLevel('primary', 60)
    await h.backend.settled()
    // No second clear: the queue is already ours.
    expect(commandsOf(h.transport)).toEqual([
      COMMAND.initialize,
      COMMAND.queue,
      COMMAND.strength,
      COMMAND.strength,
    ])
  })

  it('encodes the primary value through the product band', async () => {
    const h = harness(0x2000)
    await h.backend.connect(signal())
    await h.backend.applyLevel('primary', 50)
    await h.backend.settled()

    const packet = strengthWrites(h.transport).at(-1)!.data
    // A `vibration` product has a real second motor, so the two groups are
    // independent and the untouched one sits at zero.
    expect(readU16(packet, 9)).toBe(encodedStrength(0.5, 0x2000))
    expect(readU16(packet, 17)).toBe(0)
  })

  it('repeats the primary value in both groups when the product is unidentified', async () => {
    const h = harness(undefined)
    await h.backend.connect(signal())
    await h.backend.applyLevel('primary', 50)
    await h.backend.settled()

    // With no secondary output to address, the mini-program sends the main
    // value twice; reproduced verbatim.
    const packet = strengthWrites(h.transport).at(-1)!.data
    expect(readU16(packet, 9)).toBe(encodedStrength(0.5, undefined))
    expect(readU16(packet, 17)).toBe(encodedStrength(0.5, undefined))
  })

  it('coalesces rapid changes and sends only the newest value', async () => {
    const h = harness(0x2000, { minWriteIntervalMs: 100 })
    await h.backend.connect(signal())
    await h.backend.applyLevel('primary', 10)
    await h.backend.settled()
    const after = strengthWrites(h.transport).length

    // Three changes inside one rate-limit window.
    await h.backend.applyLevel('primary', 20)
    await h.backend.applyLevel('primary', 30)
    await h.backend.applyLevel('primary', 40)
    await h.backend.settled()
    expect(strengthWrites(h.transport).length).toBe(after)

    h.clock.advance(100)
    await h.backend.settled()
    const sent = strengthWrites(h.transport)
    expect(sent.length).toBe(after + 1)
    // A stale intermediate value is never worth sending.
    expect(readU16(sent.at(-1)!.data, 9)).toBe(encodedStrength(0.4, 0x2000))
  })

  it('drives both outputs on a dual-capability product', async () => {
    const h = harness(29)
    await h.backend.connect(signal())
    await h.backend.applyLevel('primary', 60)
    await h.backend.settled()
    h.clock.advance(200)
    await h.backend.applyLevel('secondary', 25)
    await h.backend.settled()

    const packet = strengthWrites(h.transport).at(-1)!.data
    // Heat layout: raw secondary scale first, main value last.
    expect(readU16(packet, 3)).toBe(((Math.trunc(1023 * 0.25) << 6) | 60) & 0xffff)
    expect(readU16(packet, 17)).toBe(encodedStrength(0.6, 29))
  })

  it('refuses a secondary command on an unidentified product', async () => {
    const h = harness(undefined)
    await h.backend.connect(signal())
    let caught: unknown
    try {
      await h.backend.applyLevel('secondary', 10)
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(SafetyError)
    expect((caught as SafetyError).code).toBe('UNKNOWN_CHANNEL')
    expect((caught as SafetyError).message).toMatch(/could not identify/)
  })

  it('rejects an unknown channel name', async () => {
    const h = harness(29)
    await h.backend.connect(signal())
    await expect(h.backend.applyLevel('tertiary', 10)).rejects.toThrow(/"primary" and "secondary"/)
  })

  it('clamps a level to whole percentages inside 0-100', async () => {
    const h = harness(0x2000)
    await h.backend.connect(signal())
    await h.backend.applyLevel('primary', 250)
    await h.backend.settled()
    expect(readU16(strengthWrites(h.transport).at(-1)!.data, 9)).toBe(encodedStrength(1, 0x2000))
  })

  it('retries a value whose write failed instead of losing it', async () => {
    const clock = new FakeClock()
    let failStrength = true
    const transport = new MockBleTransport({
      clock,
      reads: { [PNP_KEY]: pnpFor(0x2000) },
      failWrite: (_ref, data) => (failStrength && data[2] === COMMAND.strength ? new Error('busy') : undefined),
    })
    const errors: unknown[] = []
    const backend = new XhtkjBackend({ clock, transport, onError: error => { errors.push(error) }, minWriteIntervalMs: 50 })
    await backend.connect(signal())

    await backend.applyLevel('primary', 30)
    await backend.settled()
    expect(errors.length).toBeGreaterThan(0)

    failStrength = false
    clock.advance(50)
    await backend.settled()
    expect(readU16(strengthWrites(transport).at(-1)!.data, 9)).toBe(encodedStrength(0.3, 0x2000))
  })
})

describe('XHTKJ stop and teardown', () => {
  it('stops without waiting out the rate limit', async () => {
    const h = harness(0x2000, { minWriteIntervalMs: 1_000 })
    await h.backend.connect(signal())
    await h.backend.applyLevel('primary', 40)
    await h.backend.settled()

    // A stop issued inside the rate-limit window must land immediately.
    await h.backend.stopAll()

    const tail = commandsOf(h.transport).slice(-2)
    expect(tail).toEqual([COMMAND.stopMode, COMMAND.queue])
  })

  it('clears the queue again on the next command after a stop', async () => {
    const h = harness(0x2000)
    await h.backend.connect(signal())
    await h.backend.applyLevel('primary', 40)
    await h.backend.settled()
    await h.backend.stopAll()

    h.clock.advance(200)
    await h.backend.applyLevel('primary', 20)
    await h.backend.settled()
    expect(commandsOf(h.transport).slice(-2)).toEqual([COMMAND.queue, COMMAND.strength])
  })

  it('reports link loss and refuses further commands', async () => {
    const h = harness(29)
    const lost: number[] = []
    h.backend.onLinkLost(() => { lost.push(1) })
    await h.backend.connect(signal())

    h.transport.peripheral!.simulateDisconnect()

    expect(lost).toHaveLength(1)
    await expect(h.backend.applyLevel('primary', 10)).rejects.toBeInstanceOf(SafetyError)
  })

  it('stops output then releases the link on close', async () => {
    const h = harness(0x2000)
    await h.backend.connect(signal())
    await h.backend.applyLevel('primary', 40)
    await h.backend.settled()

    await h.backend.close()

    expect(commandsOf(h.transport).slice(-2)).toEqual([COMMAND.stopMode, COMMAND.queue])
    expect(h.transport.peripheral?.connected).toBe(false)
  })

  it('refuses commands before connect', async () => {
    const h = harness(29)
    await expect(h.backend.applyLevel('primary', 10)).rejects.toBeInstanceOf(SafetyError)
  })
})

describe('XHTKJ through the registry', () => {
  it('picks up the secondary channel and surfaces the output floor', async () => {
    const clock = new FakeClock()
    const store = new MemoryAppendOnlyStore()
    const errors: unknown[] = []
    const audit = new AuditLog(store, clock, error => { errors.push(error) })
    const transport = new MockBleTransport({ clock, reads: { [PNP_KEY]: pnpFor(94) } })
    const registry = new DeviceRegistry({
      clock,
      audit,
      policy: new PolicyStore({ maxPercent: 40, maxWaveIntensity: 80, maxDurationSec: 60 }),
      onError: error => { errors.push(error) },
      tickMs: 50,
    })
    const backend = new XhtkjBackend({ clock, transport, onError: error => { errors.push(error) } })
    registry.register(backend)

    // Before the handshake only the main output is known.
    expect(registry.snapshot().devices[0]?.channels.map(channel => channel.id)).toEqual(['primary'])

    await registry.connect('xhtkj', signal())

    const channels = registry.snapshot().devices[0]!.channels
    expect(channels.map(channel => channel.id)).toEqual(['primary', 'secondary'])
    expect(channels[0]?.outputFloorPercent).toBe(30)
    expect(channels[1]?.label).toBe('冲击')

    await registry.runPattern('model', {
      deviceId: 'xhtkj',
      channelId: 'primary',
      envelope: { preset: 'steady', minPercent: 25, maxPercent: 25, periodMs: 1_000, jitter: 0 },
      durationSec: 20,
    })
    clock.advance(100)
    await registry.settled()
    await backend.settled()

    const packet = strengthWrites(transport).at(-1)!.data
    expect(readU16(packet, 7)).toBe(encodedStrength(0.25, 94))
  })

  it('marks the device failed and zeroes state when the link drops', async () => {
    const clock = new FakeClock()
    const store = new MemoryAppendOnlyStore()
    const errors: unknown[] = []
    const audit = new AuditLog(store, clock, error => { errors.push(error) })
    const transport = new MockBleTransport({ clock, reads: { [PNP_KEY]: pnpFor(0x2000) } })
    const registry = new DeviceRegistry({
      clock,
      audit,
      policy: new PolicyStore({ maxPercent: 40, maxWaveIntensity: 80, maxDurationSec: 60 }),
      onError: error => { errors.push(error) },
      tickMs: 50,
    })
    const backend = new XhtkjBackend({ clock, transport })
    registry.register(backend)
    await registry.connect('xhtkj', signal())
    await registry.runPattern('model', {
      deviceId: 'xhtkj',
      channelId: 'primary',
      envelope: { preset: 'steady', minPercent: 30, maxPercent: 30, periodMs: 1_000, jitter: 0 },
      durationSec: 20,
    })
    clock.advance(100)
    await registry.settled()

    transport.peripheral!.simulateDisconnect()

    const device = registry.snapshot().devices[0]!
    expect(device.lifecycle).toBe('failed')
    expect(device.channels.every(channel => channel.percent === 0)).toBe(true)
    expect(device.channels.every(channel => channel.effect === undefined)).toBe(true)
  })
})
