/**
 * Waveform representation for pulse hardware.
 *
 * A waveform is *texture*, not amplitude. On a Coyote the channel strength
 * (0-200) sets pulse voltage and is capped in hardware by the `BF` command;
 * a waveform only modulates pulse width and repetition. That separation is
 * why an agent may author waveforms at all — the worst a bad one can do is
 * feel fuller within a ceiling it cannot move.
 *
 * The protocol carries four 25 ms slots per 100 ms frame. Vendor presets fill
 * all four slots identically, but nothing requires that, so the compiler here
 * samples per slot and produces smoother curves than the stock presets.
 */

/** Wall time one frame occupies. */
export const FRAME_MS = 100
/** Wall time one slot occupies. Four slots make a frame. */
export const SLOT_MS = 25
export const SLOTS_PER_FRAME = 4

/** Protocol-legal waveform frequency range (encoded units, not Hz). */
export const MIN_FREQ = 10
export const MAX_FREQ = 240

/**
 * Protocol-legal waveform intensity range.
 *
 * 100 corresponds to a ~100 µs pulse width, which the vendor's own V2 notes
 * flag as the point where pulses start to sting. The emit path therefore caps
 * every slot at the channel's internal `maxWaveIntensity` (default 80, not a
 * UI/API option). Amplitude is bounded by the channel's strength interval, and
 * the waveform frequency band is bounded by `minFreq`/`maxFreq` in the channel
 * policy.
 */
export const MIN_INTENSITY = 0
export const MAX_INTENSITY = 100

/** Longest waveform we accept: 600 frames = 60 s of loop material. */
export const MAX_FRAMES = 600

/** Four per-slot values inside one frame. */
export type FrameSlots = readonly [number, number, number, number]

/** One 100 ms output frame. */
export interface PulseFrame {
  readonly freq: FrameSlots
  readonly intensity: FrameSlots
}

/** Where a waveform came from. */
export type WaveformSource = 'builtin' | 'imported' | 'authored'

/**
 * Durability of a waveform.
 *
 * Agent authoring only ever reaches `session`, which is discarded when the
 * session ends. Moving something into `library` is a human action.
 */
export type WaveformScope = 'library' | 'session'

export interface Waveform {
  readonly id: string
  readonly name: string
  readonly frames: readonly PulseFrame[]
  /** Repeat from the first frame after the last one. */
  readonly loop: boolean
  readonly source: WaveformSource
  /** Narrative hints, e.g. `gentle`, `rhythmic`, `sharp`, `building`. */
  readonly tags: readonly string[]
}

/**
 * What the model and the UI see.
 *
 * Deliberately excludes frame data: a 60 s waveform is 600 hex strings, and
 * the model never needs them to choose one.
 */
export interface WaveformSummary {
  readonly id: string
  readonly name: string
  readonly source: WaveformSource
  readonly scope: WaveformScope
  readonly tags: readonly string[]
  readonly loop: boolean
  readonly frameCount: number
  readonly durationMs: number
  readonly peakIntensity: number
  readonly meanIntensity: number
  readonly minFreq: number
  readonly maxFreq: number
}

/** Build the four slots of a frame from a per-slot sampler. */
export function buildSlots(sample: (slot: number) => number): FrameSlots {
  return [sample(0), sample(1), sample(2), sample(3)]
}

/** Total wall time of one pass through the waveform. */
export function waveformDurationMs(waveform: Waveform): number {
  return waveform.frames.length * FRAME_MS
}

/**
 * Frame for a given index, honouring `loop`.
 *
 * @returns `undefined` once a non-looping waveform has run out, which the
 *   backend treats as "hold silence".
 */
export function frameAt(waveform: Waveform, frameIndex: number): PulseFrame | undefined {
  const count = waveform.frames.length
  if (count === 0 || frameIndex < 0) return undefined
  if (frameIndex < count) return waveform.frames[frameIndex]
  return waveform.loop ? waveform.frames[frameIndex % count] : undefined
}

/** Derive the model-facing summary. */
export function summarizeWaveform(waveform: Waveform, scope: WaveformScope): WaveformSummary {
  let peak = 0
  let total = 0
  let slots = 0
  let minFreq = MAX_FREQ
  let maxFreq = MIN_FREQ
  for (const frame of waveform.frames) {
    for (let slot = 0; slot < SLOTS_PER_FRAME; slot += 1) {
      const intensity = frame.intensity[slot] ?? 0
      const freq = frame.freq[slot] ?? MIN_FREQ
      peak = Math.max(peak, intensity)
      total += intensity
      slots += 1
      minFreq = Math.min(minFreq, freq)
      maxFreq = Math.max(maxFreq, freq)
    }
  }
  return {
    id: waveform.id,
    name: waveform.name,
    source: waveform.source,
    scope,
    tags: waveform.tags,
    loop: waveform.loop,
    frameCount: waveform.frames.length,
    durationMs: waveformDurationMs(waveform),
    peakIntensity: peak,
    meanIntensity: slots === 0 ? 0 : Math.round(total / slots),
    minFreq: waveform.frames.length === 0 ? 0 : minFreq,
    maxFreq: waveform.frames.length === 0 ? 0 : maxFreq,
  }
}
