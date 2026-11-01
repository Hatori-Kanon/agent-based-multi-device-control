import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { ProbeRegistrar } from '../src/execution/executor.ts'
import { FakeClock } from '../src/ports/fake-clock.ts'
import {
  DEFAULT_PROBE_THRESHOLDS,
  ReactionProbeRecorder,
  type ProbeAction,
  type ProbeRecord,
  type ProbeThresholds,
  type ProbeVerdict,
} from '../src/sensors/probe.ts'
import { SensorRegistry } from '../src/sensors/registry.ts'
import type { FeatureSample, SensorKind, SensorQuality, SensorSource } from '../src/sensors/types.ts'

function source(id: string, kind: SensorKind): SensorSource {
  return { id, kind, label: id, latest: () => Promise.resolve(undefined), freshnessMs: () => undefined }
}

interface SampleSpec {
  readonly ts: number
  readonly motionEnergy?: number
  readonly motionPeak?: number
  readonly audioLevelPct?: number
  readonly quality?: SensorQuality
}

function sample(sourceId: string, spec: SampleSpec): FeatureSample {
  return {
    sourceId,
    ts: spec.ts,
    frameAgeMs: 40,
    quality: spec.quality ?? 'ok',
    ...(spec.motionEnergy === undefined ? {} : { motionEnergy: spec.motionEnergy }),
    ...(spec.motionPeak === undefined ? {} : { motionPeak: spec.motionPeak }),
    ...(spec.audioLevelPct === undefined ? {} : { audioLevelPct: spec.audioLevelPct }),
  }
}

function action(at: number, overrides: { turnId?: number; beatId?: string; intentId?: string } = {}): ProbeAction {
  return {
    turnId: overrides.turnId ?? 1,
    beatId: overrides.beatId ?? 'b1',
    intentId: overrides.intentId ?? 'probe-touch',
    at,
    targets: [{ deviceId: 'coyote-1', channelId: 'A' }],
  }
}

interface HarnessOptions {
  readonly sources?: readonly SensorSource[]
  readonly thresholds?: Partial<ProbeThresholds>
}

