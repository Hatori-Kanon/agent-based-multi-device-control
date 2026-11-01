/**
 * Emit-path waveform mapping.
 *
 * A waveform's `freq` slots are protocol-encoded values in `[MIN_FREQ,
 * MAX_FREQ]`. A channel's `[minFreq, maxFreq]` policy is the **band the human
 * allows output in**, so every emitted frame is linearly remapped from the
 * protocol band into that band. The default band is the protocol band itself,
 * which is an identity mapping and returns the original frame unchanged.
 *
 * Intensity bytes are pulse **width**, not amplitude. The v3 UI no longer
 * exposes a pulse-width control, but the deployment safety cap is still
 * enforced here: {@link clampFrameIntensity} limits every slot to the channel's
 * internal `maxWaveIntensity` (default 80), keeping output clear of the ~100 µs
 * stinging threshold even when a built-in or model-authored waveform asks for
 * more. The Coyote backend applies this after the frequency mapping; backends
 * without waveform support never see frames at all.
 *
 * Note what is deliberately **not** enforced here: a slew limit between
 * consecutive slots. The idea was to prevent a startling 0-to-100 jump, but
 * the vendor's own `挤压` and `气泡` presets are exactly that — square waves
 * between 0 and 100 — so a slew limit would reject most shared waveforms while
 * protecting nothing.
 */

import {
  MAX_FREQ,
  MAX_INTENSITY,
  MIN_FREQ,
  MIN_INTENSITY,
  SLOTS_PER_FRAME,
  buildSlots,
  type PulseFrame,
  type Waveform,
} from './types.ts'

/** Clamp a band endpoint into the protocol range. */
function protocolFreq(value: number): number {
  if (!Number.isFinite(value)) return MIN_FREQ
  return Math.min(MAX_FREQ, Math.max(MIN_FREQ, Math.round(value)))
}

interface FrequencyBand {
  readonly min: number
  readonly max: number
}

/** Normalise an endpoint pair: protocol-clamped and ordered. */
function normaliseBand(minFreq: number, maxFreq: number): FrequencyBand {
  const a = protocolFreq(minFreq)
  const b = protocolFreq(maxFreq)
  return a <= b ? { min: a, max: b } : { min: b, max: a }
}

function isIdentityBand(band: FrequencyBand): boolean {
  return band.min === MIN_FREQ && band.max === MAX_FREQ
}

/** `round(band.min + (f - MIN_FREQ) / (MAX_FREQ - MIN_FREQ) * bandWidth)`. */
function mapFreq(freq: number, band: FrequencyBand): number {
  const width = MAX_FREQ - MIN_FREQ
  const span = band.max - band.min
  const mapped = band.min + (((freq - MIN_FREQ) / width) * span)
  return Math.min(MAX_FREQ, Math.max(MIN_FREQ, Math.round(mapped)))
}

/**
 * Map one frame's frequencies into `[minFreq, maxFreq]`, leaving intensity
 * alone.
 *
 * Returns the original object when the band is the full protocol band, so a
 * default policy keeps reference equality through the emit path.
 */
export function clampFrameFrequency(frame: PulseFrame, minFreq: number, maxFreq: number): PulseFrame {
  const band = normaliseBand(minFreq, maxFreq)
  if (isIdentityBand(band)) return frame
  const freq = buildSlots(slot => mapFreq(frame.freq[slot] ?? MIN_FREQ, band))
  return { freq, intensity: frame.intensity }
}

/** Normalise a pulse-width cap: integer, protocol range, fail closed. */
function normaliseIntensityCap(maxIntensity: number): number {
  if (!Number.isFinite(maxIntensity)) return MIN_INTENSITY
  return Math.min(MAX_INTENSITY, Math.max(MIN_INTENSITY, Math.round(maxIntensity)))
}

/**
 * Bring one frame's intensities under the channel's internal pulse-width cap.
 * Frequencies are untouched.
 *
 * Returns the original object when nothing needs clamping, so the common case
 * keeps reference equality through the emit path.
 */
export function clampFrameIntensity(frame: PulseFrame, maxIntensity: number): PulseFrame {
  const ceiling = normaliseIntensityCap(maxIntensity)
  let needsClamp = false
  for (let slot = 0; slot < SLOTS_PER_FRAME; slot += 1) {
    if ((frame.intensity[slot] ?? 0) > ceiling) {
      needsClamp = true
      break
    }
  }
  if (!needsClamp) return frame
  return {
    freq: frame.freq,
    intensity: buildSlots(slot => Math.min(ceiling, frame.intensity[slot] ?? 0)),
  }
}

/** Bring a whole waveform under the pulse-width cap, for preview and reporting. */
export function clampWaveformIntensity(waveform: Waveform, maxIntensity: number): Waveform {
  const frames = waveform.frames.map(frame => clampFrameIntensity(frame, maxIntensity))
  const changed = frames.some((frame, index) => frame !== waveform.frames[index])
  return changed ? { ...waveform, frames } : waveform
}

/** Map a whole waveform's frequencies for preview and reporting. */
export function clampWaveformFrequency(waveform: Waveform, minFreq: number, maxFreq: number): Waveform {
  const band = normaliseBand(minFreq, maxFreq)
  if (isIdentityBand(band)) return waveform
  const frames = waveform.frames.map(frame => clampFrameFrequency(frame, band.min, band.max))
  return { ...waveform, frames }
}

/** Highest intensity anywhere in the waveform, for summaries and warnings. */
export function peakIntensity(waveform: Waveform): number {
  let peak = 0
  for (const frame of waveform.frames) {
    for (let slot = 0; slot < SLOTS_PER_FRAME; slot += 1) {
      peak = Math.max(peak, frame.intensity[slot] ?? 0)
    }
  }
  return peak
}
