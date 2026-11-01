import { describe, expect, it } from 'vitest'
import { analyzeFrame, downsampleGray, type GrayFrame } from '../src/sensors/imaging.ts'

/** 256-step synthetic luma gradient with hand-checkable statistics. */
function gradientRow(): GrayFrame {
  const data = new Uint8Array(256)
  for (let i = 0; i < 256; i += 1) data[i] = i
  return { width: 256, height: 1, data }
}

/** 32x24 vertical ramp; shifting it by a few rows yields a known frame difference. */
function gradientFrame(width = 32, height = 24): GrayFrame {
  const data = new Uint8Array(width * height)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) data[y * width + x] = (y * 10) % 256
  }
  return { width, height, data }
}

/** Vertical roll: every row takes the value of `row + offset`. */
function shiftRows(frame: GrayFrame, offset: number): GrayFrame {
  const data = new Uint8Array(frame.data.length)
  for (let y = 0; y < frame.height; y += 1) {
    const sourceY = (y + offset) % frame.height
    data.set(frame.data.subarray(sourceY * frame.width, (sourceY + 1) * frame.width), y * frame.width)
  }
  return { width: frame.width, height: frame.height, data }
}

describe('grey frame features', () => {
  it('computes luma mean/std/over/under ratios on a synthetic gradient', () => {
    const { features } = analyzeFrame(gradientRow())

    expect(features.lumaMean).toBeCloseTo(127.5, 10)
    // Population standard deviation of the integers 0..255.
    expect(features.lumaStd).toBeCloseTo(Math.sqrt(65_535 / 12), 6)
    // 236..255 are overexposed, 0..24 are underexposed.
    expect(features.overexposedRatio).toBeCloseTo(20 / 256, 10)
    expect(features.underexposedRatio).toBeCloseTo(25 / 256, 10)
  })

  it('reports a fully black frame as dim with staticRatio 1', () => {
    const black: GrayFrame = { width: 32, height: 24, data: new Uint8Array(32 * 24) }
    const { features } = analyzeFrame(black, black)

    // "Dim" is the L0 verdict: nothing in the picture is lit.
    expect(features.lumaMean).toBe(0)
    expect(features.lumaStd).toBe(0)
    expect(features.underexposedRatio).toBe(1)
    expect(features.overexposedRatio).toBe(0)
    // Two identical frames: no pixel changed, nothing moved.
    expect(features.staticRatio).toBe(1)
    expect(features.motionEnergy).toBe(0)
    expect(features.motionPeak).toBe(0)
    expect(features.centerMotionRatio).toBe(0)
  })

  it('raises motionEnergy on a shifted frame and not on an identical one', () => {
    const base = gradientFrame()

    const quiet = analyzeFrame(base, base)
    expect(quiet.features.motionEnergy).toBe(0)

    const moved = analyzeFrame(shiftRows(base, 12), base, quiet.state)
    expect(moved.features.motionEnergy).toBeGreaterThan(0.1)
    expect(moved.features.staticRatio).toBeLessThan(0.1)

    // An identical frame adds no new difference: the EMA decays, it does not rise.
    const still = analyzeFrame(base, base, moved.state)
    expect(still.features.motionEnergy).toBeLessThan(moved.features.motionEnergy)
  })

  it('keeps a 1s motionPeak instead of the last frame', () => {
    const base = gradientFrame()
    const moved = shiftRows(base, 6)

    let result = analyzeFrame(base, base, undefined, 0)
    result = analyzeFrame(moved, base, result.state, 0)
    const spikePeak = result.features.motionPeak
    const spikeEnergy = result.features.motionEnergy
    expect(spikePeak).toBeGreaterThan(0.2)

    // 500 ms later the frame is still: energy falls, the peak survives.
    result = analyzeFrame(moved, moved, result.state, 500)
    expect(result.features.motionEnergy).toBeLessThan(spikeEnergy)
    expect(result.features.motionPeak).toBe(spikePeak)

    // Past the 1 s window the old peak is gone: it reports the still frame.
    result = analyzeFrame(moved, moved, result.state, 1_500)
    expect(result.features.motionPeak).toBe(0)
  })

  it('falls back to a two-frame peak window when no timestamp is supplied', () => {
    const base = gradientFrame()
    const moved = shiftRows(base, 6)

    let result = analyzeFrame(base, base)
    result = analyzeFrame(moved, base, result.state)
    const spikePeak = result.features.motionPeak
    expect(spikePeak).toBeGreaterThan(0.2)

    // One following frame stays inside the fallback window...
    result = analyzeFrame(moved, moved, result.state)
    expect(result.features.motionPeak).toBe(spikePeak)
    // ... the next one does not.
    result = analyzeFrame(moved, moved, result.state)
    expect(result.features.motionPeak).toBe(0)
  })

  it('averages source pixels when downsampling to the 32x24 target', () => {
    const source: GrayFrame = {
      width: 4,
      height: 4,
      data: new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]),
    }
    const small = downsampleGray(source, 2, 2)
    // Area average per 2x2 block, rounded: (0+1+4+5)/4, (2+3+6+7)/4, ...
    expect([...small.data]).toEqual([3, 5, 11, 13])

    const big: GrayFrame = { width: 64, height: 48, data: new Uint8Array(64 * 48).fill(200) }
    const flat = downsampleGray(big)
    expect(flat.width).toBe(32)
    expect(flat.height).toBe(24)
    expect(flat.data.every(value => value === 200)).toBe(true)
  })
})
