import { describe, expect, it } from 'vitest'
import {
  AuditLog,
  DeviceRegistry,
  FakeClock,
  MemoryAppendOnlyStore,
  MockBackend,
  PolicyStore,
  SafetyError,
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

  it('applies caps per channel', async () => {
    const h = createHarness()
    await h.registry.connect('toy', signal())
    await h.registry.setPolicyByHuman('toy', 'a', { maxPercent: 10 })

    const error = await safetyErrorFrom(
      h.registry.runPattern('model', { deviceId: 'toy', channelId: 'a', envelope: steady(30), durationSec: 5 }),
    )
    expect(error.code).toBe('POLICY_ENVELOPE')

    // The sibling channel still has the default cap.
    await h.registry.runPattern('model', { deviceId: 'toy', channelId: 'b', envelope: steady(30), durationSec: 5 })
    h.clock.advance(50)
    await h.registry.settled()
    expect(h.toy.deviceLevel('b')).toBe(30)

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
})

describe('audit trail', () => {
  it('records the actor, the action, and the reason for every refusal', async () => {
    const h = createHarness()
    await h.registry.connect('toy', signal())
    await h.registry.runPattern('model', { deviceId: 'toy', channelId: 'a', envelope: steady(30), durationSec: 5 })
    await safetyErrorFrom(
      h.registry.runPattern('model', { deviceId: 'toy', channelId: 'a', envelope: steady(90), durationSec: 5 }),
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
