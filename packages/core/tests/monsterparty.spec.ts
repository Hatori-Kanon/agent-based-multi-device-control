import { describe, expect, it } from 'vitest'
import {
  AuditLog,
  DeviceRegistry,
  FakeClock,
  MemoryAppendOnlyStore,
  MockTextSocketTransport,
  MONSTERPARTY_ORIGIN,
  MonsterPartyBackend,
  PolicyStore,
  SafetyError,
  stubFetch,
  type AuditRecord,
  type MockTextSocket,
  type MonsterPartyBackendOptions,
} from '../src/index.ts'

const TOKEN = 'share-token-abc123'
const SOCKET_URL = 'wss://relay.example.test/ws'

/** Product ids seen in the wild: `DS` marks dual motor, `SUCK` a suction pump. */
const DUAL_MOTOR_PID = 'AKN_DS_SUCKEGG'
const SINGLE_MOTOR_PID = 'AKN_EGG'

function tick(): Promise<void> {
  return new Promise(resolve => { setTimeout(resolve, 0) })
}

function signal(): AbortSignal {
  return new AbortController().signal
}

function okSession(): ReturnType<typeof stubFetch> {
  return stubFetch(() => ({ body: { errNo: 0, data: { socket_url: SOCKET_URL, id: 555, user_id: 777 } } }))
}

function harness(overrides: Partial<MonsterPartyBackendOptions> = {}) {
  const clock = new FakeClock()
  const errors: unknown[] = []
  const sockets = new MockTextSocketTransport()
  const backend = new MonsterPartyBackend({
    clock,
    sockets,
    sessionToken: TOKEN,
    userAgent: 'test-agent/1.0',
    fetch: okSession(),
    onError: error => { errors.push(error) },
    ...overrides,
  })
  return { clock, sockets, backend, errors }
}

/** Wait until the join frame has gone out and the handshake listener is armed. */
async function armed(sockets: MockTextSocketTransport): Promise<MockTextSocket> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (sockets.socket !== undefined && sockets.socket.sent.length > 0) break
    await tick()
  }
  const socket = sockets.socket
  if (socket === undefined) throw new Error('socket never opened')
  await tick()
  return socket
}

