import { describe, expect, it } from 'vitest'
import {
  AuditLog,
  ButtplugBackend,
  DeviceRegistry,
  FakeClock,
  INTIFACE_DEFAULT_URL,
  MemoryAppendOnlyStore,
  MockTextSocket,
  MockTextSocketTransport,
  PolicyStore,
  SafetyError,
  parseFrames,
  type AuditRecord,
  type ButtplugProtocolVersion,
} from '../src/index.ts'

const V3_DEVICES = [
  {
    DeviceIndex: 0,
    DeviceName: 'Lush 3',
    DeviceMessages: { ScalarCmd: [{ ActuatorType: 'Vibrate', FeatureDescriptor: 'Vibrator' }] },
  },
]

const V4_DEVICES = {
  '0': {
    DeviceIndex: 0,
    DeviceName: 'Cannon',
    DeviceFeatures: {
      '0': { FeatureIndex: 0, FeatureDescription: 'Vibration', Output: { Vibrate: { Value: [1, 20] } } },
    },
  },
}

interface ServerState {
  devices: unknown
  serverName?: string
  maxPingTime?: number
  failTypes?: Set<string>
  silentTypes?: Set<string>
  readonly seen: string[]
}

/** A fake Intiface answering synchronously, which the correlation map allows. */
function intiface(state: ServerState) {
  return (text: string, socket: MockTextSocket): void => {
    for (const frame of parseFrames(text)) {
      const id = frame.body.Id as number
      state.seen.push(frame.type)
      if (state.silentTypes?.has(frame.type) === true) continue
      if (state.failTypes?.has(frame.type) === true) {
        socket.emit([{ Error: { Id: id, ErrorMessage: `${frame.type} refused by server`, ErrorCode: 3 } }])
        continue
      }
      if (frame.type === 'RequestServerInfo') {
        socket.emit([{
          ServerInfo: {
            Id: id,
            ServerName: state.serverName ?? 'test-server',
            MaxPingTime: state.maxPingTime ?? 0,
          },
        }])
        continue
      }
      if (frame.type === 'RequestDeviceList') {
        socket.emit([{ DeviceList: { Id: id, Devices: state.devices } }])
        continue
      }
      socket.emit([{ Ok: { Id: id } }])
    }
  }
}

function tick(): Promise<void> {
  return new Promise(resolve => { setTimeout(resolve, 0) })
}

function signal(): AbortSignal {
  return new AbortController().signal
}

/**
 * Read a sent message with the real parser.
 *
 * A Buttplug frame is a JSON *array* of single-key objects, so indexing the
 * parsed frame as an object silently yields undefined.
 */
function sentBody(socket: MockTextSocket, type: string): Readonly<Record<string, unknown>> | undefined {
  return socket.sent
    .flatMap(text => parseFrames(text))
    .filter(frame => frame.type === type)
    .at(-1)?.body
}

function harness(version: ButtplugProtocolVersion, overrides: Partial<ServerState> = {}) {
  const clock = new FakeClock()
  const errors: unknown[] = []
  const state: ServerState = {
    devices: version === 3 ? V3_DEVICES : V4_DEVICES,
    seen: [],
    ...overrides,
  }
  const sockets = new MockTextSocketTransport({ onSend: intiface(state) })
  const backend = new ButtplugBackend({
    clock,
    sockets,
    version,
    onError: error => { errors.push(error) },
  })
  return { clock, sockets, backend, errors, state }
}

async function safetyErrorFrom(promise: Promise<unknown>): Promise<SafetyError> {
  let caught: unknown
  try {
    await promise
  } catch (error) {
    caught = error
  }
  expect(caught).toBeInstanceOf(SafetyError)
  return caught as SafetyError
}

