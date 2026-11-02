/**
 * Microphone capture host: the main-process half of the hidden camera worker's
 * audio path.
 *
 * Exactly the camera-host pattern one door down: `getUserMedia`/`AudioContext`
 * only exist in a renderer, so the hidden worker page owns the stream and this
 * host drives it. Everything that can hold a bug (cadence, level clamping,
 * quality classification, end-of-capture handling) is plain TypeScript here
 * behind {@link AudioBridge} and is unit-tested with a fake; the Electron half
 * (`camera-window.ts` + `renderer/camera.js`) is glue only.
 *
 * Two rules are copied from the camera host because they are about honesty,
 * not about optics:
 *
 * - **One microphone is one `SensorSource`** with a fixed id (`mic-1`);
 *   `SensorRegistry` keys samples by source id.
 * - **The capture end owns `unavailable`.** An unexpected end of capture
 *   (device removed, permission revoked, track ended) emits exactly one
 *   `quality: 'unavailable'` sample. A deliberate {@link AudioHost.stop} is a
 *   normal shutdown and emits nothing.
 *
 * Units: `audioLevelPct` is 0-100, a normalised RMS level. The renderer applies
 * a fixed gain so ordinary speech lands around 10-40% and clipping caps at 100;
 * this host only clamps and rounds, it never invents a level for a sample that
 * has none (`null` from the bridge reads as `unavailable`).
 */

import type {
  Clock,
  FeatureSample,
  SensorQuality,
  SensorSource,
  Timer,
} from '@embodied/core'

/** An audio input the worker page can open. */
export interface AudioDeviceInfo {
  readonly deviceId: string
  /** Empty until the platform reveals labels (after the first permission grant). */
  readonly label: string
}

/**
 * What the hidden worker page offers for audio.
 *
 * `sample()` resolves to the current level 0-100, or `null` when the page has
 * no analyser data yet (stream opening, context suspended, track ended).
 * `camera-window.ts` implements this over the same `WebContents` as the camera
 * bridge; tests implement it with a fake.
 */
export interface AudioBridge {
  listDevices(): Promise<readonly AudioDeviceInfo[]>
  /** Open the microphone stream and start the analyser. */
  start(deviceId: string): Promise<void>
  /** Current normalised level 0-100, or `null` when there is no audio yet. */
  sample(): Promise<number | null>
  stop(): Promise<void>
  /** Unexpected end of capture (unplugged, permission revoked, track ended). */
  onEnded(listener: (reason: string) => void): () => void
}

/** Public surface handed to the host wiring. */
export interface AudioHost {
  /** Sensor source id this microphone reports under (`mic-1`). */
  readonly sourceId: string
  /** Human- and model-readable source name. */
  readonly label: string
  listDevices(): Promise<readonly AudioDeviceInfo[]>
  start(deviceId: string): Promise<void>
  stop(): Promise<void>
  /** Observe feature samples; the wiring pushes them into the registry. */
  onFeatures(listener: (sample: FeatureSample) => void): () => void
}

/** Default source id (the settings page shows 麦克风). */
export const DEFAULT_AUDIO_SOURCE_ID = 'mic-1'
/** Default source label (Chinese, like the console's other labels). */
export const DEFAULT_AUDIO_LABEL = '麦克风'
/** The plan's 1-2 Hz feature rate: the microphone samples at 2 Hz. */
export const DEFAULT_AUDIO_FPS = 2

/** Frame rates follow the camera host's 1-2 Hz window. */
const MIN_FPS = 1
const MAX_FPS = 2

function clampFps(requested: number | undefined): number {
  if (requested === undefined || !Number.isFinite(requested)) return DEFAULT_AUDIO_FPS
  return Math.min(MAX_FPS, Math.max(MIN_FPS, requested))
}

/**
 * Clamp one level into the documented 0-100 range.
 *
 * Non-finite input is treated as "no measurement" (`undefined`), never as 0 —
 * a zero would read as "silence" and fabricate a measurement.
 */
export function clampAudioLevel(level: number): number | undefined {
  if (!Number.isFinite(level)) return undefined
  return Math.min(100, Math.max(0, Math.round(level)))
}

