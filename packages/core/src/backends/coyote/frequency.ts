/**
 * Coyote V3 waveform frequency: transmitted code <-> physical pulse frequency.
 *
 * The `B0` frame carries a per-slot waveform frequency byte in `10..240`, and
 * that byte is **not** a frequency: it is the pulse period in milliseconds
 * under piecewise compression. The vendor compresses a 10-1000 ms period into
 * ten protocol steps of resolution at the fast end, so the raw byte and the
 * physical frequency are inversely, non-linearly related:
 *
 *   period(v) = v                    for  10 <= v <= 100
 *             = 100 + (v - 100)*5    for 101 <= v <= 200
 *             = 600 + (v - 200)*10   for 201 <= v <= 240
 *
 * The physical frequency is the inverse of that period, `1000 / period(v)` Hz.
 * The fastest code 10 is therefore 100 Hz and the slowest 240 is 1 Hz; a
 * mid-band code is the one people get wrong, so a worked example: `v = 110`
 * gives `100 + 10*5 = 150 ms`, and `1000 / 150 = 6.67 Hz`.
 *
 * This module is pure encoding math. It does not touch the safety runtime: the
 * channel policy still stores its band in protocol units (`minFreq`/`maxFreq`),
 * and the console only uses these helpers to *display* a band in Hz and to
 * convert a human's Hz input back into a protocol code pair.
 *
 * Source: `_reference/dglab/coyote/v3/README.md` ("通道波形频率 / 通道波形强度").
 */

/** Fastest protocol code, i.e. the shortest pulse period (10 ms = 100 Hz). */
export const MIN_FREQ_CODE = 10
/** Slowest protocol code, i.e. the longest pulse period (1000 ms = 1 Hz). */
export const MAX_FREQ_CODE = 240
/** Slowest physical waveform frequency a human may set. */
export const MIN_FREQ_HZ = 1
/** Fastest physical waveform frequency a human may set. */
export const MAX_FREQ_HZ = 100

/** A frequency band in protocol units. `minCode` is the faster end. */
export interface FrequencyBandCode {
  readonly minCode: number
  readonly maxCode: number
}

/** A frequency band in whole physical Hz. `minHz` is the slower end. */
export interface FrequencyBandHz {
  readonly minHz: number
  readonly maxHz: number
}

/** Clamp to the legal transmitted-code range; non-finite input reads as code 10. */
function clampCode(code: number): number {
  if (!Number.isFinite(code)) return MIN_FREQ_CODE
  return Math.min(MAX_FREQ_CODE, Math.max(MIN_FREQ_CODE, code))
}

/** Clamp a human-supplied frequency to the physically meaningful range. */
function clampHz(hz: number): number {
  if (!Number.isFinite(hz)) return MIN_FREQ_HZ
  return Math.min(MAX_FREQ_HZ, Math.max(MIN_FREQ_HZ, hz))
}

/**
 * Pulse period the box will produce for a transmitted code, in milliseconds.
 *
 * Piecewise per the vendor table; out-of-range codes are clamped so a bad
 * caller cannot produce a nonsensical period.
 */
function periodMsForCode(code: number): number {
  const value = clampCode(code)
  if (value <= 100) return value
  if (value <= 200) return 100 + (value - 100) * 5
  return 600 + (value - 200) * 10
}

/**
 * Physical frequency in Hz for a transmitted waveform-frequency code.
 *
 * Fractional values are expected (the code space is quantised, the physical
 * frequency is not); display code should round with {@link frequencyBandToHz}.
 * Codes outside `10..240` are clamped rather than rejected.
 */
export function codeToHz(code: number): number {
  return 1000 / periodMsForCode(code)
}

/**
 * Continuous inverse of {@link periodMsForCode}: the code a period would need
 * if the protocol did not round to whole codes.
 */
function approximateCodeForPeriod(period: number): number {
  if (period <= 100) return period
  if (period <= 600) return 100 + (period - 100) / 5
  return 200 + (period - 600) / 10
}

/**
 * Nearest transmitted code for a physical frequency in Hz.
 *
 * The Hz input is clamped into `1..100`; the returned code is always a whole
 * number in `10..240`. "Nearest" is measured on the physical frequency, so the
 * console sends the code the box would actually play closest to the human's
 * request. The two integer neighbours of the unrounded code are both checked
 * because the compression is piecewise and the unrounded code sits in the gap
 * at a segment boundary (period 100-105 ms or 600-610 ms).
 *
 * Round-trip: `codeToHz(hzToCode(codeToHz(code))) === codeToHz(code)` for every
 * legal code. For an arbitrary Hz input the byte has finite resolution — one
 * millisecond per step at the fast end, where code 10 is 100 Hz and code 11 is
 * 90.9 Hz — so the result can be up to half a code step away. Whole-Hz display
 * values are not all representable for the same reason.
 */
export function hzToCode(hz: number): number {
  const requested = clampHz(hz)
  const period = 1000 / requested
  const approximate = approximateCodeForPeriod(period)
  const lower = Math.max(MIN_FREQ_CODE, Math.min(MAX_FREQ_CODE, Math.floor(approximate)))
  const upper = Math.max(MIN_FREQ_CODE, Math.min(MAX_FREQ_CODE, Math.ceil(approximate)))
  let best = lower
  let bestError = Math.abs(codeToHz(lower) - requested)
  const upperError = Math.abs(codeToHz(upper) - requested)
  if (upperError < bestError) {
    best = upper
    bestError = upperError
  }
  return best
}

/**
 * Convert a stored protocol band into a display band of whole Hz.
 *
 * The protocol's `minCode` is the *faster* end of the band (a code is a pulse
 * period), so the Hz band is inverted: `minHz` comes from `maxCode` and
 * `maxHz` from `minCode`. Whole-Hz rounding is deliberate — the console shows
 * `3–20 Hz`, and every snapshot value is meant to be directly printable.
 */
export function frequencyBandToHz(band: FrequencyBandCode): FrequencyBandHz {
  return {
    minHz: Math.round(codeToHz(band.maxCode)),
    maxHz: Math.round(codeToHz(band.minCode)),
  }
}

/**
 * Convert a display band in whole Hz into a legal protocol code pair.
 *
 * The code pair is always ordered (`minCode < maxCode`), because the policy
 * validator rejects an empty band. A very narrow request can collapse to one
 * code because the code space is coarse at the slow end (one step is up to
 * 10 ms there); when that happens the band is widened by one step rather than
 * silently returning an invalid pair. The widening prefers the slower code so
 * the requested fast end stays intact, and falls back to the fast side only at
 * the slow-most legal code.
 */
export function hzBandToCode(band: FrequencyBandHz): FrequencyBandCode {
  let minHz = clampHz(band.minHz)
  let maxHz = clampHz(band.maxHz)
  // Callers validate the band first; a defensive swap keeps the output a legal
  // ordered pair even if a future caller forgets to.
  if (minHz > maxHz) {
    const swap = minHz
    minHz = maxHz
    maxHz = swap
  }
  let minCode = hzToCode(maxHz)
  let maxCode = hzToCode(minHz)
  if (minCode >= maxCode) {
    if (maxCode < MAX_FREQ_CODE) {
      maxCode = Math.min(MAX_FREQ_CODE, minCode + 1)
    } else {
      minCode = Math.max(MIN_FREQ_CODE, maxCode - 1)
    }
  }
  return { minCode, maxCode }
}
