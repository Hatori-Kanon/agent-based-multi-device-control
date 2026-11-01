import { describe, expect, it } from 'vitest'
import { assertValidEnvelope, MIN_PERIOD_MS, WaveformLibrary, type EnvelopePreset } from '../src/index.ts'
import { parseBeatPlan, type Beat, type BeatPlan, type BeatStrength } from '../src/scenario/beat-plan.ts'
import { DEFAULT_INTENTS, ENVELOPE_DEFAULTS, STRENGTH_RATIO } from '../src/scenario/default-intents.ts'
import {
  resolvePlan,
  type FeedbackIntent,
  type ResolveChannelSnapshot,
  type ResolveContext,
} from '../src/scenario/intents.ts'

const INTENT_MAP: ReadonlyMap<string, FeedbackIntent> = new Map(DEFAULT_INTENTS.map(intent => [intent.id, intent]))
const WAVEFORMS = new WaveformLibrary()

function channel(maxPercent: number): ResolveChannelSnapshot {
  return {
    id: 'a',
    kind: 'level',
    label: 'A 通道',
    supportsWaveform: false,
    outputFloorPercent: 0,
    percent: 0,
    maxPercent,
    maxWaveIntensity: 80,
    maxDurationSec: 60,
    effect: undefined,
    waveform: undefined,
  }
}

function context(intents: ReadonlyMap<string, FeedbackIntent>, maxPercent: number): ResolveContext {
  return {
    snapshot: {
      locked: false,
      lockedReason: undefined,
      devices: [{ id: 'toy', name: 'Mock Toy', lifecycle: 'ready', canScan: false, channels: [channel(maxPercent)] }],
    },
    intents,
    regions: ['whole-body'],
    waveforms: WAVEFORMS,
  }
}

function strengthPlan(strength: BeatStrength): BeatPlan {
  const beat: Beat = { id: 'b1', intentId: 'plain', regions: ['whole-body'], strength }
  return { turnId: 1, phase: 'scene', pacing: 'probe', beats: [beat] }
}

describe('the freeform intent table', () => {
  it('ships the five freeform intents with the documented shapes', () => {
    expect(DEFAULT_INTENTS.map(intent => intent.id)).toEqual([
      'probe-touch',
      'ambient-field',
      'escalate-step',
      'soothe',
      'stop',
    ])

    const byId = new Map(DEFAULT_INTENTS.map(intent => [intent.id, intent]))
    for (const intent of DEFAULT_INTENTS) {
      expect(intent.meaning.length).toBeGreaterThan(0)
      expect(intent.regions).toEqual(['whole-body'])
      expect(intent.suggest).toBeDefined()
      expect(['low', 'med', 'high']).toContain(intent.suggest?.strength)
    }

    // `内容包规范.md` §5 / §4: the documented default distributions.
    expect(byId.get('ambient-field')?.distribution).toBe('synced')
    expect(byId.get('probe-touch')?.distribution).toBe('primary')
    expect(byId.get('escalate-step')?.distribution).toBe('primary')

    // `内容包规范.md` §5 default shapes: 2s pulse, 30s wave, ...
    expect(byId.get('probe-touch')?.suggest).toEqual({ preset: 'pulse', durationSec: 2, strength: 'low' })
    expect(byId.get('ambient-field')?.suggest).toEqual({
      preset: 'wave',
      waveform: 'tide',
      durationSec: 30,
      strength: 'med',
    })
    expect(byId.get('soothe')?.suggest).toEqual({
      preset: 'wave',
      waveform: 'breathing',
      durationSec: 20,
      strength: 'low',
    })
    expect(byId.get('stop')?.suggest).toEqual({ durationSec: 1, strength: 'low' })

    // Every referenced waveform must exist in the builtin library, or a
    // freeform pack would degrade on its very first turn.
    for (const intent of DEFAULT_INTENTS) {
      const waveform = intent.suggest?.waveform
      if (waveform !== undefined) expect(WAVEFORMS.get(waveform)).toBeDefined()
      const duration = intent.suggest?.durationSec
      if (duration !== undefined) {
        expect(duration).toBeGreaterThanOrEqual(1)
        expect(duration).toBeLessThanOrEqual(600)
      }
    }
  })

  it('parses a freeform plan that only uses the default intents', () => {
    const result = parseBeatPlan(
      {
        turnId: 1,
        phase: 'scene',
        pacing: 'probe',
        beats: [
          { id: 'b1', intentId: 'probe-touch', regions: ['whole-body'], strength: 'low' },
          { id: 'b2', intentId: 'ambient-field', regions: ['whole-body'], strength: 'med' },
          { id: 'b3', intentId: 'stop', regions: ['whole-body'], strength: 'low' },
        ],
      },
      { intents: INTENT_MAP, regions: ['whole-body'] },
    )

    expect(result.dropped).toEqual([])
    expect(result.plan.beats.map(beat => beat.intentId)).toEqual(['probe-touch', 'ambient-field', 'stop'])
  })
})

describe('the strength and envelope constants', () => {
  it('maps low/med/high to 40/70/100 percent of the cap', () => {
    // D8 freeze (2026-11-01); the retired draft said 50/80/100.
    expect(STRENGTH_RATIO).toEqual({ low: 0.4, med: 0.7, high: 1 })

    const plain: FeedbackIntent = { id: 'plain', meaning: '无建议', regions: ['whole-body'] }
    const intents = new Map([['plain', plain]])
    const ctx = context(intents, 40)
    const percentOf = (strength: BeatStrength): number | undefined => {
      const body = resolvePlan(strengthPlan(strength), ctx).commands[0]?.body
      return body?.kind === 'level' ? body.percent : undefined
    }

    expect([percentOf('low'), percentOf('med'), percentOf('high')]).toEqual([16, 28, 40])
  })

  it('ships the documented envelope defaults', () => {
    expect(ENVELOPE_DEFAULTS).toEqual({
      steady: { minRatio: 1, periodMs: 1_000, jitter: 0 },
      pulse: { minRatio: 0.35, periodMs: 1_200, jitter: 0 },
      wave: { minRatio: 0.35, periodMs: 4_000, jitter: 0 },
      random: { minRatio: 0.35, periodMs: 2_000, jitter: 10 },
      ramp: { minRatio: 0.35, periodMs: 8_000, jitter: 0 },
    })

    // The table must produce envelopes the safety runtime accepts, otherwise
    // every preset-driven beat would be refused at dispatch time.
    for (const [preset, defaults] of Object.entries(ENVELOPE_DEFAULTS)) {
      expect(defaults.minRatio).toBeGreaterThan(0)
      expect(defaults.minRatio).toBeLessThanOrEqual(1)
      expect(defaults.periodMs).toBeGreaterThanOrEqual(MIN_PERIOD_MS)
      expect(defaults.jitter).toBeGreaterThanOrEqual(0)
      expect(defaults.jitter).toBeLessThanOrEqual(100)
      const envelope = {
        preset: preset as EnvelopePreset,
        minPercent: Math.round(40 * defaults.minRatio),
        maxPercent: 40,
        periodMs: defaults.periodMs,
        jitter: defaults.jitter,
      }
      expect(() => assertValidEnvelope(envelope, 100)).not.toThrow()
    }
  })
})
