import { describe, expect, it } from 'vitest'
import {
  parseBeatPlan,
  WHOLE_BODY_REGION,
  type Beat,
  type BeatChange,
  type PlanContext,
  type PlanValidation,
} from '../src/scenario/beat-plan.ts'
import type { FeedbackIntent } from '../src/scenario/intents.ts'

function intent(id: string): FeedbackIntent {
  return { id, meaning: id, regions: ['whole-body'] }
}

/** Two intents are enough: `probe-touch` is valid, everything else is not. */
const INTENTS: ReadonlyMap<string, FeedbackIntent> = new Map([
  ['probe-touch', intent('probe-touch')],
  ['ambient-field', intent('ambient-field')],
])

/** Engine fields arrive through the context (R3); the raw plan is model output. */
const CTX: PlanContext = { intents: INTENTS, regions: ['whole-body', 'chest'], turnId: 7, phase: 'probe' }

function rawBeat(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: 'b1', intentId: 'probe-touch', regions: ['chest'], strength: 'low', ...overrides }
}

function rawPlan(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    pacing: 'probe',
    beats: [rawBeat()],
    ...overrides,
  }
}

function firstBeat(result: PlanValidation): Beat {
  const beat = result.plan.beats[0]
  if (beat === undefined) throw new Error('expected a parsed beat')
  return beat
}

describe('parseBeatPlan only drops what the contract rejects', () => {
  it('accepts a phase transition request and trims its id', () => {
    const result = parseBeatPlan(rawPlan({ advanceTo: ' peak ' }), CTX)
    expect(result.plan.advanceTo).toBe('peak')
    expect(result.warnings).toEqual([])
    // The host still validates the edge; the parser only keeps the request.
    expect(result.plan.phase).toBe('probe')
  })

  it('warns and ignores a malformed advanceTo instead of dropping the plan', () => {
    const numeric = parseBeatPlan(rawPlan({ advanceTo: 42 }), CTX)
    expect(numeric.plan.advanceTo).toBeUndefined()
    expect(numeric.plan.beats).toHaveLength(1)
    expect(numeric.warnings).toContainEqual(expect.stringContaining('advanceTo must be a non-empty phase id'))

    const blank = parseBeatPlan(rawPlan({ advanceTo: '   ' }), CTX)
    expect(blank.plan.advanceTo).toBeUndefined()
    expect(blank.warnings).toContainEqual(expect.stringContaining('advanceTo must be a non-empty phase id'))
  })
  it('drops an unknown intent and keeps the remaining beats', () => {
    const result = parseBeatPlan(
      rawPlan({
        beats: [
          rawBeat({ id: 'b1' }),
          rawBeat({ id: 'b2', intentId: 'push' }),
          rawBeat({ id: 'b3', intentId: 'ambient-field' }),
        ],
      }),
      CTX,
    )

    expect(result.plan.beats.map(beat => beat.id)).toEqual(['b1', 'b3'])
    expect(result.dropped).toContainEqual({
      beatId: 'b2',
      rule: 'intent',
      reason: 'unknown intentId "push"',
    })
  })

  it('returns an empty plan when every beat is invalid', () => {
    const result = parseBeatPlan(
      rawPlan({
        beats: [rawBeat({ id: 'b1', intentId: 'push' }), rawBeat({ id: 'b2', strength: 'insane' })],
      }),
      CTX,
    )

    expect(result.plan.beats).toEqual([])
    expect(result.plan.pacing).toBe('probe')
    expect(result.dropped.map(drop => drop.rule).sort()).toEqual(['intent', 'strength'])
  })

  it('rejects more than three choices or a choice longer than 20 characters', () => {
    const labels = ['按住他', '什么也不做', '往后缩', '喊出声']
    const tooMany = parseBeatPlan(
      rawPlan({
        choices: labels.map((label, index) => ({ id: `c${index + 1}`, label, tag: 'passive' })),
      }),
      CTX,
    )

    expect(tooMany.plan.choices?.map(choice => choice.id)).toEqual(['c1', 'c2', 'c3'])
    expect(tooMany.dropped).toContainEqual(
      expect.objectContaining({ choiceId: 'c4', rule: 'choices' }),
    )

    const twenty = 'あ'.repeat(20)
    const atLimit = parseBeatPlan(rawPlan({ choices: [{ id: 'c1', label: twenty, tag: 'resist' }] }), CTX)
    expect(atLimit.plan.choices?.[0]?.label).toBe(twenty)

    const tooLong = 'あ'.repeat(21)
    const rejected = parseBeatPlan(rawPlan({ choices: [{ id: 'c1', label: tooLong, tag: 'resist' }] }), CTX)
    expect(rejected.plan.choices).toBeUndefined()
    expect(rejected.dropped).toContainEqual(
      expect.objectContaining({ choiceId: 'c1', rule: 'choices', reason: expect.stringContaining('20') }),
    )
  })

  it('inherits target fields from the beat unless overridden', () => {
    const beatChange: BeatChange = { kind: 'level', deltaPercent: 5 }
    const result = parseBeatPlan(
      rawPlan({
        beats: [
          rawBeat({
            id: 'b1',
            strength: 'med',
            change: beatChange,
            targets: [
              { deviceId: 'toy', channelId: 'a' },
              { deviceId: 'toy', channelId: 'b', strength: 'high', change: { kind: 'level', deltaPercent: -3 } },
            ],
          }),
        ],
      }),
      CTX,
    )

    const beat = firstBeat(result)
    expect(beat.targets).toEqual([
      { deviceId: 'toy', channelId: 'a', strength: 'med', change: { kind: 'level', deltaPercent: 5 } },
      { deviceId: 'toy', channelId: 'b', strength: 'high', change: { kind: 'level', deltaPercent: -3 } },
    ])
  })
})

