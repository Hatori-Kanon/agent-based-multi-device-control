import { describe, expect, it } from 'vitest'
import {
  MAX_FREQ,
  MIN_FREQ,
  WaveformLibrary,
  type DeviceLifecycle,
  type PulseFrame,
  type Waveform,
} from '../src/index.ts'
import type {
  Beat,
  BeatChange,
  BeatPlan,
  BeatStrength,
  BeatTarget,
  WaveformModulation,
} from '../src/scenario/beat-plan.ts'
import { DEFAULT_INTENTS } from '../src/scenario/default-intents.ts'
import {
  resolvePlan,
  type FeedbackIntent,
  type ResolvedCommand,
  type ResolvedCommandBody,
  type ResolveChannelSnapshot,
  type ResolveContext,
  type ResolveDeviceSnapshot,
  type ResolveRegistrySnapshot,
  type WaveformLookup,
} from '../src/scenario/intents.ts'

const WAVEFORMS = new WaveformLibrary()

/** Canonical ids shipped by a content pack, as `loader.ts` namespaces them. */
const PACK_ID = 'tentacle-shadow'
const PACK_WAVEFORM_ID = `${PACK_ID}:tentacle-crawl`

function packWaveform(): Waveform {
  const frames: readonly PulseFrame[] = [
    { freq: [10, 10, 10, 10], intensity: [0, 0, 0, 0] },
    { freq: [10, 10, 10, 10], intensity: [60, 60, 60, 60] },
  ]
  return { id: PACK_WAVEFORM_ID, name: '触手爬行', frames, loop: true, source: 'imported', tags: ['pack'] }
}

/**
 * A stand-in for `PlaySession.waveformLookup` (play.ts): pack references
 * resolve first (`builtin:`, `<packId>:<id>` and bare local ids), then the
 * session library. Pack waveforms are installed with `addSessionWaveform`, so
 * the canonical id the resolver returns is also the id dispatch will require.
 */
function packLookup(): { readonly lookup: WaveformLookup; readonly library: WaveformLibrary } {
  const library = new WaveformLibrary()
  const packed = packWaveform()
  library.addSessionWaveform(packed)
  const lookup: WaveformLookup = {
    get: reference => {
      if (reference.startsWith('builtin:')) return library.get(reference.slice('builtin:'.length))
      if (reference.startsWith(`${PACK_ID}:`)) return library.get(reference)
      return library.get(`${PACK_ID}:${reference}`) ?? library.get(reference)
    },
  }
  return { lookup, library }
}

/**
 * A lookup with one looping texture and one one-shot texture, for the
 * `sustainLoopSec` behaviour (`loop: true` keeps playing across the gap).
 */
function sustainLookup(): { readonly lookup: WaveformLookup; readonly library: WaveformLibrary } {
  const library = new WaveformLibrary()
  library.addSessionWaveform({ ...packWaveform(), id: 'loop-sustain', name: '循环', loop: true })
  library.addSessionWaveform({ ...packWaveform(), id: 'stinger-burst', name: '短刺', loop: false })
  return { lookup: { get: id => library.get(id) }, library }
}

const AMBIENT: FeedbackIntent = {
  id: 'ambient-field',
  meaning: '持续环境',
  regions: ['whole-body'],
  distribution: 'synced',
  suggest: { preset: 'wave', waveform: 'tide', durationSec: 30, strength: 'med' },
}

const DEFAULT_INTENT_MAP: ReadonlyMap<string, FeedbackIntent> = new Map(
  DEFAULT_INTENTS.map(intent => [intent.id, intent]),
)

/**
 * An intent with no suggestion at all: level-change tests then use the
 * documented 2s fallback duration instead of ambient-field's 30s.
 */
const PLAIN_INTENT: FeedbackIntent = { id: 'plain', meaning: '无建议', regions: ['whole-body'] }
const PLAIN_INTENT_MAP: ReadonlyMap<string, FeedbackIntent> = new Map([['plain', PLAIN_INTENT]])

function channel(
  id: string,
  region?: string,
  overrides: {
    percent?: number
    minPercent?: number
    maxPercent?: number
    maxDurationSec?: number
    supportsWaveform?: boolean
  } = {},
): ResolveChannelSnapshot {
  return {
    id,
    kind: 'level',
    label: id,
    supportsWaveform: overrides.supportsWaveform ?? false,
    outputFloorPercent: 0,
    ...(region === undefined ? {} : { region }),
    percent: overrides.percent ?? 0,
    minPercent: overrides.minPercent ?? 0,
    maxPercent: overrides.maxPercent ?? 20,
    minFreq: MIN_FREQ,
    maxFreq: MAX_FREQ,
    maxDurationSec: overrides.maxDurationSec ?? 60,
    effect: undefined,
    waveform: undefined,
  }
}

function device(
  id: string,
  channels: readonly ResolveChannelSnapshot[],
  lifecycle: DeviceLifecycle = 'ready',
): ResolveDeviceSnapshot {
  return { id, name: id, lifecycle, canScan: false, channels }
}

function snapshot(...devices: readonly ResolveDeviceSnapshot[]): ResolveRegistrySnapshot {
  return { locked: false, lockedReason: undefined, devices }
}

function context(
  registry: ResolveRegistrySnapshot,
  intents: ReadonlyMap<string, FeedbackIntent> = DEFAULT_INTENT_MAP,
  roundRobinCursor?: number,
  regionAliases?: ReadonlyMap<string, readonly string[]>,
): ResolveContext {
  return {
    snapshot: registry,
    intents,
    regions: ['whole-body', 'chest', 'inner-thigh'],
    waveforms: WAVEFORMS,
    ...(roundRobinCursor === undefined ? {} : { roundRobinCursor }),
    ...(regionAliases === undefined ? {} : { regionAliases }),
  }
}

function levelBeat(
  id: string,
  options: {
    intentId?: string
    regions?: readonly string[]
    strength?: BeatStrength
    change?: BeatChange
    targets?: readonly BeatTarget[]
    texture?: WaveformModulation
  } = {},
): Beat {
  return {
    id,
    intentId: options.intentId ?? 'ambient-field',
    regions: options.regions ?? ['whole-body'],
    strength: options.strength ?? 'med',
    ...(options.change === undefined ? {} : { change: options.change }),
    ...(options.targets === undefined ? {} : { targets: options.targets }),
    ...(options.texture === undefined ? {} : { texture: options.texture }),
  }
}

function plan(beats: readonly Beat[]): BeatPlan {
  return { turnId: 42, phase: 'escalate', pacing: 'build', beats }
}

