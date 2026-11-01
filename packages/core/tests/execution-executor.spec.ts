import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import {
  AuditLog,
  DeviceRegistry,
  FakeClock,
  MemoryAppendOnlyStore,
  MockBackend,
  PolicyStore,
  WaveformLibrary,
  type AuditRecord,
  type Channel,
  type ChannelPolicy,
} from '../src/index.ts'
import { PlanExecutor, type ProbeRegistrar } from '../src/execution/executor.ts'
import type { ProbeAction } from '../src/sensors/probe.ts'
import type { Beat, BeatChange, BeatPlan, BeatStrength, BeatTarget, PlanDrop } from '../src/scenario/beat-plan.ts'
import { DEFAULT_INTENTS } from '../src/scenario/default-intents.ts'
import type { FeedbackIntent, ResolveContext, ResolveRegistrySnapshot } from '../src/scenario/intents.ts'

const WAVEFORMS = new WaveformLibrary()

const CHANNELS: readonly Channel[] = [
  { id: 'a', kind: 'level', label: 'A 通道' },
  { id: 'b', kind: 'level', label: 'B 通道' },
]

/** Explicit policy so the assertions describe behaviour, not the shipped default. */
const TEST_POLICY: ChannelPolicy = { minPercent: 0, maxPercent: 40, maxWaveIntensity: 80, minFreq: 10, maxFreq: 240, maxDurationSec: 60 }

const PLAIN: FeedbackIntent = { id: 'plain', meaning: '无建议', regions: ['whole-body'] }
const PULSE: FeedbackIntent = {
  id: 'pulse',
  meaning: '短促脉冲',
  regions: ['whole-body'],
  suggest: { preset: 'pulse', durationSec: 2, strength: 'low' },
}
const STOP = DEFAULT_INTENTS.find(intent => intent.id === 'stop')
if (STOP === undefined) throw new Error('the default intent table lost its stop intent')

const INTENTS: ReadonlyMap<string, FeedbackIntent> = new Map([
  [PLAIN.id, PLAIN],
  [PULSE.id, PULSE],
  [STOP.id, STOP],
])

/** Records every probe the executor registers. */
class RecordingProbes implements ProbeRegistrar {
  readonly calls: ProbeAction[] = []

  register(action: ProbeAction): string | undefined {
    this.calls.push(action)
    return `probe-${this.calls.length}`
  }
}

interface Harness {
  readonly clock: FakeClock
  readonly store: MemoryAppendOnlyStore
  readonly audit: AuditLog
  readonly registry: DeviceRegistry
  readonly toy: MockBackend
  readonly dead: MockBackend
  readonly probes: RecordingProbes
  readonly executor: PlanExecutor
  readonly records: () => AuditRecord[]
}

function createHarness(): Harness {
  const clock = new FakeClock()
  const store = new MemoryAppendOnlyStore()
  const errors: unknown[] = []
  const audit = new AuditLog(store, clock, error => {
    errors.push(error)
  })
  const policy = new PolicyStore(TEST_POLICY)
  const registry = new DeviceRegistry({
    clock,
    audit,
    policy,
    onError: error => {
      errors.push(error)
    },
    tickMs: 50,
    random: () => 0.5,
  })
  const toy = new MockBackend({ id: 'toy', name: 'Mock Toy', clock, channels: CHANNELS })
  // Registered but never connected: exercises the offline path deterministically.
  const dead = new MockBackend({ id: 'dead', name: 'Dead Toy', clock, channels: CHANNELS })
  registry.register(toy)
  registry.register(dead)
  const probes = new RecordingProbes()
  const executor = new PlanExecutor({ registry, audit, waveforms: WAVEFORMS, probes, clock })
  return {
    clock,
    store,
    audit,
    registry,
    toy,
    dead,
    probes,
    executor,
    records: (): AuditRecord[] => store.lines.map(line => JSON.parse(line) as AuditRecord),
  }
}

async function connect(harness: Harness, deviceId = 'toy'): Promise<void> {
  await harness.registry.connect(deviceId, new AbortController().signal)
}

