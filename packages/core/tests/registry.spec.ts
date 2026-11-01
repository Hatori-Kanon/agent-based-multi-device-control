import { describe, expect, it } from 'vitest'
import {
  AuditLog,
  DeviceRegistry,
  FakeClock,
  MemoryAppendOnlyStore,
  MockBackend,
  PolicyStore,
  SafetyError,
  WaveformLibrary,
  type AuditRecord,
  type Channel,
  type ChannelPolicy,
  type Envelope,
} from '../src/index.ts'

const CHANNELS: readonly Channel[] = [
  { id: 'a', kind: 'level', label: 'A 通道' },
  { id: 'b', kind: 'level', label: 'B 通道' },
]

function steady(percent: number): Envelope {
  return { preset: 'steady', minPercent: percent, maxPercent: percent, periodMs: 1_000, jitter: 0 }
}

function signal(): AbortSignal {
  return new AbortController().signal
}

/** Capture a rejection without letting an assertion helper swallow it. */
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

/**
 * Explicit policy so these tests describe behaviour rather than tracking the
 * shipped default, which is deliberately lower than anything asserted here.
 */
const TEST_POLICY: ChannelPolicy = { maxPercent: 40, maxWaveIntensity: 80, maxDurationSec: 60 }

function createHarness(options?: { keepAliveMs?: number; policy?: ChannelPolicy }) {
  const clock = new FakeClock()
  const store = new MemoryAppendOnlyStore()
  const errors: unknown[] = []
  const audit = new AuditLog(store, clock, error => { errors.push(error) })
  const policy = new PolicyStore(options?.policy ?? TEST_POLICY)
  const registry = new DeviceRegistry({
    clock,
    audit,
    policy,
    onError: error => { errors.push(error) },
    tickMs: 50,
    random: () => 0.5,
  })
  const toy = new MockBackend({
    id: 'toy',
    name: 'Mock Toy',
    clock,
    channels: CHANNELS,
    ...(options?.keepAliveMs === undefined ? {} : { keepAliveMs: options.keepAliveMs }),
  })
  registry.register(toy)
  return {
    clock,
    errors,
    policy,
    registry,
    toy,
    records: (): AuditRecord[] => store.lines.map(line => JSON.parse(line) as AuditRecord),
  }
}