function durationOf(body: ResolvedCommandBody | undefined): number | undefined {
  if (body === undefined || body.kind === 'waveform') return undefined
  return body.durationSec
}

function firstCommand(commands: readonly ResolvedCommand[]): ResolvedCommand {
  const command = commands[0]
  if (command === undefined) throw new Error('expected at least one command')
  return command
}

describe('resolvePlan is a pure, byte-stable function', () => {
  it('produces a byte-stable command list for the same plan and snapshot', () => {
    const registry = snapshot(
      device('toy', [channel('c', 'inner-thigh'), channel('b', 'chest'), channel('a', 'chest')]),
    )
    const fixture = plan([
      levelBeat('b1', { regions: ['chest'] }),
      levelBeat('b2', { intentId: 'probe-touch', regions: ['chest'], strength: 'low' }),
    ])
    const ctx = context(registry)
    const before = JSON.stringify(fixture)
    const first = resolvePlan(fixture, ctx)
    const replay = resolvePlan(JSON.parse(JSON.stringify(fixture)) as BeatPlan, ctx)

    expect(JSON.stringify(replay)).toBe(JSON.stringify(first))
    expect(JSON.stringify(fixture)).toBe(before)
    expect(first.planId).toMatch(/^p-0042-[0-9a-f]{8}$/)

    const keys = first.commands.map(command => `${command.beatId}/${command.deviceId}/${command.channelId}`)
    expect(keys).toEqual([...keys].sort())
    // b1/a is superseded by b2/a; the surviving commands are one per channel.
    expect(first.commands.map(command => `${command.beatId}/${command.channelId}`)).toEqual(['b1/b', 'b2/a'])
  })

  it('has no line field in its context and ignores an injected one', () => {
    const registry = snapshot(device('toy', [channel('a', 'chest', { supportsWaveform: true })]))
    const fixture = plan([levelBeat('b1', { regions: ['chest'] })])
    const plain = resolvePlan(fixture, context(registry))
    const injected = resolvePlan(fixture, { ...context(registry), line: '台词不属于控制契约' } as ResolveContext)

    expect(JSON.stringify(injected)).toBe(JSON.stringify(plain))
  })

  it('gives two different plans different ids', () => {
    const registry = snapshot(device('toy', [channel('a', 'chest')]))
    const ctx = context(registry)
    const one = resolvePlan(plan([levelBeat('b1', { regions: ['chest'] })]), ctx)
    const two = resolvePlan(plan([levelBeat('b1', { regions: ['chest'], strength: 'high' })]), ctx)

    expect(one.planId).not.toBe(two.planId)
  })
})

describe('one turn drives each channel once', () => {
  it('merges same-channel commands: last body wins and the longest hold is kept', () => {
    const registry = snapshot(device('toy', [channel('a', 'chest', { supportsWaveform: true })]))
    const fixture = plan([
      // Audit turn 13: a long level followed by a short pattern on the same
      // channel used to truncate the hold; the final state must be the pattern
      // with the 40 s hold preserved.
      levelBeat('b1', {
        intentId: 'plain',
        regions: ['chest'],
        change: { kind: 'level', targetPercent: 100, durationSec: 40 },
      }),
      levelBeat('b2', {
        intentId: 'plain',
        regions: ['chest'],
        change: { kind: 'waveform', waveformId: 'climb', durationSec: 4 },
      }),
    ])

    const resolved = resolvePlan(fixture, context(registry, PLAIN_INTENT_MAP))

    expect(resolved.commands).toHaveLength(1)
    const command = firstCommand(resolved.commands)
    expect(command.beatId).toBe('b2')
    expect(command.body).toEqual({
      kind: 'pattern',
      envelope: { preset: 'steady', minPercent: 10, maxPercent: 10, periodMs: 1_000, jitter: 0 },
      durationSec: 40,
      waveformId: 'climb',
    })
    expect(resolved.warnings).toContain(
      'beat b1: command on toy/a superseded by beat b2 in the same turn',
    )
  })

  it('keeps a final stop as a stop instead of merging the earlier hold time', () => {
    const registry = snapshot(device('toy', [channel('a', 'chest')]))
    const fixture = plan([
      levelBeat('b1', {
        regions: ['chest'],
        change: { kind: 'level', targetPercent: 100, durationSec: 40 },
      }),
      levelBeat('b2', { intentId: 'stop', regions: ['chest'] }),
    ])

    const resolved = resolvePlan(fixture, context(registry))

    expect(resolved.commands).toHaveLength(1)
    const command = firstCommand(resolved.commands)
    expect(command.beatId).toBe('b2')
    expect(command.body).toEqual({ kind: 'level', percent: 0, durationSec: 0 })
    expect(resolved.warnings).toContain(
      'beat b1: command on toy/a superseded by beat b2 in the same turn',
    )
  })

  it('leaves other channels untouched when only one channel collides', () => {
    const registry = snapshot(device('toy', [channel('a', 'chest'), channel('b', 'chest')]))
    const fixture = plan([
      levelBeat('b1', {
        intentId: 'plain',
        regions: ['chest'],
        change: { kind: 'level', targetPercent: 100, durationSec: 10 },
      }),
      levelBeat('b2', {
        intentId: 'plain',
        regions: ['chest'],
        targets: [{ deviceId: 'toy', channelId: 'a' }],
        change: { kind: 'level', targetPercent: 30, durationSec: 4 },
      }),
    ])

    const resolved = resolvePlan(fixture, context(registry, PLAIN_INTENT_MAP))

    expect(resolved.commands.map(command => `${command.beatId}/${command.channelId}`)).toEqual([
      'b1/b',
      'b2/a',
    ])
    const byChannel = new Map(resolved.commands.map(command => [command.channelId, command]))
    expect(byChannel.get('a')?.body).toEqual({ kind: 'level', percent: 6, durationSec: 10 })
    expect(byChannel.get('b')?.body).toEqual({ kind: 'level', percent: 20, durationSec: 10 })
    expect(resolved.warnings.filter(warning => warning.includes('superseded'))).toEqual([
      'beat b1: command on toy/a superseded by beat b2 in the same turn',
    ])
  })
})

