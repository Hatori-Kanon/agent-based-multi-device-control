/**
 * Interchange format for pulse frames.
 *
 * One frame is eight bytes rendered as sixteen hex characters: four frequency
 * bytes followed by four intensity bytes. This is what the vendor's own
 * documentation prints for its built-in waveforms and what the community
 * shares, so importing and exporting in this shape means shared waveforms
 * work without conversion.
 *
 *     0A0A0A0A00000000  ->  freq {10,10,10,10}  intensity {0,0,0,0}
 */

import { SafetyError } from '../devices/errors.ts'
import {
  MAX_FREQ,
  MAX_FRAMES,
  MAX_INTENSITY,
  MIN_FREQ,
  MIN_INTENSITY,
  SLOTS_PER_FRAME,
  buildSlots,
  type PulseFrame,
} from './types.ts'

const FRAME_HEX_LENGTH = 16
const HEX_PATTERN = /^[0-9a-fA-F]{16}$/

function byteAt(hex: string, byteIndex: number): number {
  return Number.parseInt(hex.slice(byteIndex * 2, byteIndex * 2 + 2), 16)
}

/**
 * Parse one frame.
 *
 * @param index - Position in the source list, used to make errors locatable.
 * @throws SafetyError `INVALID_WAVEFORM` for bad length, bad hex, or a value
 *   the pulse box would reject. Out-of-range values are refused rather than
 *   clamped because a silently mangled community waveform is worse than a
 *   clear rejection.
 */
export function parseHexFrame(hex: string, index = 0): PulseFrame {
  const trimmed = hex.trim()
  if (trimmed.length !== FRAME_HEX_LENGTH || !HEX_PATTERN.test(trimmed)) {
    throw new SafetyError(
      'INVALID_WAVEFORM',
      `frame ${index}: expected ${FRAME_HEX_LENGTH} hex characters (4 frequency bytes then 4 intensity bytes), received "${hex}"`,
    )
  }
  const freq = buildSlots(slot => byteAt(trimmed, slot))
  const intensity = buildSlots(slot => byteAt(trimmed, SLOTS_PER_FRAME + slot))
  for (let slot = 0; slot < SLOTS_PER_FRAME; slot += 1) {
    const f = freq[slot] ?? 0
    const i = intensity[slot] ?? 0
    if (f < MIN_FREQ || f > MAX_FREQ) {
      throw new SafetyError(
        'INVALID_WAVEFORM',
        `frame ${index} slot ${slot}: frequency ${f} is outside ${MIN_FREQ}-${MAX_FREQ}; the pulse box discards a channel whose frame contains an illegal value`,
      )
    }
    if (i < MIN_INTENSITY || i > MAX_INTENSITY) {
      throw new SafetyError(
        'INVALID_WAVEFORM',
        `frame ${index} slot ${slot}: intensity ${i} is outside ${MIN_INTENSITY}-${MAX_INTENSITY}`,
      )
    }
  }
  return { freq, intensity }
}

/** Render one frame back to the interchange form. */
export function formatHexFrame(frame: PulseFrame): string {
  const bytes: number[] = []
  for (let slot = 0; slot < SLOTS_PER_FRAME; slot += 1) bytes.push(frame.freq[slot] ?? MIN_FREQ)
  for (let slot = 0; slot < SLOTS_PER_FRAME; slot += 1) bytes.push(frame.intensity[slot] ?? 0)
  return bytes.map(byte => byte.toString(16).padStart(2, '0').toUpperCase()).join('')
}

/** Parse a shared waveform. */
export function parseHexFrames(hex: readonly string[]): PulseFrame[] {
  if (hex.length === 0) {
    throw new SafetyError('INVALID_WAVEFORM', 'a waveform needs at least one frame')
  }
  if (hex.length > MAX_FRAMES) {
    throw new SafetyError('INVALID_WAVEFORM', `a waveform may not exceed ${MAX_FRAMES} frames (${MAX_FRAMES / 10} seconds)`)
  }
  return hex.map((frame, index) => parseHexFrame(frame, index))
}
