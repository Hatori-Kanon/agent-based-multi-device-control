import { FakeClock, type FeatureSample } from '@embodied/core'
import { describe, expect, it } from 'vitest'
import {
  BridgedAudioHost,
  clampAudioLevel,
  DEFAULT_AUDIO_FPS,
  audioSensorSource,
  type AudioBridge,
  type AudioDeviceInfo,
} from '../src/main/sensors/audio-host.ts'

/** Let the async cadence pump (interval callback → bridge promise) settle. */
async function flush(): Promise<void> {
  await new Promise<void>(resolve => { setImmediate(resolve) })
}

class FakeAudioBridge implements AudioBridge {
  readonly devices: AudioDeviceInfo[] = [{ deviceId: 'mic-1', label: 'USB 麦克风' }]
  readonly startCalls: string[] = []
  stopCalls = 0
  sampleCalls = 0
  startError: unknown = undefined
  level: number | null = 42

  private ended: ((reason: string) => void) | undefined

  async listDevices(): Promise<readonly AudioDeviceInfo[]> {
    return this.devices
  }

  async start(deviceId: string): Promise<void> {
    if (this.startError !== undefined) throw this.startError
    this.startCalls.push(deviceId)
  }

  async sample(): Promise<number | null> {
    this.sampleCalls += 1
    return this.level
  }

  async stop(): Promise<void> {
    this.stopCalls += 1
  }

  onEnded(listener: (reason: string) => void): () => void {
    this.ended = listener
    return () => { this.ended = undefined }
  }

  /** Simulate an unplug / permission revocation / track ended. */
  emitEnded(reason: string): void {
    this.ended?.(reason)
  }
}

describe('AudioHost', () => {
  it('emits a feature sample at the configured cadence and none after stop', async () => {
    const clock = new FakeClock()
    const bridge = new FakeAudioBridge()
    const samples: FeatureSample[] = []
    const host = new BridgedAudioHost({ clock, bridge, onFeatures: sample => { samples.push(sample) } })

    await host.start('mic-1')
    expect(bridge.startCalls).toEqual(['mic-1'])
    // The first sample is one tick in; start() itself does not sample.
    await flush()
    expect(samples).toHaveLength(0)

    clock.advance(500)
    await flush()
    expect(samples).toHaveLength(1)
    clock.advance(500)
    await flush()
    expect(samples).toHaveLength(2)

    // 2 Hz by default, and every field the registry expects is present.
    expect(DEFAULT_AUDIO_FPS).toBe(2)
    expect(samples[0]).toMatchObject({
      sourceId: 'mic-1',
      ts: 500,
      frameAgeMs: 0,
      quality: 'ok',
      audioLevelPct: 42,
    })

    await host.stop()
    clock.advance(2_000)
    await flush()
    expect(samples).toHaveLength(2)
    expect(bridge.stopCalls).toBe(1)
    expect(bridge.sampleCalls).toBe(2)
  })

  it('reads a missing analyser level as unavailable rather than silence', async () => {
    const clock = new FakeClock()
    const bridge = new FakeAudioBridge()
    bridge.level = null
    const samples: FeatureSample[] = []
    const host = new BridgedAudioHost({ clock, bridge, onFeatures: sample => { samples.push(sample) } })

    await host.start('mic-1')
    clock.advance(500)
    await flush()

    expect(samples).toHaveLength(1)
    expect(samples[0]).toMatchObject({ sourceId: 'mic-1', quality: 'unavailable', frameAgeMs: 0 })
    // No audioLevelPct at all — 0 would be a fabricated measurement.
    expect(samples[0]?.audioLevelPct).toBeUndefined()
  })

  it('clamps and rounds the reported level into 0-100', async () => {
    expect(clampAudioLevel(42.4)).toBe(42)
    expect(clampAudioLevel(0)).toBe(0)
    expect(clampAudioLevel(100)).toBe(100)
    expect(clampAudioLevel(180)).toBe(100)
    expect(clampAudioLevel(-5)).toBe(0)
    expect(clampAudioLevel(Number.NaN)).toBeUndefined()
    expect(clampAudioLevel(Number.POSITIVE_INFINITY)).toBeUndefined()
  })

  it('reports a getUserMedia rejection as a readable error without crashing', async () => {
    const clock = new FakeClock()
    const bridge = new FakeAudioBridge()
    bridge.startError = new Error('getUserMedia failed: NotAllowedError: Permission denied')
    const samples: FeatureSample[] = []
    const host = new BridgedAudioHost({ clock, bridge, onFeatures: sample => { samples.push(sample) } })

    await expect(host.start('mic-1')).rejects.toThrow(/getUserMedia failed: NotAllowedError/)
    // A refused stream leaves nothing ticking and nothing emitted.
    clock.advance(2_000)
    await flush()
    expect(samples).toHaveLength(0)
    expect(bridge.startCalls).toHaveLength(0)
    expect(bridge.sampleCalls).toBe(0)
  })

  it('pushes exactly one unavailable sample when capture ends on its own', async () => {
    const clock = new FakeClock()
    const bridge = new FakeAudioBridge()
    const samples: FeatureSample[] = []
    const host = new BridgedAudioHost({ clock, bridge, onFeatures: sample => { samples.push(sample) } })

    await host.start('mic-1')
    clock.advance(500)
    await flush()
    expect(samples).toHaveLength(1)

    // Device removed: one unavailable sample, cadence stops.
    bridge.emitEnded('microphone capture ended (device removed)')
    expect(samples).toHaveLength(2)
    expect(samples[1]).toMatchObject({ sourceId: 'mic-1', quality: 'unavailable' })
    expect(samples[1]?.audioLevelPct).toBeUndefined()

    clock.advance(2_000)
    await flush()
    expect(samples).toHaveLength(2)

    // A late second report is not a new loss.
    bridge.emitEnded('again')
    expect(samples).toHaveLength(2)
  })

  it('exposes the microphone as an audio source without an on-demand snapshot', async () => {
    const clock = new FakeClock()
    const bridge = new FakeAudioBridge()
    const host = new BridgedAudioHost({ clock, bridge })
    const source = audioSensorSource(host)

    expect(source.id).toBe('mic-1')
    expect(source.kind).toBe('audio')
    expect(source.label).toBe('麦克风')
    // Audio has no snapshot: the level only exists while the host samples it.
    expect(await source.latest()).toBeUndefined()
    expect(source.freshnessMs()).toBeUndefined()
  })
})
