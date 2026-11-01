import { describe, expect, it } from 'vitest'
import type { ProbeRecord, ProbeTarget, ProbeVerdict } from '../src/sensors/probe.ts'
import {
  probeDirectorJson,
  probeWriterBrief,
} from '../src/sensors/probe-projection.ts'
import type { FeatureWindowStats } from '../src/sensors/types.ts'

const TARGETS: readonly ProbeTarget[] = [{ deviceId: 'coyote-1', channelId: 'A' }]

const BASELINE: FeatureWindowStats = {
  samples: 3,
  quality: 'ok',
  motionEnergyMean: 0.05,
  motionPeak: 0.07,
  audioLevelMeanPct: 12,
  audioPeakPct: 14,
}

const WINDOW: FeatureWindowStats = {
  samples: 6,
  quality: 'ok',
  motionEnergyMean: 0.14,
  motionPeak: 0.22,
  audioLevelMeanPct: 31,
  audioPeakPct: 41,
}

const DELTA: Readonly<Record<ProbeVerdict, ProbeRecord['delta']>> = {
  responded: { motion: 0.17, audioPct: 29 },
  none: { motion: 0.01, audioPct: 2 },
  ambiguous: { motion: 0.2, audioPct: 40 },
  unavailable: undefined,
}

interface RecordOverrides {
  readonly probeId?: string
  readonly beatId?: string
  readonly intentId?: string
  readonly verdict?: ProbeVerdict
  readonly delta?: ProbeRecord['delta']
  readonly reason?: ProbeRecord['reason']
  readonly targets?: readonly ProbeTarget[]
}

function probeRecord(overrides: RecordOverrides = {}): ProbeRecord {
  const verdict = overrides.verdict ?? 'responded'
  const reason = overrides.reason
    ?? (verdict === 'unavailable' ? 'stale' : verdict === 'ambiguous' ? 'baseline-high' : undefined)
  const seen = verdict !== 'unavailable'
  return {
    probeId: overrides.probeId ?? 'p-0001',
    turnId: 7,
    beatId: overrides.beatId ?? 'b1',
    intentId: overrides.intentId ?? 'probe-touch',
    trigger: 'passive',
    actionAt: 1_000,
    targets: overrides.targets ?? TARGETS,
    baseline: seen ? BASELINE : undefined,
    window: seen ? WINDOW : undefined,
    delta: overrides.delta !== undefined ? overrides.delta : DELTA[verdict],
    verdict,
    ...(reason === undefined ? {} : { reason }),
  }
}

const RESPONDED_SENTENCE = '刚才那一下，对方明显有反应。'
const NONE_SENTENCE = '刚才那一下，对方几乎没有反应。'
const AMBIGUOUS_SENTENCE = '对方刚动过，说不清那是反应还是动作。'
const UNAVAILABLE_SENTENCE = '（对方似乎暂时不在画面/没有佩戴）'