async function connected(h: ReturnType<typeof harness>, pid = SINGLE_MOTOR_PID): Promise<MockTextSocket> {
  const promise = h.backend.connect(signal())
  const socket = await armed(h.sockets)
  socket.emit({ op: 6, sender: { fd: 12_296 } })
  socket.emit({ op: 15, conn: true, pid })
  await promise
  return socket
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

describe('MonsterParty session resolution', () => {
  it('sends the share token as a query parameter with the configured user agent', async () => {
    const seen: { url: string; headers?: Readonly<Record<string, string>> }[] = []
    const h = harness({
      fetch: stubFetch((url, init) => {
        seen.push({ url, ...(init?.headers === undefined ? {} : { headers: init.headers }) })
        return { body: { errNo: 0, data: { socket_url: SOCKET_URL, id: 1, user_id: 2 } } }
      }),
    })
    await connected(h)

    expect(seen[0]?.url).toContain(`s=${TOKEN}`)
    expect(seen[0]?.headers?.['User-Agent']).toBe('test-agent/1.0')
  })

  it('explains an expired token instead of just reporting an error code', async () => {
    const h = harness({ fetch: stubFetch(() => ({ body: { errNo: -1 } })) })
    const error = await safetyErrorFrom(h.backend.connect(signal()))
    expect(error.message).toContain('errNo -1')
    // Tokens are single-use in practice, so the message has to say so.
    expect(error.message).toMatch(/single-use|fresh link/)
  })

  it('reports a bad HTTP status and a malformed body distinctly', async () => {
    const bad = harness({ fetch: stubFetch(() => ({ status: 502, body: {} })) })
    expect((await safetyErrorFrom(bad.backend.connect(signal()))).message).toContain('HTTP 502')

    const empty = harness({ fetch: stubFetch(() => ({ body: { data: {} } })) })
    expect((await safetyErrorFrom(empty.backend.connect(signal()))).message).toContain('socket_url')
  })

  it('never lets the share token reach an error message', async () => {
    // A network error commonly quotes the request URL, and the URL carries the
    // token. Anything a model can read must not contain it.
    const h = harness({
      fetch: stubFetch(url => new Error(`connect ECONNREFUSED for ${url}`)),
    })
    const error = await safetyErrorFrom(h.backend.connect(signal()))
    expect(error.message).not.toContain(TOKEN)
    expect(error.message).toContain('<token>')
  })
})

describe('MonsterParty relay handshake', () => {
  it('opens the socket with the Origin the relay requires', async () => {
    const h = harness()
    await connected(h)
    expect(h.sockets.opens[0]?.url).toBe(SOCKET_URL)
    expect(h.sockets.opens[0]?.headers?.Origin).toBe(MONSTERPARTY_ORIGIN)
  })

  it('joins with the session and user ids from the API', async () => {
    const h = harness({
      fetch: stubFetch(() => ({ body: { data: { socket_url: SOCKET_URL, id: 'sess-9', user_id: 'user-4' } } })),
    })
    const socket = await connected(h)
    expect(socket.sentJson[0]).toMatchObject({ op: 2, remoteID: 'sess-9', senderID: 'user-4' })
  })

  it('waits for both the sender fd and the device report', async () => {
    const h = harness()
    let settled = false
    const promise = h.backend.connect(signal()).then(() => { settled = true })
    const socket = await armed(h.sockets)

    socket.emit({ op: 6, sender: { fd: 1 } })
    await tick()
    expect(settled).toBe(false)

    socket.emit({ op: 15, conn: true, pid: SINGLE_MOTOR_PID })
    await promise
    expect(settled).toBe(true)
  })

  it('gives up with an actionable message when the toy never reports in', async () => {
    const h = harness({ readyTimeoutMs: 5_000 })
    const promise = h.backend.connect(signal())
    const socket = await armed(h.sockets)
    socket.emit({ op: 6, sender: { fd: 1 } })

    h.clock.advance(5_000)
    const error = await safetyErrorFrom(promise)
    expect(error.message).toMatch(/powered on/)
    expect(error.message).toMatch(/fresh share link/)
  })

  it('fails when the relay closes mid-handshake', async () => {
    const h = harness()
    const promise = h.backend.connect(signal())
    const socket = await armed(h.sockets)
    socket.simulateClose()
    expect((await safetyErrorFrom(promise)).message).toMatch(/closed before the toy became ready/)
  })

  it('surfaces a relay-side error code during the handshake', async () => {
    const h = harness()
    const promise = h.backend.connect(signal())
    const socket = await armed(h.sockets)
    socket.emit({ errNo: 42 })
    expect((await safetyErrorFrom(promise)).message).toContain('errNo 42')
  })
})

describe('MonsterParty capability detection', () => {
  it('exposes one channel for a single-motor toy', async () => {
    const h = harness()
    await connected(h, SINGLE_MOTOR_PID)
    expect(h.backend.channels.map(channel => channel.id)).toEqual(['vibration'])
    expect(h.backend.reportedProductId).toBe(SINGLE_MOTOR_PID)
  })

  it('exposes a suction channel only when the product id says DS', async () => {
    const h = harness()
    await connected(h, DUAL_MOTOR_PID)
    expect(h.backend.channels.map(channel => channel.id)).toEqual(['vibration', 'suction'])
  })

  it('refuses the suction channel on a single-motor toy', async () => {
    const h = harness()
    await connected(h, SINGLE_MOTOR_PID)
    const error = await safetyErrorFrom(h.backend.applyLevel('suction', 10))
    expect(error.code).toBe('UNKNOWN_CHANNEL')
    expect(error.message).toContain(SINGLE_MOTOR_PID)
  })

  it('picks the suck key type from the product id', async () => {
    const h = harness()
    const socket = await connected(h, DUAL_MOTOR_PID)
    await h.backend.applyLevel('vibration', 30)
    expect(socket.sentJson.at(-1)).toMatchObject({ keyType: 'suck' })

    const plain = harness()
    const plainSocket = await connected(plain, SINGLE_MOTOR_PID)
    await plain.backend.applyLevel('vibration', 30)
    expect(plainSocket.sentJson.at(-1)).toMatchObject({ keyType: 'vib' })
  })
})

describe('MonsterParty level frames', () => {
  it('fills all ten slots on a single-motor toy', async () => {
    const h = harness()
    const socket = await connected(h, SINGLE_MOTOR_PID)
    await h.backend.applyLevel('vibration', 42)

    const frame = socket.sentJson.at(-1)
    expect(frame).toMatchObject({ op: 3, fd: 12_296 })
    expect(frame?.vib).toEqual([42, 42, 42, 42, 42, 42, 42, 42, 42, 42])
  })

  it('maps slot 0 to suction and slots 1-4 to vibration on a dual-motor toy', async () => {
    const h = harness()
    const socket = await connected(h, DUAL_MOTOR_PID)
    await h.backend.applyLevel('vibration', 60)
    await h.backend.applyLevel('suction', 25)

    // Discovered by per-slot isolation in the reference reverse engineering.
    expect(socket.sentJson.at(-1)?.vib).toEqual([25, 60, 60, 60, 60, 0, 0, 0, 0, 0])
  })

  it('holds the other motor steady when one changes', async () => {
    const h = harness()
    const socket = await connected(h, DUAL_MOTOR_PID)
    await h.backend.applyLevel('suction', 30)
    await h.backend.applyLevel('vibration', 10)
    expect(socket.sentJson.at(-1)?.vib).toEqual([30, 10, 10, 10, 10, 0, 0, 0, 0, 0])
  })

  it('clamps a level to whole percentages inside 0-100', async () => {
    const h = harness()
    const socket = await connected(h)
    await h.backend.applyLevel('vibration', 120)
    expect((socket.sentJson.at(-1)?.vib as number[])[0]).toBe(100)
    await h.backend.applyLevel('vibration', -5)
    expect((socket.sentJson.at(-1)?.vib as number[])[0]).toBe(0)
    await h.backend.applyLevel('vibration', 33.7)
    expect((socket.sentJson.at(-1)?.vib as number[])[0]).toBe(34)
  })

  it('drives both motors to zero on stopAll', async () => {
    const h = harness()
    const socket = await connected(h, DUAL_MOTOR_PID)
    await h.backend.applyLevel('vibration', 40)
    await h.backend.applyLevel('suction', 20)
    await h.backend.stopAll()
    expect(socket.sentJson.at(-1)?.vib).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 0])
  })
})

