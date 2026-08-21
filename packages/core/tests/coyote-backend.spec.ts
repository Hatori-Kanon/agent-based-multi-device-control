import { describe, expect, it } from 'vitest'
import {
  AuditLog,
  BF_LENGTH,
  B0_LENGTH,
  COYOTE_BLE_NAME,
  COYOTE_PLAIN_FRAME,
  COYOTE_SERVICE,
  COYOTE_WRITE_CHARACTERISTIC,
  CoyoteBackend,
  DeviceRegistry,
  FakeClock,
  MemoryAppendOnlyStore,
  MockBleTransport,
  PolicyStore,
  SafetyError,
  SILENT_INTENSITY,
  WaveformLibrary,
  compileWaveformScript,
  percentToStrength,
  type AuditRecord,
  type CoyoteBackendOptions,
  type MockBleWrite,
  type Waveform,
} from '../src/index.ts'

const WRITE_REF = { service: COYOTE_SERVICE, characteristic: COYOTE_WRITE_CHARACTERISTIC }

const MODE = { none: 0b00, increase: 0b01, decrease: 0b10, absolute: 0b11 } as const

interface DecodedB0 {
  head: number
  seq: number
  modeA: number
  modeB: number
  strengthA: number
  strengthB: number
  freqA: number[]
  intensityA: number[]
  freqB: number[]
  intensityB: number[]
}

function decodeB0(data: Uint8Array): DecodedB0 {
  const flags = data[1] ?? 0
  return {
    head: data[0] ?? 0,
    seq: (flags >> 4) & 0x0f,
    modeA: (flags >> 2) & 0x03,
    modeB: flags & 0x03,
    strengthA: data[2] ?? 0,
    strengthB: data[3] ?? 0,
    freqA: [...data.slice(4, 8)],
    intensityA: [...data.slice(8, 12)],
    freqB: [...data.slice(12, 16)],
    intensityB: [...data.slice(16, 20)],
  }
}

function signal(): AbortSignal {
  return new AbortController().signal
}

function harness(overrides: Partial<CoyoteBackendOptions> = {}) {
  const clock = new FakeClock()
  const errors: unknown[] = []
  const transport = new MockBleTransport({ clock, name: COYOTE_BLE_NAME, ...(overrides.transport ? {} : {}) })
  const backend = new CoyoteBackend({
    clock,
    transport,
    maxPercent: () => 40,
    maxWaveIntensity: () => 80,
    onError: error => { errors.push(error) },
    ...overrides,
  })
  return { clock, transport, backend, errors }
}

function b0Writes(writes: readonly MockBleWrite[]): DecodedB0[] {
  return writes.filter(write => write.data.length === B0_LENGTH).map(write => decodeB0(write.data))
}

function bfWrites(writes: readonly MockBleWrite[]): MockBleWrite[] {
  return writes.filter(write => write.data.length === BF_LENGTH)
}

function twoFrameWaveform(): Waveform {
  const compiled = compileWaveformScript({
    name: 'pair',
    segments: [
      { ms: 100, freq: 30, intensity: 100, curve: 'step' },
      { ms: 100, freq: 60, intensity: 40, curve: 'step' },
    ],
  })
  return { id: 'pair', name: 'pair', frames: compiled.frames, loop: true, source: 'authored', tags: [] }
}

