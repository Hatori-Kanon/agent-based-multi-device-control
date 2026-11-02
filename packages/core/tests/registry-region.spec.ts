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
  type ChannelSnapshot,
  type DeviceBackend,
  type RegistrySnapshot,
} from '../src/index.ts'
import { RegionStore } from '../src/devices/regions.ts'
import type { Beat, BeatPlan } from '../src/scenario/beat-plan.ts'
import { resolvePlan, type FeedbackIntent, type ResolveContext } from '../src/scenario/intents.ts'

/**
 * B2-T10: `Channel.region` end to end, plus the bounds sweep a session-ceiling
 * change needs (B2-T9).
 *
 * The three tests named in `M2-实施计划.md` §3.4 are asserted against the real
 * registry snapshot, so what is exercised here is the same data the resolver
 * and `devices_list` read at runtime — not a fixture shaped to pass.
 */

const TEST_POLICY: ChannelPolicy = { minPercent: 0, maxPercent: 40, maxWaveIntensity: 80, minFreq: 10, maxFreq: 240, maxDurationSec: 60 }

/** Three independent ports, which is enough to see a wrong fan-out. */
const CHANNELS: readonly Channel[] = [
  { id: 'a', kind: 'level', label: 'A 通道' },
  { id: 'b', kind: 'level', label: 'B 通道' },
  { id: 'c', kind: 'level', label: 'C 通道' },
]

/** One intent is all the resolver needs to answer "where does chest go". */
const INTENTS: ReadonlyMap<string, FeedbackIntent> = new Map([
  ['ambient-field', { id: 'ambient-field', meaning: '持续环境', regions: ['whole-body'], distribution: 'synced' }],
])

/** Region ids a pack in these tests declares (`whole-body` is always implicit). */
const DECLARED_REGIONS: readonly string[] = ['whole-body', 'chest', 'inner-thigh']

function signal(): AbortSignal {
  return new AbortController().signal
}

function beat(regions: readonly string[], id = 'b1'): Beat {
  return { id, intentId: 'ambient-field', regions, strength: 'med' }
}

function planOf(...beats: readonly Beat[]): BeatPlan {
  return { turnId: 7, phase: 'escalate', pacing: 'build', beats }
}

function resolvedContext(snapshot: RegistrySnapshot): ResolveContext {
  return { snapshot, intents: INTENTS, regions: DECLARED_REGIONS, waveforms: new WaveformLibrary() }
}

function snapshotChannel(snapshot: RegistrySnapshot, deviceId: string, channelId: string): ChannelSnapshot {
  const device = snapshot.devices.find(candidate => candidate.id === deviceId)
  const channel = device?.channels.find(candidate => candidate.id === channelId)
  if (channel === undefined) throw new Error(`no channel ${deviceId}/${channelId} in the snapshot`)
  return channel
}

/** Every `device/channel` a plan would drive, in the resolver's sorted order. */
function routed(snapshot: RegistrySnapshot, regions: readonly string[] = ['chest']): string[] {
  return resolvePlan(planOf(beat(regions)), resolvedContext(snapshot)).commands
    .map(command => `${command.deviceId}/${command.channelId}`)
}

interface Runtime {
  readonly clock: FakeClock
  readonly errors: readonly unknown[]
  readonly policy: PolicyStore
  readonly regions: RegionStore
  readonly registry: DeviceRegistry
  readonly backends: readonly DeviceBackend[]
  readonly records: () => AuditRecord[]
}

/** A toy that implements the hardware-bound hook, and can fail one channel. */
class BoundsToy extends MockBackend {
  /** Channel ids whose bounds were re-asserted, in call order. */
  readonly boundCalls: string[] = []
  /** Simulates a transport that rejects the bound write on one port. */
  failOnBounds: string | undefined = undefined

  async applyBounds(channelId: string): Promise<void> {
    if (this.failOnBounds === channelId) throw new Error(`bounds write failed on ${channelId}`)
    this.boundCalls.push(channelId)
  }
}

function requireBoundsToy(runtime: Runtime, deviceId: string): BoundsToy {
  const backend = runtime.backends.find(candidate => candidate.id === deviceId)
  if (!(backend instanceof BoundsToy)) throw new Error(`${deviceId} is not a BoundsToy`)
  return backend
}

