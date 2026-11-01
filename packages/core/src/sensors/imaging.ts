/**
 * Grey-frame feature extraction.
 *
 * Everything here is a pure function over a `Uint8Array`: the hidden camera
 * window (renderer) ships a canvas frame, and both the host and the tests run
 * exactly this code. No Electron, DOM, or Node API is imported.
 *
 * Two feature layers are produced:
 * - L0 optics — `lumaMean` / `lumaStd` / over- and underexposed ratios: "can
 *   we see anything at all?"
 * - L1 motion — `motionEnergy` (EMA of the frame difference), `motionPeak`
 *   (raw difference peak over the last second), `staticRatio` and
 *   `centerMotionRatio`: "how much is moving, and where?"
 */

/** A grey frame; usually the 32x24 output of {@link downsampleGray}. */
export interface GrayFrame {
  readonly width: number
  readonly height: number
  /** Row-major, one byte per pixel. */
  readonly data: Uint8Array
}

/**
 * Motion bookkeeping carried between frames.
 *
 * A plain JSON object so a capture host can keep it across calls. `peak` is
 * the raw frame-difference maximum of the current peak window; `peakAt` /
 * `lastAt` place it on the caller's clock, while `frames` / `peakFrame` are
 * the clock-free fallback (see {@link analyzeFrame}).
 */
export interface MotionState {
  /** EMA of the normalised frame difference, 0-1. */
  readonly ema: number
  /** Highest raw frame difference inside the current peak window, 0-1. */
  readonly peak: number
  /** Timestamp (ms) of that peak; 0 when no timestamp was supplied. */
  readonly peakAt: number
  /** Timestamp (ms) of the previous analysed frame; 0 when none was supplied. */
  readonly lastAt: number
  /** Number of frames analysed so far. */
  readonly frames: number
  /** Frame index that set the current peak. */
  readonly peakFrame: number
  /** True once a frame carried a timestamp; picks the window mode. */
  readonly clocked: boolean
}

/** What one analysed frame reports. */
export interface FrameFeatures {
  readonly lumaMean: number
  readonly lumaStd: number
  readonly overexposedRatio: number
  readonly underexposedRatio: number
  readonly motionEnergy: number
  readonly motionPeak: number
  readonly staticRatio: number
  readonly centerMotionRatio: number
}

/** Features plus the state to feed into the next call. */
export interface AnalyzeResult {
  readonly features: FrameFeatures
  readonly state: MotionState
}

/** Default downsample target: small enough for one 1-2 Hz JSON sample. */
const DEFAULT_TARGET_WIDTH = 32
const DEFAULT_TARGET_HEIGHT = 24
/** Pixels brighter than this count as overexposed. */
const OVEREXPOSED_LUMA = 235
/** Pixels darker than this count as underexposed. */
const UNDEREXPOSED_LUMA = 25
/** Per-pixel difference (on the 0-255 scale) that counts as "changed". */
const CHANGED_PIXEL_DELTA = 8
/** Weight of the newest difference in the motion EMA (~3-frame memory). */
const MOTION_EMA_ALPHA = 0.35
/** Peak retention when timestamps are supplied: the last second. */
const MOTION_PEAK_WINDOW_MS = 1_000
/** Peak retention without timestamps: the last two frames (~1 s at 1-2 Hz). */
const MOTION_PEAK_FALLBACK_FRAMES = 2
/** The "centre" of the frame is the middle third on each axis. */
const CENTRE_DIVISOR = 3

/** Reject a frame whose buffer does not match its dimensions. */
function assertFrame(frame: GrayFrame): void {
  if (!Number.isInteger(frame.width) || !Number.isInteger(frame.height) || frame.width <= 0 || frame.height <= 0) {
    throw new RangeError(`grey frame must have positive integer dimensions, got ${frame.width}x${frame.height}`)
  }
  if (frame.data.length !== frame.width * frame.height) {
    throw new RangeError(
      `grey frame data is ${frame.data.length} bytes but ${frame.width}x${frame.height} needs ${frame.width * frame.height}`,
    )
  }
}

