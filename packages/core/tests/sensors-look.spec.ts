import { describe, expect, it } from 'vitest'
import { FakeClock } from '../src/ports/fake-clock.ts'
import { DEFAULT_LOOK_MAX_AGE_MS, DEFAULT_LOOK_MAX_BYTES, readForLook } from '../src/sensors/look.ts'
import { SensorRegistry } from '../src/sensors/registry.ts'
import { isSensorError, SensorError } from '../src/sensors/types.ts'
import type { SensorKind, SensorSource, Snapshot } from '../src/sensors/types.ts'

function snapshot(options: { sourceId?: string; ts?: number; mime?: string; bytes?: Uint8Array } = {}): Snapshot {
  return {
    sourceId: options.sourceId ?? 'usb-cam-1',
    ts: options.ts ?? 0,
    mime: options.mime ?? 'image/jpeg',
    bytes: options.bytes ?? new Uint8Array([0xFF, 0xD8, 0xFF, 0xE0]),
  }
}

function imageSource(id: string, latest: () => Promise<Snapshot | undefined>): SensorSource {
  return { id, kind: 'image', label: id, latest, freshnessMs: () => undefined }
}

function audioSource(id: string, latest: () => Promise<Snapshot | undefined>): SensorSource {
  return { id, kind: 'audio', label: id, latest, freshnessMs: () => undefined }
}

function registryFor(clock: FakeClock, ...sources: SensorSource[]): SensorRegistry {
  const registry = new SensorRegistry({ clock })
  for (const source of sources) registry.register(source)
  return registry
}

describe('look snapshot pipeline', () => {
  it('refuses a snapshot older than maxAgeMs with a readable reason', async () => {
    const clock = new FakeClock(0)
    const registry = registryFor(clock, imageSource('usb-cam-1', () => Promise.resolve(snapshot({ ts: 0 }))))

    // Exactly at the limit is still fresh; only *older* frames are refused.
    clock.advance(DEFAULT_LOOK_MAX_AGE_MS)
    const fresh = await readForLook(registry, { now: clock.now() })
    expect(fresh.ageMs).toBe(DEFAULT_LOOK_MAX_AGE_MS)

    clock.advance(1)
    let caught: unknown
    try {
      await readForLook(registry, { now: clock.now() })
    } catch (error) {
      caught = error
    }
    expect(isSensorError(caught)).toBe(true)
    if (isSensorError(caught)) {
      expect(caught.code).toBe('STALE_SNAPSHOT')
      expect(caught.message).toContain('usb-cam-1')
      expect(caught.message).toContain('3001 ms old')
      expect(caught.message).toContain('maxAgeMs=3000')
    }
  })

  it('refuses an oversize jpeg instead of sending it', async () => {
    const clock = new FakeClock(0)
    const bytes = new Uint8Array([1, 2, 3, 4, 5])
    const registry = registryFor(clock, imageSource('usb-cam-1', () => Promise.resolve(snapshot({ ts: 0, bytes }))))

    let caught: unknown
    try {
      await readForLook(registry, { now: 0, maxBytes: 4 })
    } catch (error) {
      caught = error
    }
    expect(isSensorError(caught)).toBe(true)
    if (isSensorError(caught)) {
      expect(caught.code).toBe('OVERSIZE_SNAPSHOT')
      expect(caught.message).toContain('5 bytes')
      expect(caught.message).toContain('maxBytes=4')
    }

    // The boundary itself is accepted, and the bytes were never base64-encoded
    // above — this is one small payload, not a partial upload.
    const exact = await readForLook(registry, { now: 0, maxBytes: 5 })
    expect(exact.base64).toBe('AQIDBAU=')
  })

  it('encodes the jpeg as base64 with the right mime', async () => {
    const clock = new FakeClock(1_000)
    const registry = registryFor(clock, imageSource('usb-cam-1', () => Promise.resolve(snapshot({
      sourceId: 'usb-cam-1',
      ts: 900,
      mime: 'image/jpeg',
      bytes: new Uint8Array([0xFF, 0xD8, 0xFF, 0xE0]),
    }))))

    const image = await readForLook(registry, { now: 1_000 })
    expect(image.sourceId).toBe('usb-cam-1')
    expect(image.mime).toBe('image/jpeg')
    expect(image.base64).toBe('/9j/4A==')
    expect(image.ts).toBe(900)
    expect(image.ageMs).toBe(100)
    expect(DEFAULT_LOOK_MAX_BYTES).toBe(1_500_000)
  })

  it('falls back to the first image source when sourceId is omitted', async () => {
    const clock = new FakeClock(0)
    const registry = registryFor(
      clock,
      audioSource('mic-1', () => Promise.resolve(snapshot({ sourceId: 'mic-1' }))),
      imageSource('usb-cam-2', () => Promise.resolve(snapshot({ sourceId: 'usb-cam-2' }))),
    )

    const image = await readForLook(registry, { now: 0 })
    expect(image.sourceId).toBe('usb-cam-2')
  })

  it('refuses with NO_SNAPSHOT when no image source can deliver', async () => {
    const clock = new FakeClock(0)
    await expect(readForLook(new SensorRegistry({ clock }), { now: 0 }))
      .rejects.toMatchObject({ code: 'NO_SNAPSHOT' })

    const audioOnly = registryFor(clock, audioSource('mic-1', () => Promise.resolve(snapshot())))
    await expect(readForLook(audioOnly, { now: 0 })).rejects.toMatchObject({ code: 'NO_SNAPSHOT' })
    await expect(readForLook(audioOnly, { now: 0, sourceId: 'mic-1' })).rejects.toMatchObject({ code: 'NO_SNAPSHOT' })
    await expect(readForLook(audioOnly, { now: 0, sourceId: 'nope' })).rejects.toMatchObject({ code: 'NO_SNAPSHOT' })

    const silent = registryFor(clock, imageSource('usb-cam-1', () => Promise.resolve(undefined)))
    await expect(readForLook(silent, { now: 0 })).rejects.toMatchObject({ code: 'NO_SNAPSHOT' })

    // A typed error, not an empty string or a silently dropped image.
    await expect(readForLook(silent, { now: 0 })).rejects.toBeInstanceOf(SensorError)
  })

  it('uses the wall clock when no now is supplied', async () => {
    const clock = new FakeClock(0)
    const stale = registryFor(clock, imageSource('usb-cam-1', () => Promise.resolve(snapshot({ ts: Date.now() - 60_000 }))))
    await expect(readForLook(stale)).rejects.toMatchObject({ code: 'STALE_SNAPSHOT' })

    const fresh = registryFor(clock, imageSource('usb-cam-1', () => Promise.resolve(snapshot({ ts: Date.now() }))))
    const image = await readForLook(fresh)
    expect(image.ageMs).toBeLessThan(DEFAULT_LOOK_MAX_AGE_MS)
  })
})