function levelBeat(
  id: string,
  options: {
    intentId?: string
    strength?: BeatStrength
    regions?: readonly string[]
    change?: BeatChange
    targets?: readonly BeatTarget[]
  } = {},
): Beat {
  return {
    id,
    intentId: options.intentId ?? 'plain',
    regions: options.regions ?? ['whole-body'],
    strength: options.strength ?? 'med',
    ...(options.change === undefined ? {} : { change: options.change }),
    ...(options.targets === undefined ? {} : { targets: options.targets }),
  }
}

function makePlan(beats: readonly Beat[]): BeatPlan {
  return { turnId: 42, phase: 'escalate', pacing: 'build', beats }
}

function context(harness: Harness, snapshot?: ResolveRegistrySnapshot): ResolveContext {
  return {
    snapshot: snapshot ?? harness.registry.snapshot(),
    intents: INTENTS,
    regions: ['whole-body'],
    waveforms: WAVEFORMS,
  }
}

function planResolvedRecords(harness: Harness): AuditRecord[] {
  return harness.records().filter(record => record.action === 'plan_resolved')
}

describe('the executor takes the safety runtime, never a backend', () => {
  it('takes a DeviceRegistry and never a backend', () => {
    const harness = createHarness()

    expect(harness.executor).toBeInstanceOf(PlanExecutor)
    expect(
      () => new PlanExecutor({ registry: harness.registry, audit: harness.audit, waveforms: WAVEFORMS, clock: harness.clock }),
    ).not.toThrow()

    // A backend is not a registry: the type system refuses it…
    // @ts-expect-error DeviceBackend is not a DeviceRegistry; dispatch must go through the safety runtime.
    const buildFromBackend = () => new PlanExecutor({ registry: harness.toy, audit: harness.audit, waveforms: WAVEFORMS, clock: harness.clock })
    // …and so does the constructor at runtime, for a host that casts past the types.
    expect(buildFromBackend).toThrow(TypeError)
  })
})