function harness(options: HarnessOptions = {}) {
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

interface FixtureSample extends SampleSpec {
  readonly sourceId: string
  readonly kind: SensorKind
}
interface Fixture {
  readonly name: string
  readonly expect: { readonly verdict: ProbeVerdict }
  readonly action: { readonly turnId: number; readonly beatId: string; readonly intentId: string; readonly at: number }
  readonly samples: readonly FixtureSample[]
}

function loadFixture(name: string): Fixture {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')) as Fixture
}

/** Replay a recorded fixture on a fake clock; the same file must settle the same verdict. */
function replayFixture(fixture: Fixture): ProbeRecord {
  const clock = new FakeClock(0)
  const registry = new SensorRegistry({ clock })
  const kinds = new Map<string, SensorKind>()
  for (const entry of fixture.samples) kinds.set(entry.sourceId, entry.kind)
  for (const [id, kind] of kinds) registry.register(source(id, kind))
  const recorder = new ReactionProbeRecorder({ clock, sensors: registry })

  const at = fixture.action.at
  const ordered = [...fixture.samples].sort((left, right) => left.ts - right.ts)
  for (const entry of ordered.filter(entry => entry.ts < at)) {
    clock.advance(entry.ts - clock.now())
    registry.push(sample(entry.sourceId, entry))
  }
  clock.advance(at - clock.now())
  recorder.register({
    turnId: fixture.action.turnId,
    beatId: fixture.action.beatId,
    intentId: fixture.action.intentId,
    at,
    targets: [{ deviceId: 'coyote-1', channelId: 'A' }],
  })
  for (const entry of ordered.filter(entry => entry.ts >= at)) {
    clock.advance(entry.ts - clock.now())
    registry.push(sample(entry.sourceId, entry))
  }
  clock.advance(Math.max(0, at + DEFAULT_PROBE_THRESHOLDS.windowMs - clock.now()))

  const [record] = recorder.recent(1)
  if (record === undefined) throw new Error(`fixture "${fixture.name}" settled no probe`)
  return record
}

describe('reaction probe recorder', () => {
  it('cuts a baseline window that ends exactly at actionAt', () => {
    const { clock, registry, recorder } = harness()
    // Start of the baseline window, exactly `actionAt - baselineLeadMs`.
    registry.push(sample('usb-cam-1', { ts: 0, motionEnergy: 0.05, motionPeak: 0.06 }))
    clock.advance(1_500)
    // A sample exactly at the action instant belongs to the window, not the baseline.
    registry.push(sample('usb-cam-1', { ts: 1_500, motionEnergy: 0.5, motionPeak: 0.5 }))
    expect(recorder.register(action(1_500))).toBe('p-0001')
    clock.advance(500)
    registry.push(sample('usb-cam-1', { ts: 2_000, motionEnergy: 0.2, motionPeak: 0.3 }))
    clock.advance(2_000)

    const [record] = recorder.recent(1)
    expect(record?.baseline?.samples).toBe(1)
    expect(record?.baseline?.motionEnergyMean).toBeCloseTo(0.05, 10)
    expect(record?.window?.samples).toBe(2)
    expect(record?.delta?.motion).toBeCloseTo(0.45, 10)
    expect(record?.verdict).toBe('responded')
  })

  it('settles the window at actionAt + windowMs on the injected clock', () => {
    const { clock, registry, recorder } = harness()
    registry.push(sample('usb-cam-1', { ts: 0, motionEnergy: 0.05, motionPeak: 0.06 }))
    clock.advance(1_000)
    expect(recorder.register(action(1_000))).toBe('p-0001')
    expect(clock.pendingCount).toBe(1)

    clock.advance(DEFAULT_PROBE_THRESHOLDS.windowMs - 1)
    expect(recorder.recent()).toHaveLength(0)
    clock.advance(1)
    expect(clock.pendingCount).toBe(0)
    expect(recorder.recent()).toHaveLength(1)
  })

  it('replays the same fixture to the same verdict twice', () => {
    for (const name of ['probe-responded.json', 'probe-audio-responded.json']) {
      const fixture = loadFixture(name)
      const first = replayFixture(fixture)
      const second = replayFixture(fixture)
      expect(first.verdict).toBe(fixture.expect.verdict)
      expect(second.verdict).toBe(first.verdict)
      // Deterministic ids and clocks: a replay is byte-identical, not just "same verdict".
      expect(second).toEqual(first)
    }
  })

  it('arms nothing and consumes no probe id when no source can watch', () => {
    const { clock, registry, recorder } = harness({ sources: [] })
    expect(recorder.register(action(0))).toBeUndefined()
    expect(clock.pendingCount).toBe(0)
    expect(recorder.recent()).toEqual([])

    // A degraded camera is not a watcher either.
    registry.register(source('usb-cam-1', 'image'))
    registry.push(sample('usb-cam-1', { ts: 0, quality: 'blocked', motionEnergy: 0.1 }))
    expect(recorder.register(action(100))).toBeUndefined()
    expect(clock.pendingCount).toBe(0)

    // Failed registrations are free: the first armed probe is still p-0001.
    clock.advance(500)
    registry.push(sample('usb-cam-1', { ts: 600, motionEnergy: 0.05 }))
    expect(recorder.register(action(700))).toBe('p-0001')
    expect(clock.pendingCount).toBe(1)
  })

  it('settles every pending window on settleAll and keeps the newest three', async () => {
    const { clock, registry, recorder } = harness()
    registry.push(sample('usb-cam-1', { ts: 0, motionEnergy: 0.05, motionPeak: 0.06 }))
    clock.advance(1_000)
    expect(recorder.register(action(1_000, { beatId: 'b1' }))).toBe('p-0001')
    clock.advance(100)
    registry.push(sample('usb-cam-1', { ts: 1_100, motionEnergy: 0.2, motionPeak: 0.3 }))
    expect(recorder.register(action(1_100, { beatId: 'b2' }))).toBe('p-0002')
    clock.advance(100)
    expect(recorder.register(action(1_200, { beatId: 'b3' }))).toBe('p-0003')
    clock.advance(100)
    expect(recorder.register(action(1_300, { beatId: 'b4' }))).toBe('p-0004')
    expect(clock.pendingCount).toBe(4)

    await recorder.settleAll()
    expect(clock.pendingCount).toBe(0)
    expect(recorder.recent()).toHaveLength(3)
    expect(recorder.recent().map(record => record.beatId)).toEqual(['b2', 'b3', 'b4'])
    expect(recorder.recent(1).map(record => record.beatId)).toEqual(['b4'])
    expect(recorder.recent(0)).toEqual([])
  })

  it('dispose cancels pending timers without settling', () => {
    const { clock, registry, recorder } = harness()
    registry.push(sample('usb-cam-1', { ts: 0, motionEnergy: 0.05 }))
    clock.advance(1_000)
    expect(recorder.register(action(1_000))).toBe('p-0001')
    expect(clock.pendingCount).toBe(1)

    recorder.dispose()
    expect(clock.pendingCount).toBe(0)
    clock.advance(10_000)
    expect(recorder.recent()).toEqual([])
    expect(recorder.register(action(20_000))).toBeUndefined()
  })

  it('watches only ok sources and falls back to audio when the camera is degraded', () => {
    const { clock, registry, recorder } = harness({ sources: [] })
    registry.register(source('usb-cam-1', 'image'))
    registry.register(source('mic-1', 'audio'))
    registry.push(sample('usb-cam-1', { ts: 0, quality: 'dim', motionEnergy: 0.2, motionPeak: 0.4 }))
    registry.push(sample('mic-1', { ts: 0, audioLevelPct: 10 }))

    // Only the microphone is a usable watcher; the dim camera is ignored.
    expect(recorder.register(action(100))).toBe('p-0001')
    clock.advance(100)
    registry.push(sample('mic-1', { ts: 200, audioLevelPct: 40 }))
    clock.advance(2_500)

    const [record] = recorder.recent(1)
    expect(record?.verdict).toBe('responded')
    expect(record?.delta?.audioPct).toBeGreaterThanOrEqual(15)
    // No image data was invented for the missing camera.
    expect(record?.baseline?.motionEnergyMean).toBe(0)
    expect(record?.window?.motionPeak).toBe(0)
  })

  it('satisfies the executor ProbeRegistrar contract', () => {
    const { clock, registry, recorder } = harness()
    // Compile-time integration check: the executor passes its own ProbeAction
    // shape and expects `string | undefined` back.
    const registrar: ProbeRegistrar = recorder
    registry.push(sample('usb-cam-1', { ts: 0, motionEnergy: 0.05 }))
    clock.advance(100)
    expect(registrar.register(action(100))).toBe('p-0001')
  })

  it('writes one reaction_probe line only when an audit sink is injected', async () => {
    const clock = new FakeClock(0)
    const registry = new SensorRegistry({ clock })
    registry.register(source('usb-cam-1', 'image'))
    const entries: unknown[] = []
    const recorder = new ReactionProbeRecorder({
      clock,
      sensors: registry,
      audit: { record: entry => { entries.push(entry) } },
    })
    registry.push(sample('usb-cam-1', { ts: 0, motionEnergy: 0.05, motionPeak: 0.06 }))
    clock.advance(1_000)
    recorder.register(action(1_000))
    clock.advance(2_500)
    await recorder.settleAll()

    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ actor: 'system', action: 'reaction_probe', result: 'ok' })
    const detail = (entries[0] as { detail: Record<string, unknown> }).detail
    expect(detail.probeId).toBe('p-0001')
    expect(detail.verdict).toBeDefined()
    expect(detail).not.toHaveProperty('percent')
  })
})