describe('loop output ordering on a shared channel', () => {
  function loopWaveformBeat(id: string, waveformId: string): Beat {
    return levelBeat(id, {
      intentId: 'plain',
      regions: ['chest'],
      change: { kind: 'waveform', waveformId, durationSec: 4 },
    })
  }

  function fixedLevelBeat(id: string): Beat {
    return levelBeat(id, {
      intentId: 'plain',
      regions: ['chest'],
      change: { kind: 'level', durationSec: 5 },
    })
  }

  it('warns when a superseded earlier beat is a loop', () => {
    const { lookup } = sustainLookup()
    const registry = snapshot(device('toy', [channel('a', 'chest', { supportsWaveform: true })]))
    const resolved = resolvePlan(
      plan([loopWaveformBeat('b1', 'loop-sustain'), fixedLevelBeat('b2')]),
      { ...context(registry, PLAIN_INTENT_MAP), waveforms: lookup },
    )

    expect(resolved.commands).toHaveLength(1)
    expect(firstCommand(resolved.commands).beatId).toBe('b2')
    expect(resolved.warnings).toContain(
      'beat b1: loop output must be the last beat on toy/a; earlier beats need a fixed duration',
    )
  })

  it('does not warn when the loop is the final beat', () => {
    const { lookup } = sustainLookup()
    const registry = snapshot(device('toy', [channel('a', 'chest', { supportsWaveform: true })]))
    const resolved = resolvePlan(
      plan([fixedLevelBeat('b1'), loopWaveformBeat('b2', 'loop-sustain')]),
      { ...context(registry, PLAIN_INTENT_MAP), waveforms: lookup },
    )

    expect(resolved.commands).toHaveLength(1)
    expect(firstCommand(resolved.commands).beatId).toBe('b2')
    expect(
      resolved.warnings.some(warning => warning.includes('loop output must be the last beat')),
    ).toBe(false)
  })

  it('does not warn when the loop is terminated by a stop', () => {
    const { lookup } = sustainLookup()
    const registry = snapshot(device('toy', [channel('a', 'chest', { supportsWaveform: true })]))
    const resolved = resolvePlan(
      plan([
        levelBeat('b1', {
          regions: ['chest'],
          change: { kind: 'waveform', waveformId: 'loop-sustain', durationSec: 4 },
        }),
        levelBeat('b2', { intentId: 'stop', regions: ['chest'] }),
      ]),
      { ...context(registry), waveforms: lookup },
    )

    expect(resolved.commands).toHaveLength(1)
    const command = firstCommand(resolved.commands)
    expect(command.beatId).toBe('b2')
    expect(command.body).toEqual({ kind: 'level', percent: 0, durationSec: 0 })
    // loop → stop is the legal termination, not an ordering mistake.
    expect(
      resolved.warnings.some(warning => warning.includes('loop output must be the last beat')),
    ).toBe(false)
  })

  it('does not warn across different channels', () => {
    const { lookup } = sustainLookup()
    const registry = snapshot(device('toy', [
      channel('a', 'chest', { supportsWaveform: true }),
      channel('b', 'chest', { supportsWaveform: true }),
    ]))
    const resolved = resolvePlan(
      plan([
        levelBeat('b1', {
          intentId: 'plain',
          regions: ['chest'],
          targets: [{ deviceId: 'toy', channelId: 'a' }],
          change: { kind: 'waveform', waveformId: 'loop-sustain', durationSec: 4 },
        }),
        levelBeat('b2', {
          intentId: 'plain',
          regions: ['chest'],
          targets: [{ deviceId: 'toy', channelId: 'b' }],
          change: { kind: 'level', durationSec: 5 },
        }),
      ]),
      { ...context(registry, PLAIN_INTENT_MAP), waveforms: lookup },
    )

    expect(resolved.commands).toHaveLength(2)
    expect(
      resolved.warnings.some(warning => warning.includes('loop output must be the last beat')),
    ).toBe(false)
  })
})

describe('clamping and the strength conversion', () => {
  it('maps a 100% request to the channel ceiling', () => {
    const registry = snapshot(device('toy', [channel('a', 'chest')]))
    const fixture = plan([
      levelBeat('b1', {
        intentId: 'plain',
        regions: ['chest'],
        strength: 'high',
        change: { kind: 'level', targetPercent: 100 },
      }),
    ])

    const command = firstCommand(resolvePlan(fixture, context(registry, PLAIN_INTENT_MAP)).commands)
    // 100% is relative: it means the human's ceiling, not a clamp.
    expect(command.body).toEqual({ kind: 'level', percent: 20, durationSec: 2 })
    expect(command.clamped).toBe(false)
  })

  it('applies the targetPercent > deltaPercent > strength priority', () => {
    const registry = snapshot(device('toy', [channel('a', 'chest', { percent: 18 })]))
    const ctx = context(registry, PLAIN_INTENT_MAP)

    const absolute = resolvePlan(
      plan([
        levelBeat('b1', {
          intentId: 'plain',
          regions: ['chest'],
          strength: 'med',
          change: { kind: 'level', targetPercent: 10, deltaPercent: 20 },
        }),
      ]),
      ctx,
    )
    // targetPercent is relative too: 10% of the 0-20 band is 2.
    expect(firstCommand(absolute.commands).body).toEqual({ kind: 'level', percent: 2, durationSec: 2 })

    const relative = resolvePlan(
      plan([
        levelBeat('b1', {
          intentId: 'plain',
          regions: ['chest'],
          strength: 'med',
          change: { kind: 'level', deltaPercent: 5 },
        }),
      ]),
      ctx,
    )
    // Current 18 in 0-20 is a 90% position; +5 lands at 95%, i.e. 19.
    expect(firstCommand(relative.commands).body).toEqual({ kind: 'level', percent: 19, durationSec: 2 })
    expect(firstCommand(relative.commands).clamped).toBe(false)

    const strengthOnly = resolvePlan(
      plan([levelBeat('b1', { intentId: 'plain', regions: ['chest'], strength: 'med', change: { kind: 'level' } })]),
      ctx,
    )
    expect(firstCommand(strengthOnly.commands).body).toEqual({ kind: 'level', percent: 10, durationSec: 2 })
    expect(firstCommand(strengthOnly.commands).clamped).toBe(false)
  })

  it('clamps the duration to the channel policy', () => {
    const registry = snapshot(device('toy', [channel('a', 'chest', { maxDurationSec: 10 })]))
    const command = firstCommand(resolvePlan(plan([levelBeat('b1', { regions: ['chest'] })]), context(registry)).commands)

    expect(durationOf(command.body)).toBe(10)
    expect(command.clamped).toBe(true)
  })

  it('keeps an authorised level-change hold time and clamps it to the channel cap', () => {
    // R4 / §4.3: `durationSec` on a level change is part of the contract. It
    // is kept as a hold time, then clamped to `maxDurationSec` like any other.
    const registry = snapshot(device('toy', [channel('a', 'chest', { maxDurationSec: 10 })]))
    const ctx = context(registry, PLAIN_INTENT_MAP)
    const hold = (durationSec: number): ResolvedCommand =>
      firstCommand(
        resolvePlan(
          plan([levelBeat('b1', { intentId: 'plain', regions: ['chest'], change: { kind: 'level', durationSec } })]),
          ctx,
        ).commands,
      )

    const within = hold(8)
    expect(within.body).toEqual({ kind: 'level', percent: 10, durationSec: 8 })
    expect(within.clamped).toBe(false)

    const over = hold(600)
    expect(over.body).toEqual({ kind: 'level', percent: 10, durationSec: 10 })
    expect(over.clamped).toBe(true)
  })
})