describe('Buttplug connect', () => {
  it('handshakes then asks for the device list', async () => {
    const h = harness(4)
    await h.backend.connect(signal())

    expect(h.sockets.opens[0]?.url).toBe(INTIFACE_DEFAULT_URL)
    expect(h.state.seen).toEqual(['RequestServerInfo', 'RequestDeviceList'])
    expect(h.backend.name).toContain('test-server')
  })

  it('negotiates the configured protocol version', async () => {
    const three = harness(3)
    await three.backend.connect(signal())
    expect(sentBody(three.sockets.socket!, 'RequestServerInfo')).toMatchObject({ MessageVersion: 3 })

    const four = harness(4)
    await four.backend.connect(signal())
    expect(sentBody(four.sockets.socket!, 'RequestServerInfo')).toMatchObject({ ProtocolVersionMajor: 4 })
  })

  it('turns v3 scalar actuators into channels', async () => {
    const h = harness(3)
    await h.backend.connect(signal())
    expect(h.backend.channels.map(channel => channel.id)).toEqual(['0:0:vibrate'])
    expect(h.backend.channels[0]?.label).toBe('Lush 3 · Vibrator')
    // v3 scalars are a plain 0-1 float, so there is no dead zone to publish.
    expect(h.backend.channels[0]?.outputFloorPercent).toBeUndefined()
  })

  it('publishes the dead zone a v4 feature advertises', async () => {
    const h = harness(4, {
      devices: {
        '0': {
          DeviceIndex: 0,
          DeviceName: 'Cannon',
          DeviceFeatures: {
            '0': { FeatureIndex: 0, FeatureDescription: 'Vibration', Output: { Vibrate: { Value: [5, 20] } } },
          },
        },
      },
    })
    await h.backend.connect(signal())
    // A minimum of 5 out of 20 means anything under 25% is ignored by the toy.
    expect(h.backend.channels[0]?.outputFloorPercent).toBe(25)
  })

  it('lets go of the socket when the handshake answers wrongly', async () => {
    const clock = new FakeClock()
    const sockets = new MockTextSocketTransport({
      onSend: (text, socket) => {
        for (const frame of parseFrames(text)) {
          socket.emit([{ Ok: { Id: frame.body.Id } }])
        }
      },
    })
    const backend = new ButtplugBackend({ clock, sockets, version: 4 })

    const error = await safetyErrorFrom(backend.connect(signal()))
    expect(error.message).toMatch(/expected ServerInfo/)
    expect(sockets.socket?.open).toBe(false)
  })

  it('scans on connect when asked', async () => {
    const clock = new FakeClock()
    const state: ServerState = { devices: V4_DEVICES, seen: [] }
    const sockets = new MockTextSocketTransport({ onSend: intiface(state) })
    const backend = new ButtplugBackend({ clock, sockets, version: 4, scanOnConnectMs: 500 })

    const promise = backend.connect(signal())
    await tick()
    clock.advance(500)
    await promise

    expect(state.seen).toEqual([
      'RequestServerInfo',
      'RequestDeviceList',
      'StartScanning',
      'StopScanning',
      'RequestDeviceList',
    ])
  })
})

describe('Buttplug level commands', () => {
  it('drives a v4 feature with OutputCmd inside its advertised range', async () => {
    const h = harness(4)
    await h.backend.connect(signal())
    await h.backend.applyLevel('0:0:vibrate', 50)

    expect(sentBody(h.sockets.socket!, 'OutputCmd')).toMatchObject({
      DeviceIndex: 0,
      FeatureIndex: 0,
      Command: { Vibrate: { Value: 10 } },
    })
  })

  it('drives a v3 feature with ScalarCmd as a 0-1 float', async () => {
    const h = harness(3)
    await h.backend.connect(signal())
    await h.backend.applyLevel('0:0:vibrate', 40)

    expect(sentBody(h.sockets.socket!, 'ScalarCmd')).toMatchObject({
      DeviceIndex: 0,
      Scalars: [{ Index: 0, Scalar: 0.4, ActuatorType: 'Vibrate' }],
    })
  })

  it('explains a malformed channel id', async () => {
    const h = harness(4)
    await h.backend.connect(signal())
    const error = await safetyErrorFrom(h.backend.applyLevel('nonsense', 10))
    expect(error.code).toBe('UNKNOWN_CHANNEL')
    expect(error.message).toContain('0:1:vibrate')
  })

  it('explains a channel whose device went away', async () => {
    const h = harness(4)
    await h.backend.connect(signal())
    const error = await safetyErrorFrom(h.backend.applyLevel('9:0:vibrate', 10))
    expect(error.message).toMatch(/may have disconnected/)
  })

  it('surfaces a server-side refusal using the message the server sent', async () => {
    const h = harness(4, { failTypes: new Set(['OutputCmd']) })
    await h.backend.connect(signal())
    const error = await safetyErrorFrom(h.backend.applyLevel('0:0:vibrate', 10))
    expect(error.message).toContain('OutputCmd refused by server')
  })

  it('times out a request the server never answers', async () => {
    const h = harness(4, { silentTypes: new Set(['OutputCmd']) })
    await h.backend.connect(signal())

    const promise = h.backend.applyLevel('0:0:vibrate', 10)
    h.clock.advance(5_000)
    const error = await safetyErrorFrom(promise)
    expect(error.message).toMatch(/timed out/)
  })

  it('stops with the version-appropriate message', async () => {
    const four = harness(4)
    await four.backend.connect(signal())
    await four.backend.stopAll()
    expect(four.state.seen.at(-1)).toBe('StopCmd')

    const three = harness(3)
    await three.backend.connect(signal())
    await three.backend.stopAll()
    expect(three.state.seen.at(-1)).toBe('StopAllDevices')
  })
})

