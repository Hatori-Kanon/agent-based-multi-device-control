/**
 * `look`: fetch one snapshot and turn it into something a model can receive.
 *
 * This is the only image path out of `core`. The registry hands over an opaque
 * {@link Snapshot}; this module checks how old and how large it is, then
 * base64-encodes the bytes. The image is never decoded, resized, or inspected —
 * no CV dependency exists in `core`.
 *
 * Failure is explicit: a missing source, a stale frame, or an oversize frame
 * all raise a typed {@link SensorError} so the caller can tell the model the
 * honest reason instead of silently sending nothing (or an old frame).
 */

import { systemClock } from '../ports/clock.ts'
import type { SensorRegistry } from './registry.ts'
import { SensorError } from './types.ts'
import type { Snapshot } from './types.ts'

/** Options for {@link readForLook}; all have conservative defaults. */
export interface LookOptions {
  /** Source to read. Omitted means the first registered image source. */
  readonly sourceId?: string
  /** Reject a frame older than this. Defaults to 3 s. */
  readonly maxAgeMs?: number
  /** Reject a frame larger than this, before encoding. Defaults to ~1.5 MB. */
  readonly maxBytes?: number
  /**
   * Current time in milliseconds, normally `clock.now()`.
   *
   * Additive optional field (M2 plan §8.7): a {@link Snapshot} carries only its
   * own capture time, so its age needs a `now`. Passing the injected clock
   * keeps callers deterministic (tests use `FakeClock`); when omitted the
   * process wall clock from `systemClock` is used.
   */
  readonly now?: number
}

/** The snapshot as the model layer consumes it: encoded, with its age. */
export interface ImageForModel {
  readonly sourceId: string
  readonly mime: string
  readonly base64: string
  /** Capture time of the snapshot, on the source's clock (`Clock.now()`). */
  readonly ts: number
  /** `now - ts`, never negative. */
  readonly ageMs: number
}

/** Default freshness limit for `look`, in milliseconds. */
export const DEFAULT_LOOK_MAX_AGE_MS = 3_000
/** Default snapshot size limit for `look`, in bytes (1.5 MB). */
export const DEFAULT_LOOK_MAX_BYTES = 1_500_000

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

/**
 * Standard base64 over raw bytes.
 *
 * Hand-rolled on purpose: `Buffer`, `btoa`, and `TextEncoder` are host APIs,
 * and `core` must stay platform-free. This is pure index arithmetic.
 */
function encodeBase64(bytes: Uint8Array): string {
  let encoded = ''
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index] ?? 0
    const second = bytes[index + 1]
    const third = bytes[index + 2]
    encoded += BASE64_ALPHABET[first >> 2] ?? ''
    encoded += BASE64_ALPHABET[((first & 0b11) << 4) | ((second ?? 0) >> 4)] ?? ''
    encoded += second === undefined ? '=' : BASE64_ALPHABET[((second & 0b1111) << 2) | ((third ?? 0) >> 6)] ?? ''
    encoded += third === undefined ? '=' : BASE64_ALPHABET[third & 0b111111] ?? ''
  }
  return encoded
}

/**
 * Read the newest snapshot for `look`.
 *
 * @throws {SensorError} `NO_SNAPSHOT` when no image source exists / the source
 * returns nothing; `STALE_SNAPSHOT` when the frame is older than `maxAgeMs`;
 * `OVERSIZE_SNAPSHOT` when it exceeds `maxBytes`.
 */
export async function readForLook(registry: SensorRegistry, options: LookOptions = {}): Promise<ImageForModel> {
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_LOOK_MAX_AGE_MS
  const maxBytes = options.maxBytes ?? DEFAULT_LOOK_MAX_BYTES
  const now = options.now !== undefined && Number.isFinite(options.now) ? options.now : systemClock.now()

  let sourceId = options.sourceId
  if (sourceId === undefined) {
    const firstImage = registry.statuses().find(status => status.kind === 'image')
    if (firstImage === undefined) {
      throw new SensorError('NO_SNAPSHOT', 'No image sensor source is registered; attach a camera before calling look.')
    }
    sourceId = firstImage.id
  } else {
    const status = registry.statuses().find(entry => entry.id === sourceId)
    if (status === undefined) {
      throw new SensorError('NO_SNAPSHOT', `No sensor source is registered as "${sourceId}".`)
    }
    if (status.kind !== 'image') {
      throw new SensorError('NO_SNAPSHOT', `Sensor source "${sourceId}" is ${status.kind}, not an image source.`)
    }
  }

  const snapshot = await registry.latestSnapshot(sourceId)
  if (snapshot === undefined) {
    throw new SensorError('NO_SNAPSHOT', `Sensor source "${sourceId}" returned no snapshot right now.`)
  }

  const ageMs = Math.max(0, now - snapshot.ts)
  if (ageMs > maxAgeMs) {
    throw new SensorError(
      'STALE_SNAPSHOT',
      `Snapshot from "${sourceId}" is ${ageMs} ms old, older than maxAgeMs=${maxAgeMs}; take a fresh look instead.`,
    )
  }
  if (snapshot.bytes.byteLength > maxBytes) {
    throw new SensorError(
      'OVERSIZE_SNAPSHOT',
      `Snapshot from "${sourceId}" is ${snapshot.bytes.byteLength} bytes, above maxBytes=${maxBytes}; request a smaller frame.`,
    )
  }

  return {
    sourceId: snapshot.sourceId,
    mime: snapshot.mime,
    base64: encodeBase64(snapshot.bytes),
    ts: snapshot.ts,
    ageMs,
  }
}