describe('resolved commands carry the pre-mapping request', () => {
  it('records targetPercent and the requested interval percentage', () => {
    const registry = snapshot(device('toy', [channel('a', 'chest', { maxPercent: 20 })]))
    const command = firstCommand(resolvePlan(
      plan([levelBeat('b1', {
        intentId: 'plain',
        regions: ['chest'],
        strength: 'med',
        change: { kind: 'level', targetPercent: 50 },
      })]),
      context(registry, PLAIN_INTENT_MAP),
    ).commands)

    expect(command.body).toEqual({ kind: 'level', percent: 10, durationSec: 2 })
    // The audit keeps what the model asked for (50) next to what it became (10).
    expect(command.request).toEqual({ strength: 'med', targetPercent: 50, requestedPercent: 50 })
  })

  it('records the strength request behind a waveform change', () => {
    const registry = snapshot(device('toy', [
      channel('a', 'chest', { supportsWaveform: true, maxPercent: 20 }),
    ]))
    const command = firstCommand(resolvePlan(
      plan([levelBeat('b1', {
        intentId: 'plain',
        regions: ['chest'],
        strength: 'low',
        change: { kind: 'waveform', waveformId: 'climb', durationSec: 4 },
      })]),
      context(registry, PLAIN_INTENT_MAP),
    ).commands)

    expect(command.request).toEqual({ strength: 'low', requestedPercent: 25 })
    expect(command.body.kind).toBe('pattern')
    if (command.body.kind === 'pattern') expect(command.body.envelope.maxPercent).toBe(5)
  })

  it('keeps a zero request for the stop intent', () => {
    const registry = snapshot(device('toy', [channel('a', 'chest')]))
    const command = firstCommand(resolvePlan(
      plan([levelBeat('b1', { intentId: 'stop', regions: ['chest'], strength: 'high' })]),
      context(registry),
    ).commands)

    expect(command.request).toEqual({ strength: 'high', targetPercent: 0, requestedPercent: 0 })
  })
})

describe('region routing and distribution', () => {
  it('routes a synced intent to every region channel and leaves the third alone', () => {
    const registry = snapshot(
      device('toy', [channel('a', 'chest'), channel('b', 'chest'), channel('c', 'inner-thigh')]),
    )
    const resolved = resolvePlan(plan([levelBeat('b1', { regions: ['chest'] })]), context(registry))

    expect(resolved.commands.map(command => command.channelId)).toEqual(['a', 'b'])
    expect(resolved.narrativeOnlyBeats).toEqual([])
  })

  it('keeps only the primary channel for a primary intent', () => {
    const registry = snapshot(device('toy', [channel('a', 'chest'), channel('b', 'chest')]))
    const resolved = resolvePlan(
      plan([levelBeat('b1', { intentId: 'probe-touch', regions: ['chest'], strength: 'low' })]),
      context(registry),
    )

    expect(resolved.commands.map(command => command.channelId)).toEqual(['a'])
  })

  it('rotates the chosen channel with the round-robin cursor', () => {
    const registry = snapshot(device('toy', [channel('a', 'chest'), channel('b', 'chest'), channel('c', 'chest')]))
    const rotating = new Map<string, FeedbackIntent>([
      ['ambient-field', { ...AMBIENT, distribution: 'round-robin' }],
    ])
    const fixture = plan([levelBeat('b1', { regions: ['chest'] })])
    const picked = (cursor: number): string[] =>
      resolvePlan(fixture, context(registry, rotating, cursor)).commands.map(command => command.channelId)

    expect(picked(0)).toEqual(['a'])
    expect(picked(1)).toEqual(['b'])
    expect(picked(2)).toEqual(['c'])
    expect(picked(4)).toEqual(['b'])
  })

  it('rotates over ready channels when a matching device is offline', () => {
    const registry = snapshot(
      // Offline duplicate first: a cursor must not land on it while `toy`
      // still has deliverable channels for the same region.
      device('dead', [channel('a', 'chest')], 'disconnected'),
      device('toy', [channel('a', 'chest'), channel('b', 'chest')]),
    )
    const rotating = new Map<string, FeedbackIntent>([
      ['ambient-field', { ...AMBIENT, distribution: 'round-robin' }],
    ])
    const fixture = plan([levelBeat('b1', { regions: ['chest'] })])
    const picked = (cursor: number): string[] =>
      resolvePlan(fixture, context(registry, rotating, cursor)).commands.map(command => command.channelId)

    expect(picked(0)).toEqual(['a'])
    expect(picked(1)).toEqual(['b'])
    // The offline channel is not part of the rotation, so it never produces a
    // silent turn while another channel can play the same region.
    expect(picked(2)).toEqual(['a'])
  })

  it('falls back to every online level channel when no channel carries the region', () => {
    const registry = snapshot(device('toy', [channel('a'), channel('b')]))
    const resolved = resolvePlan(plan([levelBeat('b1', { regions: ['chest'] })]), context(registry))

    expect(resolved.commands.map(command => command.channelId)).toEqual(['a', 'b'])
    expect(resolved.commands.every(command => command.degraded === 'no-region-match')).toBe(true)
  })

  it('honours per-target overrides', () => {
    const registry = snapshot(
      device('toy', [channel('a', 'chest'), channel('b', 'chest', { maxPercent: 40, percent: 30 })]),
    )
    const fixture = plan([
      levelBeat('b1', {
        intentId: 'plain',
        regions: ['chest'],
        strength: 'low',
        change: { kind: 'level' },
        targets: [
          { deviceId: 'toy', channelId: 'a', strength: 'high' },
          { deviceId: 'toy', channelId: 'b', strength: 'med', change: { kind: 'level', deltaPercent: 10 } },
        ],
      }),
    ])
    const commands = new Map(
      resolvePlan(fixture, context(registry, PLAIN_INTENT_MAP)).commands.map(command => [
        command.channelId,
        command,
      ]),
    )

    // Target `a` inherits the level change and overrides only the strength.
    expect(commands.get('a')?.body).toEqual({ kind: 'level', percent: 16, durationSec: 2 })
    // Target `b` overrides the change too: deltaPercent is relative to its own
    // current position. Current 30 in 0-40 is a 75% position; +10 lands at
    // 85%, i.e. 34, and that is a normal mapping rather than a clamp.
    expect(commands.get('b')?.body).toEqual({ kind: 'level', percent: 34, durationSec: 2 })
    expect(commands.get('b')?.clamped).toBe(false)
  })

  it('skips explicit targets whose device or channel is gone', () => {
    const registry = snapshot(device('toy', [channel('a', 'chest')]))
    const fixture = plan([
      levelBeat('b1', {
        regions: ['chest'],
        targets: [
          { deviceId: 'ghost', channelId: 'a' },
          { deviceId: 'toy', channelId: 'z' },
          { deviceId: 'toy', channelId: 'a' },
        ],
      }),
    ])

    const resolved = resolvePlan(fixture, context(registry))
    expect(resolved.commands.map(command => command.channelId)).toEqual(['a'])
    expect(resolved.warnings.filter(warning => warning.includes('target'))).toHaveLength(2)
  })
})