describe('policy is enforced before the transport is touched', () => {
  it('refuses a level above the human cap and writes nothing', async () => {
    const h = createHarness()
    await h.registry.connect('toy', signal())
    const before = h.toy.writes.length

    const error = await safetyErrorFrom(
      h.registry.setLevel('model', { deviceId: 'toy', channelId: 'a', percent: 80, durationSec: 5 }),
    )
    expect(error.code).toBe('POLICY_PERCENT')
    expect(error.message).toContain('40')

    await h.registry.settled()
    expect(h.toy.writes.length).toBe(before)
    expect(h.toy.deviceLevel('a')).toBe(0)

    const rejected = h.records().find(record => record.action === 'set_level' && record.result === 'rejected')
    expect(rejected?.reason).toContain('POLICY_PERCENT')
  })

  it('refuses indefinite output', async () => {
    const h = createHarness()
    await h.registry.connect('toy', signal())
    const error = await safetyErrorFrom(
      h.registry.setLevel('model', { deviceId: 'toy', channelId: 'a', percent: 20 }),
    )
    expect(error.code).toBe('POLICY_DURATION')
    expect(error.message).toMatch(/indefinite/)
  })

  it('plays authored patterns inside the cap instead of refusing them', async () => {
    const h = createHarness()
    await h.registry.connect('toy', signal())
    await h.registry.setPolicyByHuman('toy', 'a', { maxPercent: 10 })

    // An envelope that asks for 30 on a 10-capped channel runs at 10: the cap
    // is the human's boundary, so authored content is tightened to it.
    await h.registry.runPattern('model', { deviceId: 'toy', channelId: 'a', envelope: steady(30), durationSec: 5 })
    h.clock.advance(50)
    await h.registry.settled()
    expect(h.toy.deviceLevel('a')).toBe(10)

    // The sibling channel still has the default cap.
    await h.registry.runPattern('model', { deviceId: 'toy', channelId: 'b', envelope: steady(30), durationSec: 5 })
    h.clock.advance(50)
    await h.registry.settled()
    expect(h.toy.deviceLevel('b')).toBe(30)

    // The audit note records what actually ran: the clamped envelope.
    const run = h.records().find(record => record.action === 'run_pattern' && record.result === 'ok')
    expect(run?.detail?.envelope).toMatchObject({ minPercent: 10, maxPercent: 10 })

    const change = h.records().find(record => record.action === 'policy_change')
    expect(change?.actor).toBe('human')
  })

  it('makes a mid-session cap change take effect in both directions', async () => {
    const h = createHarness()
    await h.registry.connect('toy', signal())
    await h.registry.runPattern('model', { deviceId: 'toy', channelId: 'a', envelope: steady(40), durationSec: 60 })
    h.clock.advance(50)
    await h.registry.settled()
    expect(h.toy.deviceLevel('a')).toBe(40)

    // Lowering must bite immediately, not at the next value change. A steady
    // envelope emits nothing on its own, so this is only true because the
    // registry re-writes through the clamping path on a policy change.
    await h.registry.setPolicyByHuman('toy', 'a', { maxPercent: 15 })
    await h.registry.settled()
    expect(h.toy.deviceLevel('a')).toBe(15)

    // Raising it again lets the running effect return to its requested level.
    await h.registry.setPolicyByHuman('toy', 'a', { maxPercent: 40 })
    h.clock.advance(50)
    await h.registry.settled()
    expect(h.toy.deviceLevel('a')).toBe(40)
  })

  it('rejects unknown devices and channels', async () => {
    const h = createHarness()
    await h.registry.connect('toy', signal())
    expect((await safetyErrorFrom(
      h.registry.setLevel('model', { deviceId: 'nope', channelId: 'a', percent: 10, durationSec: 5 }),
    )).code).toBe('UNKNOWN_DEVICE')
    expect((await safetyErrorFrom(
      h.registry.setLevel('model', { deviceId: 'toy', channelId: 'nope', percent: 10, durationSec: 5 }),
    )).code).toBe('UNKNOWN_CHANNEL')
  })

  it('refuses commands before the device is connected', async () => {
    const h = createHarness()
    expect((await safetyErrorFrom(
      h.registry.setLevel('model', { deviceId: 'toy', channelId: 'a', percent: 10, durationSec: 5 }),
    )).code).toBe('NOT_CONNECTED')
  })
})

