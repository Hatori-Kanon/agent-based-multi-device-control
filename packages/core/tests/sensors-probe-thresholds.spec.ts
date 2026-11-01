import { describe, expect, it } from 'vitest'
import { FakeClock } from '../src/ports/fake-clock.ts'
import {
  ReactionProbeRecorder,
  type ProbeAction,
  type ProbeRecord,
  type ProbeThresholds,
} from '../src/sensors/probe.ts'
import { SensorRegistry } from '../src/sensors/registry.ts'
import type { FeatureSample, SensorKind, SensorSource } from '../src/sensors/types.ts'

function source(id: string, kind: SensorKind): SensorSource {
  return { id, kind, label: id, latest: () => Promise.resolve(undefined), freshnessMs: () => undefined }
}

interface SampleSpec {
  readonly ts: number
  readonly motionEnergy?: number
  readonly motionPeak?: number
  readonly audioLevelPct?: number
}

function sample(sourceId: string, spec: SampleSpec): FeatureSample {
  return {
    sourceId,
    ts: spec.ts,
    frameAgeMs: 40,
    quality: 'ok',
    ...(spec.motionEnergy === undefined ? {} : { motionEnergy: spec.motionEnergy }),
    ...(spec.motionPeak === undefined ? {} : { motionPeak: spec.motionPeak }),
    ...(spec.audioLevelPct === undefined ? {} : { audioLevelPct: spec.audioLevelPct }),
  }
}

function action(at: number): ProbeAction {
  return {
    turnId: 1,
    beatId: `b-${at}`,
    intentId: 'probe-touch',
    at,
    targets: [{ deviceId: 'coyote-1', channelId: 'A' }],
  }
}

function harness(options: { readonly sources?: readonly SensorSource[]; readonly thresholds?: Partial<ProbeThresholds> } = {}) {
  const clock = new FakeClock(0)
  const registry = new SensorRegistry({ clock })
  for (const entry of options.sources ?? [source('usb-cam-1', 'image')]) registry.register(entry)
  const recorder = new ReactionProbeRecorder({
    clock,
    sensors: registry,
    ...(options.thresholds === undefined ? {} : { thresholds: options.thresholds }),
  })
  return { clock, registry, recorder }
}

function newestRecord(recorder: ReactionProbeRecorder): ProbeRecord {
  const [record] = recorder.recent(1)
  if (record === undefined) throw new Error('expected a settled probe')
  return record
}

/** Baseline at 0/1_000 ms, action at 1_500 ms, one window sample at 1_500 ms. */
function runMotionCase(options: { readonly baselineEnergy: number; readonly windowPeak: number; readonly thresholds?: Partial<ProbeThresholds> }): ProbeRecord {
  const { clock, registry, recorder } = harness(options.thresholds === undefined ? {} : { thresholds: options.thresholds })
  registry.push(sample('usb-cam-1', { ts: 0, motionEnergy: options.baselineEnergy }))
  clock.advance(1_000)
  registry.push(sample('usb-cam-1', { ts: 1_000, motionEnergy: options.baselineEnergy }))
  clock.advance(500)
  registry.push(sample('usb-cam-1', { ts: 1_500, motionEnergy: 0.1, motionPeak: options.windowPeak }))
  expect(recorder.register(action(1_500))).toBe('p-0001')
  clock.advance(2_500)
  return newestRecord(recorder)
}

/** Baseline at 0/1_000 ms, action at 1_500 ms, one window sample at 1_500 ms. */
function runAudioCase(baselinePct: number, windowPeakPct: number): ProbeRecord {
  const { clock, registry, recorder } = harness({ sources: [source('mic-1', 'audio')] })
  registry.push(sample('mic-1', { ts: 0, audioLevelPct: baselinePct }))
  clock.advance(1_000)
  registry.push(sample('mic-1', { ts: 1_000, audioLevelPct: baselinePct }))
  clock.advance(500)
  registry.push(sample('mic-1', { ts: 1_500, audioLevelPct: windowPeakPct }))
  expect(recorder.register(action(1_500))).toBe('p-0001')
  clock.advance(2_500)
  return newestRecord(recorder)
}

