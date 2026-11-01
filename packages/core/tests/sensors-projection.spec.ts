import { describe, expect, it } from 'vitest'
import type { ProbeRecord, ProbeVerdict } from '../src/sensors/probe.ts'
import { probeWriterBrief } from '../src/sensors/probe-projection.ts'
import {
  DEFAULT_PROBE_BLOCK_BUDGET,
  DEFAULT_SENSOR_BLOCK_BUDGET,
  probePromptBlock,
  sensorPromptBlock,
  sensorsListPayload,
} from '../src/sensors/projection.ts'
import type { FeatureWindowStats, SensorKind, SensorQuality, SensorStatus } from '../src/sensors/types.ts'

function status(
  id: string,
  kind: SensorKind,
  quality: SensorQuality,
  label: string,
  freshnessMs: number | undefined,
): SensorStatus {
  return {
    id,
    kind,
    label,
    quality,
    lastTs: freshnessMs === undefined ? undefined : 1_000,
    freshnessMs,
  }
}

describe('sensor projection', () => {
  it('renders an empty sensor block when nothing is registered', () => {
    expect(sensorPromptBlock([])).toBe('')
    expect(sensorPromptBlock([], DEFAULT_SENSOR_BLOCK_BUDGET)).toBe('')
    // An empty budget and an empty world are both "no section", never noise.
    expect(sensorPromptBlock([], 0)).toBe('')
    expect(sensorPromptBlock([status('usb-cam-1', 'image', 'ok', 'USB 摄像头', 100)], 0)).toBe('')
  })

  it('keeps the injected block within 200 characters', () => {
    expect(DEFAULT_SENSOR_BLOCK_BUDGET).toBe(200)
    const many: SensorStatus[] = []
    for (let index = 0; index < 20; index += 1) {
      many.push(status(`cam-${index}`, 'image', 'ok', '很长的摄像头名称一号', 400 + index))
    }
    const block = sensorPromptBlock(many)
    expect(block.startsWith('感知：')).toBe(true)
    expect(block.length).toBeLessThanOrEqual(200)
    // Facts are dropped (freshness, then ok sources) before hard truncation.
    expect(block.endsWith('…')).toBe(true)

    // A tight budget goes straight to the actionable sources.
    const mixed = [
      status('cam-1', 'image', 'ok', '摄像头', 400),
      status('mic-1', 'audio', 'stale', '麦克风', 3_000),
    ]
    const tight = sensorPromptBlock(mixed, 20)
    expect(tight.length).toBeLessThanOrEqual(20)
    expect(tight).toContain('无新数据')
    expect(tight).not.toContain('可用')
    expect(tight).not.toContain('s前')
  })

  it('states quality facts only and never an emotion label', () => {
    const block = sensorPromptBlock([
      status('usb-cam-1', 'image', 'dim', 'USB 摄像头', 1_200),
      status('usb-cam-2', 'image', 'blocked', '副摄像头', 800),
      status('mic-1', 'audio', 'stale', '麦克风', 3_000),
    ])

    expect(block).toContain('USB 摄像头')
    expect(block).toContain('偏暗')
    expect(block).toContain('被遮挡')
    expect(block).toContain('无新数据')
    // No inferred feeling, no hedging, no advice — only measured facts.
    expect(block).not.toMatch(/紧张|害怕|焦虑|生气|开心|兴奋|难过|情绪|似乎|可能|大概|推测|建议/)
    expect(block).not.toMatch(/mood|emotion|feeling/i)
  })

  it('skips an hr source and describes audio by volume only', () => {
    const block = sensorPromptBlock([
      status('hr-band-1', 'hr', 'ok', '心率臂带', 500),
      status('mic-1', 'audio', 'ok', '麦克风', 500),
    ])

    expect(block).not.toContain('hr-band-1')
    expect(block).not.toContain('心率臂带')
    expect(block).toContain('麦克风')
    // A microphone has a level, not a picture.
    expect(block).toContain('音量')
    expect(block).not.toContain('画面')
  })

  it('projects one payload entry per source in registration order', () => {
    const payload = sensorsListPayload([
      status('usb-cam-1', 'image', 'ok', 'USB 摄像头', 400),
      status('mic-1', 'audio', 'stale', '麦克风', undefined),
    ])

    expect(payload).toEqual({
      sources: [
        { id: 'usb-cam-1', kind: 'image', label: 'USB 摄像头', quality: 'ok', freshnessMs: 400 },
        { id: 'mic-1', kind: 'audio', label: '麦克风', quality: 'stale', freshnessMs: undefined },
      ],
    })
  })
})

const PROBE_BASELINE: FeatureWindowStats = {
  samples: 3,
  quality: 'ok',
  motionEnergyMean: 0.05,
  motionPeak: 0.07,
  audioLevelMeanPct: 12,
  audioPeakPct: 14,
}

const PROBE_WINDOW: FeatureWindowStats = {
  samples: 6,
  quality: 'ok',
  motionEnergyMean: 0.14,
  motionPeak: 0.22,
  audioLevelMeanPct: 31,
  audioPeakPct: 41,
}