describe('emergency stop latches until a human clears it', () => {
  it('zeroes output, blocks model writes, still allows stops, and reopens on unlock', async () => {
    const h = createHarness()
    await h.registry.connect('toy', signal())
    await h.registry.runPattern('model', { deviceId: 'toy', channelId: 'a', envelope: steady(30), durationSec: 60 })
    h.clock.advance(50)
    await h.registry.settled()
    expect(h.toy.deviceLevel('a')).toBe(30)

    await h.registry.emergencyStop('hotkey')
    await h.registry.settled()
    expect(h.registry.isLocked).toBe(true)
    expect(h.toy.deviceLevel('a')).toBe(0)
    expect(h.toy.outputting).toBe(false)

    expect((await safetyErrorFrom(
      h.registry.setLevel('model', { deviceId: 'toy', channelId: 'a', percent: 20, durationSec: 5 }),
    )).code).toBe('LOCKED')
    expect((await safetyErrorFrom(
      h.registry.runPattern('model', { deviceId: 'toy', channelId: 'a', envelope: steady(20), durationSec: 5 }),
    )).code).toBe('LOCKED')

    // A stop is always available; refusing it would be absurd.
    await h.registry.stop('model', 'toy', 'a')
    await h.registry.settled()
    expect(h.toy.deviceLevel('a')).toBe(0)

    const audit = h.records()
    expect(audit.some(record => record.action === 'panic' && record.actor === 'human')).toBe(true)
    expect(audit.filter(record => record.action === 'set_level' && record.result === 'rejected')).toHaveLength(1)

    await h.registry.unlock('human', 'operator cleared')
    expect(h.registry.isLocked).toBe(false)
    await h.registry.setLevel('model', { deviceId: 'toy', channelId: 'a', percent: 20, durationSec: 5 })
    h.clock.advance(50)
    await h.registry.settled()
    expect(h.toy.deviceLevel('a')).toBe(20)
    expect(h.records().some(record => record.action === 'unlock')).toBe(true)
  })

  it('does not let a write queued before the latch resurrect output', async () => {
    const gate = { release: undefined as (() => void) | undefined }
    const clock = new FakeClock()
    const store = new MemoryAppendOnlyStore()
    const errors: unknown[] = []
    const audit = new AuditLog(store, clock, error => { errors.push(error) })
    const policy = new PolicyStore(TEST_POLICY)
    const registry = new DeviceRegistry({ clock, audit, policy, onError: error => { errors.push(error) }, tickMs: 50 })

    let blockNext = false
    const toy = new MockBackend({
      id: 'toy',
      clock,
      channels: CHANNELS,
      failOnApply: () => undefined,
    })
    // Wrap applyLevel so one write can be held open across the panic.
    const original = toy.applyLevel.bind(toy)
    toy.applyLevel = async (channelId: string, percent: number): Promise<void> => {
      if (blockNext) {
        blockNext = false
        await new Promise<void>(resolve => { gate.release = resolve })
      }
      await original(channelId, percent)
    }

    registry.register(toy)
    await registry.connect('toy', signal())

    blockNext = true
    await registry.runPattern('model', { deviceId: 'toy', channelId: 'a', envelope: steady(30), durationSec: 60 })
    const panic = registry.emergencyStop('hotkey')
    gate.release?.()
    await panic
    await registry.settled()

    expect(toy.deviceLevel('a')).toBe(0)
    expect(toy.outputting).toBe(false)
  })
})

describe('generation tokens keep a stale effect from stopping a live one', () => {
  it('survives replacing an effect just before its deadline', async () => {
    const h = createHarness()
    await h.registry.connect('toy', signal())

    await h.registry.runPattern('model', { deviceId: 'toy', channelId: 'a', envelope: steady(30), durationSec: 1 })
    h.clock.advance(950)
    await h.registry.settled()
    expect(h.toy.deviceLevel('a')).toBe(30)

    await h.registry.runPattern('model', { deviceId: 'toy', channelId: 'a', envelope: steady(35), durationSec: 30 })
    h.clock.advance(300)
    await h.registry.settled()

    expect(h.toy.deviceLevel('a')).toBe(35)
  })

  it('re-writes the same level after a stop', async () => {
    const h = createHarness()
    await h.registry.connect('toy', signal())

    await h.registry.runPattern('model', { deviceId: 'toy', channelId: 'a', envelope: steady(30), durationSec: 30 })
    h.clock.advance(50)
    await h.registry.settled()
    expect(h.toy.deviceLevel('a')).toBe(30)

    await h.registry.stop('model', 'toy', 'a')
    await h.registry.settled()
    expect(h.toy.deviceLevel('a')).toBe(0)

    await h.registry.runPattern('model', { deviceId: 'toy', channelId: 'a', envelope: steady(30), durationSec: 30 })
    h.clock.advance(50)
    await h.registry.settled()
    expect(h.toy.deviceLevel('a')).toBe(30)
  })
})