function createRuntime(
  makeBackends: (clock: FakeClock) => readonly DeviceBackend[],
  regions: RegionStore = new RegionStore(),
): Runtime {
  const clock = new FakeClock()
  const store = new MemoryAppendOnlyStore()
  const errors: unknown[] = []
  const audit = new AuditLog(store, clock, error => { errors.push(error) })
  const policy = new PolicyStore(TEST_POLICY)
  const registry = new DeviceRegistry({
    clock,
    audit,
    policy,
    regions,
    onError: error => { errors.push(error) },
    tickMs: 50,
    random: () => 0.5,
  })
  const backends = makeBackends(clock)
  for (const backend of backends) registry.register(backend)
  return {
    clock,
    errors,
    policy,
    regions,
    registry,
    backends,
    records: (): AuditRecord[] => store.lines.map(line => JSON.parse(line) as AuditRecord),
  }
}

/** A mock toy whose labels come from `Channel.region` (a real backend may set them). */
function labelledToy(clock: FakeClock, channels: readonly Channel[]): MockBackend {
  return new MockBackend({ id: 'toy', name: 'Mock Toy', clock, channels })
}

describe('Channel.region reaches the resolver through the registry snapshot', () => {
  it('applies a region change to the next plan without a restart', async () => {
    const h = createRuntime(clock => [labelledToy(clock, [
      { id: 'a', kind: 'level', label: 'A 通道', region: 'chest' },
      { id: 'b', kind: 'level', label: 'B 通道', region: 'inner-thigh' },
      { id: 'c', kind: 'level', label: 'C 通道' },
    ])])
    await h.registry.connect('toy', signal())

    // Before the edit only A carries chest; C is unlabelled and stays quiet.
    expect(routed(h.registry.snapshot())).toEqual(['toy/a'])

    await h.registry.setRegionByHuman('toy', 'b', 'chest')

    // No reconnect, no rebuilt registry: the very next resolvePlan sees it.
    expect(h.registry.snapshot().devices[0]?.lifecycle).toBe('ready')
    expect(snapshotChannel(h.registry.snapshot(), 'toy', 'b').region).toBe('chest')
    expect(routed(h.registry.snapshot())).toEqual(['toy/a', 'toy/b'])

    // Clearing the label takes effect just as immediately.
    await h.registry.setRegionByHuman('toy', 'b', undefined)
    expect(snapshotChannel(h.registry.snapshot(), 'toy', 'b').region).toBeUndefined()
    expect(routed(h.registry.snapshot())).toEqual(['toy/a'])
  })

  it('lets a human label override the region a backend declared', async () => {
    const h = createRuntime(clock => [labelledToy(clock, [
      { id: 'a', kind: 'level', label: 'A 通道', region: 'chest' },
      { id: 'b', kind: 'level', label: 'B 通道' },
    ])])
    // Works before the device is connected: a human labels ports first.
    expect(snapshotChannel(h.registry.snapshot(), 'toy', 'a').region).toBe('chest')
    expect(snapshotChannel(h.registry.snapshot(), 'toy', 'b').region).toBeUndefined()

    await h.registry.setRegionByHuman('toy', 'a', 'inner-thigh')
    expect(snapshotChannel(h.registry.snapshot(), 'toy', 'a').region).toBe('inner-thigh')

    // The human map wins over `Channel.region`, and the resolver follows it.
    await h.registry.connect('toy', signal())
    expect(routed(h.registry.snapshot(), ['inner-thigh'])).toEqual(['toy/a'])

    // `whole-body` is the resolver's wildcard, never invented by the registry.
    expect(snapshotChannel(h.registry.snapshot(), 'toy', 'a').region).not.toBe('whole-body')
  })

  it('falls back to every level channel when no channel carries the region', async () => {
    const h = createRuntime(clock => [labelledToy(clock, CHANNELS)])
    await h.registry.connect('toy', signal())

    const resolved = resolvePlan(planOf(beat(['chest'])), resolvedContext(h.registry.snapshot()))

    // Nothing is labelled chest, so the ladder sends the beat to every online
    // level channel and marks each command as degraded rather than failing.
    expect(resolved.commands.map(command => command.channelId)).toEqual(['a', 'b', 'c'])
    expect(resolved.commands.every(command => command.degraded === 'no-region-match')).toBe(true)
    expect(resolved.narrativeOnlyBeats).toEqual([])
    expect(resolved.warnings.join('\n')).toContain('no channel carries region(s) "chest"')

    // Labelling one channel removes the fallback for that region.
    await h.registry.setRegionByHuman('toy', 'b', 'chest')
    expect(routed(h.registry.snapshot())).toEqual(['toy/b'])
  })
})

