/**
 * The authoring surface: a small declarative script that compiles to frames.
 *
 * A two-second waveform is twenty eight-byte hex strings. Asking a model to
 * emit those costs roughly ten times the tokens of the equivalent script, and
 * one transposed character deforms the whole waveform instead of nudging one
 * segment. Segments are also reviewable by a human, which matters for
 * something that drives an electrical output.
 *
 *     { ms: 800, freq: { from: 60, to: 20 }, intensity: { from: 0, to: 70 }, curve: 'easeIn' }
 */

import { SafetyError } from '../devices/errors.ts'
import {
  FRAME_MS,
  MAX_FRAMES,
  MAX_FREQ,
  MAX_INTENSITY,
  MIN_FREQ,
  MIN_INTENSITY,
  SLOTS_PER_FRAME,
  SLOT_MS,
  buildSlots,
  type PulseFrame,
} from './types.ts'

/** How a segment interpolates between its start and end values. */
export type WaveformCurve = 'linear' | 'easeIn' | 'easeOut' | 'easeInOut' | 'step'

/** A constant, or a value that travels from one bound to another. */
export type RampedValue = number | { readonly from: number; readonly to: number }

export interface WaveformSegment {
  /** Duration in milliseconds; whole number, at least one slot. */
  readonly ms: number
  readonly freq: RampedValue
  readonly intensity: RampedValue
  /** Defaults to `linear`. `step` holds `from` for the whole segment. */
  readonly curve?: WaveformCurve
}

export interface WaveformScript {
  readonly name: string
  /** Defaults to `true`; a waveform is usually loop material. */
  readonly loop?: boolean
  readonly tags?: readonly string[]
  readonly segments: readonly WaveformSegment[]
}

/** Compiler output; the library assigns the id and source. */
export interface CompiledWaveform {
  readonly name: string
  readonly frames: readonly PulseFrame[]
  readonly loop: boolean
  readonly tags: readonly string[]
}

const MAX_SEGMENTS = 64
const MAX_NAME_LENGTH = 64
const MAX_TAGS = 8
const MAX_TAG_LENGTH = 24
const MAX_SEGMENT_MS = 60_000

interface Span {
  readonly startMs: number
  readonly ms: number
  readonly freqFrom: number
  readonly freqTo: number
  readonly intensityFrom: number
  readonly intensityTo: number
  readonly curve: WaveformCurve
}

function fail(message: string): never {
  throw new SafetyError('INVALID_WAVEFORM', message)
}

function bounds(value: RampedValue, label: string, index: number, low: number, high: number): { from: number; to: number } {
  const from = typeof value === 'number' ? value : value.from
  const to = typeof value === 'number' ? value : value.to
  for (const [edge, candidate] of [['from', from], ['to', to]] as const) {
    if (typeof candidate !== 'number' || !Number.isFinite(candidate)) {
      fail(`segment ${index}: ${label}.${edge} must be a number`)
    }
    if (candidate < low || candidate > high) {
      fail(`segment ${index}: ${label}.${edge} is ${candidate}, outside the legal ${low}-${high}`)
    }
  }
  return { from, to }
}

function easing(curve: WaveformCurve, progress: number): number {
  switch (curve) {
    case 'linear':
      return progress
    case 'easeIn':
      return progress * progress
    case 'easeOut':
      return 1 - (1 - progress) * (1 - progress)
    case 'easeInOut':
      // Symmetric quadratic: slow start, fastest through the middle, slow end.
      return progress < 0.5
        ? 2 * progress * progress
        : 1 - 2 * (1 - progress) * (1 - progress)
    case 'step':
      // Progress never reaches 1 inside a segment, so `from` holds throughout
      // and the change lands on the segment boundary.
      return progress >= 1 ? 1 : 0
  }
}