describe('devices run in parallel and cancel independently', () => {
  it('keeps one channel running while another is stopped', async () => {
    const h = createHarness()
    const other = new MockBackend({ id: 'other', name: 'Other', clock: h.clock })
    h.registry.register(other)
    await h.registry.connect('toy', signal())
    await h.registry.connect('other', signal())

    await h.registry.runPattern('model', { deviceId: 'toy', channelId: 'a', envelope: steady(30), durationSec: 30 })
    await h.registry.runPattern('model', { deviceId: 'toy', channelId: 'b', envelope: steady(25), durationSec: 30 })
    await h.registry.runPattern('model', { deviceId: 'other', channelId: 'main', envelope: steady(20), durationSec: 30 })
    h.clock.advance(50)
    await h.registry.settled()

    expect(h.toy.deviceLevel('a')).toBe(30)
    expect(h.toy.deviceLevel('b')).toBe(25)
    expect(other.deviceLevel('main')).toBe(20)

    await h.registry.stop('model', 'toy', 'a')
    await h.registry.settled()

    expect(h.toy.deviceLevel('a')).toBe(0)
    expect(h.toy.deviceLevel('b')).toBe(25)
    expect(other.deviceLevel('main')).toBe(20)

    const snapshot = h.registry.snapshot()
    const toySnapshot = snapshot.devices.find(device => device.id === 'toy')
    expect(toySnapshot?.channels.find(channel => channel.id === 'a')?.effect).toBeUndefined()
    expect(toySnapshot?.channels.find(channel => channel.id === 'b')?.effect?.preset).toBe('steady')
  })

  it('stops everything when no target is named', async () => {
    const h = createHarness()
    const other = new MockBackend({ id: 'other', clock: h.clock })
    h.registry.register(other)
    await h.registry.connect('toy', signal())
    await h.registry.connect('other', signal())
    await h.registry.runPattern('model', { deviceId: 'toy', channelId: 'a', envelope: steady(30), durationSec: 30 })
    await h.registry.runPattern('model', { deviceId: 'other', channelId: 'main', envelope: steady(20), durationSec: 30 })
    h.clock.advance(50)
    await h.registry.settled()

    await h.registry.stop('model')
    await h.registry.settled()

    expect(h.toy.outputting).toBe(false)
    expect(other.outputting).toBe(false)
  })
})

describe('hardware dead-man behaviour', () => {
  it('streaming hardware zeroes itself once the host stops refreshing', async () => {
    const h = createHarness({ keepAliveMs: 300 })
    expect(h.toy.isStreaming).toBe(true)
    await h.registry.connect('toy', signal())
    await h.registry.runPattern('model', { deviceId: 'toy', channelId: 'a', envelope: steady(30), durationSec: 60 })
    h.clock.advance(100)
    await h.registry.settled()
    expect(h.toy.deviceLevel('a')).toBe(30)

    // The backend's own refresh loop keeps it alive with no further commands.
    h.clock.advance(5_000)
    await h.registry.settled()
    expect(h.toy.deviceLevel('a')).toBe(30)

    // Abrupt host death: no graceful zero is ever written.
    h.toy.simulateHostDeath()
    h.clock.advance(301)
    expect(h.toy.deviceLevel('a')).toBe(0)
    expect(h.toy.outputting).toBe(false)
  })

  it('stateful hardware keeps outputting after host death, which is why a host-side timer is not enough', async () => {
    const h = createHarness()
    expect(h.toy.isStreaming).toBe(false)
    await h.registry.connect('toy', signal())
    await h.registry.runPattern('model', { deviceId: 'toy', channelId: 'a', envelope: steady(30), durationSec: 60 })
    h.clock.advance(100)
    await h.registry.settled()
    expect(h.toy.deviceLevel('a')).toBe(30)

    h.toy.simulateHostDeath()
    h.clock.advance(10_000)

    // Nothing zeroes this device. Only a firmware watchdog or a streaming
    // protocol can, which is why Coyote is the reference backend.
    expect(h.toy.deviceLevel('a')).toBe(30)
  })
})