describe('dispatch', () => {
  it('dispatches the same command list when an extra line field is injected', async () => {
    const harness = createHarness()
    await connect(harness)
    const fixture = makePlan([levelBeat('b1'), levelBeat('b2', { intentId: 'pulse' })])
    const withProse = { ...fixture, line: '（台词不属于控制契约）' } as BeatPlan

    const plain = await harness.executor.dispatch(fixture, context(harness))
    const injected = await harness.executor.dispatch(withProse, context(harness))

    expect(injected.blocked).toBe(false)
    expect(injected.actions).toEqual(plain.actions)

    // Structural guarantee, not just a behavioural one: the module holds no
    // prose identifier at all.
    const source = await readFile(new URL('../src/execution/executor.ts', import.meta.url), 'utf8')
    expect(source).not.toMatch(/\bline\b/)
  })

  it('records plan_resolved with per-beat status', async () => {
    const harness = createHarness()
    await connect(harness)
    const fixture = makePlan([
      levelBeat('b1', { strength: 'med' }),
      levelBeat('b2', { strength: 'high', change: { kind: 'level', targetPercent: 100, durationSec: 600 } }),
      levelBeat('b3', { regions: ['chest'], strength: 'low' }),
      levelBeat('b4', { strength: 'low', targets: [{ deviceId: 'dead', channelId: 'a' }] }),
    ])
    const dropped: readonly PlanDrop[] = [
      { beatId: 'b9', rule: 'intent', reason: 'unknown intentId "push"' },
    ]

    const result = await harness.executor.dispatch(fixture, context(harness), { dropped, warnings: ['parser note'] })

    expect(result.blocked).toBe(false)
    const byBeat = new Map<string, string[]>()
    for (const action of result.actions) {
      const statuses = byBeat.get(action.beatId) ?? []
      statuses.push(action.status)
      byBeat.set(action.beatId, statuses)
    }
    expect(byBeat.get('b1')).toEqual(['dispatched', 'dispatched'])
    expect(byBeat.get('b2')).toEqual(['clamped', 'clamped'])
    expect(byBeat.get('b3')).toEqual(['degraded', 'degraded'])
    expect(byBeat.has('b4')).toBe(false)

    // Never above the human's cap, even for the clamped beat.
    expect(harness.toy.writes.length).toBeGreaterThan(0)
    expect(harness.toy.writes.every(write => write.percent <= TEST_POLICY.maxPercent)).toBe(true)
    expect(harness.toy.writes.some(write => write.percent === TEST_POLICY.maxPercent)).toBe(true)
    // The offline device was never touched.
    expect(harness.dead.writes).toEqual([])

    const entries = planResolvedRecords(harness)
    expect(entries).toHaveLength(1)
    const record = entries[0]
    if (record === undefined) throw new Error('expected a plan_resolved record')
    expect(record.actor).toBe('model')
    const detail = record.detail as Record<string, unknown>
    expect(detail['planId']).toBe(result.planId)
    expect(detail['turnId']).toBe(42)
    expect(detail['phase']).toBe('escalate')
    expect(detail['pacing']).toBe('build')
    expect(detail['blocked']).toBe(false)
    expect(detail['dropped']).toEqual(dropped)
    expect(detail['narrativeOnly']).toEqual(['b4'])
    expect(detail['actions']).toEqual(result.actions)
    expect(detail['warnings']).toContain('parser note')
    expect(detail['warnings']).toEqual(expect.arrayContaining([expect.stringContaining('disconnected')]))
  })

  it('registers exactly one probe per dispatched beat', async () => {
    const harness = createHarness()
    await connect(harness)
    const fixture = makePlan([
      levelBeat('b1'),
      levelBeat('b2', { intentId: 'pulse' }),
      levelBeat('b3', { intentId: 'stop', strength: 'high' }),
    ])

    const result = await harness.executor.dispatch(fixture, context(harness))

    expect(result.actions).toHaveLength(6)
    expect(harness.probes.calls).toHaveLength(2)
    const byBeat = new Map(harness.probes.calls.map(call => [call.beatId, call]))
    expect([...byBeat.keys()]).toEqual(['b1', 'b2'])
    expect(byBeat.get('b1')?.intentId).toBe('plain')
    expect(byBeat.get('b1')?.turnId).toBe(42)
    expect(byBeat.get('b1')?.targets).toEqual([
      { deviceId: 'toy', channelId: 'a' },
      { deviceId: 'toy', channelId: 'b' },
    ])
    // `stop` is a bypass in the probe contract (§4.2 / D3): one action, no probe.
    expect(byBeat.has('b3')).toBe(false)
    expect(harness.toy.writes.at(-1)?.percent).toBe(0)

    // 50 ms effect ticks are not actions: time alone must never register a probe.
    const before = harness.probes.calls.length
    harness.clock.advance(1_000)
    expect(harness.probes.calls.length).toBe(before)
  })

  it('returns blocked and touches no device while the registry is locked', async () => {
    const harness = createHarness()
    await connect(harness)
    await harness.registry.emergencyStop('test')
    const writesBefore = harness.toy.writes.length

    const result = await harness.executor.dispatch(makePlan([levelBeat('b1')]), context(harness))

    expect(result.blocked).toBe(true)
    expect(result.actions).toEqual([])
    expect(harness.toy.writes).toHaveLength(writesBefore)
    expect(harness.probes.calls).toEqual([])

    const record = planResolvedRecords(harness)[0]
    expect(record?.detail).toMatchObject({ blocked: true, planId: result.planId, actions: [], narrativeOnly: [] })
  })

  it('records a rejected command and dispatches the rest', async () => {
    const harness = createHarness()
    await connect(harness)
    // A snapshot taken before the link was known to be down: resolution thinks
    // `dead` is ready, so the executor has to survive its refusal.
    const staleSnapshot: ResolveRegistrySnapshot = {
      ...harness.registry.snapshot(),
      devices: harness.registry.snapshot().devices.map(device =>
        device.id === 'dead' ? { ...device, lifecycle: 'ready' as const } : device,
      ),
    }
    const fixture = makePlan([
      levelBeat('b1', {
        targets: [
          { deviceId: 'dead', channelId: 'a' },
          { deviceId: 'toy', channelId: 'a' },
        ],
      }),
    ])

    const result = await harness.executor.dispatch(fixture, context(harness, staleSnapshot))

    expect(result.actions.map(action => action.status)).toEqual(['rejected', 'dispatched'])
    expect(result.actions[0]?.reason).toContain('NOT_CONNECTED')
    expect(result.actions[1]?.beatId).toBe('b1')
    // One probe, covering only the target that really reached hardware.
    expect(harness.probes.calls).toHaveLength(1)
    expect(harness.probes.calls[0]?.targets).toEqual([{ deviceId: 'toy', channelId: 'a' }])

    const record = planResolvedRecords(harness)[0]
    expect(record?.detail).toMatchObject({
      blocked: false,
      actions: expect.arrayContaining([expect.objectContaining({ beatId: 'b1', status: 'rejected' })]),
    })
  })

  it('writes the same plan_resolved detail for the same plan and snapshot', async () => {
    const harness = createHarness()
    await connect(harness)
    const fixture = makePlan([levelBeat('b1'), levelBeat('b2', { intentId: 'pulse' })])
    const ctx = context(harness)

    await harness.executor.dispatch(fixture, ctx)
    await harness.executor.dispatch(fixture, ctx)

    const details = planResolvedRecords(harness).map(record => record.detail)
    expect(details).toHaveLength(2)
    expect(details[1]).toEqual(details[0])
  })

  it('records an empty plan without touching a device', async () => {
    const harness = createHarness()
    await connect(harness)

    const result = await harness.executor.dispatch(makePlan([]), context(harness))

    expect(result.actions).toEqual([])
    expect(result.blocked).toBe(false)
    expect(harness.toy.writes).toEqual([])
    expect(planResolvedRecords(harness)).toHaveLength(1)
  })
})