describe('parseBeatPlan never throws', () => {
  it('degrades any non-object input to an empty plan', () => {
    for (const raw of [undefined, null, 42, 'plan', [], true]) {
      const result = parseBeatPlan(raw, CTX)
      expect(result.plan.beats).toEqual([])
      expect(result.dropped[0]?.rule).toBe('plan')
    }
  })

  it('drops the whole plan when pacing is not one of the four values', () => {
    const result = parseBeatPlan(rawPlan({ pacing: 'sprint' }), CTX)

    expect(result.plan.beats).toEqual([])
    expect(result.dropped).toContainEqual(
      expect.objectContaining({ rule: 'pacing', reason: expect.stringContaining('sprint') }),
    )
  })

  it('survives a thawed plan from JSON.parse', () => {
    const raw = JSON.parse(JSON.stringify(rawPlan())) as unknown
    expect(() => parseBeatPlan(raw, CTX)).not.toThrow()
    expect(parseBeatPlan(raw, CTX).plan.beats).toHaveLength(1)
  })
})

describe('beats, ids and counts', () => {
  it('takes turnId and phase from the engine context, never from the model output', () => {
    const result = parseBeatPlan(rawPlan({ turnId: 999, phase: 'peak' }), CTX)

    // R3: forged copies are ignored; the engine context wins.
    expect(result.plan.turnId).toBe(7)
    expect(result.plan.phase).toBe('probe')
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining('engine field "turnId" was ignored'),
        expect.stringContaining('engine field "phase" was ignored'),
      ]),
    )
  })

  it('defaults engine fields silently when the context supplies none', () => {
    const noEngineContext: PlanContext = { intents: INTENTS, regions: ['whole-body', 'chest'] }
    const result = parseBeatPlan({ pacing: 'probe', beats: [rawBeat()] }, noEngineContext)

    expect(result.plan.turnId).toBe(0)
    expect(result.plan.phase).toBe('')
    // Callers without an engine context must not see warnings: `warnings` only
    // ever describes model output.
    expect(result.warnings).toEqual([])
  })

  it('keeps at most three beats and drops the rest with a warning', () => {
    const beats = ['b1', 'b2', 'b3', 'b4'].map(id => rawBeat({ id }))
    const result = parseBeatPlan(rawPlan({ beats }), CTX)

    expect(result.plan.beats.map(beat => beat.id)).toEqual(['b1', 'b2', 'b3'])
    expect(result.dropped).toContainEqual(expect.objectContaining({ beatId: 'b4', rule: 'beats' }))
  })

  it('drops a beat with no id or a duplicate id', () => {
    const result = parseBeatPlan(
      rawPlan({ beats: [rawBeat({ id: 'b1' }), rawBeat({ id: 'b1' }), rawBeat({ id: undefined })] }),
      CTX,
    )

    expect(result.plan.beats).toHaveLength(1)
    const rules = result.dropped.map(drop => drop.rule)
    expect(rules).toEqual(['beat', 'beat'])
    expect(result.dropped[0]?.reason).toContain('duplicate')
  })

  it('never accepts an empty beats array as a plan', () => {
    const result = parseBeatPlan(rawPlan({ beats: [] }), CTX)

    expect(result.plan.beats).toEqual([])
    expect(result.dropped).toContainEqual(expect.objectContaining({ rule: 'beats' }))
  })
})