describe('unknown explicit targets fall back to the beat regions', () => {
  it('routes by region when every guessed target names an unknown device', () => {
    const registry = snapshot(device('toy', [channel('a', 'chest'), channel('b', 'chest')]))
    const fixture = plan([
      levelBeat('b1', {
        intentId: 'plain',
        regions: ['chest'],
        // The prompt never exposes device ids, so the model guesses pack ids
        // ("tentacle-shadow"/"tentacle" for a coyote in the smoke run).
        targets: [{ deviceId: 'tentacle-shadow', channelId: 'a' }],
      }),
    ])

    const resolved = resolvePlan(fixture, context(registry, PLAIN_INTENT_MAP))

    expect(resolved.commands.map(command => command.channelId)).toEqual(['a', 'b'])
    expect(resolved.narrativeOnlyBeats).toEqual([])
    expect(resolved.warnings).toContain(
      'beat b1: no explicit target matched; falling back to region matching',
    )
  })

  it('applies the intent distribution to the region fallback', () => {
    const registry = snapshot(device('toy', [channel('a', 'chest'), channel('b', 'chest')]))
    const fixture = plan([
      levelBeat('b1', {
        intentId: 'probe-touch', // distribution: 'primary'
        regions: ['chest'],
        targets: [{ deviceId: 'tentacle-shadow', channelId: 'a' }],
      }),
    ])

    const resolved = resolvePlan(fixture, context(registry))

    // The fallback is region routing, so primary must pick one channel instead
    // of dispatching every match (ui-v12-review §P2-2).
    expect(resolved.commands).toHaveLength(1)
    expect(resolved.commands[0]?.channelId).toBe('a')
    expect(resolved.warnings).toContain(
      'beat b1: no explicit target matched; falling back to region matching',
    )
  })

  it('stays narrative-only when the guessed target has no region to fall back to', () => {
    const registry = snapshot(device('toy', [channel('a', 'chest')]))
    const fixture = plan([
      levelBeat('b1', {
        intentId: 'plain',
        regions: [],
        targets: [{ deviceId: 'tentacle', channelId: 'a' }],
      }),
    ])

    const resolved = resolvePlan(fixture, context(registry, PLAIN_INTENT_MAP))

    expect(resolved.commands).toEqual([])
    expect(resolved.narrativeOnlyBeats).toEqual(['b1'])
    expect(resolved.warnings).toContain(
      'beat b1: target device "tentacle" is not connected; target dropped',
    )
    expect(
      resolved.warnings.some(warning => warning.includes('falling back to region matching')),
    ).toBe(false)
  })

  it('does not fall back when a valid target merely points at an offline device', () => {
    const registry = snapshot(
      device('toy', [channel('a', 'chest')]),
      device('dead', [channel('a', 'chest')], 'disconnected'),
    )
    const fixture = plan([
      levelBeat('b1', {
        intentId: 'plain',
        regions: ['chest'],
        targets: [{ deviceId: 'dead', channelId: 'a' }],
      }),
    ])

    const resolved = resolvePlan(fixture, context(registry, PLAIN_INTENT_MAP))

    // The target matched a real device, so the region fallback must not route
    // the beat to the unrelated ready toy.
    expect(resolved.commands).toEqual([])
    expect(resolved.narrativeOnlyBeats).toEqual(['b1'])
    expect(
      resolved.warnings.some(warning => warning.includes('falling back to region matching')),
    ).toBe(false)
    expect(resolved.warnings.some(warning => warning.includes('disconnected'))).toBe(true)
  })
})