describe('shutdown', () => {
  it('zeroes output, closes transports, and refuses later commands', async () => {
    const h = createHarness()
    await h.registry.connect('toy', signal())
    await h.registry.runPattern('model', { deviceId: 'toy', channelId: 'a', envelope: steady(30), durationSec: 30 })
    h.clock.advance(50)
    await h.registry.settled()

    await h.registry.shutdown()

    expect(h.toy.closeCount).toBe(1)
    expect(h.toy.deviceLevel('a')).toBe(0)
    expect((await safetyErrorFrom(
      h.registry.setLevel('model', { deviceId: 'toy', channelId: 'a', percent: 10, durationSec: 5 }),
    )).code).toBe('SHUTTING_DOWN')

    const audit = h.records()
    expect(audit.some(record => record.action === 'panic')).toBe(true)
    expect(audit.some(record => record.action === 'shutdown')).toBe(true)
  })

  it('is idempotent', async () => {
    const h = createHarness()
    await h.registry.connect('toy', signal())
    await h.registry.shutdown()
    await h.registry.shutdown()
    expect(h.toy.closeCount).toBe(1)
  })

  it('sends one raw frame for a human protocol experiment (audited)', async () => {
    const h = createHarness()
    await h.registry.connect('toy', signal())

    await h.registry.rawWrite('human', 'toy', 'AA080400280000DE')
    await h.registry.settled()
    expect([...h.toy.rawWrites[0]!]).toEqual([0xaa, 0x08, 0x04, 0x00, 0x28, 0x00, 0x00, 0xde])
    expect(h.records().some(record => record.action === 'raw_write' && record.result === 'ok')).toBe(true)

    expect((await safetyErrorFrom(
      h.registry.rawWrite('human', 'toy', 'bad-hex'),
    )).code).toBe('POLICY_ENVELOPE')

    await h.registry.emergencyStop('hotkey')
    expect((await safetyErrorFrom(
      h.registry.rawWrite('human', 'toy', 'AA080400280000DE'),
    )).code).toBe('LOCKED')
  })

  it('unregisters a device: stops output, closes the transport, forgets it', async () => {    const h = createHarness()
    await h.registry.connect('toy', signal())
    await h.registry.runPattern('model', { deviceId: 'toy', channelId: 'a', envelope: steady(30), durationSec: 60 })
    h.clock.advance(50)
    await h.registry.settled()
    expect(h.toy.deviceLevel('a')).toBe(30)

    await h.registry.unregister('toy')
    await h.registry.settled()
    expect(h.toy.deviceLevel('a')).toBe(0)
    expect(h.toy.closeCount).toBe(1)
    expect(h.registry.snapshot().devices.some(device => device.id === 'toy')).toBe(false)
    expect((await safetyErrorFrom(
      h.registry.setLevel('model', { deviceId: 'toy', channelId: 'a', percent: 10, durationSec: 5 }),
    )).code).toBe('UNKNOWN_DEVICE')
    expect(h.records().some(record => record.action === 'device_removed')).toBe(true)
  })
})

