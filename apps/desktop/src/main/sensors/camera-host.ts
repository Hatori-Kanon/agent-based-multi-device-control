/**
 * Camera capture host: the main-process half of the hidden camera worker.
 *
 * Web Media APIs (`getUserMedia`, `<video>`, canvas) exist only in a renderer,
 * so a hidden worker window owns the stream and this host drives it — exactly
 * the pattern the BLE bridge next door established. Everything that can hold a
 * bug (cadence, sample assembly, quality classification, JPEG freshness) is
 * plain TypeScript here behind {@link CameraBridge} and is unit-tested with a
 * fake; the Electron half (`camera-window.ts`) is glue only.
 *
 * Two rules are load-bearing:
 *
 * - **One camera is one `SensorSource`.** The source id is fixed at
 *   construction (`usb-cam-1` by default), because `SensorRegistry` keys
 *   samples by source id.
 * - **The capture end owns `unavailable`.** The registry derives `stale` from
 *   its injected clock and deliberately never reads `SensorSource.freshnessMs()`
 *   (plan §8.7 ruling 5), so a capture stream that ends on its own (USB
 *   unplugged, privacy switch, track ended) emits exactly one
 *   `quality: 'unavailable'` sample. A deliberate {@link CameraHost.stop} is a
 *   normal shutdown and emits nothing.
 */

import type {
  Clock,
  FeatureSample,
  FrameFeatures,
  SensorQuality,
  SensorSource,
  Snapshot,
  Timer,
} from '@embodied/core'

/** A video input the worker page can open. */
export interface CameraDeviceInfo {
  readonly deviceId: string
  /** Empty until the platform reveals labels (after the first permission grant). */
  readonly label: string
}

/** One analysed 32x24 frame, as it crosses the bridge from the worker page. */
export interface CameraFeaturesMessage {
  readonly type: 'features'
  readonly sample: {
    /** Worker-page monotonic timestamp of the captured frame. */
    readonly capturedAtMs: number
    /** Age of the presented frame at capture time, in milliseconds. */
    readonly frameAgeMs: number
    readonly features: FrameFeatures
  }
}

/**
 * One JPEG, base64 encoded so it survives the JSON bridge.
 *
 * `bytes: ''` means "the page has no frame right now" — distinct from a failed
 * bridge call, which rejects.
 */
export interface CameraJpegMessage {
  readonly type: 'jpeg'
  readonly bytes: string
}

/**
 * What the hidden camera page offers. `camera-window.ts` implements this with
 * `executeJavaScript` + the preload bridge; tests implement it with a fake.
 */
export interface CameraBridge {
  listDevices(): Promise<readonly CameraDeviceInfo[]>
  /** Open a MediaStream; the page owns the `<video>` and the capture canvas. */
  start(deviceId: string): Promise<void>
  /** Capture and analyse one frame; `null` when the stream has no frame yet. */
  sample(): Promise<CameraFeaturesMessage | null>
  /** Capture the current frame as JPEG; empty `bytes` when there is none. */
  snapshot(): Promise<CameraJpegMessage>
  stop(): Promise<void>
  /** Unexpected end of capture (unplugged, privacy switch, track ended). */
  onEnded(listener: (reason: string) => void): () => void
}

/** One on-demand JPEG with the host-clock time it was captured. */
export interface CameraJpeg {
  readonly bytes: Uint8Array
  readonly ts: number
}

/** Public surface handed to the host wiring (plan §3.1 A1-T5). */
export interface CameraHost {
  /** Sensor source id this camera reports under (`usb-cam-1`). */
  readonly sourceId: string
  /** Human- and model-readable source name. */
  readonly label: string
  listDevices(): Promise<readonly CameraDeviceInfo[]>
  start(deviceId: string, options?: { readonly fps?: number }): Promise<void>
  stop(): Promise<void>
  /**
   * Newest JPEG, captured on demand.
   *
   * A cached frame younger than `maxAgeMs` is returned as-is; an older one is
   * never handed out as if it were current — one fresh capture is attempted
   * instead, and `undefined` is returned when the page cannot produce a frame.
   */
  latestJpeg(maxAgeMs?: number): Promise<CameraJpeg | undefined>
  /** Observe feature samples; the wiring pushes them into the registry. */
  onFeatures(listener: (sample: FeatureSample) => void): () => void
}