describe('probe projection', () => {
  it('renders the writer brief without any digit', () => {
    const records = [
      probeRecord({ probeId: 'p-0001', beatId: 'b1', verdict: 'responded' }),
      probeRecord({ probeId: 'p-0002', beatId: 'b2', intentId: 'probe-tease', verdict: 'none' }),
      probeRecord({ probeId: 'p-0003', beatId: 'b3', verdict: 'ambiguous' }),
      probeRecord({ probeId: 'p-0004', beatId: 'b4', verdict: 'unavailable' }),
    ]

    const brief = probeWriterBrief(records)
    // The contract is literal: no Arabic digit of any script reaches the writer.
    expect(brief).not.toMatch(/\p{Nd}/u)
    expect(brief).not.toContain('%')
    // Nor do ids, reasons or measurement vocabulary leak into the prose.
    expect(brief).not.toMatch(/p-000|b[1-4]|probe-touch|probe-tease|motion|audio|baseline/i)
  })

  it('maps each verdict to one fixed narrative sentence', () => {
    expect(probeWriterBrief([probeRecord({ verdict: 'responded' })])).toBe(RESPONDED_SENTENCE)
    expect(probeWriterBrief([probeRecord({ verdict: 'none' })])).toBe(NONE_SENTENCE)
    expect(probeWriterBrief([probeRecord({ verdict: 'ambiguous' })])).toBe(AMBIGUOUS_SENTENCE)
    expect(probeWriterBrief([probeRecord({ verdict: 'unavailable' })])).toBe(UNAVAILABLE_SENTENCE)

    // The template is deterministic: same record, same sentence, every time.
    expect(probeWriterBrief([probeRecord({ verdict: 'responded' })]))
      .toBe(probeWriterBrief([probeRecord({ verdict: 'responded' })]))

    // One sentence per record, oldest first.
    expect(probeWriterBrief([
      probeRecord({ verdict: 'none' }),
      probeRecord({ verdict: 'responded' }),
    ])).toBe(`${NONE_SENTENCE}\n${RESPONDED_SENTENCE}`)

    expect(probeWriterBrief([])).toBe('')
  })

  it('maps unavailable to a no-camera sentence, never a negative one', () => {
    const brief = probeWriterBrief([probeRecord({ verdict: 'unavailable', reason: 'stale' })])
    expect(brief).toBe(UNAVAILABLE_SENTENCE)
    expect(brief).toContain('暂时不在画面')
    expect(brief).toContain('没有佩戴')

    // "Can't see the body" is an absent fact, not a judgement about the player.
    expect(brief).not.toMatch(/没反应|没有反应|拒绝|冷漠|冷淡|失望|讨厌|不感兴趣/)
    // And it must stay distinct from a measured non-reaction.
    expect(brief).not.toBe(probeWriterBrief([probeRecord({ verdict: 'none' })]))
  })

  it('keeps structured facts and raw deltas for the director', () => {
    const records = [
      probeRecord({ probeId: 'p-0001', beatId: 'b1', verdict: 'responded' }),
      probeRecord({ probeId: 'p-0002', beatId: 'b2', intentId: 'probe-tease', verdict: 'none' }),
      probeRecord({ probeId: 'p-0003', beatId: 'b3', verdict: 'ambiguous' }),
      probeRecord({ probeId: 'p-0004', beatId: 'b4', verdict: 'unavailable' }),
    ]

    const entries = probeDirectorJson(records)
    expect(entries.map(entry => entry.verdict)).toEqual(['responded', 'none', 'ambiguous', 'unavailable'])
    // `ambiguous` still reports the measured sign; its magnitude stays unknown.
    expect(entries.map(entry => entry.direction)).toEqual(['up', 'flat', 'up', 'unknown'])
    expect(entries.map(entry => entry.magnitude)).toEqual(['medium', 'small', 'unknown', 'unknown'])

    const [first, , ambiguous, unavailable] = entries
    expect(first?.probeId).toBe('p-0001')
    expect(first?.beatId).toBe('b1')
    expect(first?.intentId).toBe('probe-touch')
    expect(first?.targets).toEqual([{ deviceId: 'coyote-1', channelId: 'A' }])
    expect(first?.delta).toEqual({ motion: 0.17, audioPct: 29 })
    expect(first).not.toHaveProperty('reason')
    expect(ambiguous?.reason).toBe('baseline-high')
    expect(unavailable?.reason).toBe('stale')
    expect(unavailable?.delta).toBeUndefined()

    // Numbers are allowed for the director; the writer projection of the same
    // facts must stay digit-free (the two-projection invariant).
    expect(JSON.stringify(entries)).toContain('0.17')
    expect(probeWriterBrief(records)).not.toMatch(/\p{Nd}/u)
  })

  it('bands the delta relative to the default thresholds', () => {
    const magnitude = (motion: number): string | undefined =>
      probeDirectorJson([probeRecord({ delta: { motion, audioPct: 1 } })])[0]?.magnitude
    expect(magnitude(0.07)).toBe('small')
    expect(magnitude(0.16)).toBe('medium')
    expect(magnitude(0.33)).toBe('large')
    // An untrusted verdict never gets a confident band.
    expect(probeDirectorJson([probeRecord({ verdict: 'ambiguous' })])[0]?.magnitude).toBe('unknown')
  })

  it('copies targets instead of exposing the caller array', () => {
    const targets: readonly ProbeTarget[] = [{ deviceId: 'coyote-1', channelId: 'A' }]
    const entries = probeDirectorJson([probeRecord({ targets })])
    expect(entries[0]?.targets).toEqual(targets)
    expect(entries[0]?.targets).not.toBe(targets)
    expect(probeDirectorJson([])).toEqual([])
  })
})