describe('the region map persists and every human change is audited', () => {
  it('persists the region map and audits the change', async () => {
    const h = createRuntime(clock => [labelledToy(clock, CHANNELS)])

    await h.registry.setRegionByHuman('toy', 'b', 'inner-thigh')
    await h.registry.setRegionByHuman('toy', 'a', 'chest')

    // Not connected: a label is registry metadata, not output.
    expect(h.registry.snapshot().devices[0]?.lifecycle).toBe('disconnected')
    expect(snapshotChannel(h.registry.snapshot(), 'toy', 'a').region).toBe('chest')
    expect(snapshotChannel(h.registry.snapshot(), 'toy', 'b').region).toBe('inner-thigh')

    // Persistence is the explicit map, keyed `device:channel` and sorted.
    const persisted = h.regions.snapshot()
    expect(persisted).toEqual({ 'toy:a': 'chest', 'toy:b': 'inner-thigh' })

    // A second change reports what it replaced, so the audit line is a history
    // rather than a list of new values.
    await h.registry.setRegionByHuman('toy', 'b', 'chest')
    expect(h.regions.snapshot()).toEqual({ 'toy:a': 'chest', 'toy:b': 'chest' })

    const changes = h.records().filter(record => record.action === 'region_change')
    expect(changes).toHaveLength(3)
    expect(changes[0]).toMatchObject({
      actor: 'human',
      action: 'region_change',
      result: 'ok',
      detail: { deviceId: 'toy', channelId: 'b', previous: null, next: 'inner-thigh' },
    })
    expect(changes[1]?.detail).toMatchObject({ deviceId: 'toy', channelId: 'a', previous: null, next: 'chest' })
    expect(changes[2]?.detail).toMatchObject({ deviceId: 'toy', channelId: 'b', previous: 'inner-thigh', next: 'chest' })

    // Restart: a fresh store loads the persisted map into a fresh registry.
    const restored = new RegionStore()
    restored.restore(persisted)
    const rebooted = createRuntime(clock => [labelledToy(clock, CHANNELS)], restored)
    expect(snapshotChannel(rebooted.registry.snapshot(), 'toy', 'a').region).toBe('chest')
    expect(snapshotChannel(rebooted.registry.snapshot(), 'toy', 'b').region).toBe('inner-thigh')
  })

  it('accepts player-authored part names and rejects only malformed keys', async () => {
    const h = createRuntime(clock => [labelledToy(clock, CHANNELS)])

    // v6: a region key is the player's own part name; Chinese, spaces and
    // case are fine. It is trimmed before storage and audit.
    await h.registry.setRegionByHuman('toy', 'a', ' 左胸 ')
    expect(snapshotChannel(h.registry.snapshot(), 'toy', 'a').region).toBe('左胸')
    await h.registry.setRegionByHuman('toy', 'b', '绑带 2')
    expect(snapshotChannel(h.registry.snapshot(), 'toy', 'b').region).toBe('绑带 2')
    const records = h.records()
    expect(records.at(-2)).toMatchObject({
      actor: 'human',
      action: 'region_change',
      result: 'ok',
      detail: { deviceId: 'toy', channelId: 'a', previous: null, next: '左胸' },
    })

    // The shape guard only rejects unusable keys: control characters, blank,
    // or over-long text. The refusal is still audited.
    await expect(h.registry.setRegionByHuman('toy', 'a', 'bad\nname')).rejects.toBeInstanceOf(SafetyError)
    await expect(h.registry.setRegionByHuman('toy', 'a', '   ')).rejects.toBeInstanceOf(SafetyError)
    await expect(h.registry.setRegionByHuman('toy', 'a', 'x'.repeat(65))).rejects.toBeInstanceOf(SafetyError)
    expect(h.records().at(-1)).toMatchObject({ action: 'region_change', result: 'rejected' })
    // The last good value is untouched by the rejected writes.
    expect(snapshotChannel(h.registry.snapshot(), 'toy', 'a').region).toBe('左胸')

    // An unknown channel is refused the same way instead of inventing a label.
    await expect(h.registry.setRegionByHuman('toy', 'zz', 'chest')).rejects.toBeInstanceOf(SafetyError)
  })

  it('rejects a malformed persisted key instead of guessing', () => {
    const store = new RegionStore()
    expect(() => store.restore({ 'chest': 'chest' })).toThrow(SafetyError)
    expect(store.snapshot()).toEqual({})

    // Atomic: one bad entry restores nothing, so a corrupt file cannot half-apply.
    expect(() => store.restore({ 'toy:a': 'chest', 'no-separator': 'chest' })).toThrow(SafetyError)
    expect(store.snapshot()).toEqual({})
    expect(store.get('toy', 'a')).toBeUndefined()

    // v6: values are player part names, not slugs; they are trimmed on restore.
    store.restore({ 'toy:a': ' 左胸 ' })
    expect(store.get('toy', 'a')).toBe('左胸')
    expect(() => store.restore({ 'toy:a': 'bad\u0000name' })).toThrow(SafetyError)
    expect(store.get('toy', 'a')).toBe('左胸')
  })

  it('keeps the map sorted and does not echo manifest defaults', () => {
    const store = new RegionStore({
      defaults: { 'toy:a': 'chest', 'toy:b': 'inner-thigh' },
    })
    // The baseline is readable but is not an explicit setting.
    expect(store.get('toy', 'a')).toBe('chest')
    expect(store.snapshot()).toEqual({})

    store.setByHuman('toy', 'c', 'chest')
    store.setByHuman('toy', 'a', 'inner-thigh')
    store.setByHuman('toy', 'b', 'chest')
    expect(store.snapshot()).toEqual({
      'toy:a': 'inner-thigh',
      'toy:b': 'chest',
      'toy:c': 'chest',
    })
    // Object key order is the write order: sorted so `state/devices.json`
    // diffs stay stable across restarts.
    expect(Object.keys(store.snapshot())).toEqual(['toy:a', 'toy:b', 'toy:c'])

    // Clearing beats a manifest default rather than revealing it again.
    const change = store.setByHuman('toy', 'a', undefined)
    expect(change).toEqual({ previous: 'inner-thigh', next: undefined })
    expect(store.get('toy', 'a')).toBeUndefined()
    expect(store.snapshot()).toEqual({ 'toy:b': 'chest', 'toy:c': 'chest' })
  })
})