export interface BridgedAudioHostOptions {
  readonly clock: Clock
  readonly bridge: AudioBridge
  readonly sourceId?: string
  readonly label?: string
  /** Convenience listener registered before capture starts. */
  readonly onFeatures?: (sample: FeatureSample) => void
  /** Receives bridge failures; cadence keeps running. */
  readonly onError?: (error: unknown) => void
  /** Push rate; clamped to the plan's 1-2 Hz window. */
  readonly fps?: number
}

export class BridgedAudioHost implements AudioHost {
  readonly sourceId: string
  readonly label: string
  private readonly clock: Clock
  private readonly bridge: AudioBridge
  private readonly fps: number
  private readonly onError: ((error: unknown) => void) | undefined
  private readonly featureListeners = new Set<(sample: FeatureSample) => void>()
  private readonly detachEnded: () => void
  private timer: Timer | undefined
  private running = false

  constructor(options: BridgedAudioHostOptions) {
    this.clock = options.clock
    this.bridge = options.bridge
    this.sourceId = options.sourceId ?? DEFAULT_AUDIO_SOURCE_ID
    this.label = options.label ?? DEFAULT_AUDIO_LABEL
    this.fps = clampFps(options.fps)
    this.onError = options.onError
    if (options.onFeatures !== undefined) this.featureListeners.add(options.onFeatures)
    this.detachEnded = this.bridge.onEnded(reason => { this.handleCaptureEnded(reason) })
  }

  listDevices(): Promise<readonly AudioDeviceInfo[]> {
    return this.bridge.listDevices()
  }

  /**
   * Open the microphone and start the level cadence.
   *
   * `bridge.start` rejects on a `getUserMedia` refusal; the rejection is
   * propagated unchanged and nothing is left ticking.
   */
  async start(deviceId: string): Promise<void> {
    if (this.running) await this.stop()
    await this.bridge.start(deviceId)
    this.running = true
    const tickMs = Math.max(1, Math.round(1_000 / this.fps))
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
  }

  onFeatures(listener: (sample: FeatureSample) => void): () => void {
    this.featureListeners.add(listener)
    return () => {
      this.featureListeners.delete(listener)
    }
  }

  /** One cadence tick: read the analyser level, wrap it, fan it out. */
  private async sampleOnce(): Promise<void> {
    if (!this.running) return
    try {
      const level = await this.bridge.sample()
      // A stop or a stream end may have landed while the bridge call was in
      // flight; a late sample must not be emitted after either.
      if (!this.running) return
      const audioLevelPct = level === null ? undefined : clampAudioLevel(level)
      this.emitSample({
        sourceId: this.sourceId,
        ts: this.clock.now(),
        frameAgeMs: 0,
        quality: audioLevelPct === undefined ? 'unavailable' : 'ok',
        ...(audioLevelPct === undefined ? {} : { audioLevelPct }),
      })
    } catch (error) {
      this.report(error)
    }
  }

  /**
   * The bridge reported that capture ended on its own.
   *
   * Emits exactly one `unavailable` sample and stops the cadence. Not reported
   * as an error: a device removed while the mic was on is an expected state,
   * not a malfunction.
   */
  private handleCaptureEnded(_reason: string): void {
    if (!this.running) return
    this.running = false
    this.timer?.cancel()
    this.timer = undefined
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

  private report(error: unknown): void {
    this.onError?.(error)
  }
}

/**
 * Expose one microphone as a registry source.
 *
 * There is no on-demand "snapshot" for audio: the level only exists while the
 * capture host samples it, so `latest()` is always `undefined` and the registry
 * derives quality/freshness from the feature ring. `freshnessMs()` stays
 * undefined for the same reason as the camera: the registry must not read it
 * (plan §8.7 ruling 5).
 */
export function audioSensorSource(host: AudioHost): SensorSource {
  return {
    id: host.sourceId,
    kind: 'audio',
    label: host.label,
    latest: async (): Promise<undefined> => undefined,
    freshnessMs: () => undefined,
  }
}

/** Re-exported so callers can spell the quality union without a second import. */
export type AudioQuality = Extract<SensorQuality, 'ok' | 'unavailable'>