describe('offline devices and degraded commands', () => {
  it('degrades an offline device to narrative instead of throwing', () => {
    const registry = snapshot(device('toy', [channel('a', 'chest')], 'disconnected'))
    const fixture = plan([levelBeat('b1', { regions: ['chest'] })])

    expect(() => resolvePlan(fixture, context(registry))).not.toThrow()
    const resolved = resolvePlan(fixture, context(registry))
    expect(resolved.commands).toEqual([])
    expect(resolved.narrativeOnlyBeats).toEqual(['b1'])
    expect(resolved.warnings.some(warning => warning.includes('disconnected'))).toBe(true)
  })

  it('prefers a ready duplicate region match over an offline device for a primary intent', () => {
    const registry = snapshot(
      // Exactly the adversarial-review repro: the offline device sorts first
      // in the snapshot, so the old id-only order made `primary` pick it, drop
      // the command, and leave the whole beat silent.
      device('dead', [channel('a', 'chest')], 'disconnected'),
      device('toy', [channel('a', 'chest')]),
    )
    const fixture = plan([
      levelBeat('b1', { intentId: 'probe-touch', regions: ['chest'], strength: 'low' }),
    ])

    const resolved = resolvePlan(fixture, context(registry))

    expect(resolved.commands).toHaveLength(1)
    expect(resolved.commands[0]?.deviceId).toBe('toy')
    expect(resolved.commands[0]?.channelId).toBe('a')
    expect(resolved.narrativeOnlyBeats).toEqual([])
    expect(resolved.warnings.some(warning => warning.includes('disconnected'))).toBe(false)
  })

  it('keeps the beat narrative-only when every matching channel is offline', () => {
    const registry = snapshot(
      device('dead', [channel('a', 'chest')], 'disconnected'),
      device('gone', [channel('a', 'chest')], 'failed'),
    )
    const fixture = plan([
      levelBeat('b1', { intentId: 'probe-touch', regions: ['chest'], strength: 'low' }),
    ])

    const resolved = resolvePlan(fixture, context(registry))

    expect(resolved.commands).toEqual([])
    expect(resolved.narrativeOnlyBeats).toEqual(['b1'])
    expect(resolved.warnings.some(warning => warning.includes('disconnected'))).toBe(true)
  })

  it('sends to the ready device and leaves the offline one narrative-only', () => {
    const registry = snapshot(
      device('toy', [channel('a', 'chest')]),
      device('dead', [channel('a', 'chest')], 'failed'),
    )
    const fixture = plan([
      levelBeat('b1', {
        regions: ['chest'],
        targets: [
          { deviceId: 'toy', channelId: 'a' },
          { deviceId: 'dead', channelId: 'a' },
        ],
      }),
    ])
    const resolved = resolvePlan(fixture, context(registry))

    expect(resolved.commands.map(command => command.deviceId)).toEqual(['toy'])
    expect(resolved.narrativeOnlyBeats).toEqual([])
    expect(resolved.warnings.some(warning => warning.includes('failed'))).toBe(true)
  })

  it('degrades a missing waveform to a plain pattern', () => {
    const registry = snapshot(device('toy', [channel('a', 'chest', { supportsWaveform: true })]))
    const vanished: FeedbackIntent = {
      ...AMBIENT,
      suggest: { preset: 'wave', waveform: 'nope', durationSec: 30, strength: 'med' },
    }
    const resolved = resolvePlan(
      plan([levelBeat('b1', { regions: ['chest'] })]),
      context(registry, new Map([['ambient-field', vanished]])),
    )
    const command = firstCommand(resolved.commands)

    expect(command.degraded).toBe('unknown-waveform')
    expect(command.body.kind).toBe('pattern')
    if (command.body.kind === 'pattern') expect(command.body.waveformId).toBeUndefined()
  })

  it('degrades a waveform on a channel that cannot play one', () => {
    const registry = snapshot(device('toy', [channel('a', 'chest')]))
    const command = firstCommand(
      resolvePlan(plan([levelBeat('b1', { regions: ['chest'] })]), context(registry)).commands,
    )

    expect(command.degraded).toBe('unsupported-waveform')
    expect(command.body.kind).toBe('pattern')
    if (command.body.kind === 'pattern') expect(command.body.waveformId).toBeUndefined()
  })

  it('reports an unknown intent without throwing', () => {
    const registry = snapshot(device('toy', [channel('a', 'chest')]))
    const resolved = resolvePlan(plan([levelBeat('b1', { intentId: 'vanished' })]), context(registry))

    expect(resolved.commands).toEqual([])
    expect(resolved.narrativeOnlyBeats).toEqual(['b1'])
  })
})

describe('unknown waveform references fall back to the session default', () => {
  const vanished = (): FeedbackIntent => ({
    ...AMBIENT,
    suggest: { preset: 'wave', waveform: 'no-such-waveform', durationSec: 30, strength: 'med' },
  })

  it('uses the configured default waveform on a waveform-capable channel', () => {
    const registry = snapshot(device('toy', [channel('a', 'chest', { supportsWaveform: true })]))
    const resolved = resolvePlan(
      plan([levelBeat('b1', { regions: ['chest'] })]),
      {
        ...context(registry, new Map([['ambient-field', vanished()]])),
        defaultWaveformId: 'tide',
      },
    )
    const command = firstCommand(resolved.commands)

    expect(command.body.kind).toBe('pattern')
    if (command.body.kind === 'pattern') {
      expect(command.body.waveformId).toBe('tide')
      // The intent's envelope is kept: only the texture fallback changed.
      expect(command.body.envelope.preset).toBe('wave')
    }
    // Still reported as a degradation: the requested texture was not played.
    expect(command.degraded).toBe('unknown-waveform')
    expect(resolved.warnings.some(
      warning => warning.includes('using the session default waveform "tide"'),
    )).toBe(true)
  })

  it('keeps the plain pattern when the channel cannot play a waveform', () => {
    const registry = snapshot(device('toy', [channel('a', 'chest')]))
    const resolved = resolvePlan(
      plan([levelBeat('b1', { regions: ['chest'] })]),
      {
        ...context(registry, new Map([['ambient-field', vanished()]])),
        defaultWaveformId: 'tide',
      },
    )
    const command = firstCommand(resolved.commands)

    expect(command.body.kind).toBe('pattern')
    if (command.body.kind === 'pattern') expect(command.body.waveformId).toBeUndefined()
    expect(command.degraded).toBe('unknown-waveform')
    expect(resolved.warnings.some(warning => warning.includes('falling back to a plain pattern'))).toBe(true)
  })

  it('keeps the plain pattern when no default is configured', () => {
    const registry = snapshot(device('toy', [channel('a', 'chest', { supportsWaveform: true })]))
    const command = firstCommand(resolvePlan(
      plan([levelBeat('b1', { regions: ['chest'] })]),
      context(registry, new Map([['ambient-field', vanished()]])),
    ).commands)

    expect(command.body.kind).toBe('pattern')
    if (command.body.kind === 'pattern') expect(command.body.waveformId).toBeUndefined()
    expect(command.degraded).toBe('unknown-waveform')
  })
})

