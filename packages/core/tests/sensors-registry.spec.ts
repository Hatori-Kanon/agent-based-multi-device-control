import { describe, expect, it } from 'vitest'
import { FakeClock } from '../src/ports/fake-clock.ts'
import { SensorRegistry } from '../src/sensors/registry.ts'
import {
  isSensorError,
  SensorError,
  type FeatureSample,
  type SensorKind,
  type SensorSource,
  type Snapshot,
} from '../src/sensors/types.ts'

interface SourceOverrides {
  readonly id?: string
  readonly kind?: SensorKind
  readonly label?: string
  readonly latest?: () => Promise<Snapshot | undefined>
  readonly freshnessMs?: () => number | undefined
}

function fakeSource(overrides: SourceOverrides = {}): SensorSource {
  return {
    id: overrides.id ?? 'usb-cam-1',
    kind: overrides.kind ?? 'image',
    label: overrides.label ?? 'USB 摄像头',
    latest: overrides.latest ?? (() => Promise.resolve(undefined)),
    freshnessMs: overrides.freshnessMs ?? (() => undefined),
  }
}

interface SampleOverrides {
  readonly sourceId?: string
  readonly ts?: number
  readonly quality?: FeatureSample['quality']
  readonly motionEnergy?: number
}

function featureSample(overrides: SampleOverrides = {}): FeatureSample {
  const sample: FeatureSample = {
    sourceId: overrides.sourceId ?? 'usb-cam-1',
    ts: overrides.ts ?? 0,
    frameAgeMs: 80,
    quality: overrides.quality ?? 'ok',
  }
  return overrides.motionEnergy === undefined ? sample : { ...sample, motionEnergy: overrides.motionEnergy }
}

describe('sensor registry', () => {
  it('returns an empty status list and never throws when no source is registered', async () => {
    const clock = new FakeClock(0)
    const registry = new SensorRegistry({ clock })

    expect(registry.statuses()).toEqual([])
    expect(registry.latestSample('usb-cam-1')).toBeUndefined()
    expect(registry.series('usb-cam-1')).toBeUndefined()
    await expect(registry.latestSnapshot('usb-cam-1')).resolves.toBeUndefined()
    // Detaching something that was never attached is a no-op, not a failure.
    expect(() => { registry.unregister('usb-cam-1') }).not.toThrow()
    expect(registry.statuses()).toEqual([])
  })

  it('marks a source stale after 3s without a sample', () => {
    const clock = new FakeClock(0)
    const registry = new SensorRegistry({ clock })
    registry.register(fakeSource())

    // Attached but never sampled: unavailable, with no invented timestamps.
    expect(registry.statuses()[0]).toEqual({
      id: 'usb-cam-1',
      kind: 'image',
      label: 'USB 摄像头',
      quality: 'unavailable',
      lastTs: undefined,
      freshnessMs: undefined,
    })

    registry.push(featureSample({ ts: 0 }))
    expect(registry.statuses()[0]?.quality).toBe('ok')
    expect(registry.statuses()[0]?.lastTs).toBe(0)

    clock.advance(2_999)
    expect(registry.statuses()[0]?.quality).toBe('ok')
    clock.advance(1)
    expect(registry.statuses()[0]?.quality).toBe('stale')
    expect(registry.statuses()[0]?.freshnessMs).toBe(3_000)

    // A fresh sample clears staleness and its own quality wins.
    registry.push(featureSample({ ts: 3_000, quality: 'dim' }))
    expect(registry.statuses()[0]?.quality).toBe('dim')
  })

  it('rejects a sample for an unknown source with a typed error', () => {
    const clock = new FakeClock(0)
    const registry = new SensorRegistry({ clock })

    let caught: unknown
    try {
      registry.push(featureSample({ sourceId: 'usb-cam-1' }))
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(SensorError)
    expect(isSensorError(caught)).toBe(true)
    if (isSensorError(caught)) {
      expect(caught.code).toBe('UNKNOWN_SOURCE')
      expect(caught.message).toContain('usb-cam-1')
    }
    // Nothing was stored, so a later registration starts clean.
    registry.register(fakeSource())
    expect(registry.latestSample('usb-cam-1')).toBeUndefined()
    registry.push(featureSample({ sourceId: 'usb-cam-1', ts: 10 }))
    expect(registry.latestSample('usb-cam-1')?.ts).toBe(10)
  })

  it('looks up the latest sample and the series by source id', () => {
    const clock = new FakeClock(0)
    const registry = new SensorRegistry({ clock })
    registry.register(fakeSource())
    registry.register(fakeSource({ id: 'mic-1', kind: 'audio', label: '麦克风' }))

    registry.push(featureSample({ ts: 0, motionEnergy: 0.1 }))
    clock.advance(500)
    registry.push(featureSample({ ts: 500, motionEnergy: 0.2 }))

    expect(registry.latestSample('usb-cam-1')?.ts).toBe(500)
    expect(registry.series('usb-cam-1')?.stats(0, 500)?.samples).toBe(2)
    expect(registry.series('usb-cam-1')?.stats(0, 500)?.motionEnergyMean).toBeCloseTo(0.15, 10)
    // Two independent series, in registration order.
    expect(registry.statuses().map(status => status.id)).toEqual(['usb-cam-1', 'mic-1'])
  })

  it('returns an image snapshot and degrades a failing source to undefined', async () => {
    const clock = new FakeClock(0)
    const errors: unknown[] = []
    const registry = new SensorRegistry({ clock, onError: error => { errors.push(error) } })
    const snapshot: Snapshot = {
      sourceId: 'usb-cam-1',
      ts: 1_000,
      mime: 'image/jpeg',
      bytes: new Uint8Array([1, 2, 3]),
    }
    registry.register(fakeSource({ latest: () => Promise.resolve(snapshot) }))
    registry.register(fakeSource({ id: 'mic-1', kind: 'audio' }))
    registry.register(fakeSource({
      id: 'broken-cam',
      latest: () => Promise.reject(new Error('device unplugged')),
    }))

    await expect(registry.latestSnapshot('usb-cam-1')).resolves.toBe(snapshot)
    // Non-image sources have no snapshot to give; that is not an error.
    await expect(registry.latestSnapshot('mic-1')).resolves.toBeUndefined()
    await expect(registry.latestSnapshot('broken-cam')).resolves.toBeUndefined()
    expect(errors).toHaveLength(1)

    // A failed snapshot never poisons statuses().
    expect(registry.statuses().map(status => status.id)).toEqual(['usb-cam-1', 'mic-1', 'broken-cam'])
  })
})