describe('reapplyBounds re-asserts hardware caps after a session-wide change', () => {
  it('re-applies bounds on every ready channel and skips the rest', async () => {
    const h = createRuntime(clock => [
      new BoundsToy({ id: 'pulse', name: 'Pulse toy', clock, channels: CHANNELS.slice(0, 2) }),
      // A stateful toy with no hardware bound to re-assert: nothing to call.
      new MockBackend({ id: 'plain', name: 'Plain toy', clock, channels: CHANNELS.slice(2) }),
      new BoundsToy({ id: 'unplugged', name: 'Unplugged toy', clock, channels: CHANNELS.slice(2) }),
    ])
    await h.registry.connect('pulse', signal())
    await h.registry.connect('plain', signal())
    const auditBefore = h.records().length

    await h.registry.reapplyBounds()

    expect(requireBoundsToy(h, 'pulse').boundCalls).toEqual(['a', 'b'])
    // Never connected: the queue is not touched and the backend is not called.
    expect(requireBoundsToy(h, 'unplugged').boundCalls).toEqual([])
    // Bounds re-assertion is not a new action; the cap change was already audited.
    expect(h.records().length).toBe(auditBefore)
    expect(h.errors).toEqual([])
  })

  it('keeps going when one channel rejects the bounds write', async () => {
    const h = createRuntime(clock => [
      new BoundsToy({ id: 'pulse', name: 'Pulse toy', clock, channels: CHANNELS.slice(0, 3) }),
    ])
    await h.registry.connect('pulse', signal())
    const pulse = requireBoundsToy(h, 'pulse')
    pulse.failOnBounds = 'a'
    const auditBefore = h.records().length

    await h.registry.reapplyBounds()

    // The failing port is reported, the remaining ports are still narrowed.
    expect(pulse.boundCalls).toEqual(['b', 'c'])
    expect(h.errors.map(error => String(error)).join('\n')).toContain('bounds write failed on a')
    expect(h.records().length).toBe(auditBefore)
  })
})