describe('pattern bodies', () => {
  it('builds the envelope from the intent preset and the strength conversion', () => {
    const registry = snapshot(device('toy', [channel('a', 'chest', { supportsWaveform: true })]))
    const command = firstCommand(
      resolvePlan(plan([levelBeat('b1', { regions: ['chest'] })]), context(registry)).commands,
    )

    expect(command.body).toEqual({
      kind: 'pattern',
      envelope: { preset: 'wave', minPercent: 4, maxPercent: 10, periodMs: 4_000, jitter: 0 },
      durationSec: 30,
      waveformId: 'tide',
    })
    expect(command.degraded).toBeUndefined()
  })

  it('plays a waveform change as a steady pattern', () => {
    const registry = snapshot(device('toy', [channel('a', 'chest', { supportsWaveform: true })]))
    const command = firstCommand(
      resolvePlan(
        plan([levelBeat('b1', { regions: ['chest'], change: { kind: 'waveform', waveformId: 'climb', durationSec: 8 } })]),
        context(registry),
      ).commands,
    )

    expect(command.body).toEqual({
      kind: 'pattern',
      envelope: { preset: 'steady', minPercent: 10, maxPercent: 10, periodMs: 1_000, jitter: 0 },
      durationSec: 8,
      waveformId: 'climb',
    })
  })

  it('passes a parsed texture through as pattern modulation', () => {
    const registry = snapshot(device('toy', [channel('a', 'chest', { supportsWaveform: true })]))
    const command = firstCommand(
      resolvePlan(plan([levelBeat('b1', { regions: ['chest'], texture: { rate: 1.5 } })]), context(registry)).commands,
    )

    expect(command.body.kind).toBe('pattern')
    if (command.body.kind === 'pattern') expect(command.body.modulation).toEqual({ rate: 1.5 })
  })

  it('carries a change texture through as pattern modulation', () => {
    // R1: texture lands on the change; it is still only passed through as
    // modulation and never applied in M2 (D16).
    const registry = snapshot(device('toy', [channel('a', 'chest', { supportsWaveform: true })]))
    const command = firstCommand(
      resolvePlan(
        plan([
          levelBeat('b1', {
            intentId: 'plain',
            regions: ['chest'],
            change: { kind: 'waveform', waveformId: 'climb', durationSec: 4, texture: { rate: 1.2 } },
          }),
        ]),
        context(registry, PLAIN_INTENT_MAP),
      ).commands,
    )

    expect(command.body.kind).toBe('pattern')
    if (command.body.kind === 'pattern') expect(command.body.modulation).toEqual({ rate: 1.2 })
  })

  it('resolves the stop intent to a zero level', () => {
    const registry = snapshot(device('toy', [channel('a', 'chest'), channel('b', 'chest')]))
    const resolved = resolvePlan(
      plan([levelBeat('b1', { intentId: 'stop', regions: ['chest'], strength: 'high' })]),
      context(registry),
    )

    expect(resolved.commands.map(command => command.body)).toEqual([
      { kind: 'level', percent: 0, durationSec: 0 },
      { kind: 'level', percent: 0, durationSec: 0 },
    ])
    expect(resolved.commands.every(command => !command.clamped)).toBe(true)
  })
})

describe('looping waveforms sustain across the thinking gap', () => {
  function channelWithCap(maxDurationSec = 60): ResolveChannelSnapshot {
    return channel('a', 'chest', { supportsWaveform: true, maxDurationSec })
  }

  function waveformBeat(waveformId: string, durationSec: number): Beat {
    return levelBeat('b1', {
      intentId: 'plain',
      regions: ['chest'],
      change: { kind: 'waveform', waveformId, durationSec },
    })
  }

  function durationOf(command: ResolvedCommand): number | undefined {
    return command.body.kind === 'waveform' ? undefined : command.body.durationSec
  }

  it('raises a looping pattern to the session sustain hold', () => {
    const { lookup } = sustainLookup()
    const registry = snapshot(device('toy', [channelWithCap()]))
    const command = firstCommand(resolvePlan(
      plan([waveformBeat('loop-sustain', 4)]),
      { ...context(registry, PLAIN_INTENT_MAP), waveforms: lookup, sustainLoopSec: 60 },
    ).commands)

    expect(command.body.kind).toBe('pattern')
    if (command.body.kind === 'pattern') expect(command.body.waveformId).toBe('loop-sustain')
    expect(durationOf(command)).toBe(60)
  })

  it('leaves a non-loop texture short', () => {
    const { lookup } = sustainLookup()
    const registry = snapshot(device('toy', [channelWithCap()]))
    const command = firstCommand(resolvePlan(
      plan([waveformBeat('stinger-burst', 4)]),
      { ...context(registry, PLAIN_INTENT_MAP), waveforms: lookup, sustainLoopSec: 60 },
    ).commands)

    expect(durationOf(command)).toBe(4)
  })

  it('keeps the requested duration when no sustain hold is configured', () => {
    const { lookup } = sustainLookup()
    const registry = snapshot(device('toy', [channelWithCap()]))
    const command = firstCommand(resolvePlan(
      plan([waveformBeat('loop-sustain', 4)]),
      { ...context(registry, PLAIN_INTENT_MAP), waveforms: lookup },
    ).commands)

    expect(durationOf(command)).toBe(4)
  })

  it('never exceeds the channel maximum', () => {
    const { lookup } = sustainLookup()
    const registry = snapshot(device('toy', [channelWithCap(30)]))
    const command = firstCommand(resolvePlan(
      plan([waveformBeat('loop-sustain', 4)]),
      { ...context(registry, PLAIN_INTENT_MAP), waveforms: lookup, sustainLoopSec: 60 },
    ).commands)

    expect(durationOf(command)).toBe(30)
  })

  it('does not extend level or stop commands', () => {
    const { lookup } = sustainLookup()
    const registry = snapshot(device('toy', [channel('a', 'chest', { supportsWaveform: true })]))
    const ctx: ResolveContext = {
      ...context(registry, PLAIN_INTENT_MAP),
      waveforms: lookup,
      sustainLoopSec: 60,
    }

    const level = firstCommand(resolvePlan(
      plan([levelBeat('b1', { intentId: 'plain', regions: ['chest'], change: { kind: 'level', durationSec: 4 } })]),
      ctx,
    ).commands)
    expect(level.body).toEqual({ kind: 'level', percent: 10, durationSec: 4 })

    const stop = firstCommand(resolvePlan(
      plan([levelBeat('b2', { intentId: 'stop', regions: ['chest'] })]),
      { ...context(registry), waveforms: lookup, sustainLoopSec: 60 },
    ).commands)
    expect(stop.body).toEqual({ kind: 'level', percent: 0, durationSec: 0 })
  })

  it('does not leak a sustained loop hold into a later level body', () => {
    const { lookup } = sustainLookup()
    const registry = snapshot(device('toy', [channelWithCap()]))
    const resolved = resolvePlan(
      plan([
        levelBeat('b1', {
          intentId: 'plain',
          regions: ['chest'],
          change: { kind: 'waveform', waveformId: 'loop-sustain', durationSec: 4 },
        }),
        levelBeat('b2', {
          intentId: 'plain',
          regions: ['chest'],
          change: { kind: 'level', durationSec: 5 },
        }),
      ]),
      { ...context(registry, PLAIN_INTENT_MAP), waveforms: lookup, sustainLoopSec: 60 },
    )

    expect(resolved.commands).toHaveLength(1)
    const command = firstCommand(resolved.commands)
    expect(command.beatId).toBe('b2')
    // The surviving body is a level; the superseded loop's 60 s sustain must
    // not extend it through the merge (ui-v12-review §P2-1).
    expect(command.body).toMatchObject({ kind: 'level', durationSec: 5 })
  })

  it('sustains a loop that survives the merge', () => {
    const { lookup } = sustainLookup()
    const registry = snapshot(device('toy', [channelWithCap()]))
    const resolved = resolvePlan(
      plan([
        levelBeat('b1', {
          intentId: 'plain',
          regions: ['chest'],
          change: { kind: 'waveform', waveformId: 'loop-sustain', durationSec: 4 },
        }),
        levelBeat('b2', {
          intentId: 'plain',
          regions: ['chest'],
          change: { kind: 'waveform', waveformId: 'loop-sustain', durationSec: 6 },
        }),
      ]),
      { ...context(registry, PLAIN_INTENT_MAP), waveforms: lookup, sustainLoopSec: 60 },
    )

    expect(resolved.commands).toHaveLength(1)
    const command = firstCommand(resolved.commands)
    expect(command.beatId).toBe('b2')
    if (command.body.kind === 'pattern') expect(command.body.waveformId).toBe('loop-sustain')
    expect(durationOf(command)).toBe(60)
  })

  it('leaves a non-loop final body at the merged hold', () => {
    const { lookup } = sustainLookup()
    const registry = snapshot(device('toy', [channelWithCap()]))
    const resolved = resolvePlan(
      plan([
        levelBeat('b1', {
          intentId: 'plain',
          regions: ['chest'],
          change: { kind: 'waveform', waveformId: 'loop-sustain', durationSec: 4 },
        }),
        levelBeat('b2', {
          intentId: 'plain',
          regions: ['chest'],
          change: { kind: 'waveform', waveformId: 'stinger-burst', durationSec: 6 },
        }),
      ]),
      { ...context(registry, PLAIN_INTENT_MAP), waveforms: lookup, sustainLoopSec: 60 },
    )

    expect(resolved.commands).toHaveLength(1)
    const command = firstCommand(resolved.commands)
    expect(command.beatId).toBe('b2')
    if (command.body.kind === 'pattern') expect(command.body.waveformId).toBe('stinger-burst')
    // Non-loop stays short even though the superseded beat was a loop.
    expect(durationOf(command)).toBe(6)
  })
})