describe('MonsterParty liveness', () => {
  it('sends only the application heartbeat, never a protocol ping', async () => {
    const h = harness({ heartbeatIntervalMs: 9_000 })
    const socket = await connected(h)
    const before = socket.sent.length

    h.clock.advance(9_000)
    await tick()
    h.clock.advance(9_000)
    await tick()

    const beats = socket.sentJson.slice(before).filter(frame => frame.op === 8)
    expect(beats).toHaveLength(2)
    // The reference traced two-minute disconnects to a client-side protocol
    // ping, so op:8 must be the only keepalive.
    expect(socket.sentJson.slice(before).every(frame => frame.op === 8)).toBe(true)
  })

  it('treats a toy-offline report as link loss even while the socket stays up', async () => {
    const h = harness()
    const lost: number[] = []
    h.backend.onLinkLost(() => { lost.push(1) })
    const socket = await connected(h)

    socket.emit({ op: 15, conn: false })

    expect(lost).toHaveLength(1)
    expect(socket.open).toBe(true)
    expect((await safetyErrorFrom(h.backend.applyLevel('vibration', 10))).code).toBe('NOT_CONNECTED')
  })

  it('reports link loss when the relay drops the socket', async () => {
    const h = harness()
    const lost: number[] = []
    h.backend.onLinkLost(() => { lost.push(1) })
    const socket = await connected(h)

    socket.simulateClose(1006, 'relay gone')
    expect(lost).toHaveLength(1)
  })

  it('stops the heartbeat once the link is gone', async () => {
    const h = harness({ heartbeatIntervalMs: 1_000 })
    const socket = await connected(h)
    socket.emit({ op: 15, conn: false })
    const before = socket.sent.length
    h.clock.advance(10_000)
    await tick()
    expect(socket.sent.length).toBe(before)
  })

  it('zeroes output and closes the socket on close', async () => {
    const h = harness()
    const socket = await connected(h)
    await h.backend.applyLevel('vibration', 50)
    await h.backend.close()

    const frames = socket.sentJson.filter(frame => frame.op === 3)
    expect(frames.at(-1)?.vib).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 0])
    expect(socket.closeCount).toBe(1)
    expect(socket.open).toBe(false)
  })

  it('refuses a level before connect and explains the token lifecycle', async () => {
    const h = harness()
    const error = await safetyErrorFrom(h.backend.applyLevel('vibration', 10))
    expect(error.code).toBe('NOT_CONNECTED')
    expect(error.message).toMatch(/fresh link/)
  })

  it('requires a share token at construction', () => {
    const clock = new FakeClock()
    expect(() => new MonsterPartyBackend({
      clock,
      sockets: new MockTextSocketTransport(),
      sessionToken: '   ',
    })).toThrow(/share token is required/)
  })
})