const PROBE_DELTA: Readonly<Record<ProbeVerdict, ProbeRecord['delta']>> = {
  responded: { motion: 0.17, audioPct: 29 },
  none: { motion: 0.01, audioPct: 2 },
  ambiguous: { motion: 0.2, audioPct: 40 },
  unavailable: undefined,
}

interface ProbeRecordOverrides {
  readonly probeId?: string
  readonly beatId?: string
  readonly intentId?: string
  readonly verdict?: ProbeVerdict
  readonly reason?: ProbeRecord['reason']
}

function probeRecord(overrides: ProbeRecordOverrides = {}): ProbeRecord {
  const verdict = overrides.verdict ?? 'responded'
  const reason = overrides.reason ?? (verdict === 'unavailable' ? 'stale' : undefined)
  const seen = verdict !== 'unavailable'
  return {
    probeId: overrides.probeId ?? 'p-0001',
    turnId: 1,
    beatId: overrides.beatId ?? 'b1',
    intentId: overrides.intentId ?? 'probe-touch',
    trigger: 'passive',
    actionAt: 1_000,
    targets: [{ deviceId: 'coyote-1', channelId: 'A' }],
    baseline: seen ? PROBE_BASELINE : undefined,
    window: seen ? PROBE_WINDOW : undefined,
    delta: PROBE_DELTA[verdict],
    verdict,
    ...(reason === undefined ? {} : { reason }),
  }
}

describe('probe prompt block', () => {
  it('adds no probe block at all when no probe was ever registered', () => {
    for (const audience of ['director', 'writer', 'model'] as const) {
      expect(probePromptBlock([], { for: audience })).toBe('')
    }
    // An empty world and a zero budget are both "no section", never noise.
    expect(probePromptBlock([probeRecord()], { for: 'writer', budgetChars: 0 })).toBe('')
    expect(DEFAULT_PROBE_BLOCK_BUDGET).toBe(200)
  })

  it('injects at most the last three probes', () => {
    const records = [
      probeRecord({ probeId: 'p-0001', beatId: 'b-oldest', verdict: 'unavailable', reason: 'stale' }),
      probeRecord({ probeId: 'p-0002', beatId: 'b-2', verdict: 'ambiguous' }),
      probeRecord({ probeId: 'p-0003', beatId: 'b-3', verdict: 'none' }),
      probeRecord({ probeId: 'p-0004', beatId: 'b-newest', verdict: 'responded' }),
    ]

    const writer = probePromptBlock(records, { for: 'writer' })
    // The dropped oldest probe was the only unavailable one, so its sentence
    // must not appear; the remaining three each contribute one line.
    expect(writer).not.toContain('暂时不在画面')
    expect(writer.split('\n')).toHaveLength(3)
    expect(writer).not.toMatch(/\p{Nd}/u)

    const director = probePromptBlock(records, { for: 'director' })
    expect(director).not.toContain('b-oldest')
    expect(director).toContain('b-newest')
    expect(director.split('；')).toHaveLength(3)
    expect(director.length).toBeLessThanOrEqual(DEFAULT_PROBE_BLOCK_BUDGET)

    // The single-call model gets the same digit-free narrative as the writer.
    expect(probePromptBlock(records, { for: 'model' })).toBe(writer)
  })

  it('degrades to narrative when every source is stale', () => {
    const records = [
      probeRecord({ probeId: 'p-0001', beatId: 'b1', verdict: 'unavailable', reason: 'stale' }),
      probeRecord({ probeId: 'p-0002', beatId: 'b2', verdict: 'unavailable', reason: 'stale' }),
      probeRecord({ probeId: 'p-0003', beatId: 'b3', verdict: 'unavailable', reason: 'stale' }),
    ]

    const director = probePromptBlock(records, { for: 'director' })
    // No fake direction/magnitude band: the whole block becomes narrative.
    expect(director).toBe(`探测：${probeWriterBrief(records)}`)
    expect(director).toContain('暂时不在画面')
    expect(director).not.toContain('未知')
    expect(director).not.toContain('b1')
    expect(director).not.toMatch(/\p{Nd}/u)
  })

  it('keeps a mixed batch structured and narrates only the unavailable probe', () => {
    const records = [
      probeRecord({ beatId: 'b1', verdict: 'responded' }),
      probeRecord({ beatId: 'b2', verdict: 'unavailable', reason: 'stale' }),
    ]

    const director = probePromptBlock(records, { for: 'director' })
    expect(director).toContain('b1/probe-touch 有反应')
    expect(director).toContain('暂时不在画面')
    // A probe that saw nothing gets no invented direction/magnitude band.
    expect(director).not.toContain('b2/probe-touch')
    expect(director).not.toContain('未知')
  })

  it('renders the director as compact facts and never leaks digits to writer/model', () => {
    const records = [probeRecord({ verdict: 'responded' })]
    const director = probePromptBlock(records, { for: 'director' })
    expect(director).toContain('b1/probe-touch')
    expect(director).toContain('有反应')
    expect(director).toContain('升')
    expect(director).toContain('中')

    const writer = probePromptBlock(records, { for: 'writer' })
    expect(writer).toBe(`探测：${probeWriterBrief(records)}`)
    expect(writer).not.toMatch(/\p{Nd}/u)
    expect(writer).not.toContain('0.17')
    expect(probePromptBlock(records, { for: 'model' })).toBe(writer)
  })
})