/** Downsample with area averaging; the target pixel is the mean of its source block. */
export function downsampleGray(
  frame: GrayFrame,
  targetWidth = DEFAULT_TARGET_WIDTH,
  targetHeight = DEFAULT_TARGET_HEIGHT,
): GrayFrame {
  assertFrame(frame)
  if (!Number.isInteger(targetWidth) || !Number.isInteger(targetHeight) || targetWidth <= 0 || targetHeight <= 0) {
    throw new RangeError(`downsample target must be positive integers, got ${targetWidth}x${targetHeight}`)
  }
  if (frame.width === targetWidth && frame.height === targetHeight) {
    return { width: targetWidth, height: targetHeight, data: frame.data.slice() }
  }

  const data = new Uint8Array(targetWidth * targetHeight)
  for (let y = 0; y < targetHeight; y += 1) {
    const sourceYStart = Math.floor((y * frame.height) / targetHeight)
    const sourceYEnd = Math.min(frame.height, Math.max(sourceYStart + 1, Math.floor(((y + 1) * frame.height) / targetHeight)))
    for (let x = 0; x < targetWidth; x += 1) {
      const sourceXStart = Math.floor((x * frame.width) / targetWidth)
      const sourceXEnd = Math.min(frame.width, Math.max(sourceXStart + 1, Math.floor(((x + 1) * frame.width) / targetWidth)))
      let sum = 0
      let count = 0
      for (let sourceY = sourceYStart; sourceY < sourceYEnd; sourceY += 1) {
        const rowOffset = sourceY * frame.width
        for (let sourceX = sourceXStart; sourceX < sourceXEnd; sourceX += 1) {
          sum += frame.data[rowOffset + sourceX] ?? 0
          count += 1
        }
      }
      data[y * targetWidth + x] = count === 0 ? 0 : Math.round(sum / count)
    }
  }
  return { width: targetWidth, height: targetHeight, data }
}

interface Optics {
  readonly lumaMean: number
  readonly lumaStd: number
  readonly overexposedRatio: number
  readonly underexposedRatio: number
}

/** L0: is the picture usable at all? */
function opticsOf(frame: GrayFrame): Optics {
  const total = frame.data.length
  if (total === 0) return { lumaMean: 0, lumaStd: 0, overexposedRatio: 0, underexposedRatio: 0 }

  let sum = 0
  let overexposed = 0
  let underexposed = 0
  for (const value of frame.data) {
    sum += value
    if (value > OVEREXPOSED_LUMA) overexposed += 1
    else if (value < UNDEREXPOSED_LUMA) underexposed += 1
  }
  const lumaMean = sum / total
  let variance = 0
  for (const value of frame.data) {
    const delta = value - lumaMean
    variance += delta * delta
  }
  return {
    lumaMean,
    lumaStd: Math.sqrt(variance / total),
    overexposedRatio: overexposed / total,
    underexposedRatio: underexposed / total,
  }
}

interface FrameDifference {
  /** Mean absolute difference, normalised to 0-1. */
  readonly motionRaw: number
  /** 1 - changed-pixel ratio. */
  readonly staticRatio: number
  /** Changed-pixel ratio inside the centre third. */
  readonly centerMotionRatio: number
}