describe('dispatch preemption (wave-4 review B-3)', () => {
  /** Explicit single-channel targets keep one command per beat. */
  function toyBeat(id: string): Beat {
    return levelBeat(id, { targets: [{ deviceId: 'toy', channelId: 'a' }] })
  }

  it('dispatches nothing when the signal is already aborted', async () => {
    const harness = createHarness()
    await connect(harness)
    const controller = new AbortController()
    controller.abort()

    const result = await harness.executor.dispatch(
      makePlan([toyBeat('b1'), toyBeat('b2')]),
      context(harness),
      undefined,
      { signal: controller.signal },
    )

    expect(result.blocked).toBe(false)
    expect(result.preempted).toBe(true)
    expect(result.actions).toEqual([])
    expect(result.remainingBeats).toEqual(['b1', 'b2'])
    expect(harness.toy.writes).toEqual([])
    expect(harness.probes.calls).toEqual([])

    const record = planResolvedRecords(harness)[0]
    expect(record?.detail).toMatchObject({
      blocked: false,
      preempted: true,
      remainingBeats: ['b1', 'b2'],
      actions: [],
    })
    expect(harness.clock.pendingCount).toBe(0)
  })

  it('stops after the in-flight beat and lists the remaining beat ids', async () => {
    const harness = createHarness()
    await connect(harness)
    const controller = new AbortController()
    // Abort on the first accepted dispatch: the command already handed to the
    // registry must finish, every later command must be dropped.
    const stopListening = harness.registry.subscribe(event => {
      if (event.kind === 'level') controller.abort()
    })
    try {
      const result = await harness.executor.dispatch(
        makePlan([toyBeat('b1'), toyBeat('b2'), toyBeat('b3')]),
        context(harness),
        undefined,
        { signal: controller.signal },
      )

      expect(result.preempted).toBe(true)
      expect(result.actions.map(action => action.beatId)).toEqual(['b1'])
      expect(result.remainingBeats).toEqual(['b2', 'b3'])
      // Effects already dispatched are not rolled back; only b1 ever reached
      // the backend.
      expect(harness.toy.writes).toHaveLength(1)
      expect(harness.probes.calls.map(call => call.beatId)).toEqual(['b1'])

      const record = planResolvedRecords(harness)[0]
      expect(record?.detail).toMatchObject({
        blocked: false,
        preempted: true,
        remainingBeats: ['b2', 'b3'],
        actions: result.actions,
      })
    } finally {
      stopListening()
      await harness.registry.stop('system')
    }
    expect(harness.clock.pendingCount).toBe(0)
  })

  it('leaves the preemption fields absent on a normal dispatch', async () => {
    const harness = createHarness()
    await connect(harness)

    const result = await harness.executor.dispatch(makePlan([toyBeat('b1')]), context(harness))

    expect(result.preempted).toBeUndefined()
    expect(result.remainingBeats).toBeUndefined()
    const record = planResolvedRecords(harness)[0]
    expect(record?.detail).not.toHaveProperty('preempted')
    expect(record?.detail).not.toHaveProperty('remainingBeats')
    await harness.registry.stop('system')
    expect(harness.clock.pendingCount).toBe(0)
  })
})