/** Push cadence default: the plan's 1-2 Hz feature rate, at its fast end. */
export const DEFAULT_CAMERA_FPS = 2
/** Oldest JPEG a caller accepts by default (matches `look`'s default). */
export const DEFAULT_JPEG_MAX_AGE_MS = 3_000

/** Frame rates are clamped to the plan's 1-2 Hz window. */
const MIN_FPS = 1
const MAX_FPS = 2

/** Burnt-out frame: most pixels at the top of the luma range. */
const BRIGHT_OVEREXPOSED_RATIO = 0.5
/** A frame whose mean luma is below this is simply too dark to read. */
const DIM_LUMA_MEAN = 25
/** Or: most pixels are pinned at the bottom of the range. */
const DIM_UNDEREXPOSED_RATIO = 0.6
/** A perfectly uniform frame is an occluded lens, not a dark room. */
const BLOCKED_LUMA_STD = 2

function clampFps(requested: number | undefined): number {
  if (requested === undefined || !Number.isFinite(requested)) return DEFAULT_CAMERA_FPS
  return Math.min(MAX_FPS, Math.max(MIN_FPS, requested))
}

/**
 * Turn raw optics into the status-facing quality.
 *
 * Ordered so a burnt-out frame reads `bright` even though it is also
 * over-exposed everywhere, and a covered lens reads `dim` unless the frame is
 * perfectly uniform (auto-gain on a lens cap), which is `blocked`.
 */
export function qualityFromFeatures(features: FrameFeatures): SensorQuality {
  if (features.overexposedRatio >= BRIGHT_OVEREXPOSED_RATIO) return 'bright'
  if (features.lumaMean < DIM_LUMA_MEAN) return 'dim'
  if (features.underexposedRatio >= DIM_UNDEREXPOSED_RATIO) return 'dim'
  if (features.lumaStd < BLOCKED_LUMA_STD) return 'blocked'
  return 'ok'
}

export interface BridgedCameraHostOptions {
  readonly clock: Clock
  readonly bridge: CameraBridge
  readonly sourceId?: string
  readonly label?: string
  /** Convenience listener registered before capture starts. */
  readonly onFeatures?: (sample: FeatureSample) => void
  /** Receives bridge/sample failures; cadence keeps running. */
  readonly onError?: (error: unknown) => void
}

/** Default source id for the desktop's single USB camera. */
export const DEFAULT_CAMERA_SOURCE_ID = 'usb-cam-1'
/** Default source label (Chinese, like the console's other device labels). */
export const DEFAULT_CAMERA_LABEL = 'USB 摄像头'

export class BridgedCameraHost implements CameraHost {
  readonly sourceId: string
  readonly label: string
  private readonly clock: Clock
  private readonly bridge: CameraBridge
  private readonly onError: ((error: unknown) => void) | undefined
  private readonly featureListeners = new Set<(sample: FeatureSample) => void>()
  private readonly detachEnded: () => void
  private timer: Timer | undefined
  private running = false
  private lastJpeg: CameraJpeg | undefined
  private pendingJpeg: Promise<CameraJpeg | undefined> | undefined

  constructor(options: BridgedCameraHostOptions) {
    this.clock = options.clock
    this.bridge = options.bridge
    this.sourceId = options.sourceId ?? DEFAULT_CAMERA_SOURCE_ID
    this.label = options.label ?? DEFAULT_CAMERA_LABEL
    this.onError = options.onError
    if (options.onFeatures !== undefined) this.featureListeners.add(options.onFeatures)
    this.detachEnded = this.bridge.onEnded(reason => { this.handleCaptureEnded(reason) })
  }

  listDevices(): Promise<readonly CameraDeviceInfo[]> {
    return this.bridge.listDevices()
  }

  /**
   * Open the stream and start the feature cadence.
   *
   * `bridge.start` rejects on a `getUserMedia` refusal; the rejection is
   * propagated unchanged (its message names the platform error) and nothing
   * is left ticking.
   */
  async start(deviceId: string, options: { readonly fps?: number } = {}): Promise<void> {
    if (this.running) await this.stop()
    const fps = clampFps(options.fps)
    // A camera change invalidates frames captured from the previous device.
    this.lastJpeg = undefined
    await this.bridge.start(deviceId)
    this.running = true
    const tickMs = Math.max(1, Math.round(1_000 / fps))
    this.timer = this.clock.interval(tickMs, () => { void this.sampleOnce() })
  }