describe('MonsterParty through the registry', () => {
  it('picks up the suction channel that only the handshake reveals', async () => {
    const clock = new FakeClock()
    const store = new MemoryAppendOnlyStore()
    const errors: unknown[] = []
    const audit = new AuditLog(store, clock, error => { errors.push(error) })
    const sockets = new MockTextSocketTransport()
    const registry = new DeviceRegistry({
      clock,
      audit,
      policy: new PolicyStore({ minPercent: 0, maxPercent: 40, maxWaveIntensity: 80, minFreq: 10, maxFreq: 240, maxDurationSec: 60 }),
      onError: error => { errors.push(error) },
      tickMs: 50,
    })
    const backend = new MonsterPartyBackend({ clock, sockets, sessionToken: TOKEN, fetch: okSession() })
    registry.register(backend)

    // Only one channel is known before the relay reports the product id.
    expect(registry.snapshot().devices[0]?.channels.map(channel => channel.id)).toEqual(['vibration'])

    const promise = registry.connect('monsterparty', signal())
    const socket = await armed(sockets)
    socket.emit({ op: 6, sender: { fd: 99 } })
    socket.emit({ op: 15, conn: true, pid: DUAL_MOTOR_PID })
    await promise

    const channels = registry.snapshot().devices[0]!.channels
    expect(channels.map(channel => channel.id)).toEqual(['vibration', 'suction'])
    // No waveform stage and a linear mapping from zero.
    expect(channels.every(channel => channel.supportsWaveform === false)).toBe(true)
    expect(channels.every(channel => channel.outputFloorPercent === 0)).toBe(true)

    const records = store.lines.map(line => JSON.parse(line) as AuditRecord)
    const connect = records.find(record => record.action === 'connect')
    expect(connect?.detail).toMatchObject({ channels: ['vibration', 'suction'] })

    await registry.runPattern('model', {
      deviceId: 'monsterparty',
      channelId: 'suction',
      envelope: { preset: 'steady', minPercent: 15, maxPercent: 15, periodMs: 1_000, jitter: 0 },
      durationSec: 20,
    })
    clock.advance(100)
    await registry.settled()
    expect(socket.sentJson.at(-1)?.vib).toEqual([15, 0, 0, 0, 0, 0, 0, 0, 0, 0])
  })
})
