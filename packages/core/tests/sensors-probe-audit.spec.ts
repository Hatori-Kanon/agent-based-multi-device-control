import { describe, expect, it } from 'vitest'
import { FakeClock } from '../src/ports/fake-clock.ts'
import {
  ReactionProbeRecorder,
  type ProbeAction,
  type ProbeAuditSink,
} from '../src/sensors/probe.ts'
import { SensorRegistry } from '../src/sensors/registry.ts'
import type { FeatureSample, SensorSource } from '../src/sensors/types.ts'

type RecordedEntry = Parameters<ProbeAuditSink['record']>[0]

function source(id: string): SensorSource {
  return { id, kind: 'image', label: id, latest: () => Promise.resolve(undefined), freshnessMs: () => undefined }
}

interface SampleSpec {
  readonly ts: number
  readonly motionEnergy?: number
  readonly motionPeak?: number
}

function sample(sourceId: string, spec: SampleSpec): FeatureSample {
  return {
    sourceId,
    ts: spec.ts,
    frameAgeMs: 40,
    quality: 'ok',
    ...(spec.motionEnergy === undefined ? {} : { motionEnergy: spec.motionEnergy }),
    ...(spec.motionPeak === undefined ? {} : { motionPeak: spec.motionPeak }),
  }
}

function action(at: number, beatId: string): ProbeAction {
  return {
    turnId: 1,
    beatId,
    intentId: 'probe-touch',
    at,
    targets: [{ deviceId: 'coyote-1', channelId: 'A' }],
  }
}

interface Harness {
  readonly clock: FakeClock
  readonly registry: SensorRegistry
  readonly recorder: ReactionProbeRecorder
}

function harness(audit?: ProbeAuditSink): Harness {
  const clock = new FakeClock(0)
  const registry = new SensorRegistry({ clock })
  registry.register(source('usb-cam-1'))
  const recorder = new ReactionProbeRecorder({
    clock,
    sensors: registry,
    ...(audit === undefined ? {} : { audit }),
  })
  return { clock, registry, recorder }
}

/** One baseline sample, one action, one window sample, then settle. */
async function settleResponded(entries: RecordedEntry[], beatId = 'b1'): Promise<void> {
  const { clock, registry, recorder } = harness({ record: entry => { entries.push(entry) } })
  registry.push(sample('usb-cam-1', { ts: 0, motionEnergy: 0.05, motionPeak: 0.06 }))
  clock.advance(1_000)
  expect(recorder.register(action(1_000, beatId))).toBe('p-0001')
  clock.advance(100)
  registry.push(sample('usb-cam-1', { ts: 1_100, motionEnergy: 0.2, motionPeak: 0.3 }))
  clock.advance(2_500)
  await recorder.settleAll()
}

function keysOf(value: unknown): string[] {
  if (value === null || typeof value !== 'object') throw new Error('expected an object')
  return Object.keys(value).sort()
}

/** Walk a JSON-like value and return every dotted path whose key matches. */
function matchingKeys(value: unknown, predicate: (key: string) => boolean, path = '$'): string[] {
  if (value === null || typeof value !== 'object') return []
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => matchingKeys(item, predicate, `${path}[${index}]`))
  }
  return Object.entries(value).flatMap(([key, child]) => [
    ...(predicate(key) ? [`${path}.${key}`] : []),
    ...matchingKeys(child, predicate, `${path}.${key}`),
  ])
}

