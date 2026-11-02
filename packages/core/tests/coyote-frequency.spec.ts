import { describe, expect, it } from 'vitest'
import {
  codeToHz,
  frequencyBandToHz,
  hzBandToCode,
  hzToCode,
  MAX_FREQ_CODE,
  MAX_FREQ_HZ,
  MIN_FREQ_CODE,
  MIN_FREQ_HZ,
} from '../src/index.ts'

/**
 * The vendor code table.
 *
 * A transmitted code is a pulse period in milliseconds under piecewise
 * compression, so the physical frequency is `1000 / period`. A mid-band code
 * is the one that is easy to get wrong: 110 is `100 + 10*5 = 150 ms`, i.e.
 * 6.67 Hz, not 100/110 of anything.
 */
const CODE_TO_HZ: ReadonlyArray<readonly [number, number]> = [
  [10, 100],
  [20, 50],
  [50, 20],
  [100, 10],
  [102, 1000 / 110],
  [110, 1000 / 150],
  [200, 1000 / 600],
  [204, 1000 / 640],
  [240, 1],
]

describe('coyote frequency conversion', () => {
  it('maps the protocol code table onto physical pulse frequency', () => {
    for (const [code, hz] of CODE_TO_HZ) {
      expect(codeToHz(code)).toBeCloseTo(hz, 10)
    }
  })

  it('clamps out-of-range codes instead of producing nonsense', () => {
    expect(codeToHz(0)).toBe(100)
    expect(codeToHz(5)).toBe(100)
    expect(codeToHz(999)).toBe(1)
    expect(codeToHz(Number.NaN)).toBe(100)
    // Both ends of the legal range are inclusive.
    expect(codeToHz(MIN_FREQ_CODE)).toBe(MAX_FREQ_HZ)
    expect(codeToHz(MAX_FREQ_CODE)).toBe(MIN_FREQ_HZ)
  })

  it('round-trips every legal code through Hz and back', () => {
    for (let code = MIN_FREQ_CODE; code <= MAX_FREQ_CODE; code += 1) {
      const hz = codeToHz(code)
      expect(hzToCode(hz)).toBe(code)
    }
  })

  it('clamps Hz input into 1-100 before choosing a code', () => {
    expect(hzToCode(MIN_FREQ_HZ)).toBe(MAX_FREQ_CODE)
    expect(hzToCode(MAX_FREQ_HZ)).toBe(MIN_FREQ_CODE)
    expect(hzToCode(0)).toBe(MAX_FREQ_CODE)
    expect(hzToCode(-5)).toBe(MAX_FREQ_CODE)
    expect(hzToCode(101)).toBe(MIN_FREQ_CODE)
    expect(hzToCode(Number.NaN)).toBe(MAX_FREQ_CODE)
  })

  it('returns the code whose physical frequency is nearest the request', () => {
    // 6 Hz: candidates are 165 ms (6.06 Hz) and 170 ms (5.88 Hz); 165 wins.
    expect(hzToCode(6)).toBe(113)
    expect(codeToHz(hzToCode(6))).toBeCloseTo(6.06, 1)
    // 87 Hz: period 11.5 ms, so code 12 (83.3 Hz) is nearer than code 11 (90.9 Hz).
    expect(hzToCode(87)).toBe(12)
    expect(codeToHz(hzToCode(87))).toBeCloseTo(83.33, 1)
    // Fast end: both 10 and 11 codes are within a step, 100 Hz is exact.
    expect(hzToCode(95)).toBe(11)
    expect(hzToCode(99)).toBe(10)
  })

  it('exposes the whole-Hz display band with the protocol inversion applied', () => {
    // Code 10 is the fastest (100 Hz), code 240 the slowest (1 Hz).
    expect(frequencyBandToHz({ minCode: 10, maxCode: 240 })).toEqual({ minHz: 1, maxHz: 100 })
    expect(frequencyBandToHz({ minCode: 20, maxCode: 120 })).toEqual({ minHz: 5, maxHz: 50 })
    expect(frequencyBandToHz({ minCode: 50, maxCode: 100 })).toEqual({ minHz: 10, maxHz: 20 })
    // Whole-Hz rounding is the display contract.
    expect(frequencyBandToHz({ minCode: 21, maxCode: 24 })).toEqual({ minHz: 42, maxHz: 48 })
  })

  it('converts a whole-Hz band into an ordered code pair', () => {
    expect(hzBandToCode({ minHz: 1, maxHz: 100 })).toEqual({ minCode: 10, maxCode: 240 })
    expect(hzBandToCode({ minHz: 5, maxHz: 50 })).toEqual({ minCode: 20, maxCode: 120 })
    expect(hzBandToCode({ minHz: 4, maxHz: 40 })).toEqual({ minCode: 25, maxCode: 130 })
    // The display path and the input path agree on representable whole-Hz bands.
    for (const band of [{ minHz: 1, maxHz: 100 }, { minHz: 5, maxHz: 50 }, { minHz: 4, maxHz: 40 }]) {
      expect(frequencyBandToHz(hzBandToCode(band))).toEqual(band)
    }
  })

  it('widens a band that collapses onto one code instead of returning an empty one', () => {
    // 49 Hz and 50 Hz are both nearest to code 20 (50 Hz); the pair must widen.
    const narrow = hzBandToCode({ minHz: 49, maxHz: 50 })
    expect(narrow.minCode).toBeLessThan(narrow.maxCode)
    expect(narrow).toEqual({ minCode: 20, maxCode: 21 })

    // Same at the fast end of the compressed range (90-95 Hz both collapse on 11).
    const fast = hzBandToCode({ minHz: 90, maxHz: 95 })
    expect(fast.minCode).toBeLessThan(fast.maxCode)
    expect(fast).toEqual({ minCode: 11, maxCode: 12 })
  })

  it('clamps band input into the legal ranges', () => {
    expect(hzBandToCode({ minHz: -20, maxHz: 500 })).toEqual({ minCode: 10, maxCode: 240 })
    expect(frequencyBandToHz({ minCode: 0, maxCode: 999 })).toEqual({ minHz: 1, maxHz: 100 })
    // A caller that accidentally passes the band reversed still gets an ordered pair.
    expect(hzBandToCode({ minHz: 50, maxHz: 5 })).toEqual({ minCode: 20, maxCode: 120 })
  })
})
