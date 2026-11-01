/**
 * Named perception sources.
 *
 * The registry aggregates sources by `sourceId`, keeps one {@link FeatureRing}
 * per source, and derives a status view from the injected {@link Clock}. It
 * never parses a snapshot and never assumes a source is a camera — `kind` may
 * be `image`, `audio`, or `hr`.
 *
 * Missing sources are a supported state, never an error: an empty registry
 * reports no statuses, a source that has not sampled yet reports
 * `unavailable`, and a source that stops sampling turns `stale` after
 * {@link DEFAULT_STALE_AFTER_MS}. Only pushing a sample for an unregistered
 * source is a caller bug, and that throws a typed {@link SensorError}.
 */

import type { Clock } from '../ports/clock.ts'
import { DEFAULT_RETAIN_MS, FeatureRing } from './ring-buffer.ts'
import { SensorError } from './types.ts'
import type { FeatureSample, SensorSource, SensorStatus, Snapshot } from './types.ts'

/** A source silent for this long is `stale`, not `ok`. */
export const DEFAULT_STALE_AFTER_MS = 3_000

export interface SensorRegistryOptions {
  readonly clock: Clock
  /** Silence after which a source reports `stale`. Defaults to 3 s. */
  readonly staleAfterMs?: number
  /** How much feature history each source keeps. Defaults to 60 s. */
  readonly historyMs?: number
  /** Receives snapshot failures that the registry degrades over. */
  readonly onError?: (error: unknown) => void
}

interface SensorEntry {
  source: SensorSource
  readonly ring: FeatureRing
}

/** Aggregates perception sources and their feature history. */
export class SensorRegistry {
  private readonly clock: Clock
  private readonly staleAfterMs: number
  private readonly historyMs: number
  private readonly onError: ((error: unknown) => void) | undefined
  private readonly entries = new Map<string, SensorEntry>()

  constructor(options: SensorRegistryOptions) {
    this.clock = options.clock
    this.staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS
    this.historyMs = options.historyMs ?? DEFAULT_RETAIN_MS
    this.onError = options.onError
  }

  /**
   * Attach a source under its id.
   *
   * Re-registering the same id replaces the source but keeps its history, so a
   * reconnected camera does not lose the window a probe is waiting on.
   */
  register(source: SensorSource): void {
    const existing = this.entries.get(source.id)
    if (existing !== undefined) {
      existing.source = source
      return
    }
    this.entries.set(source.id, {
      source,
      ring: new FeatureRing({ clock: this.clock, retainMs: this.historyMs }),
    })
  }

  /** Detach a source; unknown ids are a no-op. */
  unregister(sourceId: string): void {
    this.entries.delete(sourceId)
  }

  /**
   * Store one feature sample.
   *
   * @throws {SensorError} `UNKNOWN_SOURCE` when nothing is registered under
   * `sample.sourceId` — the HTTP layer maps this to `400`.
   */
  push(sample: FeatureSample): void {
    const entry = this.entries.get(sample.sourceId)
    if (entry === undefined) {
      throw new SensorError(
        'UNKNOWN_SOURCE',
        `No sensor source is registered as "${sample.sourceId}"; register it before pushing features.`,
      )
    }
    entry.ring.push(sample)
  }

  /**
   * Every registered source, in registration order.
   *
   * Never throws and never writes: with no sources the result is simply `[]`.
   */
  statuses(): readonly SensorStatus[] {
    const now = this.clock.now()
    const statuses: SensorStatus[] = []
    for (const entry of this.entries.values()) {
      const newest = entry.ring.latest()
      const freshnessMs = entry.ring.freshnessMs(now)
      const quality = newest === undefined
        ? 'unavailable'
        : freshnessMs !== undefined && freshnessMs >= this.staleAfterMs
          ? 'stale'
          : newest.quality
      statuses.push({
        id: entry.source.id,
        kind: entry.source.kind,
        label: entry.source.label,
        quality,
        lastTs: newest?.ts,
        freshnessMs: newest === undefined ? undefined : freshnessMs,
      })
    }
    return statuses
  }

  /** Newest sample for a source, or `undefined` when unknown / never sampled. */
  latestSample(sourceId: string): FeatureSample | undefined {
    return this.entries.get(sourceId)?.ring.latest()
  }

  /**
   * Newest snapshot for an image source.
   *
   * Non-image sources and unknown ids answer `undefined`; a source that cannot
   * deliver right now is degraded (reported through `onError`), never thrown,
   * because a missing camera must not break a turn.
   */
  async latestSnapshot(sourceId: string): Promise<Snapshot | undefined> {
    const entry = this.entries.get(sourceId)
    if (entry === undefined || entry.source.kind !== 'image') return undefined
    try {
      return await entry.source.latest()
    } catch (error) {
      this.onError?.(error)
      return undefined
    }
  }

  /** Feature history of a source, or `undefined` when unknown. */
  series(sourceId: string): FeatureRing | undefined {
    return this.entries.get(sourceId)?.ring
  }
}