describe('audit trail', () => {
  it('records the actor, the action, and the reason for every refusal', async () => {
    const h = createHarness()
    await h.registry.connect('toy', signal())
    await h.registry.runPattern('model', { deviceId: 'toy', channelId: 'a', envelope: steady(30), durationSec: 5 })
    // Over-cap content now clamps; a malformed shape still refuses.
    await safetyErrorFrom(
      h.registry.runPattern('model', { deviceId: 'toy', channelId: 'a', envelope: { ...steady(30), preset: 'wobble' as never }, durationSec: 5 }),
    )
    await h.registry.settled()

    const audit = h.records()
    const accepted = audit.find(record => record.action === 'run_pattern' && record.result === 'ok')
    const refused = audit.find(record => record.action === 'run_pattern' && record.result === 'rejected')

    expect(accepted?.actor).toBe('model')
    expect(accepted?.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(refused?.reason).toContain('POLICY_ENVELOPE')
    // Records are only ever appended.
    expect(audit.length).toBeGreaterThanOrEqual(3)
  })

  it('survives a sink failure without breaking device control', async () => {
    const clock = new FakeClock()
    const failures: unknown[] = []
    const audit = new AuditLog({ append: () => Promise.reject(new Error('disk full')) }, clock, error => { failures.push(error) })
    const registry = new DeviceRegistry({
      clock,
      audit,
      policy: new PolicyStore(TEST_POLICY),
      onError: () => {},
      tickMs: 50,
    })
    const toy = new MockBackend({ id: 'toy', clock, channels: CHANNELS })
    registry.register(toy)
    await registry.connect('toy', signal())

    await registry.runPattern('model', { deviceId: 'toy', channelId: 'a', envelope: steady(30), durationSec: 30 })
    clock.advance(50)
    await registry.settled()
    expect(toy.deviceLevel('a')).toBe(30)

    // A broken audit sink must never be able to block an emergency stop.
    await registry.emergencyStop('hotkey')
    await registry.settled()
    expect(toy.deviceLevel('a')).toBe(0)
    expect(failures.length).toBeGreaterThan(0)
  })
})

/**
 * The dispatch event type as the registry publishes it.
 *
 * Declared from the subscription signature rather than imported, so these
 * tests remain valid whether or not `index.ts` re-exports the new module yet.
 */
type PublishedDispatch = Parameters<Parameters<DeviceRegistry['subscribe']>[0]>[0]

describe('dispatch events follow accepted commands, never envelope ticks', () => {
  it('emits exactly one dispatch event per accepted command and none for a rejected one', async () => {
    const h = createHarness()
    const events: PublishedDispatch[] = []
    const unsubscribe = h.registry.subscribe(event => { events.push(event) })
    await h.registry.connect('toy', signal())

    await h.registry.setLevel('model', { deviceId: 'toy', channelId: 'a', percent: 20, durationSec: 5 })
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ kind: 'level', deviceId: 'toy', channelId: 'a', percent: 20, durationSec: 5 })
    expect(events[0]?.at).toBe(h.clock.now())

    // A refused command never reaches the dispatch point.
    await safetyErrorFrom(
      h.registry.setLevel('model', { deviceId: 'toy', channelId: 'a', percent: 80, durationSec: 5 }),
    )
    expect(events).toHaveLength(1)

    await h.registry.runPattern('model', { deviceId: 'toy', channelId: 'b', envelope: steady(25), durationSec: 5 })
    expect(events).toHaveLength(2)
    expect(events[1]).toMatchObject({ kind: 'pattern', deviceId: 'toy', channelId: 'b', percent: 25, durationSec: 5 })

    await h.registry.stop('model', 'toy', 'a')
    expect(events).toHaveLength(3)
    expect(events[2]).toMatchObject({ kind: 'stop', deviceId: 'toy', channelId: 'a' })

    // A registered but unconnected device refuses before dispatch, so no event.
    const cold = new MockBackend({ id: 'cold', clock: h.clock })
    h.registry.register(cold)
    await safetyErrorFrom(
      h.registry.setLevel('model', { deviceId: 'cold', channelId: 'main', percent: 10, durationSec: 5 }),
    )
    expect(events).toHaveLength(3)

    unsubscribe()
  })

  it('emits no dispatch event for a per-tick envelope write', async () => {
    const h = createHarness()
    const events: PublishedDispatch[] = []
    h.registry.subscribe(event => { events.push(event) })
    await h.registry.connect('toy', signal())

    await h.registry.setLevel('model', { deviceId: 'toy', channelId: 'a', percent: 20, durationSec: 5 })
    await h.registry.runPattern('model', {
      deviceId: 'toy',
      channelId: 'b',
      envelope: { preset: 'wave', minPercent: 5, maxPercent: 30, periodMs: 200, jitter: 0 },
      durationSec: 5,
    })
    await h.registry.settled()
    const writesBefore = h.toy.writes.length

    // 1 000 ms at tickMs = 50 is twenty envelope samples on channel b.
    h.clock.advance(1_000)
    await h.registry.settled()

    // The transport saw the samples...
    expect(h.toy.writes.length).toBeGreaterThan(writesBefore)
    // ...but they are parts of one effect, not new actions.
    expect(events).toHaveLength(2)
    expect(events[0]).toMatchObject({ kind: 'level', channelId: 'a' })
    expect(events[1]).toMatchObject({ kind: 'pattern', channelId: 'b' })
  })

  it('emits one waveform event and folds a runPattern waveform into the pattern event', async () => {
    const clock = new FakeClock()
    const store = new MemoryAppendOnlyStore()
    const errors: unknown[] = []
    const audit = new AuditLog(store, clock, error => { errors.push(error) })
    const waveforms = new WaveformLibrary()
    const registry = new DeviceRegistry({
      clock,
      audit,
      policy: new PolicyStore(TEST_POLICY),
      waveforms,
      onError: error => { errors.push(error) },
      tickMs: 50,
    })
    const toy = new MockBackend({
      id: 'toy',
      clock,
      channels: [{ id: 'pulse', kind: 'level', label: 'Pulse', supportsWaveform: true }],
    })
    registry.register(toy)
    const events: PublishedDispatch[] = []
    registry.subscribe(event => { events.push(event) })
    await registry.connect('toy', signal())
    const waveformId = waveforms.list()[0]!.id

    await registry.setWaveform('model', 'toy', 'pulse', waveformId)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ kind: 'waveform', deviceId: 'toy', channelId: 'pulse', waveformId })

    // runPattern selects the same waveform internally; that is one dispatch,
    // not a pattern event plus a waveform event.
    await registry.runPattern('model', {
      deviceId: 'toy',
      channelId: 'pulse',
      envelope: steady(20),
      durationSec: 5,
      waveformId,
    })
    expect(events).toHaveLength(2)
    expect(events[1]).toMatchObject({
      kind: 'pattern',
      deviceId: 'toy',
      channelId: 'pulse',
      percent: 20,
      durationSec: 5,
      waveformId,
    })

    // Clearing a waveform is still an accepted dispatch; there is no id to carry.
    await registry.setWaveform('model', 'toy', 'pulse')
    expect(events).toHaveLength(3)
    expect(events[2]).toMatchObject({ kind: 'waveform', deviceId: 'toy', channelId: 'pulse' })
    expect(events[2]).not.toHaveProperty('waveformId')
  })

  it('stops delivering events after unsubscribe', async () => {
    const h = createHarness()
    const events: PublishedDispatch[] = []
    const unsubscribe = h.registry.subscribe(event => { events.push(event) })
    await h.registry.connect('toy', signal())

    await h.registry.setLevel('model', { deviceId: 'toy', channelId: 'a', percent: 20, durationSec: 5 })
    expect(events).toHaveLength(1)

    unsubscribe()
    unsubscribe()
    await h.registry.stop('model', 'toy', 'a')
    expect(events).toHaveLength(1)
  })

  it('keeps the dispatch chain alive when a listener throws', async () => {
    const h = createHarness()
    const seen: string[] = []
    h.registry.subscribe(() => { throw new Error('broken probe') })
    h.registry.subscribe(event => { seen.push(event.kind) })
    await h.registry.connect('toy', signal())

    await h.registry.setLevel('model', { deviceId: 'toy', channelId: 'a', percent: 20, durationSec: 5 })
    h.clock.advance(50)
    await h.registry.settled()

    expect(h.toy.deviceLevel('a')).toBe(20)
    expect(seen).toEqual(['level'])
    expect(h.errors.some(error => error instanceof Error && error.message === 'broken probe')).toBe(true)
  })

  it('reports an emergency stop and a broad stop as one stop dispatch each', async () => {
    const h = createHarness()
    const events: PublishedDispatch[] = []
    h.registry.subscribe(event => { events.push(event) })
    await h.registry.connect('toy', signal())
    await h.registry.runPattern('model', { deviceId: 'toy', channelId: 'a', envelope: steady(30), durationSec: 60 })

    await h.registry.emergencyStop('hotkey')
    await h.registry.settled()
    expect(events).toHaveLength(2)
    expect(events[0]).toMatchObject({ kind: 'pattern', deviceId: 'toy', channelId: 'a' })
    expect(events[1]).toEqual({ kind: 'stop', deviceId: 'all', channelId: 'all', at: h.clock.now() })

    // Stops stay accepted while locked, and a broad stop is still one command.
    await h.registry.stop('model')
    await h.registry.settled()
    expect(events).toHaveLength(3)
    expect(events[2]).toMatchObject({ kind: 'stop', deviceId: 'all', channelId: 'all' })
  })

  it('treats setLevel(0) as a stop dispatch, not a level dispatch', async () => {
    const h = createHarness()
    const events: PublishedDispatch[] = []
    h.registry.subscribe(event => { events.push(event) })
    await h.registry.connect('toy', signal())

    await h.registry.setLevel('model', { deviceId: 'toy', channelId: 'a', percent: 0 })
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ kind: 'stop', deviceId: 'toy', channelId: 'a' })
  })

  it('does not report a human cap change as a dispatch', async () => {
    const h = createHarness()
    const events: PublishedDispatch[] = []
    h.registry.subscribe(event => { events.push(event) })
    await h.registry.connect('toy', signal())
    await h.registry.setLevel('model', { deviceId: 'toy', channelId: 'a', percent: 30, durationSec: 60 })

    await h.registry.setPolicyByHuman('toy', 'a', { maxPercent: 10 })
    await h.registry.settled()

    // The immediate post-change re-write goes through the transport, not dispatch.
    expect(h.toy.deviceLevel('a')).toBe(10)
    expect(events).toHaveLength(1)
  })
})