function validate(script: WaveformScript): Span[] {
  const name = script.name?.trim() ?? ''
  if (name.length === 0 || name.length > MAX_NAME_LENGTH) {
    fail(`name must be 1-${MAX_NAME_LENGTH} characters`)
  }
  const tags = script.tags ?? []
  if (tags.length > MAX_TAGS) fail(`at most ${MAX_TAGS} tags are allowed`)
  for (const tag of tags) {
    if (typeof tag !== 'string' || tag.trim().length === 0 || tag.length > MAX_TAG_LENGTH) {
      fail(`each tag must be 1-${MAX_TAG_LENGTH} characters`)
    }
  }
  if (!Array.isArray(script.segments) || script.segments.length === 0) {
    fail('a script needs at least one segment')
  }
  if (script.segments.length > MAX_SEGMENTS) fail(`at most ${MAX_SEGMENTS} segments are allowed`)

  const spans: Span[] = []
  let cursor = 0
  for (const [index, segment] of script.segments.entries()) {
    if (!Number.isSafeInteger(segment.ms) || segment.ms < SLOT_MS || segment.ms > MAX_SEGMENT_MS) {
      fail(`segment ${index}: ms must be a whole number from ${SLOT_MS} to ${MAX_SEGMENT_MS}`)
    }
    const curve = segment.curve ?? 'linear'
    if (!['linear', 'easeIn', 'easeOut', 'easeInOut', 'step'].includes(curve)) {
      fail(`segment ${index}: unknown curve "${String(curve)}"`)
    }
    const freq = bounds(segment.freq, 'freq', index, MIN_FREQ, MAX_FREQ)
    const intensity = bounds(segment.intensity, 'intensity', index, MIN_INTENSITY, MAX_INTENSITY)
    spans.push({
      startMs: cursor,
      ms: segment.ms,
      freqFrom: freq.from,
      freqTo: freq.to,
      intensityFrom: intensity.from,
      intensityTo: intensity.to,
      curve,
    })
    cursor += segment.ms
  }

  if (cursor % FRAME_MS !== 0) {
    fail(
      `total duration must be a whole number of ${FRAME_MS}ms frames because the hardware streams frames; it is currently ${cursor}ms — adjust a segment by ${FRAME_MS - (cursor % FRAME_MS)}ms`,
    )
  }
  const frameCount = cursor / FRAME_MS
  if (frameCount < 1 || frameCount > MAX_FRAMES) {
    fail(`total duration must be between ${FRAME_MS}ms and ${MAX_FRAMES * FRAME_MS}ms; it is ${cursor}ms`)
  }
  return spans
}

function spanFor(spans: readonly Span[], timeMs: number): Span {
  for (const span of spans) {
    if (timeMs < span.startMs + span.ms) return span
  }
  // Defensive: the caller never samples past the end.
  return spans[spans.length - 1]!
}

/**
 * Compile a script into frames.
 *
 * Each of the four slots in a frame is sampled independently at 25 ms
 * resolution, so ramps come out four times smoother than the vendor presets,
 * which repeat one value across the whole frame.
 *
 * @throws SafetyError `INVALID_WAVEFORM` with a message that names the
 *   offending segment and the legal range.
 */
export function compileWaveformScript(script: WaveformScript): CompiledWaveform {
  const spans = validate(script)
  const totalMs = spans.reduce((sum, span) => sum + span.ms, 0)
  const frameCount = totalMs / FRAME_MS
  const frames: PulseFrame[] = []

  for (let frame = 0; frame < frameCount; frame += 1) {
    const sampleAt = (slot: number): { freq: number; intensity: number } => {
      const timeMs = frame * FRAME_MS + slot * SLOT_MS
      const span = spanFor(spans, timeMs)
      const progress = span.ms === 0 ? 1 : (timeMs - span.startMs) / span.ms
      const eased = easing(span.curve, progress)
      return {
        freq: span.freqFrom + (span.freqTo - span.freqFrom) * eased,
        intensity: span.intensityFrom + (span.intensityTo - span.intensityFrom) * eased,
      }
    }
    frames.push({
      freq: buildSlots(slot => {
        const value = Math.round(sampleAt(slot).freq)
        return Math.min(MAX_FREQ, Math.max(MIN_FREQ, value))
      }),
      intensity: buildSlots(slot => {
        const value = Math.round(sampleAt(slot).intensity)
        return Math.min(MAX_INTENSITY, Math.max(MIN_INTENSITY, value))
      }),
    })
  }

  const produces = frames.some(candidate => {
    for (let slot = 0; slot < SLOTS_PER_FRAME; slot += 1) {
      if ((candidate.intensity[slot] ?? 0) > 0) return true
    }
    return false
  })
  if (!produces) {
    fail('this waveform never produces output; at least one slot must have intensity above 0')
  }

  return {
    name: script.name.trim(),
    frames,
    loop: script.loop ?? true,
    tags: (script.tags ?? []).map(tag => tag.trim()),
  }
}