describe('regions degrade instead of rejecting the beat', () => {
  it('keeps declared regions and warns about undeclared ones', () => {
    const result = parseBeatPlan(rawPlan({ beats: [rawBeat({ regions: ['chest', 'tail', 'chest'] })] }), CTX)

    expect(firstBeat(result).regions).toEqual(['chest'])
    expect(result.warnings.some(warning => warning.includes('tail'))).toBe(true)
    expect(result.dropped).toContainEqual(
      expect.objectContaining({ beatId: 'b1', rule: 'region', reason: expect.stringContaining('tail') }),
    )
  })

  it('falls back to whole-body when every region is unknown', () => {
    const result = parseBeatPlan(rawPlan({ beats: [rawBeat({ regions: ['tail'] })] }), CTX)

    expect(firstBeat(result).regions).toEqual([WHOLE_BODY_REGION])
    expect(result.plan.beats).toHaveLength(1)
    expect(result.dropped.some(drop => drop.rule === 'region')).toBe(true)
  })

  it('falls back to whole-body when regions is missing entirely', () => {
    const raw = rawBeat()
    delete raw['regions']
    const result = parseBeatPlan(rawPlan({ beats: [raw] }), CTX)

    expect(firstBeat(result).regions).toEqual([WHOLE_BODY_REGION])
    expect(result.dropped.some(drop => drop.rule === 'region')).toBe(true)
  })
})

describe('change, targets and texture validation', () => {
  it('drops an invalid level change and falls back to the suggestion', () => {
    const result = parseBeatPlan(rawPlan({ beats: [rawBeat({ change: { kind: 'level', deltaPercent: 99 } })] }), CTX)

    expect(firstBeat(result).change).toEqual({ kind: 'level' })
    expect(result.dropped).toContainEqual(expect.objectContaining({ rule: 'change' }))
  })

  it('accepts a level change with neither targetPercent nor deltaPercent', () => {
    const result = parseBeatPlan(rawPlan({ beats: [rawBeat({ change: { kind: 'level' } })] }), CTX)

    expect(firstBeat(result).change).toEqual({ kind: 'level' })
    expect(result.dropped.some(drop => drop.rule === 'change')).toBe(false)
  })

  it('keeps the absolute target of a level change', () => {
    const result = parseBeatPlan(
      rawPlan({ beats: [rawBeat({ change: { kind: 'level', targetPercent: 60, durationSec: 8 } })] }),
      CTX,
    )

    expect(firstBeat(result).change).toEqual({ kind: 'level', targetPercent: 60, durationSec: 8 })
  })

  it('drops a waveform change without a waveformId or durationSec', () => {
    const missingId = parseBeatPlan(rawPlan({ beats: [rawBeat({ change: { kind: 'waveform', durationSec: 2 } })] }), CTX)
    const missingDuration = parseBeatPlan(
      rawPlan({ beats: [rawBeat({ change: { kind: 'waveform', waveformId: 'tide' } })] }),
      CTX,
    )

    expect(firstBeat(missingId).change).toBeUndefined()
    expect(firstBeat(missingDuration).change).toBeUndefined()
    expect(missingId.dropped.some(drop => drop.rule === 'change')).toBe(true)
    expect(missingDuration.dropped.some(drop => drop.rule === 'change')).toBe(true)
  })

  it('accepts a complete waveform change', () => {
    const result = parseBeatPlan(
      rawPlan({ beats: [rawBeat({ change: { kind: 'waveform', waveformId: 'tide', durationSec: 12 } })] }),
      CTX,
    )

    expect(firstBeat(result).change).toEqual({ kind: 'waveform', waveformId: 'tide', durationSec: 12 })
  })

  it('drops duplicate or malformed targets', () => {
    const result = parseBeatPlan(
      rawPlan({
        beats: [
          rawBeat({
            targets: [
              { deviceId: 'toy', channelId: 'a' },
              { deviceId: 'toy', channelId: 'a' },
              { deviceId: 'toy' },
              { deviceId: '', channelId: 'b' },
            ],
          }),
        ],
      }),
      CTX,
    )

    expect(firstBeat(result).targets).toEqual([{ deviceId: 'toy', channelId: 'a', strength: 'low' }])
    expect(result.dropped.filter(drop => drop.rule === 'target')).toHaveLength(3)
  })

  it('parses change.texture as a range-checked field instead of an unknown key', () => {
    // R1 / D9: texture lives on the change. It must not be reported as an
    // unknown change field, and its own range rules still apply.
    const waveformChange = parseBeatPlan(
      rawPlan({
        beats: [
          rawBeat({
            change: { kind: 'waveform', waveformId: 'tide', durationSec: 4, texture: { rate: 1.5, intensityScale: 0.5 } },
          }),
        ],
      }),
      CTX,
    )
    expect(firstBeat(waveformChange).change).toEqual({
      kind: 'waveform',
      waveformId: 'tide',
      durationSec: 4,
      texture: { rate: 1.5, intensityScale: 0.5 },
    })
    expect(waveformChange.warnings.some(warning => warning.includes('unknown change field'))).toBe(false)

    const levelChange = parseBeatPlan(
      rawPlan({ beats: [rawBeat({ change: { kind: 'level', texture: { rate: 9, phaseOffset: 0.25 } } })] }),
      CTX,
    )
    expect(firstBeat(levelChange).change).toEqual({ kind: 'level', texture: { phaseOffset: 0.25 } })
    expect(levelChange.warnings.some(warning => warning.includes('texture.rate'))).toBe(true)
  })

  it('drops illegal texture fields but keeps the rest', () => {
    const result = parseBeatPlan(
      rawPlan({ beats: [rawBeat({ texture: { rate: 5, intensityScale: 0.5, phaseOffset: 2 } })] }),
      CTX,
    )

    expect(firstBeat(result).texture).toEqual({ intensityScale: 0.5 })
    expect(result.warnings.some(warning => warning.includes('texture.rate'))).toBe(true)
  })

  it('keeps mustMention when boolean and ignores other types', () => {
    const result = parseBeatPlan(
      rawPlan({ beats: [rawBeat({ id: 'b1', mustMention: true }), rawBeat({ id: 'b2', mustMention: 'yes' })] }),
      CTX,
    )

    expect(result.plan.beats[0]?.mustMention).toBe(true)
    expect(result.plan.beats[1]?.mustMention).toBeUndefined()
    expect(result.warnings.some(warning => warning.includes('mustMention'))).toBe(true)
  })
})