describe('session ceiling bounds the effective cap', () => {
  it('surfaces the ceiling in the snapshot and rejects anything above it', async () => {
    // Review item R5: only the Coyote BF sync used `effective()`, so the
    // snapshot and the write path still advertised the raw channel cap.
    const h = createHarness()
    await h.registry.connect('toy', signal())
    h.policy.setByHuman('toy', 'a', { maxPercent: 40 })
    h.policy.setSessionCeilingByHuman(15)

    const channelA = h.registry.snapshot().devices
      .find(device => device.id === 'toy')?.channels
      .find(channel => channel.id === 'a')
    expect(channelA?.maxPercent).toBe(15)

    const before = h.toy.writes.length
    const error = await safetyErrorFrom(
      h.registry.setLevel('human', { deviceId: 'toy', channelId: 'a', percent: 40, durationSec: 5 }),
    )
    expect(error.code).toBe('POLICY_PERCENT')
    expect(error.message).toContain('15')
    await h.registry.settled()
    expect(h.toy.writes.length).toBe(before)

    // Releasing the ceiling brings the channel cap back into force.
    h.policy.setSessionCeilingByHuman(100)
    const restored = h.registry.snapshot().devices
      .find(device => device.id === 'toy')?.channels
      .find(channel => channel.id === 'a')
    expect(restored?.maxPercent).toBe(40)
  })
})

describe('dispatch listeners cannot break the control path', () => {
  it('reports an async listener rejection instead of leaking an unhandled rejection', async () => {
    const h = createHarness()
    await h.registry.connect('toy', signal())
    const before = h.errors.length
    h.registry.subscribe(async () => {
      throw new Error('async listener boom')
    })

    await h.registry.setLevel('model', { deviceId: 'toy', channelId: 'a', percent: 10, durationSec: 5 })
    await h.registry.settled()
    // Two microtask turns let the promise catch run.
    await Promise.resolve()
    await Promise.resolve()

    expect(h.errors.length).toBeGreaterThan(before)
    expect((h.errors.at(-1) as Error).message).toContain('async listener boom')
  })
})
