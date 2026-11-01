/**
 * Sensor feature vocabulary.
 *
 * This file is the single type source for every piece of perception code in
 * `core`. It deliberately contains **no platform API and no image parsing**:
 * a capture host turns frames into {@link FeatureSample}s and JSON snapshots,
 * and this module names those shapes.
 *
 * The same vocabulary serves three source kinds: `image` (a camera), `audio`
 * (a microphone, M5) and `hr` (a heart-rate strap, reserved for M2-C — the
 * type exists so that nothing here assumes perception equals a camera).
 */

/** What a source senses. `hr` is a reserved placeholder; M2 produces none. */
export type SensorKind = 'image' | 'audio' | 'hr'

/**
 * Usability of one sample or source.
 *
 * `unavailable` means "there is nothing to look at yet" (never sampled, or the
 * source was never attached); it is a supported state, not an error. `stale`
 * means the source used to work but has not produced a sample recently.
 */
export type SensorQuality = 'ok' | 'dim' | 'bright' | 'blocked' | 'stale' | 'unavailable'

/** Stable machine-readable reasons a sensor operation is refused. */
export type SensorErrorCode =
  /** A feature sample was pushed for a source id nobody registered. */
  | 'UNKNOWN_SOURCE'
  /** `look` found no snapshot for the requested source. */
  | 'NO_SNAPSHOT'
  /** `look` found a snapshot but it is older than `maxAgeMs`. */
  | 'STALE_SNAPSHOT'
  /** `look` found a snapshot that exceeds `maxBytes`. */
  | 'OVERSIZE_SNAPSHOT'

/**
 * Refusal or failure raised by the perception layer.
 *
 * Kept separate from `SafetyError`: a missing camera must never look like a
 * safety fault, and the HTTP layer maps this to `400` rather than `500`.
 */
export class SensorError extends Error {
  /**
   * @param code - Stable machine-readable reason.
   * @param message - Actionable text for the model or operator.
   */
  constructor(readonly code: SensorErrorCode, message: string) {
    super(message)
    this.name = 'SensorError'
  }
}

/** Narrow an unknown rejection to a {@link SensorError}. */
export function isSensorError(value: unknown): value is SensorError {
  return value instanceof SensorError
}

/**
 * One 1-2 Hz feature sample.
 *
 * An image source fills the L0/L1 optics fields; an audio source fills
 * `audioLevelPct` only; an `hr` source fills `bpm` only. Every field beyond
 * `quality` is optional, so a source reports exactly what it can measure —
 * never a zero standing in for "unknown".
 */
export interface FeatureSample {
  readonly sourceId: string
  /** `Clock.now()` at the moment the capture host sampled the frame. */
  readonly ts: number
  /** Age of the frame behind this sample, in milliseconds. */
  readonly frameAgeMs: number
  readonly quality: SensorQuality
  /** 0-1 normalised frame-difference EMA (L1). */
  readonly motionEnergy?: number
  /** 0-1 peak of the raw frame difference over the last second (L1). */
  readonly motionPeak?: number
  /** 0-1 complement of the changed-pixel ratio (L1). */
  readonly staticRatio?: number
  /** 0-1 changed-pixel ratio inside the centre third of the frame (L1). */
  readonly centerMotionRatio?: number
  /** 0-255 mean luma (L0). */
  readonly lumaMean?: number
  /** 0-255 luma standard deviation (L0). */
  readonly lumaStd?: number
  /** Ratio of pixels brighter than 235 (L0). */
  readonly overexposedRatio?: number
  /** Ratio of pixels darker than 25 (L0). */
  readonly underexposedRatio?: number
  /** 0-100 normalised audio level (audio sources only). */
  readonly audioLevelPct?: number
  /** Heart rate in beats per minute (reserved for M2-C). */
  readonly bpm?: number
}

/** The `look` / {@link SensorSource.latest} return value; M2 only produces JPEG. */
export interface Snapshot {
  readonly sourceId: string
  readonly ts: number
  readonly mime: string
  readonly bytes: Uint8Array
}

/**
 * A named perception source.
 *
 * The registry never parses a snapshot and never assumes it is an image: a
 * host registers one source per input device and reports its own freshness.
 */
export interface SensorSource {
  /** Stable id such as `usb-cam-1`, `phone-cam-1`, or `mic`. */
  readonly id: string
  readonly kind: SensorKind
  /** Human- and model-readable name. */
  readonly label: string
  /** Latest snapshot on demand, or `undefined` when the source is not attached. */
  latest(): Promise<Snapshot | undefined>
  /** Age of the last captured frame in milliseconds; `undefined` when never sampled. */
  freshnessMs(): number | undefined
}

/**
 * One source as the model and the UI see it.
 *
 * A source that never sampled reports `quality: 'unavailable'` with both
 * timestamps `undefined` — the absence is explicit, never fabricated as 0.
 */
export interface SensorStatus {
  readonly id: string
  readonly kind: SensorKind
  readonly label: string
  readonly quality: SensorQuality
  readonly lastTs: number | undefined
  readonly freshnessMs: number | undefined
}

/**
 * Aggregate of one time window.
 *
 * Fields that no sample in the window carried stay 0, because the window is
 * otherwise real; a window with **no samples at all** is `undefined` so that
 * callers can tell "no data" from "measured zero".
 */
export interface FeatureWindowStats {
  readonly samples: number
  /** Quality of the most recent sample in the window. */
  readonly quality: SensorQuality
  readonly motionEnergyMean: number
  readonly motionPeak: number
  readonly audioLevelMeanPct: number
  readonly audioPeakPct: number
}