/** L1: how much moved between the two frames. */
function differenceOf(next: GrayFrame, previous: GrayFrame | undefined): FrameDifference {
  if (previous === undefined || previous.width !== next.width || previous.height !== next.height) {
    return { motionRaw: 0, staticRatio: 1, centerMotionRatio: 0 }
  }
  const total = next.width * next.height
  if (total === 0) return { motionRaw: 0, staticRatio: 1, centerMotionRatio: 0 }

  const centreXStart = Math.floor(next.width / CENTRE_DIVISOR)
  const centreXEnd = Math.floor((next.width * 2) / CENTRE_DIVISOR)
  const centreYStart = Math.floor(next.height / CENTRE_DIVISOR)
  const centreYEnd = Math.floor((next.height * 2) / CENTRE_DIVISOR)

  let deltaSum = 0
  let changed = 0
  let centreChanged = 0
  let centreTotal = 0
  for (let y = 0; y < next.height; y += 1) {
    const rowOffset = y * next.width
    const inCentreRow = y >= centreYStart && y < centreYEnd
    for (let x = 0; x < next.width; x += 1) {
      const index = rowOffset + x
      const delta = Math.abs((next.data[index] ?? 0) - (previous.data[index] ?? 0))
      deltaSum += delta
      const inCentre = inCentreRow && x >= centreXStart && x < centreXEnd
      if (inCentre) centreTotal += 1
      if (delta >= CHANGED_PIXEL_DELTA) {
        changed += 1
        if (inCentre) centreChanged += 1
      }
    }
  }
  return {
    motionRaw: deltaSum / total / 255,
    staticRatio: 1 - changed / total,
    centerMotionRatio: centreTotal === 0 ? 0 : centreChanged / centreTotal,
  }
}

/**
 * Compute L0/L1 features and advance the motion state.
 *
 * `nowMs` is the caller's `Clock.now()`. When it is supplied, `motionPeak`
 * keeps the maximum raw frame difference of the last 1000 ms; frames that move
 * less do **not** overwrite it. This is the real contract for a 1-2 Hz capture
 * loop.
 *
 * When `nowMs` is omitted the function has no notion of seconds, so
 * `motionPeak` falls back to a **two-frame** window, which is a deliberate
 * approximation of ~1 s at the 1-2 Hz cadence. A capture host should always
 * pass a timestamp; the fallback exists so that a pure renderer loop that only
 * has frames still produces a usable peak instead of an error.
 */
export function analyzeFrame(
  next: GrayFrame,
  previous?: GrayFrame,
  state?: MotionState,
  nowMs?: number,
): AnalyzeResult {
  assertFrame(next)
  const optics = opticsOf(next)
  const difference = differenceOf(next, previous)
  const instant = difference.motionRaw
  const frames = (state?.frames ?? 0) + 1
  const ema = MOTION_EMA_ALPHA * instant + (1 - MOTION_EMA_ALPHA) * (state?.ema ?? 0)

  let peak: number
  let peakAt: number
  let peakFrame: number
  let lastAt: number
  let clocked: boolean

  if (nowMs !== undefined && Number.isFinite(nowMs)) {
    clocked = true
    const keepInWindow = state !== undefined && state.clocked && nowMs - state.peakAt <= MOTION_PEAK_WINDOW_MS
    if (keepInWindow && state !== undefined && state.peak >= instant) {
      peak = state.peak
      peakAt = state.peakAt
      peakFrame = state.peakFrame
    } else {
      peak = instant
      peakAt = nowMs
      peakFrame = frames
    }
    lastAt = nowMs
  } else {
    clocked = state?.clocked ?? false
    const keepInWindow = state !== undefined && frames - state.peakFrame < MOTION_PEAK_FALLBACK_FRAMES
    if (keepInWindow && state !== undefined && state.peak >= instant) {
      peak = state.peak
      peakAt = state.peakAt
      peakFrame = state.peakFrame
    } else {
      peak = instant
      peakAt = 0
      peakFrame = frames
    }
    lastAt = state?.lastAt ?? 0
  }

  return {
    features: {
      lumaMean: optics.lumaMean,
      lumaStd: optics.lumaStd,
      overexposedRatio: optics.overexposedRatio,
      underexposedRatio: optics.underexposedRatio,
      motionEnergy: ema,
      motionPeak: peak,
      staticRatio: difference.staticRatio,
      centerMotionRatio: difference.centerMotionRatio,
    },
    state: { ema, peak, peakAt, lastAt, frames, peakFrame, clocked },
  }
}
