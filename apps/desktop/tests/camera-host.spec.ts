import { FakeClock, type FeatureSample, type FrameFeatures } from '@embodied/core'
import { describe, expect, it } from 'vitest'
import {
  BridgedCameraHost,
  cameraSensorSource,
  qualityFromFeatures,
  type CameraBridge,
  type CameraDeviceInfo,
  type CameraFeaturesMessage,
  type CameraJpegMessage,
} from '../src/main/sensors/camera-host.ts'

/** A believable normal frame: bright enough, some motion, nothing blown out. */
const FEATURES: FrameFeatures = {
  lumaMean: 120,
  lumaStd: 40,
  overexposedRatio: 0.01,
  underexposedRatio: 0.01,
  motionEnergy: 0.2,
  motionPeak: 0.3,
  staticRatio: 0.8,
  centerMotionRatio: 0.1,
}

/** Tiny JPEG magic bytes; the host never decodes the image, only sizes it. */
const JPEG_BASE64 = Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64')

/** Let the async cadence pump (interval callback → bridge promise) settle. */
async function flush(): Promise<void> {
  await new Promise<void>(resolve => { setImmediate(resolve) })
}

class FakeCameraBridge implements CameraBridge {
  readonly devices: CameraDeviceInfo[] = [{ deviceId: 'cam-1', label: 'USB Camera' }]
  readonly startCalls: string[] = []
  stopCalls = 0
  sampleCalls = 0
  snapshotCalls = 0
  startError: unknown = undefined
  sampleResult: CameraFeaturesMessage | null = {
    type: 'features',
    sample: { capturedAtMs: 0, frameAgeMs: 12, features: FEATURES },
  }
  snapshotResult: CameraJpegMessage = { type: 'jpeg', bytes: JPEG_BASE64 }

  private ended: ((reason: string) => void) | undefined

  async listDevices(): Promise<readonly CameraDeviceInfo[]> {
    return this.devices
  }

  async start(deviceId: string): Promise<void> {
    if (this.startError !== undefined) throw this.startError
    this.startCalls.push(deviceId)
  }

  async sample(): Promise<CameraFeaturesMessage | null> {
    this.sampleCalls += 1
    return this.sampleResult
  }

  async snapshot(): Promise<CameraJpegMessage> {
    this.snapshotCalls += 1
    return this.snapshotResult
  }

  async stop(): Promise<void> {
    this.stopCalls += 1
  }

  onEnded(listener: (reason: string) => void): () => void {
    this.ended = listener
    return () => { this.ended = undefined }
  }

  /** Simulate an unplug / privacy-switch end of the capture stream. */
  emitEnded(reason: string): void {
    this.ended?.(reason)
  }
}