describe('reaction probe audit', () => {
  it('records one reaction_probe line per action with baseline, window and verdict', async () => {
    const entries: RecordedEntry[] = []
    const { clock, registry, recorder } = harness({ record: entry => { entries.push(entry) } })
    registry.push(sample('usb-cam-1', { ts: 0, motionEnergy: 0.05, motionPeak: 0.06 }))
    clock.advance(1_000)
    expect(recorder.register(action(1_000, 'b1'))).toBe('p-0001')
    clock.advance(100)
    registry.push(sample('usb-cam-1', { ts: 1_100, motionEnergy: 0.2, motionPeak: 0.3 }))
    expect(recorder.register(action(1_100, 'b2'))).toBe('p-0002')
    clock.advance(2_500)
    await recorder.settleAll()

    expect(entries).toHaveLength(2)
    expect(entries.map(entry => entry.actor)).toEqual(['system', 'system'])
    expect(entries.map(entry => entry.action)).toEqual(['reaction_probe', 'reaction_probe'])
    expect(entries.map(entry => entry.result)).toEqual(['ok', 'ok'])
    expect(entries.map(entry => entry.detail.probeId)).toEqual(['p-0001', 'p-0002'])
    expect(entries.map(entry => entry.detail.beatId)).toEqual(['b1', 'b2'])

    const [first, second] = entries
    expect(first).toMatchObject({
      actor: 'system',
      action: 'reaction_probe',
      result: 'ok',
      detail: {
        probeId: 'p-0001',
        turnId: 1,
        beatId: 'b1',
        intentId: 'probe-touch',
        trigger: 'passive',
        actionAt: 1_000,
        targets: [{ deviceId: 'coyote-1', channelId: 'A' }],
        verdict: 'responded',
      },
    })
    expect(first?.detail.baseline).toMatchObject({ samples: 1, quality: 'ok', motionEnergyMean: 0.05, motionPeak: 0.06 })
    expect(first?.detail.window).toMatchObject({ samples: 1, quality: 'ok', motionEnergyMean: 0.2, motionPeak: 0.3 })
    const delta = first?.detail.delta as { readonly motion: number; readonly audioPct: number } | undefined
    expect(delta?.motion).toBeCloseTo(0.25, 10)
    expect(second?.detail.verdict).toBe('responded')
    expect(second?.detail).not.toHaveProperty('reason')

    // Settling the same probes again appends nothing: exactly one line per action.
    await recorder.settleAll()
    expect(entries).toHaveLength(2)
  })

  it('never puts a device percentage into the probe detail', async () => {
    const entries: RecordedEntry[] = []
    await settleResponded(entries)
    const detail = entries[0]?.detail
    if (detail === undefined) throw new Error('expected a settled probe detail')

    // The key set is the contract; a new device field cannot slip in silently.
    expect(Object.keys(detail).sort()).toEqual([
      'actionAt',
      'baseline',
      'beatId',
      'delta',
      'intentId',
      'probeId',
      'targets',
      'trigger',
      'turnId',
      'verdict',
      'window',
    ])

    // Targets carry ids only — never a level, cap or waveform intensity.
    const targets = detail.targets as readonly Readonly<Record<string, unknown>>[]
    expect(targets).toEqual([{ deviceId: 'coyote-1', channelId: 'A' }])
    expect(targets.map(target => Object.keys(target).sort())).toEqual([['channelId', 'deviceId']])

    // Windows carry measured perception features only.
    for (const stats of [detail.baseline, detail.window]) {
      expect(keysOf(stats)).toEqual([
        'audioLevelMeanPct',
        'audioPeakPct',
        'motionEnergyMean',
        'motionPeak',
        'quality',
        'samples',
      ])
    }

    // No device-level vocabulary anywhere, at any depth.
    expect(matchingKeys(detail, key => /percent|cap|intensity|duration|strength/i.test(key))).toEqual([])
    expect(JSON.stringify(detail)).not.toMatch(
      /"percent"\s*:|targetPercent|deltaPercent|maxPercent|maxDurationSec|maxWaveIntensity/i,
    )
  })

  it('records the degrade reason without inventing a percentage', async () => {
    const entries: RecordedEntry[] = []
    const { clock, registry, recorder } = harness({ record: entry => { entries.push(entry) } })
    registry.push(sample('usb-cam-1', { ts: 0, motionEnergy: 0.05 }))
    // The source is still `ok` when the probe registers, but no sample falls
    // inside either window by the time it settles.
    clock.advance(2_000)
    expect(recorder.register(action(2_000, 'b1'))).toBe('p-0001')
    clock.advance(2_500)
    await recorder.settleAll()

    const detail = entries[0]?.detail
    expect(detail?.verdict).toBe('unavailable')
    expect(detail?.reason).toBe('stale')
    expect(detail?.baseline).toBeUndefined()
    expect(detail?.window).toBeUndefined()
    expect(detail?.delta).toBeUndefined()
    expect(matchingKeys(detail, key => /percent|cap|intensity/i.test(key))).toEqual([])
  })

  it('a throwing sink does not change the verdict', async () => {
    for (const mode of ['sync', 'async'] as const) {
      const clock = new FakeClock(0)
      const registry = new SensorRegistry({ clock })
      registry.register(source('usb-cam-1'))
      const audit: ProbeAuditSink = {
        record: () => {
          if (mode === 'sync') throw new Error('audit sink exploded')
          return Promise.reject(new Error('audit sink rejected'))
        },
      }
      const recorder = new ReactionProbeRecorder({ clock, sensors: registry, audit })
      registry.push(sample('usb-cam-1', { ts: 0, motionEnergy: 0.05, motionPeak: 0.06 }))
      clock.advance(1_000)
      expect(recorder.register(action(1_000, 'b1'))).toBe('p-0001')
      clock.advance(100)
      registry.push(sample('usb-cam-1', { ts: 1_100, motionEnergy: 0.2, motionPeak: 0.3 }))
      clock.advance(2_500)

      await expect(recorder.settleAll()).resolves.toBeUndefined()
      const [record] = recorder.recent(1)
      expect(record?.verdict).toBe('responded')
      expect(record?.delta?.motion).toBeCloseTo(0.25, 10)
      expect(clock.pendingCount).toBe(0)
    }
  })
})