describe('reaction probe thresholds and quality gates', () => {
  it('returns ambiguous when the baseline was already moving', () => {
    const { clock, registry, recorder } = harness()
    registry.push(sample('usb-cam-1', { ts: 0, motionEnergy: 0.3, motionPeak: 0.4 }))
    clock.advance(1_000)
    registry.push(sample('usb-cam-1', { ts: 1_000, motionEnergy: 0.35, motionPeak: 0.45 }))
    clock.advance(500)
    registry.push(sample('usb-cam-1', { ts: 1_500, motionEnergy: 0.1, motionPeak: 0.12 }))
    recorder.register(action(1_500))
    clock.advance(2_500)

    const motionRecord = newestRecord(recorder)
    expect(motionRecord.verdict).toBe('ambiguous')
    expect(motionRecord.reason).toBe('baseline-high')
    // The delta is still recorded: it is a fact, the verdict just cannot trust it.
    expect(motionRecord.delta).toBeDefined()

    const audio = harness({ sources: [source('mic-1', 'audio')] })
    audio.registry.push(sample('mic-1', { ts: 0, audioLevelPct: 40 }))
    audio.clock.advance(1_000)
    audio.registry.push(sample('mic-1', { ts: 1_000, audioLevelPct: 45 }))
    audio.clock.advance(500)
    audio.registry.push(sample('mic-1', { ts: 1_500, audioLevelPct: 20 }))
    audio.recorder.register(action(1_500))
    audio.clock.advance(2_500)
    expect(newestRecord(audio.recorder).verdict).toBe('ambiguous')
    expect(newestRecord(audio.recorder).reason).toBe('baseline-high')
  })

  it('returns none when both deltas are below threshold', () => {
    const record = runMotionCase({ baselineEnergy: 0.05, windowPeak: 0.08 })

    expect(record.verdict).toBe('none')
    expect(record.reason).toBeUndefined()
    expect(record.delta?.motion).toBeCloseTo(0.03, 10)
    // Audio was not comparable (motion-only case): it is omitted, not 0-filled.
    expect(record.delta?.audioPct).toBeUndefined()
  })

  it('returns responded on a 0.08 motion delta or a 15% audio delta', () => {
    // Window peak 0.13 - baseline mean 0.05 = exactly 0.08, the threshold.
    const motionRecord = runMotionCase({ baselineEnergy: 0.05, windowPeak: 0.13 })
    expect(motionRecord.delta?.motion).toBeCloseTo(0.08, 10)
    expect(motionRecord.verdict).toBe('responded')

    // Window peak 25 - baseline mean 10 = exactly 15 percentage points.
    const audioRecord = runAudioCase(10, 25)
    expect(audioRecord.delta?.audioPct).toBeCloseTo(15, 10)
    expect(audioRecord.verdict).toBe('responded')
  })

  it('honours injected threshold overrides', () => {
    // The same 0.08 delta misses a stricter motion threshold...
    const strict = runMotionCase({ baselineEnergy: 0.05, windowPeak: 0.13, thresholds: { motionDeltaMin: 0.2 } })
    expect(strict.verdict).toBe('none')

    // ... and a shorter window settles earlier on the injected clock.
    const { clock, registry, recorder } = harness({ thresholds: { windowMs: 1_000 } })
    registry.push(sample('usb-cam-1', { ts: 0, motionEnergy: 0.05 }))
    clock.advance(1_000)
    recorder.register(action(1_000))
    clock.advance(999)
    expect(recorder.recent()).toHaveLength(0)
    clock.advance(1)
    expect(recorder.recent()).toHaveLength(1)
  })

  it('reports unavailable when no sample lands in either window', () => {
    // A fresh sample outside the baseline window keeps the source "ok" at
    // registration, but no data covers the action: the probe is stale.
    const stale = harness()
    stale.registry.push(sample('usb-cam-1', { ts: 0, motionEnergy: 0.05 }))
    stale.clock.advance(2_000)
    stale.recorder.register(action(2_000))
    stale.clock.advance(2_500)
    const staleRecord = newestRecord(stale.recorder)
    expect(staleRecord.verdict).toBe('unavailable')
    expect(staleRecord.reason).toBe('stale')
    expect(staleRecord.baseline).toBeUndefined()
    expect(staleRecord.window).toBeUndefined()
    expect(staleRecord.delta).toBeUndefined()

    // A source that disappears before settling is "no source", not "stale".
    const gone = harness()
    gone.registry.push(sample('usb-cam-1', { ts: 0, motionEnergy: 0.05 }))
    gone.clock.advance(1_000)
    gone.recorder.register(action(1_000))
    gone.registry.unregister('usb-cam-1')
    gone.clock.advance(2_500)
    expect(newestRecord(gone.recorder).verdict).toBe('unavailable')
    expect(newestRecord(gone.recorder).reason).toBe('no-source')
  })

  it('treats a degenerate window as ambiguous', () => {
    // Baseline has samples, the window has none: there is nothing to compare.
    const { clock, registry, recorder } = harness()
    registry.push(sample('usb-cam-1', { ts: 0, motionEnergy: 0.05 }))
    clock.advance(1_000)
    recorder.register(action(1_000))
    clock.advance(2_500)

    const record = newestRecord(recorder)
    expect(record.verdict).toBe('ambiguous')
    expect(record.reason).toBe('degenerate')
    expect(record.baseline?.samples).toBe(1)
    expect(record.window).toBeUndefined()
  })
})

describe('probe comparability (review blocker B-1)', () => {
  it('never compares a window against a baseline the modality never saw', () => {
    // The camera only starts sampling after the action, so the baseline window
    // is empty. A rising window must not be scored as a reaction against an
    // invented zero baseline.
    const { clock, registry, recorder } = harness()
    clock.advance(1_500)
    registry.push(sample('usb-cam-1', { ts: 1_500, motionEnergy: 0, motionPeak: 0.9 }))
    expect(recorder.register(action(1_500))).toBe('p-0001')
    clock.advance(2_500)

    const record = newestRecord(recorder)
    expect(record.verdict).toBe('ambiguous')
    expect(record.reason).toBe('degenerate')
    // No fabricated motion delta.
    expect(record.delta?.motion).toBeUndefined()
  })

  it('keeps a comparable modality usable when the other one appeared late', () => {
    // Audio observed both windows; the camera appeared only in the window.
    const { clock, registry, recorder } = harness({ sources: [source('mic-1', 'audio'), source('usb-cam-1', 'image')] })
    registry.push(sample('mic-1', { ts: 0, audioLevelPct: 10 }))
    clock.advance(1_000)
    registry.push(sample('mic-1', { ts: 1_000, audioLevelPct: 10 }))
    clock.advance(500)
    registry.push(sample('mic-1', { ts: 1_500, audioLevelPct: 40 }))
    registry.push(sample('usb-cam-1', { ts: 1_500, motionEnergy: 0, motionPeak: 0.9 }))
    expect(recorder.register(action(1_500))).toBe('p-0001')
    clock.advance(2_500)

    const record = newestRecord(recorder)
    expect(record.verdict).toBe('responded')
    expect(record.delta?.audioPct).toBeGreaterThanOrEqual(15)
    expect(record.delta?.motion).toBeUndefined()
  })
})