describe('CameraHost', () => {
  it('emits a feature sample at the configured cadence and none after stop', async () => {
    const clock = new FakeClock()
    const bridge = new FakeCameraBridge()
    const samples: FeatureSample[] = []
    const host = new BridgedCameraHost({ clock, bridge, onFeatures: sample => { samples.push(sample) } })

    await host.start('cam-1', { fps: 2 })
    expect(bridge.startCalls).toEqual(['cam-1'])
    // The first sample is one tick in; start() itself does not sample.
    await flush()
    expect(samples).toHaveLength(0)

    clock.advance(500)
    await flush()
    expect(samples).toHaveLength(1)
    clock.advance(500)
    await flush()
    expect(samples).toHaveLength(2)

    expect(samples[0]).toMatchObject({
      sourceId: 'usb-cam-1',
      quality: 'ok',
      frameAgeMs: 12,
      motionEnergy: 0.2,
      motionPeak: 0.3,
      lumaMean: 120,
    })
    expect(samples[0]?.ts).toBe(500)
    expect(samples[1]?.ts).toBe(1_000)

    await host.stop()
    clock.advance(2_000)
    await flush()
    expect(samples).toHaveLength(2)
    expect(bridge.stopCalls).toBe(1)
    expect(bridge.sampleCalls).toBe(2)
  })

  it('returns undefined jpeg older than maxAgeMs', async () => {
    const clock = new FakeClock()
    const bridge = new FakeCameraBridge()
    const host = new BridgedCameraHost({ clock, bridge, onFeatures: () => {} })

    const fresh = await host.latestJpeg(1_000)
    expect(fresh?.bytes).toEqual(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]))
    expect(fresh?.ts).toBe(0)

    // A cache inside the window is answered without touching the page again.
    expect((await host.latestJpeg(1_000))?.ts).toBe(0)
    expect(bridge.snapshotCalls).toBe(1)

    clock.advance(5_000)
    // The page no longer has a frame to give (stream paused or the camera is
    // gone): an old JPEG must never be presented as if it were current.
    bridge.snapshotResult = { type: 'jpeg', bytes: '' }
    expect(await host.latestJpeg(1_000)).toBeUndefined()
    expect(bridge.snapshotCalls).toBe(2)
  })

  it('reports a getUserMedia rejection as a readable error without crashing', async () => {
    const clock = new FakeClock()
    const bridge = new FakeCameraBridge()
    bridge.startError = new Error('getUserMedia failed: NotAllowedError: Permission denied')
    const samples: FeatureSample[] = []
    const host = new BridgedCameraHost({ clock, bridge, onFeatures: sample => { samples.push(sample) } })

    await expect(host.start('cam-1')).rejects.toThrow(/getUserMedia failed: NotAllowedError/)
    // A refused stream leaves nothing ticking and nothing emitted.
    clock.advance(2_000)
    await flush()
    expect(samples).toHaveLength(0)
    expect(bridge.startCalls).toHaveLength(0)
  })

  it('pushes exactly one unavailable sample when the capture ends on its own', async () => {
    const clock = new FakeClock()
    const bridge = new FakeCameraBridge()
    const samples: FeatureSample[] = []
    const host = new BridgedCameraHost({ clock, bridge, onFeatures: sample => { samples.push(sample) } })

    await host.start('cam-1')
    clock.advance(500)
    await flush()
    expect(samples).toHaveLength(1)

    // Unplugged USB: one unavailable sample, cadence stops.
    bridge.emitEnded('camera stream ended (device removed or unplugged)')
    expect(samples).toHaveLength(2)
    expect(samples[1]).toMatchObject({ sourceId: 'usb-cam-1', quality: 'unavailable' })

    clock.advance(2_000)
    await flush()
    expect(samples).toHaveLength(2)

    // A late second report is not a new loss.
    bridge.emitEnded('again')
    expect(samples).toHaveLength(2)
  })

  it('classifies dark, blown-out and occluded frames for the status view', () => {
    expect(qualityFromFeatures(FEATURES)).toBe('ok')
    expect(qualityFromFeatures({ ...FEATURES, lumaMean: 200, overexposedRatio: 0.7 })).toBe('bright')
    expect(qualityFromFeatures({ ...FEATURES, lumaMean: 10, underexposedRatio: 0.8 })).toBe('dim')
    expect(qualityFromFeatures({ ...FEATURES, lumaMean: 90, lumaStd: 1 })).toBe('blocked')
  })

  it('exposes the camera as an image source whose snapshot keeps the capture time', async () => {
    const clock = new FakeClock()
    const bridge = new FakeCameraBridge()
    const host = new BridgedCameraHost({ clock, bridge, onFeatures: () => {} })
    const source = cameraSensorSource(host)

    expect(source.id).toBe('usb-cam-1')
    expect(source.kind).toBe('image')
    const snapshot = await source.latest()
    expect(snapshot?.mime).toBe('image/jpeg')
    expect(snapshot?.ts).toBe(0)
    expect(snapshot?.bytes).toEqual(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]))
    // Derived from the feature ring, never from the source (plan §8.7 ruling 5).
    expect(source.freshnessMs()).toBeUndefined()
  })
})