describe('Coyote connect handshake', () => {
  it('asks for the documented device and writes the hardware ceiling before anything else', async () => {
    const h = harness({ maxPercent: channel => (channel === 'a' ? 40 : 15) })
    await h.backend.connect(signal())
    await h.backend.settled()

    expect(h.transport.requests[0]?.name).toBe(COYOTE_BLE_NAME)
    expect(h.transport.requests[0]?.services).toContain(COYOTE_SERVICE)

    const writes = h.transport.peripheral!.writesTo(WRITE_REF)
    // BF first, then the frame stream.
    expect(writes[0]?.data).toHaveLength(BF_LENGTH)
    expect(writes[0]?.withoutResponse).toBe(false)
    expect(writes[0]?.data[1]).toBe(percentToStrength(40))
    expect(writes[0]?.data[2]).toBe(percentToStrength(15))
    expect(writes[1]?.data).toHaveLength(B0_LENGTH)
    // The frame stream does not wait for a GATT acknowledgement.
    expect(writes[1]?.withoutResponse).toBe(true)
  })

  it('refuses to become controllable when the ceiling cannot be written', async () => {
    const clock = new FakeClock()
    const transport = new MockBleTransport({
      clock,
      name: COYOTE_BLE_NAME,
      failWrite: (_ref, data) => (data.length === BF_LENGTH ? new Error('gatt write failed') : undefined),
    })
    const backend = new CoyoteBackend({
      clock,
      transport,
      maxPercent: () => 40,
      maxWaveIntensity: () => 80,
    })

    let caught: unknown
    try {
      await backend.connect(signal())
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(SafetyError)
    expect((caught as SafetyError).code).toBe('NOT_CONNECTED')
    expect((caught as SafetyError).message).toMatch(/refusing to drive/)
    expect(backend.streaming).toBe(false)
    // And it let the link go rather than sitting on a half-open connection.
    expect(transport.peripheral?.connected).toBe(false)

    clock.advance(1_000)
    expect(b0Writes(transport.peripheral!.writes)).toHaveLength(0)
  })

  it('asserts absolute zero on the first frame so a previous session cannot persist', async () => {
    const h = harness()
    await h.backend.connect(signal())
    await h.backend.settled()

    const first = b0Writes(h.transport.peripheral!.writes)[0]!
    expect(first.head).toBe(0xb0)
    expect(first.modeA).toBe(MODE.absolute)
    expect(first.modeB).toBe(MODE.absolute)
    expect(first.strengthA).toBe(0)
    expect(first.strengthB).toBe(0)
    expect(first.seq).toBeGreaterThan(0)
  })
})

describe('Coyote frame stream', () => {
  it('writes one frame per 100ms and stops the moment the stream stops', async () => {
    const h = harness()
    await h.backend.connect(signal())
    await h.backend.settled()
    const before = b0Writes(h.transport.peripheral!.writes).length

    for (let tick = 0; tick < 10; tick += 1) {
      h.clock.advance(100)
      await h.backend.settled()
    }
    const streamed = b0Writes(h.transport.peripheral!.writes).length - before
    expect(streamed).toBe(10)

    // Closing stops the stream; this is the hardware dead-man switch.
    await h.backend.close()
    const afterClose = b0Writes(h.transport.peripheral!.writes).length
    h.clock.advance(2_000)
    await h.backend.settled()
    expect(b0Writes(h.transport.peripheral!.writes).length).toBe(afterClose)
  })

  it('sends an absolute strength once and then falls silent about it', async () => {
    const h = harness()
    await h.backend.connect(signal())
    await h.backend.settled()
    const peripheral = h.transport.peripheral!

    // Acknowledge the initial zero so the baseline is established.
    const firstSeq = b0Writes(peripheral.writes)[0]!.seq
    peripheral.notify({ service: COYOTE_SERVICE, characteristic: '0000150b-0000-1000-8000-00805f9b34fb' }, Uint8Array.from([0xb1, firstSeq, 0, 0]))

    h.clock.advance(100)
    await h.backend.settled()
    const settled = b0Writes(peripheral.writes).at(-1)!
    expect(settled.modeA).toBe(MODE.none)
    expect(settled.seq).toBe(0)

    await h.backend.applyLevel('a', 30)
    h.clock.advance(100)
    await h.backend.settled()
    const change = b0Writes(peripheral.writes).at(-1)!
    expect(change.modeA).toBe(MODE.absolute)
    expect(change.strengthA).toBe(percentToStrength(30))
    expect(change.seq).toBeGreaterThan(0)
    // B is untouched, so it must not be re-asserted.
    expect(change.modeB).toBe(MODE.none)
  })

  it('composes both channels into a single frame', async () => {
    const h = harness()
    await h.backend.connect(signal())
    await h.backend.applyLevel('a', 30)
    await h.backend.applyLevel('b', 10)
    h.clock.advance(100)
    await h.backend.settled()

    const frame = b0Writes(h.transport.peripheral!.writes).at(-1)!
    expect(frame.strengthA).toBe(percentToStrength(30))
    expect(frame.strengthB).toBe(percentToStrength(10))
    // One 20-byte write carries both, which is why keep-alive cannot live in
    // the per-channel effect scheduler.
    expect(h.transport.peripheral!.writesTo(WRITE_REF).at(-1)?.data).toHaveLength(B0_LENGTH)
  })
})

describe('Coyote waveform stage', () => {
  it('streams waveform frames in order and clamps intensity without touching frequency', async () => {
    const h = harness({ maxWaveIntensity: () => 70 })
    await h.backend.connect(signal())
    await h.backend.applyWaveform('a', twoFrameWaveform())
    await h.backend.applyLevel('a', 30)

    const seen: DecodedB0[] = []
    for (let tick = 0; tick < 4; tick += 1) {
      h.clock.advance(100)
      await h.backend.settled()
      seen.push(b0Writes(h.transport.peripheral!.writes).at(-1)!)
    }

    // Frame 0 of the waveform is intensity 100, clamped to the 70 cap.
    expect(seen[0]?.intensityA).toEqual([70, 70, 70, 70])
    expect(seen[0]?.freqA).toEqual([30, 30, 30, 30])
    // Frame 1 is intensity 40, already under the cap.
    expect(seen[1]?.intensityA).toEqual([40, 40, 40, 40])
    expect(seen[1]?.freqA).toEqual([60, 60, 60, 60])
    // And it loops.
    expect(seen[2]?.intensityA).toEqual([70, 70, 70, 70])
    expect(seen[3]?.intensityA).toEqual([40, 40, 40, 40])
  })

  it('uses a plain texture when a level is set with no waveform chosen', async () => {
    const h = harness()
    await h.backend.connect(signal())
    await h.backend.applyLevel('a', 30)
    h.clock.advance(100)
    await h.backend.settled()

    // Strength alone produces nothing on this hardware, so a default texture is
    // required or set_level would silently do nothing.
    const frame = b0Writes(h.transport.peripheral!.writes).at(-1)!
    expect(frame.intensityA).toEqual([...COYOTE_PLAIN_FRAME.intensity])
    expect(frame.freqA).toEqual([...COYOTE_PLAIN_FRAME.freq])
  })

  it('sends the vendor silence sentinel for an idle channel', async () => {
    const h = harness()
    await h.backend.connect(signal())
    await h.backend.applyLevel('a', 30)
    h.clock.advance(100)
    await h.backend.settled()

    const frame = b0Writes(h.transport.peripheral!.writes).at(-1)!
    expect(frame.intensityB).toEqual([...SILENT_INTENSITY])
  })

  it('restarts a waveform from its beginning when output resumes', async () => {
    const h = harness({ maxWaveIntensity: () => 100 })
    await h.backend.connect(signal())
    await h.backend.applyWaveform('a', twoFrameWaveform())
    await h.backend.applyLevel('a', 30)
    h.clock.advance(100)
    await h.backend.settled()
    expect(b0Writes(h.transport.peripheral!.writes).at(-1)?.intensityA).toEqual([100, 100, 100, 100])

    // Idle for a while, then resume: the cursor must not have drifted.
    await h.backend.applyLevel('a', 0)
    h.clock.advance(500)
    await h.backend.settled()
    await h.backend.applyLevel('a', 30)
    h.clock.advance(100)
    await h.backend.settled()
    expect(b0Writes(h.transport.peripheral!.writes).at(-1)?.intensityA).toEqual([40, 40, 40, 40])
  })
})

describe('Coyote physical wheel', () => {
  const NOTIFY = { service: COYOTE_SERVICE, characteristic: '0000150b-0000-1000-8000-00805f9b34fb' }

  it('ignores an uncommanded strength change and re-asserts the commanded target', async () => {
    const h = harness()
    await h.backend.connect(signal())
    await h.backend.settled()
    const peripheral = h.transport.peripheral!

    // Acknowledge our own zero so the box knows the baseline.
    const firstSeq = b0Writes(peripheral.writes)[0]!.seq
    peripheral.notify(NOTIFY, Uint8Array.from([0xb1, firstSeq, 0, 0]))

    await h.backend.applyLevel('a', 30)
    h.clock.advance(100)
    await h.backend.settled()
    const commanded = b0Writes(peripheral.writes).at(-1)!
    peripheral.notify(NOTIFY, Uint8Array.from([0xb1, commanded.seq, commanded.strengthA, 0]))

    // The operator turns the wheel: sequence 0, a value we did not command.
    // The wheel is no longer adopted — the stream stays in charge.
    peripheral.notify(NOTIFY, Uint8Array.from([0xb1, 0, 40, 0]))

    h.clock.advance(100)
    await h.backend.settled()
    const frame = b0Writes(peripheral.writes).at(-1)!
    expect(frame.modeA).toBe(MODE.absolute)
    expect(frame.strengthA).toBe(percentToStrength(30))
  })

  it('ignores a stale level report and drives it to zero', async () => {
    const h = harness()
    await h.backend.connect(signal())
    await h.backend.settled()
    const peripheral = h.transport.peripheral!

    // A box still holding 50 from a previous session reports it with seq 0.
    peripheral.notify(NOTIFY, Uint8Array.from([0xb1, 0, 100, 0]))

    h.clock.advance(100)
    await h.backend.settled()
    // We must drive it to zero, not adopt it.
    const frame = b0Writes(peripheral.writes).at(-1)!
    expect(frame.modeA).toBe(MODE.absolute)
    expect(frame.strengthA).toBe(0)
  })
})

describe('Coyote bounds and link loss', () => {
  it('rewrites the persisted ceiling when asked', async () => {
    let cap = 40
    const h = harness({ maxPercent: () => cap })
    await h.backend.connect(signal())
    await h.backend.settled()
    expect(bfWrites(h.transport.peripheral!.writes)).toHaveLength(1)

    cap = 15
    await h.backend.applyBounds('a')
    const caps = bfWrites(h.transport.peripheral!.writes)
    expect(caps).toHaveLength(2)
    expect(caps[1]?.data[1]).toBe(percentToStrength(15))
  })

  it('reports link loss and stops streaming', async () => {
    const h = harness()
    const lost: number[] = []
    h.backend.onLinkLost(() => { lost.push(h.clock.now()) })
    await h.backend.connect(signal())
    await h.backend.settled()

    h.transport.peripheral!.simulateDisconnect()
    expect(lost).toHaveLength(1)
    expect(h.backend.streaming).toBe(false)

    const before = h.transport.peripheral!.writes.length
    h.clock.advance(1_000)
    await h.backend.settled()
    expect(h.transport.peripheral!.writes.length).toBe(before)
  })

  it('declares the link lost after repeated write failures', async () => {
    const clock = new FakeClock()
    let failFrames = false
    const transport = new MockBleTransport({
      clock,
      name: COYOTE_BLE_NAME,
      failWrite: (_ref, data) => (failFrames && data.length === B0_LENGTH ? new Error('link stalled') : undefined),
    })
    const errors: unknown[] = []
    const backend = new CoyoteBackend({
      clock,
      transport,
      maxPercent: () => 40,
      maxWaveIntensity: () => 80,
      onError: error => { errors.push(error) },
    })
    const lost: string[] = []
    backend.onLinkLost(() => { lost.push('lost') })

    await backend.connect(signal())
    await backend.settled()
    failFrames = true
    for (let tick = 0; tick < 6; tick += 1) {
      clock.advance(100)
      await backend.settled()
    }

    expect(errors.length).toBeGreaterThanOrEqual(5)
    expect(lost).toHaveLength(1)
    expect(backend.streaming).toBe(false)
  })

  it('refuses commands before connect and after link loss', async () => {
    const h = harness()
    await expect(h.backend.applyLevel('a', 10)).rejects.toBeInstanceOf(SafetyError)
    await h.backend.connect(signal())
    await expect(h.backend.applyLevel('a', 10)).resolves.toBeUndefined()
    h.transport.peripheral!.simulateDisconnect()
    await expect(h.backend.applyLevel('a', 10)).rejects.toBeInstanceOf(SafetyError)
  })

  it('rejects an unknown channel by name', async () => {
    const h = harness()
    await h.backend.connect(signal())
    await expect(h.backend.applyLevel('c', 10)).rejects.toThrow(/channels "a" and "b"/)
  })
})

describe('Coyote through the registry', () => {
  function registryHarness() {
    const clock = new FakeClock()
    const store = new MemoryAppendOnlyStore()
    const errors: unknown[] = []
    const audit = new AuditLog(store, clock, error => { errors.push(error) })
    const policy = new PolicyStore({ maxPercent: 40, maxWaveIntensity: 80, maxDurationSec: 60 })
    const waveforms = new WaveformLibrary()
    const transport = new MockBleTransport({ clock, name: COYOTE_BLE_NAME })
    const registry = new DeviceRegistry({
      clock,
      audit,
      policy,
      waveforms,
      onError: error => { errors.push(error) },
      tickMs: 50,
      random: () => 0.5,
    })
    const backend = new CoyoteBackend({
      clock,
      transport,
      maxPercent: channel => policy.get('coyote', channel).maxPercent,
      maxWaveIntensity: channel => policy.get('coyote', channel).maxWaveIntensity,
      onError: error => { errors.push(error) },
    })
    registry.register(backend)
    return {
      clock,
      registry,
      backend,
      transport,
      policy,
      waveforms,
      errors,
      records: (): AuditRecord[] => store.lines.map(line => JSON.parse(line) as AuditRecord),
    }
  }

  it('runs different patterns and waveforms on A and B, cancellable independently', async () => {
    const h = registryHarness()
    await h.registry.connect('coyote', signal())

    await h.registry.runPattern('model', {
      deviceId: 'coyote',
      channelId: 'a',
      envelope: { preset: 'steady', minPercent: 30, maxPercent: 30, periodMs: 1_000, jitter: 0 },
      durationSec: 30,
      waveformId: 'breathing',
    })
    await h.registry.runPattern('model', {
      deviceId: 'coyote',
      channelId: 'b',
      envelope: { preset: 'wave', minPercent: 5, maxPercent: 20, periodMs: 2_000, jitter: 0 },
      durationSec: 30,
      waveformId: 'staccato',
    })

    h.clock.advance(100)
    await h.registry.settled()
    await h.backend.settled()

    let snapshot = h.registry.snapshot()
    let channels = snapshot.devices[0]!.channels
    expect(channels[0]?.waveform?.id).toBe('breathing')
    expect(channels[1]?.waveform?.id).toBe('staccato')
    expect(channels[0]?.effect?.preset).toBe('steady')
    expect(channels[1]?.effect?.preset).toBe('wave')
    expect(channels[0]?.percent).toBe(30)
    expect(channels[0]?.supportsWaveform).toBe(true)

    // Cancelling A must leave B running.
    await h.registry.stop('model', 'coyote', 'a')
    await h.registry.settled()
    await h.backend.settled()

    snapshot = h.registry.snapshot()
    channels = snapshot.devices[0]!.channels
    expect(channels[0]?.effect).toBeUndefined()
    expect(channels[0]?.percent).toBe(0)
    expect(channels[1]?.effect?.preset).toBe('wave')
    expect(channels[1]?.percent).toBeGreaterThan(0)
  })

  it('clamps an agent-authored waveform to the channel cap', async () => {
    const h = registryHarness()
    await h.registry.connect('coyote', signal())
    await h.policy.setByHuman('coyote', 'a', { maxWaveIntensity: 45 })

    const authored = h.waveforms.author({
      name: 'hot',
      segments: [{ ms: 100, freq: 20, intensity: 100, curve: 'step' }],
    })
    await h.registry.runPattern('model', {
      deviceId: 'coyote',
      channelId: 'a',
      envelope: { preset: 'steady', minPercent: 30, maxPercent: 30, periodMs: 1_000, jitter: 0 },
      durationSec: 30,
      waveformId: authored.id,
    })

    h.clock.advance(100)
    await h.registry.settled()
    await h.backend.settled()

    const frame = b0Writes(h.transport.peripheral!.writes).at(-1)!
    expect(frame.intensityA).toEqual([45, 45, 45, 45])
  })

  it('re-asserts the hardware ceiling when a human moves the cap', async () => {
    const h = registryHarness()
    await h.registry.connect('coyote', signal())
    await h.backend.settled()
    expect(bfWrites(h.transport.peripheral!.writes)).toHaveLength(1)

    await h.registry.setPolicyByHuman('coyote', 'a', { maxPercent: 12 })
    await h.registry.settled()

    const caps = bfWrites(h.transport.peripheral!.writes)
    expect(caps).toHaveLength(2)
    expect(caps[1]?.data[1]).toBe(percentToStrength(12))
    expect(h.records().some(record => record.action === 'policy_change')).toBe(true)
  })

  it('marks the device unavailable and zeroes state when the link drops', async () => {
    const h = registryHarness()
    await h.registry.connect('coyote', signal())
    await h.registry.runPattern('model', {
      deviceId: 'coyote',
      channelId: 'a',
      envelope: { preset: 'steady', minPercent: 30, maxPercent: 30, periodMs: 1_000, jitter: 0 },
      durationSec: 30,
      waveformId: 'breathing',
    })
    h.clock.advance(100)
    await h.registry.settled()
    await h.backend.settled()
    expect(h.registry.snapshot().devices[0]?.lifecycle).toBe('ready')

    h.transport.peripheral!.simulateDisconnect()

    const snapshot = h.registry.snapshot()
    expect(snapshot.devices[0]?.lifecycle).toBe('failed')
    const channel = snapshot.devices[0]!.channels[0]!
    expect(channel.percent).toBe(0)
    expect(channel.effect).toBeUndefined()
    expect(channel.waveform).toBeUndefined()
    expect(h.records().some(record => record.action === 'link_lost')).toBe(true)

    // Further model commands are refused rather than swallowed.
    await expect(h.registry.runPattern('model', {
      deviceId: 'coyote',
      channelId: 'a',
      envelope: { preset: 'steady', minPercent: 10, maxPercent: 10, periodMs: 1_000, jitter: 0 },
      durationSec: 10,
    })).rejects.toBeInstanceOf(SafetyError)
  })

  it('refuses a waveform on a channel that has no waveform stage', async () => {
    const h = registryHarness()
    await h.registry.connect('coyote', signal())
    await expect(h.registry.setWaveform('model', 'coyote', 'a', 'no-such-waveform'))
      .rejects.toMatchObject({ code: 'UNKNOWN_WAVEFORM' })
  })
})
