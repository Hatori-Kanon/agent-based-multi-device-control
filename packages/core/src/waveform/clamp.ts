/**
 * Emit-path intensity clamping.
 *
 * Waveform intensity is pulse *width*, and 100 sits at the point the vendor's
 * own V2 notes flag as the onset of stinging. Deployment policy therefore caps
 * it below the protocol maximum.
 *
 * Note what is deliberately **not** enforced here: a slew limit between
 * consecutive slots. The idea was to prevent a startling 0-to-100 jump, but
 * the vendor's own `挤压` and `气泡` presets are exactly that — square waves
 * between 0 and 100 — so a slew limit would reject most shared waveforms while
 * protecting nothing. Amplitude is what makes an output strong, and amplitude
 * is capped in hardware by the `BF` command, one layer below this one.
 */

import {
  MAX_INTENSITY,
  MIN_INTENSITY,
  SLOTS_PER_FRAME,
  buildSlots,
  type PulseFrame,
  type Waveform,
} from './types.ts'

/**
 * Default cap on pulse width.
 *
 * 80 keeps output clear of the ~100 µs stinging threshold while leaving most
 * of the expressive range available. A human may raise it toward 100.
 */
export const DEFAULT_MAX_WAVE_INTENSITY = 80

/** Bring one frame's intensities under a cap. Frequencies are untouched. */
export function clampFrameIntensity(frame: PulseFrame, maxIntensity: number): PulseFrame {
  const ceiling = Math.min(MAX_INTENSITY, Math.max(MIN_INTENSITY, Math.round(maxIntensity)))
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

/** Bring a whole waveform under a cap, for preview and reporting. */
export function clampWaveformIntensity(waveform: Waveform, maxIntensity: number): Waveform {
  const frames = waveform.frames.map(frame => clampFrameIntensity(frame, maxIntensity))
  const changed = frames.some((frame, index) => frame !== waveform.frames[index])
  return changed ? { ...waveform, frames } : waveform
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