  /** Stop capture. A deliberate stop is not an "end of stream" signal. */
  async stop(): Promise<void> {
    const wasRunning = this.running
    this.running = false
    this.timer?.cancel()
    this.timer = undefined
    if (!wasRunning) return
    try {
      await this.bridge.stop()
    } catch (error) {
      // Report the failure *and* propagate it: callers (the settings page and
      // the shutdown path) must not record a clean stop while the renderer may
      // still be capturing.
      this.report(error)
      throw error
    }
  }

  /** Unsubscribe every listener and stop the timer; the worker window is gone. */
  dispose(): void {
    this.running = false
    this.timer?.cancel()
    this.timer = undefined
    this.detachEnded()
    this.featureListeners.clear()
    this.lastJpeg = undefined
  }

  async latestJpeg(maxAgeMs = DEFAULT_JPEG_MAX_AGE_MS): Promise<CameraJpeg | undefined> {
    const cached = this.lastJpeg
    if (cached !== undefined && this.clock.now() - cached.ts <= maxAgeMs) return cached
    return this.captureJpeg()
  }

  onFeatures(listener: (sample: FeatureSample) => void): () => void {
    this.featureListeners.add(listener)
    return () => {
      this.featureListeners.delete(listener)
    }
  }

  /** One cadence tick: sample the page, wrap the frame, fan it out. */
  private async sampleOnce(): Promise<void> {
    if (!this.running) return
    try {
      const message = await this.bridge.sample()
      // A stop or a stream end may have landed while the bridge call was in
      // flight; a late sample must not be emitted after either.
      if (!this.running || message === null || message.type !== 'features') return
      this.emitSample({
        sourceId: this.sourceId,
        ts: this.clock.now(),
        frameAgeMs: message.sample.frameAgeMs,
        quality: qualityFromFeatures(message.sample.features),
        ...message.sample.features,
      })
    } catch (error) {
      this.report(error)
    }
  }

  /**
   * The bridge reported that capture ended on its own.
   *
   * Emits exactly one `unavailable` sample and stops the cadence. Not reported
   * as an error: the console shows a degraded source, it does not pop a fault
   * (an unplugged camera is an expected state, not a malfunction).
   */
  private handleCaptureEnded(_reason: string): void {
    if (!this.running) return
    this.running = false
    this.timer?.cancel()
    this.timer = undefined
    this.lastJpeg = undefined
    this.emitSample({
      sourceId: this.sourceId,
      ts: this.clock.now(),
      frameAgeMs: 0,
      quality: 'unavailable',
    })
  }

  private emitSample(sample: FeatureSample): void {
    for (const listener of [...this.featureListeners]) {
      try {
        listener(sample)
      } catch (error) {
        this.report(error)
      }
    }
  }

  private async captureJpeg(): Promise<CameraJpeg | undefined> {
    const pending = this.pendingJpeg
    if (pending !== undefined) return pending
    const request = (async (): Promise<CameraJpeg | undefined> => {
      try {
        const message = await this.bridge.snapshot()
        if (message.type !== 'jpeg' || message.bytes.length === 0) return undefined
        const bytes = Uint8Array.from(Buffer.from(message.bytes, 'base64'))
        if (bytes.length === 0) return undefined
        const jpeg: CameraJpeg = { bytes, ts: this.clock.now() }
        this.lastJpeg = jpeg
        return jpeg
      } catch (error) {
        this.report(error)
        return undefined
      } finally {
        this.pendingJpeg = undefined
      }
    })()
    this.pendingJpeg = request
    return request
  }

  private report(error: unknown): void {
    this.onError?.(error)
  }
}

/**
 * Expose one camera as a registry source.
 *
 * `latest()` goes through {@link CameraHost.latestJpeg}, so the snapshot carries
 * the capture time and a stale frame is refused rather than presented as
 * current. `freshnessMs()` is intentionally undefined: the registry does not
 * read it (plan §8.7 ruling 5) and the feature ring already answers freshness.
 */
export function cameraSensorSource(host: CameraHost, options: { readonly maxAgeMs?: number } = {}): SensorSource {
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_JPEG_MAX_AGE_MS
  return {
    id: host.sourceId,
    kind: 'image',
    label: host.label,
    latest: async (): Promise<Snapshot | undefined> => {
      const jpeg = await host.latestJpeg(maxAgeMs)
      if (jpeg === undefined) return undefined
      return { sourceId: host.sourceId, ts: jpeg.ts, mime: 'image/jpeg', bytes: jpeg.bytes }
    },
    freshnessMs: () => undefined,
  }
}
