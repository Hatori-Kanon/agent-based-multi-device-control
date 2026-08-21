import { describe, expect, it } from 'vitest'
import {
  B0_LENGTH,
  BF_LENGTH,
  clampStrength,
  COYOTE_BLE_NAME,
  COYOTE_NOTIFY_CHARACTERISTIC,
  COYOTE_SERVICE,
  COYOTE_WRITE_CHARACTERISTIC,
  decodeNotification,
  encodeB0,
  encodeBF,
  MAX_STRENGTH,
  percentToStrength,
  SILENT_FREQ,
  SILENT_INTENSITY,
  strengthToPercent,
  toHex,
  type B0Fields,
  type FrameSlots,
} from '../src/index.ts'

function s(a: number, b: number, c: number, d: number): FrameSlots {
  return [a, b, c, d]
}

/** Silence exactly as the vendor examples write it: all-zero frequency too. */
const VENDOR_SILENT_FREQ = s(0, 0, 0, 0)
const VENDOR_SILENT_INTENSITY = s(0, 0, 0, 101)

function b0(overrides: Partial<B0Fields> = {}): Uint8Array {
  return encodeB0({
    seq: 0,
    modeA: 'none',
    modeB: 'none',
    strengthA: 0,
    strengthB: 0,
    freqA: s(10, 10, 10, 10),
    intensityA: s(0, 10, 20, 30),
    freqB: VENDOR_SILENT_FREQ,
    intensityB: VENDOR_SILENT_INTENSITY,
    ...overrides,
  })
}

describe('Coyote V3 addressing', () => {
  it('uses the documented name and characteristic UUIDs', () => {
    expect(COYOTE_BLE_NAME).toBe('47L121000')
    expect(COYOTE_SERVICE).toBe('0000180c-0000-1000-8000-00805f9b34fb')
    expect(COYOTE_WRITE_CHARACTERISTIC).toBe('0000150a-0000-1000-8000-00805f9b34fb')
    expect(COYOTE_NOTIFY_CHARACTERISTIC).toBe('0000150b-0000-1000-8000-00805f9b34fb')
  })
})

/**
 * These expected strings are copied from the worked examples in
 * `_reference/dglab/coyote/v3/README.md`. If the encoder disagrees with them,
 * the encoder is wrong.
 */
describe('B0 encoding against the vendor worked examples', () => {
  it('matches example set No.1 — waveform only, no strength change', () => {
    expect(toHex(b0())).toBe('B00000000A0A0A0A000A141E0000000000000065')
    expect(toHex(b0({ freqA: s(15, 15, 15, 15), intensityA: s(40, 50, 60, 70) })))
      .toBe('B00000000F0F0F0F28323C460000000000000065')
    expect(toHex(b0({ freqA: s(30, 30, 30, 30), intensityA: s(80, 90, 100, 100) })))
      .toBe('B00000001E1E1E1E505A64640000000000000065')
    expect(toHex(b0({ freqA: s(40, 60, 80, 100), intensityA: s(100, 90, 90, 90) })))
      .toBe('B0000000283C5064645A5A5A0000000000000065')
  })

  it('matches example set No.2 — relative strength increase with and without a sequence', () => {
    expect(toHex(b0({ modeA: 'increase', strengthA: 5 })))
      .toBe('B00405000A0A0A0A000A141E0000000000000065')
    expect(toHex(b0({
      seq: 1,
      modeA: 'increase',
      strengthA: 10,
      freqA: s(40, 60, 80, 100),
      intensityA: s(100, 90, 90, 90),
    }))).toBe('B0140A00283C5064645A5A5A0000000000000065')
  })

  it('matches example set No.4 — both channels driven', () => {
    const both = (freqA: FrameSlots, intensityA: FrameSlots, intensityB: FrameSlots): string =>
      toHex(b0({ freqA, intensityA, freqB: s(10, 10, 10, 10), intensityB }))

    expect(both(s(10, 10, 10, 10), s(0, 10, 20, 30), s(0, 0, 0, 0)))
      .toBe('B00000000A0A0A0A000A141E0A0A0A0A00000000')
    expect(both(s(15, 15, 15, 15), s(40, 50, 60, 70), s(10, 10, 10, 10)))
      .toBe('B00000000F0F0F0F28323C460A0A0A0A0A0A0A0A')
    expect(both(s(30, 30, 30, 30), s(80, 90, 100, 100), s(0, 0, 0, 10)))
      .toBe('B00000001E1E1E1E505A64640A0A0A0A0000000A')
    expect(both(s(40, 60, 80, 100), s(0, 90, 90, 90), s(0, 0, 0, 10)))
      .toBe('B0000000283C5064005A5A5A0A0A0A0A0000000A')
  })

  it('packs the sequence into the high nibble and the two modes into the low nibble', () => {
    // The doc's strengthZero() helper: seq 1, mode 0b1100 (A absolute, B none).
    expect(b0({ seq: 1, modeA: 'absolute', modeB: 'none' })[1]).toBe(0x1c)
    // Mode table example 6: 0b1101 — A absolute, B relative increase.
    expect(b0({ seq: 0, modeA: 'absolute', modeB: 'increase' })[1]).toBe(0x0d)
    expect(b0({ seq: 0, modeA: 'decrease', modeB: 'none' })[1]).toBe(0x08)
    expect(b0({ seq: 15, modeA: 'absolute', modeB: 'absolute' })[1]).toBe(0xff)
  })

  it('always produces a 20-byte frame', () => {
    expect(b0()).toHaveLength(B0_LENGTH)
  })

  it('refuses a sequence number the 4-bit field cannot hold', () => {
    expect(() => b0({ seq: 16 })).toThrow(RangeError)
    expect(() => b0({ seq: -1 })).toThrow(RangeError)
  })

  it('clamps strength instead of letting the box read an out-of-range value as zero', () => {
    // The protocol says values outside 0-200 are treated as 0, which would
    // silently drop output rather than cap it.
    expect(b0({ strengthA: 250, modeA: 'absolute' })[2]).toBe(MAX_STRENGTH)
    expect(b0({ strengthA: -5, modeA: 'absolute' })[2]).toBe(0)
  })
})