describe('choices and lineGuidance', () => {
  it('drops choices with digits or a duplicate label', () => {
    const result = parseBeatPlan(
      rawPlan({
        choices: [
          { id: 'c1', label: '按住3秒', tag: 'resist' },
          { id: 'c2', label: '什么也不做', tag: 'passive' },
          { id: 'c3', label: '什么也不做', tag: 'passive' },
          { id: 'c4', label: '往后缩', tag: '' },
        ],
      }),
      CTX,
    )

    expect(result.plan.choices).toEqual([{ id: 'c2', label: '什么也不做', tag: 'passive' }])
    expect(result.dropped.filter(drop => drop.rule === 'choices')).toHaveLength(3)
  })

  it('filters lineGuidance.mustMentionBeatIds to existing beats and warns', () => {
    const result = parseBeatPlan(
      rawPlan({
        beats: [rawBeat({ id: 'b1' })],
        lineGuidance: { tone: 'steady', mustMentionBeatIds: ['b1', 'b9'] },
      }),
      CTX,
    )

    expect(result.plan.lineGuidance).toEqual({ tone: 'steady', mustMentionBeatIds: ['b1'] })
    expect(result.warnings.some(warning => warning.includes('b9'))).toBe(true)
  })

  it('ignores an unusable nextTurnAfterSec', () => {
    const kept = parseBeatPlan(rawPlan({ nextTurnAfterSec: 20 }), CTX)
    const ignored = parseBeatPlan(rawPlan({ nextTurnAfterSec: -5 }), CTX)

    expect(kept.plan.nextTurnAfterSec).toBe(20)
    expect(ignored.plan.nextTurnAfterSec).toBeUndefined()
    expect(ignored.warnings.some(warning => warning.includes('nextTurnAfterSec'))).toBe(true)
  })

  it('ignores unknown top-level fields and says so', () => {
    const result = parseBeatPlan(
      { ...rawPlan(), line: '台词不应出现在 plan 里', beats: [rawBeat()] },
      CTX,
    )

    expect('line' in result.plan).toBe(false)
    expect(result.warnings.some(warning => warning.includes('line'))).toBe(true)
  })
})
