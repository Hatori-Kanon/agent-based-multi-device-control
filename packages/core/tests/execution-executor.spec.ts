import { readFile } from 'node:fs/promises'
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

/** Channels that accept waveform selection; only the waveform-degrade tests need them. */
const WAVEFORM_CHANNELS: readonly Channel[] = [
  { id: 'a', kind: 'level', label: 'A 通道', supportsWaveform: true },
  { id: 'b', kind: 'level', label: 'B 通道', supportsWaveform: true },
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

/**
 * Registry double whose `runPattern` fails on demand.
 *
 * `PlanExecutor` only accepts a real `DeviceRegistry` (instanceof check), so
 * failure injection subclasses it instead of stubbing the interface.
 */
class ScriptedRunPatternRegistry extends DeviceRegistry {
  runPatternCalls = 0

  constructor(
    options: ConstructorParameters<typeof DeviceRegistry>[0],
    private readonly failure: (call: number) => Error,
  ) {
    super(options)
  }

  override async runPattern(): Promise<void> {
    this.runPatternCalls += 1
    throw this.failure(this.runPatternCalls)
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

interface HarnessOptions {
  readonly channels?: readonly Channel[]
  /** Overrides the harness policy (e.g. a narrow 0-20 band for request tests). */
  readonly policy?: ChannelPolicy
  /**
   * Builds the registry after the harness clock/audit/policy exist, so a test
   * can inject a `DeviceRegistry` subclass for failure-path coverage.
   */
  readonly registry?: (deps: {
    readonly clock: FakeClock
    readonly audit: AuditLog
    readonly policy: PolicyStore
    readonly onError: (error: unknown) => void
  }) => DeviceRegistry
}

function createHarness(options: HarnessOptions = {}): Harness {
  const channels = options.channels ?? CHANNELS
  const clock = new FakeClock()
  const store = new MemoryAppendOnlyStore()
  const errors: unknown[] = []
  const audit = new AuditLog(store, clock, error => {
    errors.push(error)
  })
  const policy = new PolicyStore(options.policy ?? TEST_POLICY)
  const onError = (error: unknown): void => {
    errors.push(error)
  }
  const registry = options.registry === undefined
    ? new DeviceRegistry({ clock, audit, policy, onError, tickMs: 50, random: () => 0.5 })
    : options.registry({ clock, audit, policy, onError })
  const toy = new MockBackend({ id: 'toy', name: 'Mock Toy', clock, channels })
  // Registered but never connected: exercises the offline path deterministically.
  const dead = new MockBackend({ id: 'dead', name: 'Dead Toy', clock, channels })
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

  it('records plan_resolved with merged per-channel statuses', async () => {
    const harness = createHarness()
    await connect(harness)
    // b1/b2/b3 all resolve onto toy/a and toy/b. The per-channel merge keeps
    // only b3's body there (b1/b2 are reported as superseded warnings), while
    // b4's offline target stays narrative-only.
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
    expect(byBeat.get('b1')).toBeUndefined()
    expect(byBeat.get('b2')).toBeUndefined()
    expect(byBeat.get('b3')).toEqual(['degraded', 'degraded'])
    expect(byBeat.has('b4')).toBe(false)
    // The merged command keeps b3's fallback body (wave preset, low strength:
    // 0.25 × the 0-40 test interval = 10%).
    expect(result.actions.every(action => action.percent === 10)).toBe(true)

    // Never above the human's cap.
    expect(harness.toy.writes.length).toBeGreaterThan(0)
    expect(harness.toy.writes.every(write => write.percent <= TEST_POLICY.maxPercent)).toBe(true)
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
    expect(detail['warnings']).toEqual(expect.arrayContaining([expect.stringContaining('superseded')]))
  })

  it('records the model request next to the mapped percent', async () => {
    const harness = createHarness({
      channels: WAVEFORM_CHANNELS,
      policy: { ...TEST_POLICY, minPercent: 0, maxPercent: 20 },
    })
    await connect(harness)

    const result = await harness.executor.dispatch(makePlan([
      levelBeat('b1', {
        intentId: 'plain',
        strength: 'med',
        targets: [{ deviceId: 'toy', channelId: 'a' }],
        change: { kind: 'level', targetPercent: 50, durationSec: 2 },
      }),
      levelBeat('b2', {
        intentId: 'plain',
        strength: 'low',
        targets: [{ deviceId: 'toy', channelId: 'b' }],
        change: { kind: 'waveform', waveformId: 'tide', durationSec: 4 },
      }),
    ]), context(harness))

    expect(result.actions).toHaveLength(2)
    // 50 interval-% on a 0-20 band maps to 10 output-%; the audit keeps both.
    expect(result.actions[0]).toMatchObject({
      percent: 10,
      request: { strength: 'med', targetPercent: 50, requestedPercent: 50 },
    })
    // The waveform attempt fails (no registry waveform library), the plain
    // retry succeeds; the request still records what the model asked for.
    expect(result.actions[1]).toMatchObject({
      status: 'degraded',
      percent: 5,
      request: { strength: 'low', requestedPercent: 25 },
    })

    const detail = planResolvedRecords(harness)[0]?.detail as Record<string, unknown>
    expect(detail['actions']).toEqual(result.actions)
  })

  it('reports dispatched and clamped for single-channel commands', async () => {
    const harness = createHarness()
    await connect(harness)

    const dispatched = await harness.executor.dispatch(makePlan([
      levelBeat('b1', { targets: [{ deviceId: 'toy', channelId: 'a' }] }),
    ]), context(harness))
    expect(dispatched.actions.map(action => action.status)).toEqual(['dispatched'])

    const clamped = await harness.executor.dispatch(makePlan([
      levelBeat('b2', {
        targets: [{ deviceId: 'toy', channelId: 'b' }],
        strength: 'high',
        change: { kind: 'level', targetPercent: 100, durationSec: 600 },
      }),
    ]), context(harness))
    expect(clamped.actions.map(action => action.status)).toEqual(['clamped'])
    expect(clamped.actions[0]?.percent).toBe(TEST_POLICY.maxPercent)
  })

  it('registers exactly one probe per dispatched beat', async () => {
    const harness = createHarness()
    await connect(harness)
    // Explicit distinct channels keep both beats in the turn: per-channel
    // merging would otherwise keep only the last command on one channel.
    const played = await harness.executor.dispatch(makePlan([
      levelBeat('b1', { targets: [{ deviceId: 'toy', channelId: 'a' }] }),
      levelBeat('b2', { intentId: 'pulse', targets: [{ deviceId: 'toy', channelId: 'b' }] }),
    ]), context(harness))

    expect(played.actions).toHaveLength(2)
    expect(harness.probes.calls).toHaveLength(2)
    const byBeat = new Map(harness.probes.calls.map(call => [call.beatId, call]))
    expect([...byBeat.keys()]).toEqual(['b1', 'b2'])
    expect(byBeat.get('b1')?.intentId).toBe('plain')
    expect(byBeat.get('b1')?.turnId).toBe(42)
    expect(byBeat.get('b1')?.targets).toEqual([{ deviceId: 'toy', channelId: 'a' }])
    expect(byBeat.get('b2')?.targets).toEqual([{ deviceId: 'toy', channelId: 'b' }])

    // `stop` is a bypass in the probe contract (§4.2 / D3): it dispatches, but
    // registers no probe and leaves no beat-specific target.
    const stopped = await harness.executor.dispatch(
      makePlan([levelBeat('b3', { intentId: 'stop', strength: 'high' })]),
      context(harness),
    )
    expect(stopped.actions).toHaveLength(2)
    expect(harness.probes.calls).toHaveLength(2)
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

describe('waveform-stage failures degrade instead of rejecting the beat', () => {
  it('retries the same envelope without the waveform and reports degraded', async () => {
    // The registry has no waveform library here, so selecting `tide` throws even
    // though the executor's own lookup resolved it — exactly the "waveform
    // asset failed at dispatch" shape this path exists for.
    const harness = createHarness({ channels: WAVEFORM_CHANNELS })
    await connect(harness)
    const events: string[] = []
    const unsubscribe = harness.registry.subscribe(event => events.push(event.kind))
    try {
      const result = await harness.executor.dispatch(
        makePlan([
          levelBeat('b1', {
            targets: [{ deviceId: 'toy', channelId: 'a' }],
            change: { kind: 'waveform', waveformId: 'tide', durationSec: 4 },
          }),
        ]),
        context(harness),
      )

      expect(result.actions).toHaveLength(1)
      expect(result.actions[0]).toMatchObject({
        beatId: 'b1',
        deviceId: 'toy',
        channelId: 'a',
        status: 'degraded',
      })
      expect(result.actions[0]?.reason).toContain('waveform "tide" failed')
      expect(result.actions[0]?.reason).toContain('ran a plain pattern')
      // The retry really reached the registry: exactly one accepted pattern.
      expect(events.filter(kind => kind === 'pattern')).toHaveLength(1)

      const detail = planResolvedRecords(harness)[0]?.detail as Record<string, unknown>
      expect(detail['warnings']).toEqual(expect.arrayContaining([
        expect.stringContaining('waveform "tide" failed'),
      ]))
    } finally {
      unsubscribe()
    }
  })

  it('rejects only when the waveform-free retry also fails', async () => {
    // A registry double that keeps failing at the waveform stage: the first
    // attempt throws, the waveform-free retry throws as well, so the command
    // must stay rejected after exactly two calls.
    let registry: ScriptedRunPatternRegistry | undefined
    const harness = createHarness({
      channels: WAVEFORM_CHANNELS,
      registry: deps => {
        registry = new ScriptedRunPatternRegistry(
          { ...deps },
          () => new SafetyError('UNKNOWN_WAVEFORM', 'waveform asset write failed (fake)'),
        )
        return registry
      },
    })
    await connect(harness)

    const result = await harness.executor.dispatch(
      makePlan([
        levelBeat('b1', {
          targets: [{ deviceId: 'toy', channelId: 'a' }],
          change: { kind: 'waveform', waveformId: 'tide', durationSec: 4 },
        }),
      ]),
      context(harness),
    )

    expect(registry?.runPatternCalls).toBe(2)
    expect(result.actions).toHaveLength(1)
    expect(result.actions[0]?.status).toBe('rejected')
    expect(result.actions[0]?.reason).toContain('UNKNOWN_WAVEFORM')

    const detail = planResolvedRecords(harness)[0]?.detail as Record<string, unknown>
    expect(detail['warnings']).toEqual(expect.arrayContaining([
      expect.stringContaining('waveform "tide" failed'),
    ]))
  })

  it('does not retry a refusal that is not a waveform-stage failure', async () => {
    const harness = createHarness({ channels: WAVEFORM_CHANNELS })
    await connect(harness)
    // Resolution thinks `dead` is ready; the registry refuses it with
    // NOT_CONNECTED before any waveform handling. That is a channel refusal,
    // not a waveform failure: reject as before, with exactly one attempt.
    const staleSnapshot: ResolveRegistrySnapshot = {
      ...harness.registry.snapshot(),
      devices: harness.registry.snapshot().devices.map(device =>
        device.id === 'dead' ? { ...device, lifecycle: 'ready' as const } : device,
      ),
    }

    const result = await harness.executor.dispatch(
      makePlan([
        levelBeat('b1', {
          targets: [{ deviceId: 'dead', channelId: 'a' }],
          change: { kind: 'waveform', waveformId: 'tide', durationSec: 4 },
        }),
      ]),
      context(harness, staleSnapshot),
    )

    expect(result.actions).toHaveLength(1)
    expect(result.actions[0]?.status).toBe('rejected')
    expect(result.actions[0]?.reason).toContain('NOT_CONNECTED')
    // One registry attempt only: the waveform-free retry was not made.
    expect(harness.records().filter(record => record.action === 'run_pattern')).toHaveLength(1)

    const detail = planResolvedRecords(harness)[0]?.detail as Record<string, unknown>
    const warnings = detail['warnings'] as string[]
    expect(warnings.some(warning => warning.includes('waveform "tide" failed'))).toBe(false)
  })

  it('does not retry once the turn is aborted', async () => {
    const controller = new AbortController()
    let registry: ScriptedRunPatternRegistry | undefined
    const harness = createHarness({
      channels: WAVEFORM_CHANNELS,
      registry: deps => {
        registry = new ScriptedRunPatternRegistry(
          { ...deps },
          () => {
            // The first attempt aborts the turn and then fails at the waveform
            // stage: the catch must report it without a second registry call.
            controller.abort()
            return new SafetyError('UNKNOWN_WAVEFORM', 'waveform write aborted (fake)')
          },
        )
        return registry
      },
    })
    await connect(harness)

    const result = await harness.executor.dispatch(
      makePlan([
        levelBeat('b1', {
          targets: [{ deviceId: 'toy', channelId: 'a' }],
          change: { kind: 'waveform', waveformId: 'tide', durationSec: 4 },
        }),
      ]),
      context(harness),
      undefined,
      { signal: controller.signal },
    )

    expect(registry?.runPatternCalls).toBe(1)
    expect(result.actions).toHaveLength(1)
    expect(result.actions[0]?.status).toBe('rejected')
    expect(result.actions[0]?.reason).toContain('UNKNOWN_WAVEFORM')

    const detail = planResolvedRecords(harness)[0]?.detail as Record<string, unknown>
    const warnings = detail['warnings'] as string[]
    expect(warnings.some(warning => warning.includes('retrying as a plain pattern'))).toBe(false)
  })
})

describe('dispatch preemption (wave-4 review B-3)', () => {
  /**
   * Explicit per-channel targets keep one command per beat. Beats must use
   * distinct channels: the resolver's per-channel merge would otherwise keep
   * only the last command in the turn.
   */
  function toyBeat(id: string, channelId = 'a'): Beat {
    return levelBeat(id, { targets: [{ deviceId: 'toy', channelId }] })
  }

  /** Snapshot that believes the disconnected `dead` device is ready. */
  function staleReadySnapshot(harness: Harness): ResolveRegistrySnapshot {
    return {
      ...harness.registry.snapshot(),
      devices: harness.registry.snapshot().devices.map(device =>
        device.id === 'dead' ? { ...device, lifecycle: 'ready' as const } : device,
      ),
    }
  }

  /** Third command on another device, so the plan keeps three distinct beats. */
  function deadBeat(id: string): Beat {
    return levelBeat(id, { targets: [{ deviceId: 'dead', channelId: 'a' }] })
  }

  it('dispatches nothing when the signal is already aborted', async () => {
    const harness = createHarness()
    await connect(harness)
    const controller = new AbortController()
    controller.abort()

    const result = await harness.executor.dispatch(
      makePlan([toyBeat('b1', 'a'), toyBeat('b2', 'b'), deadBeat('b3')]),
      context(harness, staleReadySnapshot(harness)),
      undefined,
      { signal: controller.signal },
    )

    expect(result.blocked).toBe(false)
    expect(result.preempted).toBe(true)
    expect(result.actions).toEqual([])
    expect(result.remainingBeats).toEqual(['b1', 'b2', 'b3'])
    expect(harness.toy.writes).toEqual([])
    expect(harness.probes.calls).toEqual([])

    const record = planResolvedRecords(harness)[0]
    expect(record?.detail).toMatchObject({
      blocked: false,
      preempted: true,
      remainingBeats: ['b1', 'b2', 'b3'],
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
        makePlan([toyBeat('b1', 'a'), toyBeat('b2', 'b'), deadBeat('b3')]),
        context(harness, staleReadySnapshot(harness)),
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
