import { describe, expect, it } from 'vitest'
import { WaveformLibrary, type DeviceLifecycle } from '../src/index.ts'
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
} from '../src/scenario/intents.ts'

const WAVEFORMS = new WaveformLibrary()

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
    maxPercent: overrides.maxPercent ?? 20,
    maxWaveIntensity: 80,
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
): ResolveContext {
  return {
    snapshot: registry,
    intents,
    regions: ['whole-body', 'chest', 'inner-thigh'],
    waveforms: WAVEFORMS,
    ...(roundRobinCursor === undefined ? {} : { roundRobinCursor }),
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
    expect(first.commands.map(command => command.channelId)).toEqual(['a', 'b', 'a'])
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

describe('clamping and the strength conversion', () => {
  it('clamps a high-strength beat to the channel cap and marks it clamped', () => {
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
    expect(command.body).toEqual({ kind: 'level', percent: 20, durationSec: 2 })
    expect(command.clamped).toBe(true)
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
    expect(firstCommand(absolute.commands).body).toEqual({ kind: 'level', percent: 10, durationSec: 2 })

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
    expect(firstCommand(relative.commands).body).toEqual({ kind: 'level', percent: 20, durationSec: 2 })
    expect(firstCommand(relative.commands).clamped).toBe(true)

    const strengthOnly = resolvePlan(
      plan([levelBeat('b1', { intentId: 'plain', regions: ['chest'], strength: 'med', change: { kind: 'level' } })]),
      ctx,
    )
    expect(firstCommand(strengthOnly.commands).body).toEqual({ kind: 'level', percent: 14, durationSec: 2 })
    expect(firstCommand(strengthOnly.commands).clamped).toBe(false)
  })

  it('clamps the duration to the channel policy', () => {
    const registry = snapshot(device('toy', [channel('a', 'chest', { maxDurationSec: 10 })]))
    const command = firstCommand(resolvePlan(plan([levelBeat('b1', { regions: ['chest'] })]), context(registry)).commands)

    expect(durationOf(command.body)).toBe(10)
    expect(command.clamped).toBe(true)
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
    expect(commands.get('a')?.body).toEqual({ kind: 'level', percent: 20, durationSec: 2 })
    // Target `b` overrides the change too: deltaPercent is relative to its own
    // current snapshot percent (30), so 40 is the target, not clamped.
    expect(commands.get('b')?.body).toEqual({ kind: 'level', percent: 40, durationSec: 2 })
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

describe('pattern bodies', () => {
  it('builds the envelope from the intent preset and the strength conversion', () => {
    const registry = snapshot(device('toy', [channel('a', 'chest', { supportsWaveform: true })]))
    const command = firstCommand(
      resolvePlan(plan([levelBeat('b1', { regions: ['chest'] })]), context(registry)).commands,
    )

    expect(command.body).toEqual({
      kind: 'pattern',
      envelope: { preset: 'wave', minPercent: 5, maxPercent: 14, periodMs: 4_000, jitter: 0 },
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
      envelope: { preset: 'steady', minPercent: 14, maxPercent: 14, periodMs: 1_000, jitter: 0 },
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