describe('Buttplug discovery', () => {
  it('brackets the scan window and adopts what appeared', async () => {
    const h = harness(4, { devices: {} })
    await h.backend.connect(signal())
    expect(h.backend.channels).toHaveLength(0)

    const changes: number[] = []
    h.backend.onChannelsChanged(() => { changes.push(1) })

    h.state.devices = V4_DEVICES
    const promise = h.backend.scan(1_000, signal())
    await tick()
    h.clock.advance(1_000)
    await promise

    expect(h.state.seen.slice(-3)).toEqual(['StartScanning', 'StopScanning', 'RequestDeviceList'])
    expect(h.backend.channels.map(channel => channel.id)).toEqual(['0:0:vibrate'])
    expect(changes.length).toBeGreaterThan(0)
  })

  it('follows v3 device add and remove events', async () => {
    const h = harness(3, { devices: [] })
    await h.backend.connect(signal())
    const changes: number[] = []
    h.backend.onChannelsChanged(() => { changes.push(1) })
    const socket = h.sockets.socket!

    socket.emit([{ DeviceAdded: { Id: 0, ...V3_DEVICES[0]! } }])
    expect(h.backend.channels.map(channel => channel.id)).toEqual(['0:0:vibrate'])

    socket.emit([{ DeviceRemoved: { Id: 0, DeviceIndex: 0 } }])
    expect(h.backend.channels).toHaveLength(0)
    expect(changes).toHaveLength(2)
  })

  it('ignores v3-only add events when speaking v4', async () => {
    const h = harness(4, { devices: {} })
    await h.backend.connect(signal())
    h.sockets.socket!.emit([{ DeviceAdded: { Id: 0, DeviceIndex: 0, DeviceName: 'x' } }])
    // v4 folds membership into DeviceList; a stray v3 event must not be trusted.
    expect(h.backend.channels).toHaveLength(0)
  })
})

describe('Buttplug liveness', () => {
  it('pings at half the interval the server allows', async () => {
    const h = harness(4, { maxPingTime: 1_000 })
    await h.backend.connect(signal())
    const before = h.state.seen.filter(type => type === 'Ping').length

    h.clock.advance(500)
    await tick()
    h.clock.advance(500)
    await tick()

    expect(h.state.seen.filter(type => type === 'Ping').length).toBe(before + 2)
  })

  it('does not ping when the server does not require it', async () => {
    const h = harness(4, { maxPingTime: 0 })
    await h.backend.connect(signal())
    h.clock.advance(60_000)
    await tick()
    expect(h.state.seen).not.toContain('Ping')
  })

  it('drops the connection when the peer is not speaking this protocol', async () => {
    const h = harness(4)
    await h.backend.connect(signal())
    const lost: number[] = []
    h.backend.onLinkLost(() => { lost.push(1) })

    h.sockets.socket!.emit('{"not":"an array"}')

    expect(lost).toHaveLength(1)
    expect(h.sockets.socket?.open).toBe(false)
    expect(h.errors.length).toBeGreaterThan(0)
  })

  it('reports link loss, clears channels, and rejects work in flight', async () => {
    const h = harness(4, { silentTypes: new Set(['OutputCmd']) })
    await h.backend.connect(signal())
    const lost: number[] = []
    h.backend.onLinkLost(() => { lost.push(1) })

    const inFlight = h.backend.applyLevel('0:0:vibrate', 20)
    h.sockets.socket!.simulateClose(1006, 'engine stopped')

    expect(lost).toHaveLength(1)
    // The hub's devices are gone with it.
    expect(h.backend.channels).toHaveLength(0)
    await expect(inFlight).rejects.toBeInstanceOf(SafetyError)
    await expect(h.backend.applyLevel('0:0:vibrate', 20)).rejects.toThrow(/start the engine/)
  })

  it('stops output then closes the socket', async () => {
    const h = harness(4)
    await h.backend.connect(signal())
    await h.backend.close()
    expect(h.state.seen.at(-1)).toBe('StopCmd')
    expect(h.sockets.socket?.open).toBe(false)
  })

  it('refuses commands before connect', async () => {
    const h = harness(4)
    await expect(h.backend.applyLevel('0:0:vibrate', 10)).rejects.toBeInstanceOf(SafetyError)
  })
})

