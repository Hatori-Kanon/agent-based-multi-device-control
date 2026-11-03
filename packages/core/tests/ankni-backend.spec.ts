import { describe, expect, it } from 'vitest'
import {
  ANKNI_STOP_FRAME,
  FakeClock,
  MockBleTransport,
  encodeAnkniFrame,
  AnkniBackend,
  XHTKJ_ALT_SERVICE,
  XHTKJ_ALT_STREAM_CHARACTERISTIC,
  XHTKJ_ADVERTISING_SERVICE,
  PNP_ID_CHARACTERISTIC,
  DEVICE_INFORMATION_SERVICE,
  COMMAND,
  XHTKJ_ALT_WRITE_CHARACTERISTIC,
  type MockBleWrite,
} from '../src/index.ts'

const PNP_KEY = `${DEVICE_INFORMATION_SERVICE}/${PNP_ID_CHARACTERISTIC}`.toLowerCase()

function signal(): AbortSignal {
  return new AbortController().signal
}

function pnpFor(productId: number): Uint8Array {
  return Uint8Array.from([0x02, 0x5e, 0x04, productId & 0xff, (productId >> 8) & 0xff, 0x01, 0x00])
}

function harness(overrides: Partial<ConstructorParameters<typeof AnkniBackend>[0]> = {}) {
  const clock = new FakeClock()
  const errors: unknown[] = []
  const transport = new MockBleTransport({
    clock,
    name: 'ANKNI ZKRXB',
    reads: { [PNP_KEY]: pnpFor(0x00a5) },
    // The classic 谜姬 layout is absent on the clone.
    failWrite: ref => (ref.service === XHTKJ_ALT_SERVICE ? undefined : new Error('NotFoundError')),
  })
  const backend = new AnkniBackend({
    clock,
    transport,
    onError: error => { errors.push(error) },
    ...overrides,
  })
  return { clock, transport, backend, errors }
}

function streamWrites(transport: MockBleTransport): MockBleWrite[] {
  return (transport.peripheral?.writes ?? []).filter(
    write => write.service === XHTKJ_ALT_SERVICE && write.characteristic === XHTKJ_ALT_STREAM_CHARACTERISTIC,
  )
}

function frameOf(write: MockBleWrite): number[] {
  return [...write.data]
}

describe('Ankni frame encoding', () => {
  it('places the main motor at byte 3 with a sum checksum', () => {
    const frame = encodeAnkniFrame({ main: 40 })
    expect(frameOf({ data: frame } as MockBleWrite)).toEqual([0xaa, 0x08, 0x04, 0x28, 0x00, 0x00, 0x00, 0xde])
  })

  it('clamps the motor value into 0-100', () => {
    expect(frameOf({ data: encodeAnkniFrame({ main: 200 }) } as MockBleWrite)[3]).toBe(100)
    expect(frameOf({ data: encodeAnkniFrame({ main: -5 }) } as MockBleWrite)[3]).toBe(0)
  })

  it('produces the always-stop frame', () => {
    expect([...ANKNI_STOP_FRAME]).toEqual([0xaa, 0x08, 0x04, 0x00, 0x00, 0x00, 0x00, 0xb6])
  })
})

describe('AnkniBackend', () => {
  it('connects, adopts the clone layout, and streams frames on 0xddd1', async () => {
    const h = harness()
    await h.backend.connect(signal())
    expect(h.transport.requests[0]?.optionalServices).toContain(XHTKJ_ALT_SERVICE)

    // Initialize goes to the acked channel (0xddd2).
    const init = (h.transport.peripheral?.writes ?? []).find(
      write => write.service === XHTKJ_ALT_SERVICE && write.characteristic === XHTKJ_ALT_WRITE_CHARACTERISTIC,
    )
    expect(init?.data[2]).toBe(COMMAND.initialize)
    expect(init?.withoutResponse).toBe(false)

    // The stream channel is fire-and-forget.
    await h.backend.applyLevel('rotation', 40)
    h.clock.advance(200)
    await h.backend.settled()
    const written = streamWrites(h.transport)
    expect(written.length).toBeGreaterThan(1)
    expect(written.every(write => write.withoutResponse)).toBe(true)
    expect(frameOf(written[written.length - 1]!)).toEqual([0xaa, 0x08, 0x04, 0x28, 0x00, 0x00, 0x00, 0xde])
  })

  it('pins the chooser to a bound platform id and reports the connected unit', async () => {
    const clock = new FakeClock()
    const transport = new MockBleTransport({
      clock,
      name: 'ANKNI ZKRXB',
      platformId: 'ankni-1',
      reads: { [PNP_KEY]: pnpFor(0x2000) },
    })
    const backend = new AnkniBackend({
      clock,
      transport,
      bleDeviceId: () => 'ankni-1',
      bleReservedIds: () => ['ankni-2'],
    })
    await backend.connect(signal())
    expect(transport.requests[0]?.deviceId).toBe('ankni-1')
    expect(transport.requests[0]?.excludeDeviceIds).toEqual(['ankni-2'])
    expect(backend.platformDeviceId).toBe('ankni-1')
    await backend.close()
  })

  it('stops by streaming the zero frame', async () => {
    const h = harness()
    await h.backend.connect(signal())
    await h.backend.applyLevel('rotation', 40)
    h.clock.advance(200)
    await h.backend.settled()

    await h.backend.stopAll()
    h.clock.advance(200)
    await h.backend.settled()
    const written = streamWrites(h.transport)
    expect(frameOf(written[written.length - 1]!)).toEqual([...ANKNI_STOP_FRAME])
  })

  it('refuses unknown channels and disconnected writes', async () => {
    const h = harness()
    await expect(h.backend.applyLevel('nope', 10)).rejects.toMatchObject({ code: 'UNKNOWN_CHANNEL' })
    await expect(h.backend.applyLevel('rotation', 10)).rejects.toMatchObject({ code: 'NOT_CONNECTED' })
  })
})
