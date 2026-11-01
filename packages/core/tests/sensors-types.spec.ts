import { describe, expect, it } from 'vitest'
import {
  isSensorError,
  SensorError,
  type FeatureSample,
  type SensorSource,
  type SensorStatus,
} from '../src/sensors/types.ts'

/** A source that is attached but has never produced a frame. */
function neverSampledSource(): SensorSource {
  return {
    id: 'usb-cam-1',
    kind: 'image',
    label: 'USB 摄像头',
    latest: () => Promise.resolve(undefined),
    freshnessMs: () => undefined,
  }
}

describe('sensor feature contract', () => {
  it('treats a source that never sampled as unavailable, not an error', async () => {
    const source = neverSampledSource()

    // "No frame yet" is a supported answer: both accessors resolve to
    // undefined instead of rejecting / throwing.
    await expect(source.latest()).resolves.toBeUndefined()
    expect(source.freshnessMs()).toBeUndefined()

    // The status vocabulary has a dedicated word for it, so a consumer never
    // has to read "0" or a missing timestamp as a measured value.
    const status: SensorStatus = {
      id: source.id,
      kind: source.kind,
      label: source.label,
      quality: 'unavailable',
      lastTs: undefined,
      freshnessMs: undefined,
    }
    expect(status.quality).toBe('unavailable')
    expect(status.lastTs).toBeUndefined()
    expect(status.freshnessMs).toBeUndefined()
  })

  it('accepts an hr source that carries bpm only, for the reserved M2-C contract', () => {
    // M2 produces no HR samples, but the type vocabulary must not force a
    // strap to report camera-shaped fields it cannot measure.
    const sample: FeatureSample = {
      sourceId: 'hr-band-1',
      ts: 1_000,
      frameAgeMs: 0,
      quality: 'ok',
      bpm: 72,
    }
    expect(sample.bpm).toBe(72)
    expect(sample.motionEnergy).toBeUndefined()
    expect(sample.audioLevelPct).toBeUndefined()

    const source: SensorSource = {
      id: 'hr-band-1',
      kind: 'hr',
      label: '心率臂带',
      latest: () => Promise.resolve(undefined),
      freshnessMs: () => 0,
    }
    expect(source.kind).toBe('hr')
  })

  it('carries a stable code on a typed sensor error', () => {
    const error = new SensorError('UNKNOWN_SOURCE', 'no source is registered')
    expect(isSensorError(error)).toBe(true)
    expect(error.code).toBe('UNKNOWN_SOURCE')
    expect(error.name).toBe('SensorError')
    expect(isSensorError(new Error('plain'))).toBe(false)
  })
})