describe('Buttplug through the registry', () => {
  function registryHarness() {
    const clock = new FakeClock()
    const store = new MemoryAppendOnlyStore()
    const errors: unknown[] = []
    const audit = new AuditLog(store, clock, error => { errors.push(error) })
    const state: ServerState = { devices: {}, seen: [] }
    const sockets = new MockTextSocketTransport({ onSend: intiface(state) })
    const registry = new DeviceRegistry({
      clock,
      audit,
      policy: new PolicyStore({ minPercent: 0, maxPercent: 40, maxWaveIntensity: 80, minFreq: 10, maxFreq: 240, maxDurationSec: 60 }),
      onError: error => { errors.push(error) },
      tickMs: 50,
    })
    const backend = new ButtplugBackend({ clock, sockets, version: 4, onError: error => { errors.push(error) } })
    registry.register(backend)
    return {
      clock,
      registry,
      backend,
      sockets,
      state,
      records: (): AuditRecord[] => store.lines.map(line => JSON.parse(line) as AuditRecord),
    }
  }

  it('adopts devices found by a scan and records it', async () => {
    const h = registryHarness()
    await h.registry.connect('buttplug', signal())
    expect(h.registry.snapshot().devices[0]?.channels).toHaveLength(0)

    h.state.devices = V4_DEVICES
    const promise = h.registry.scan('model', 'buttplug', 1_000, signal())
    await tick()
    h.clock.advance(1_000)
    await promise

    const channels = h.registry.snapshot().devices[0]!.channels
    expect(channels.map(channel => channel.id)).toEqual(['0:0:vibrate'])

    const records = h.records()
    expect(records.some(record => record.action === 'scan' && record.result === 'ok')).toBe(true)
    expect(records.some(record => record.action === 'channels_changed')).toBe(true)
  })

  it('drives a discovered channel and honours the cap', async () => {
    const h = registryHarness()
    h.state.devices = V4_DEVICES
    await h.registry.connect('buttplug', signal())

    await h.registry.runPattern('model', {
      deviceId: 'buttplug',
      channelId: '0:0:vibrate',
      envelope: { preset: 'steady', minPercent: 30, maxPercent: 30, periodMs: 1_000, jitter: 0 },
      durationSec: 20,
    })
    h.clock.advance(100)
    await h.registry.settled()

    const sent = sentBody(h.sockets.socket!, 'OutputCmd')
    // 30% of the advertised 1-20 range.
    expect(sent).toMatchObject({ Command: { Vibrate: { Value: 6 } } })

    // Over-cap authored content clamps to the channel cap instead of refusing.
    await h.registry.runPattern('model', {
      deviceId: 'buttplug',
      channelId: '0:0:vibrate',
      envelope: { preset: 'steady', minPercent: 90, maxPercent: 90, periodMs: 1_000, jitter: 0 },
      durationSec: 20,
    })
    h.clock.advance(100)
    await h.registry.settled()
    const clamped = sentBody(h.sockets.socket!, 'OutputCmd')
    // 90% requested on a 40-capped channel runs at 40%: 0.4 of 1-20.
    expect(clamped).toMatchObject({ Command: { Vibrate: { Value: 8 } } })
  })

  it('refuses a scan while a human has output locked', async () => {
    const h = registryHarness()
    await h.registry.connect('buttplug', signal())
    await h.registry.emergencyStop('hotkey')

    const error = await safetyErrorFrom(h.registry.scan('model', 'buttplug', 500, signal()))
    expect(error.code).toBe('LOCKED')
  })

  it('refuses a scan on a backend that serves a single device', async () => {
    const h = registryHarness()
    await h.registry.connect('buttplug', signal())
    // The mock backend has no scan capability.
    const error = await safetyErrorFrom(h.registry.scan('model', 'nope', 500, signal()))
    expect(error.code).toBe('UNKNOWN_DEVICE')
  })
})
