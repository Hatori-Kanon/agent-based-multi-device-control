import { describe, expect, it } from 'vitest'
import { FakeClock } from '../src/ports/fake-clock.ts'
import { SensorRegistry } from '../src/sensors/registry.ts'
import type { SensorSource } from '../src/sensors/types.ts'

function cameraSource(): SensorSource {
  return {
    id: 'usb-cam-1',
    kind: 'image',
    label: 'USB 摄像头',
    latest: () => Promise.resolve(undefined),
    freshnessMs: () => undefined,
  }
}

describe('sensor registry quality', () => {
  it('keeps an explicit unavailable sample after the stale window', () => {
    // The camera host pushes exactly one `unavailable` sample when the device
    // disappears. It must not decay into "stale" three seconds later, because
    // the two mean different things to the model.
    const clock = new FakeClock()
    const registry = new SensorRegistry({ clock })
    registry.register(cameraSource())
    registry.push({ sourceId: 'usb-cam-1', ts: clock.now(), frameAgeMs: 0, quality: 'unavailable' })

    expect(registry.statuses()[0]?.quality).toBe('unavailable')

    clock.advance(5_000)
    expect(registry.statuses()[0]?.quality).toBe('unavailable')
  })

  it('still reports stale for a source that simply stopped sampling', () => {
    const clock = new FakeClock()
    const registry = new SensorRegistry({ clock })
    registry.register(cameraSource())
    registry.push({ sourceId: 'usb-cam-1', ts: clock.now(), frameAgeMs: 0, quality: 'ok' })

    expect(registry.statuses()[0]?.quality).toBe('ok')
    clock.advance(5_000)
    expect(registry.statuses()[0]?.quality).toBe('stale')
  })
})
