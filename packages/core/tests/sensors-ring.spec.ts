import { describe, expect, it } from 'vitest'
import { FakeClock } from '../src/ports/fake-clock.ts'
import { DEFAULT_RETAIN_MS, FeatureRing } from '../src/sensors/ring-buffer.ts'
import type { FeatureSample } from '../src/sensors/types.ts'

function sample(ts: number, extra: Partial<FeatureSample> = {}): FeatureSample {
  return {
    sourceId: 'usb-cam-1',
    ts,
    frameAgeMs: 120,
    quality: 'ok',
    ...extra,
  }
}

describe('feature ring buffer', () => {
  it('drops samples older than retainMs without changing a window still inside it', () => {
    const clock = new FakeClock(0)
    const ring = new FeatureRing({ clock, retainMs: 60_000 })
    expect(DEFAULT_RETAIN_MS).toBe(60_000)

    ring.push(sample(0, { motionEnergy: 0.1, motionPeak: 0.1 }))
    clock.advance(10_000)
    ring.push(sample(10_000, { motionEnergy: 0.2, motionPeak: 0.2 }))
    clock.advance(10_000)
    ring.push(sample(20_000, { motionEnergy: 0.3, motionPeak: 0.3 }))

    const before = ring.stats(10_000, 20_000)
    expect(before?.samples).toBe(2)

    // The oldest sample falls out of retention; the window inside it does not.
    clock.advance(40_001)
    expect(ring.between(0, 0)).toEqual([])
    expect(ring.stats(0, 5_000)).toBeUndefined()
    expect(ring.stats(10_000, 20_000)).toEqual(before)
    expect(ring.latest()?.ts).toBe(20_000)
    expect(ring.at(15_000)?.ts).toBe(10_000)
    expect(ring.freshnessMs(70_001)).toBe(50_001)
  })

  it('returns undefined, not zeros, for a window with no samples', () => {
    const clock = new FakeClock(0)
    const ring = new FeatureRing({ clock })

    expect(ring.stats(0, 1_000)).toBeUndefined()
    expect(ring.latest()).toBeUndefined()
    expect(ring.freshnessMs(0)).toBeUndefined()

    // A real measurement of zero is still a measurement: it must stay a value.
    ring.push(sample(5_000, { motionEnergy: 0 }))
    expect(ring.stats(0, 1_000)).toBeUndefined()
    const measured = ring.stats(5_000, 5_000)
    expect(measured).toBeDefined()
    expect(measured?.samples).toBe(1)
    expect(measured?.motionEnergyMean).toBe(0)
  })

  it('reports motionPeak as the maximum of the window', () => {
    const clock = new FakeClock(0)
    const ring = new FeatureRing({ clock })
    ring.push(sample(0, { motionEnergy: 0.1, motionPeak: 0.12 }))
    ring.push(sample(500, { motionEnergy: 0.5, motionPeak: 0.62 }))
    ring.push(sample(1_000, { motionEnergy: 0.2, motionPeak: 0.25 }))

    const stats = ring.stats(0, 1_000)
    expect(stats?.samples).toBe(3)
    expect(stats?.motionPeak).toBe(0.62)
    expect(stats?.motionEnergyMean).toBeCloseTo((0.1 + 0.5 + 0.2) / 3, 10)
    expect(stats?.quality).toBe('ok')
    // No audio sample in the window: the aggregate field is 0, not a gap.
    expect(stats?.audioPeakPct).toBe(0)
    expect(stats?.audioLevelMeanPct).toBe(0)

    // The peak belongs to the window, not to the ring's whole history.
    expect(ring.stats(1_000, 1_000)?.motionPeak).toBe(0.25)
  })
})