describe('silence sentinel', () => {
  it('carries exactly one deliberately illegal intensity and legal frequency', () => {
    expect(SILENT_FREQ.every(value => value >= 10 && value <= 240)).toBe(true)
    expect(SILENT_INTENSITY.filter(value => value > 100)).toEqual([101])
  })
})

describe('BF bounds command', () => {
  it('lays out caps then frequency balance then intensity balance', () => {
    const encoded = encodeBF({
      softCapA: 80,
      softCapB: 30,
      freqBalanceA: 128,
      freqBalanceB: 129,
      intensityBalanceA: 64,
      intensityBalanceB: 65,
    })
    expect(encoded).toHaveLength(BF_LENGTH)
    // BF | capA=0x50 | capB=0x1E | freqBalA=0x80 | freqBalB=0x81 | intBalA=0x40 | intBalB=0x41
    expect(toHex(encoded)).toBe('BF501E80814041')
  })

  it('clamps a cap that the box would otherwise ignore', () => {
    // Out-of-range caps leave the persisted ceiling untouched, which is the
    // one failure mode we must never produce.
    const encoded = encodeBF({
      softCapA: 500,
      softCapB: -10,
      freqBalanceA: 0,
      freqBalanceB: 0,
      intensityBalanceA: 0,
      intensityBalanceB: 0,
    })
    expect(encoded[1]).toBe(MAX_STRENGTH)
    expect(encoded[2]).toBe(0)
  })
})

describe('notification decoding', () => {
  it('reads a B1 strength report', () => {
    const message = decodeNotification(Uint8Array.from([0xb1, 0x01, 0x19, 0x05]))
    expect(message).toEqual({ seq: 1, strengthA: 25, strengthB: 5 })
  })

  it('reads a wheel-driven report as sequence zero', () => {
    expect(decodeNotification(Uint8Array.from([0xb1, 0x00, 0x0b, 0x00]))?.seq).toBe(0)
  })

  it('ignores other messages rather than treating them as errors', () => {
    // 0xBE is deprecated; anything unknown must be skipped, not fatal.
    expect(decodeNotification(Uint8Array.from([0xbe, 0, 0, 0]))).toBeUndefined()
    expect(decodeNotification(Uint8Array.from([0xb1, 0x00]))).toBeUndefined()
    expect(decodeNotification(new Uint8Array())).toBeUndefined()
  })
})

describe('percent and strength mapping', () => {
  it('spans the full strength range', () => {
    expect(percentToStrength(0)).toBe(0)
    expect(percentToStrength(50)).toBe(100)
    expect(percentToStrength(100)).toBe(MAX_STRENGTH)
  })

  it('round-trips', () => {
    for (const percent of [0, 1, 17, 40, 73, 100]) {
      expect(strengthToPercent(percentToStrength(percent))).toBe(percent)
    }
  })

  it('fails closed on nonsense input', () => {
    expect(percentToStrength(Number.NaN)).toBe(0)
    expect(percentToStrength(-10)).toBe(0)
    // A finite over-range value caps...
    expect(percentToStrength(1_000)).toBe(MAX_STRENGTH)
    // ...but a non-finite one falls to zero, matching clampPercentToPolicy:
    // NaN or Infinity means an upstream calculation broke, and jumping to
    // maximum output is the worst possible response to a bug.
    expect(clampStrength(Number.POSITIVE_INFINITY)).toBe(0)
    expect(clampStrength(Number.NaN)).toBe(0)
  })
})
