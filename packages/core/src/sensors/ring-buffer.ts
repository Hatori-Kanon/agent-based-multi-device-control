/**
 * Per-source feature history.
 *
 * A reaction window compares "before the action" with "after the action", so
 * every source keeps a bounded trail of {@link FeatureSample}s instead of only
 * the last value. Time comes from the injected {@link Clock}; pruning happens
 * lazily on every read, which keeps this class timer-free and deterministic
 * under `FakeClock`.
 */

import type { Clock } from '../ports/clock.ts'
import type { FeatureSample, FeatureWindowStats } from './types.ts'

/** Default history depth: 60 s at 1-2 Hz. */
export const DEFAULT_RETAIN_MS = 60_000

export interface FeatureRingOptions {
  readonly clock: Clock
  /** How long a sample stays addressable. Defaults to {@link DEFAULT_RETAIN_MS}. */
  readonly retainMs?: number
}

/** Bounded feature history for one source. */
export class FeatureRing {
  private readonly clock: Clock
  private readonly retainMs: number
  /** Ascending by `ts`, so `at`/`between` are binary-search friendly. */
  private samples: FeatureSample[] = []

  constructor(options: FeatureRingOptions) {
    this.clock = options.clock
    this.retainMs = options.retainMs ?? DEFAULT_RETAIN_MS
  }

  /** Append one sample. Out-of-order timestamps are inserted in order. */
  push(sample: FeatureSample): void {
    this.prune(this.clock.now())
    const last = this.samples[this.samples.length - 1]
    if (last === undefined || last.ts <= sample.ts) {
      this.samples.push(sample)
      return
    }
    this.samples.splice(this.insertionIndex(sample.ts), 0, sample)
  }

  /** Most recent retained sample, or `undefined` when the ring is empty. */
  latest(): FeatureSample | undefined {
    this.prune(this.clock.now())
    return this.samples[this.samples.length - 1]
  }

  /** Most recent sample at or before `ts`, or `undefined`. */
  at(ts: number): FeatureSample | undefined {
    this.prune(this.clock.now())
    let low = 0
    let high = this.samples.length - 1
    let found: FeatureSample | undefined
    while (low <= high) {
      const middle = (low + high) >> 1
      const sample = this.samples[middle]
      if (sample !== undefined && sample.ts <= ts) {
        found = sample
        low = middle + 1
      } else {
        high = middle - 1
      }
    }
    return found
  }

  /** Retained samples with `fromTs <= ts <= toTs`, oldest first. */
  between(fromTs: number, toTs: number): readonly FeatureSample[] {
    this.prune(this.clock.now())
    if (toTs < fromTs) return []
    const window: FeatureSample[] = []
    for (const sample of this.samples) {
      if (sample.ts > toTs) break
      if (sample.ts >= fromTs) window.push(sample)
    }
    return window
  }

  /**
   * Aggregate a closed time window.
   *
   * Returns `undefined` — never zeros — when the window holds no samples:
   * "no measurement" and "measured zero" must stay distinguishable.
   */
  stats(fromTs: number, toTs: number): FeatureWindowStats | undefined {
    const window = this.between(fromTs, toTs)
    const newest = window[window.length - 1]
    if (newest === undefined) return undefined

    let motionEnergySum = 0
    let motionEnergyCount = 0
    let motionPeak = 0
    let audioLevelSum = 0
    let audioLevelCount = 0
    let audioPeakPct = 0
    for (const sample of window) {
      if (sample.motionEnergy !== undefined) {
        motionEnergySum += sample.motionEnergy
        motionEnergyCount += 1
      }
      if (sample.motionPeak !== undefined && sample.motionPeak > motionPeak) motionPeak = sample.motionPeak
      if (sample.audioLevelPct !== undefined) {
        audioLevelSum += sample.audioLevelPct
        audioLevelCount += 1
        if (sample.audioLevelPct > audioPeakPct) audioPeakPct = sample.audioLevelPct
      }
    }

    return {
      samples: window.length,
      quality: newest.quality,
      motionEnergyMean: motionEnergyCount === 0 ? 0 : motionEnergySum / motionEnergyCount,
      motionPeak,
      audioLevelMeanPct: audioLevelCount === 0 ? 0 : audioLevelSum / audioLevelCount,
      audioPeakPct,
    }
  }

  /** Age of the newest retained sample at `now`, or `undefined` when empty. */
  freshnessMs(now: number): number | undefined {
    const newest = this.latest()
    return newest === undefined ? undefined : Math.max(0, now - newest.ts)
  }

  /** Insertion point for a sample older than the current tail. */
  private insertionIndex(ts: number): number {
    let low = 0
    let high = this.samples.length
    while (low < high) {
      const middle = (low + high) >> 1
      const sample = this.samples[middle]
      if (sample !== undefined && sample.ts <= ts) low = middle + 1
      else high = middle
    }
    return low
  }

  /** Drop everything strictly older than the retention horizon. */
  private prune(now: number): void {
    const cutoff = now - this.retainMs
    let dropped = 0
    while (dropped < this.samples.length) {
      const sample = this.samples[dropped]
      if (sample === undefined || sample.ts >= cutoff) break
      dropped += 1
    }
    if (dropped > 0) this.samples.splice(0, dropped)
  }
}