describe('waveform references resolve to dispatchable canonical ids', () => {
  it('returns the canonical id for bare, builtin: and namespaced references', () => {
    const registry = snapshot(device('toy', [channel('a', 'chest', { supportsWaveform: true })]))
    const { lookup, library } = packLookup()
    const cases = [
      // The model / intent may write any of the three shapes; the host library
      // only answers to the canonical one.
      { reference: 'tentacle-crawl', expected: PACK_WAVEFORM_ID },
      { reference: 'builtin:tide', expected: 'tide' },
      { reference: PACK_WAVEFORM_ID, expected: PACK_WAVEFORM_ID },
    ] as const

    for (const { reference, expected } of cases) {
      const intent: FeedbackIntent = {
        ...AMBIENT,
        suggest: { preset: 'wave', waveform: reference, durationSec: 30, strength: 'med' },
      }
      const command = firstCommand(resolvePlan(
        plan([levelBeat('b1', { regions: ['chest'] })]),
        { ...context(registry, new Map([['ambient-field', intent]])), waveforms: lookup },
      ).commands)

      expect(command.degraded).toBeUndefined()
      expect(command.body.kind).toBe('pattern')
      if (command.body.kind === 'pattern') expect(command.body.waveformId).toBe(expected)
      // This is exactly what dispatch (`registry.setWaveform` → `require`) asks
      // for; echoing the request reference instead failed with UNKNOWN_WAVEFORM.
      expect(library.require(expected)).toBeDefined()
    }
  })

  it('canonicalizes a change waveform reference too', () => {
    const registry = snapshot(device('toy', [channel('a', 'chest', { supportsWaveform: true })]))
    const { lookup } = packLookup()
    const command = firstCommand(resolvePlan(
      plan([
        levelBeat('b1', {
          intentId: 'plain',
          regions: ['chest'],
          change: { kind: 'waveform', waveformId: 'tentacle-crawl', durationSec: 4 },
        }),
      ]),
      { ...context(registry, PLAIN_INTENT_MAP), waveforms: lookup },
    ).commands)

    expect(command.degraded).toBeUndefined()
    expect(command.body.kind).toBe('pattern')
    if (command.body.kind === 'pattern') expect(command.body.waveformId).toBe(PACK_WAVEFORM_ID)
  })
})

describe('region aliases bridge pack vocabulary and player-named channels', () => {
  const ALIASES = new Map([['inner-thigh', ['阴蒂']]])

  /** The pack declares `inner-thigh`; the player labelled the channel `阴蒂`. */
  function aliasRegistry(): ResolveRegistrySnapshot {
    return snapshot(device('toy', [channel('clit', '阴蒂'), channel('thigh', '大腿内侧')]))
  }

  it('routes a pack region id to the aliased channel instead of falling back', () => {
    const resolved = resolvePlan(
      plan([levelBeat('b1', { intentId: 'plain', regions: ['inner-thigh'] })]),
      context(aliasRegistry(), PLAIN_INTENT_MAP, undefined, ALIASES),
    )

    expect(resolved.commands.map(command => command.channelId)).toEqual(['clit'])
    expect(resolved.commands[0]?.degraded).toBeUndefined()
    expect(resolved.warnings.some(warning => warning.includes('falling back'))).toBe(false)
  })

  it('falls back to every online channel when no alias is declared', () => {
    const resolved = resolvePlan(
      plan([levelBeat('b1', { intentId: 'plain', regions: ['inner-thigh'] })]),
      context(aliasRegistry(), PLAIN_INTENT_MAP),
    )

    expect(resolved.commands.map(command => command.channelId)).toEqual(['clit', 'thigh'])
    expect(resolved.commands.every(command => command.degraded === 'no-region-match')).toBe(true)
    expect(resolved.warnings.some(warning => warning.includes('falling back'))).toBe(true)
  })

  it('does not match when an alias exists for the region but names another part', () => {
    const resolved = resolvePlan(
      plan([levelBeat('b1', { intentId: 'plain', regions: ['inner-thigh'] })]),
      context(aliasRegistry(), PLAIN_INTENT_MAP, undefined, new Map([['inner-thigh', ['胸口']]])),
    )

    expect(resolved.commands.map(command => command.channelId)).toEqual(['clit', 'thigh'])
    expect(resolved.commands.every(command => command.degraded === 'no-region-match')).toBe(true)
  })
})
