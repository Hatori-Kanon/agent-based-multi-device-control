import { COYOTE_SERVICE, COYOTE_WRITE_CHARACTERISTIC, SafetyError, type BleCharacteristicRef, type BleFilter } from '@embodied/core'
import { describe, expect, it } from 'vitest'
import { BridgedBleTransport, bytesToHex, hexToBytes, type BleBridge } from '../src/main/ble/bridge.ts'

const REF: BleCharacteristicRef = { service: COYOTE_SERVICE, characteristic: COYOTE_WRITE_CHARACTERISTIC }
const NOTIFY_REF: BleCharacteristicRef = { service: COYOTE_SERVICE, characteristic: '0000150b-0000-1000-8000-00805f9b34fb' }

interface Recorded {
  readonly kind: 'request' | 'read' | 'write' | 'subscribe' | 'unsubscribe' | 'disconnect'
  readonly handle?: string
  readonly hex?: string
  readonly withoutResponse?: boolean
  readonly ref?: BleCharacteristicRef
  readonly filter?: BleFilter
}

class FakeBridge implements BleBridge {
  readonly calls: Recorded[] = []
  requestResult: { handle: string; name?: string } = { handle: 'h1', name: 'Coyote' }
  readResult = '025e041d0001'
  failNext: Error | undefined
  private notifyListeners = new Set<(event: { handle: string; ref: BleCharacteristicRef; hex: string }) => void>()
  private disconnectListeners = new Set<(event: { handle: string }) => void>()

  request(filter: BleFilter): Promise<{ handle: string; name?: string }> {
    this.calls.push({ kind: 'request', filter })
    return Promise.resolve(this.requestResult)
  }

  read(handle: string, ref: BleCharacteristicRef): Promise<string> {
    this.calls.push({ kind: 'read', handle, ref })
    return Promise.resolve(this.readResult)
  }

  write(handle: string, ref: BleCharacteristicRef, hex: string, withoutResponse: boolean): Promise<void> {
    this.calls.push({ kind: 'write', handle, ref, hex, withoutResponse })
    return Promise.resolve()
  }

  subscribe(handle: string, ref: BleCharacteristicRef): Promise<void> {
    this.calls.push({ kind: 'subscribe', handle, ref })
    if (this.failNext !== undefined) {
      const failure = this.failNext
      this.failNext = undefined
      return Promise.reject(failure)
    }
    return Promise.resolve()
  }

  unsubscribe(handle: string, ref: BleCharacteristicRef): Promise<void> {
    this.calls.push({ kind: 'unsubscribe', handle, ref })
    return Promise.resolve()
  }

  disconnect(handle: string): Promise<void> {
    this.calls.push({ kind: 'disconnect', handle })
    return Promise.resolve()
  }

  onNotify(listener: (event: { handle: string; ref: BleCharacteristicRef; hex: string }) => void): () => void {
    this.notifyListeners.add(listener)
    return () => { this.notifyListeners.delete(listener) }
  }

  onDisconnected(listener: (event: { handle: string }) => void): () => void {
    this.disconnectListeners.add(listener)
    return () => { this.disconnectListeners.delete(listener) }
  }

  emitNotify(handle: string, ref: BleCharacteristicRef, hex: string): void {
    for (const listener of this.notifyListeners) listener({ handle, ref, hex })
  }

  emitDisconnected(handle: string): void {
    for (const listener of this.disconnectListeners) listener({ handle })
  }

  countOf(kind: Recorded['kind']): number {
    return this.calls.filter(call => call.kind === kind).length
  }
}

function signal(): AbortSignal {
  return new AbortController().signal
}

describe('hex payload conversion', () => {
  it('round-trips bytes', () => {
    const data = Uint8Array.from([0xb0, 0x00, 0x0a, 0xff])
    expect(bytesToHex(data)).toBe('b0000aff')
    expect([...hexToBytes('b0000aff')]).toEqual([...data])
  })

  it('pads single digits so the length always stays even', () => {
    expect(bytesToHex(Uint8Array.from([0, 1, 15]))).toBe('00010f')
  })

  it('refuses malformed input instead of producing silent garbage', () => {
    expect(() => hexToBytes('abc')).toThrow(SafetyError)
    expect(() => hexToBytes('zz')).toThrow(SafetyError)
  })
})

describe('BridgedBleTransport', () => {
  it('passes the filter through and exposes the connected device', async () => {
    const bridge = new FakeBridge()
    const transport = new BridgedBleTransport(bridge)
    const filter: BleFilter = { name: '47L121000', services: [COYOTE_SERVICE] }

    const peripheral = await transport.request(filter, signal())

    expect(bridge.calls[0]?.filter).toEqual(filter)
    expect(peripheral.id).toBe('h1')
    expect(peripheral.name).toBe('Coyote')
    expect(peripheral.connected).toBe(true)
  })

  it('carries the optional services a device does not advertise', async () => {
    const bridge = new FakeBridge()
    const transport = new BridgedBleTransport(bridge)
    // A 谜姬 toy advertises 0xd34e but keeps control under 0xff10 and its
    // product id in the standard Device Information service.
    const filter: BleFilter = {
      services: ['0000d34e-0000-1000-8000-00805f9b34fb'],
      optionalServices: ['0000ff10-0000-1000-8000-00805f9b34fb', '0000180a-0000-1000-8000-00805f9b34fb'],
    }
    await transport.request(filter, signal())
    expect(bridge.calls[0]?.filter).toEqual(filter)
  })

  it('decodes a characteristic read back into bytes', async () => {
    const bridge = new FakeBridge()
    const transport = new BridgedBleTransport(bridge)
    const peripheral = await transport.request({ services: [COYOTE_SERVICE] }, signal())

    const value = await peripheral.read(NOTIFY_REF)
    expect([...value]).toEqual([0x02, 0x5e, 0x04, 0x1d, 0x00, 0x01])
    expect(bridge.calls.filter(call => call.kind === 'read')).toHaveLength(1)
  })

  it('refuses a read after the link is gone', async () => {
    const bridge = new FakeBridge()
    const transport = new BridgedBleTransport(bridge)
    const peripheral = await transport.request({ services: [COYOTE_SERVICE] }, signal())
    bridge.emitDisconnected('h1')
    await expect(peripheral.read(NOTIFY_REF)).rejects.toBeInstanceOf(SafetyError)
  })

  it('sends writes as hex and preserves the without-response flag', async () => {
    const bridge = new FakeBridge()
    const transport = new BridgedBleTransport(bridge)
    const peripheral = await transport.request({ services: [COYOTE_SERVICE] }, signal())

    await peripheral.write(REF, Uint8Array.from([0xbf, 0x50]), false)
    await peripheral.write(REF, Uint8Array.from([0xb0, 0x00]), true)

    const writes = bridge.calls.filter(call => call.kind === 'write')
    expect(writes[0]).toMatchObject({ hex: 'bf50', withoutResponse: false })
    expect(writes[1]).toMatchObject({ hex: 'b000', withoutResponse: true })
  })

  it('opens one worker subscription per characteristic no matter how many listeners join', async () => {
    const bridge = new FakeBridge()
    const transport = new BridgedBleTransport(bridge)
    const peripheral = await transport.request({ services: [COYOTE_SERVICE] }, signal())

    const first: string[] = []
    const second: string[] = []
    const offFirst = await peripheral.subscribe(NOTIFY_REF, data => { first.push(bytesToHex(data)) })
    await peripheral.subscribe(NOTIFY_REF, data => { second.push(bytesToHex(data)) })
    expect(bridge.countOf('subscribe')).toBe(1)

    bridge.emitNotify('h1', NOTIFY_REF, 'b1010000')
    expect(first).toEqual(['b1010000'])
    expect(second).toEqual(['b1010000'])

    // Dropping one listener must not close the shared subscription.
    offFirst()
    expect(bridge.countOf('unsubscribe')).toBe(0)
    bridge.emitNotify('h1', NOTIFY_REF, 'b1020000')
    expect(first).toEqual(['b1010000'])
    expect(second).toEqual(['b1010000', 'b1020000'])
  })

  it('closes the worker subscription once the last listener leaves', async () => {
    const bridge = new FakeBridge()
    const transport = new BridgedBleTransport(bridge)
    const peripheral = await transport.request({ services: [COYOTE_SERVICE] }, signal())
    const off = await peripheral.subscribe(NOTIFY_REF, () => {})
    off()
    await Promise.resolve()
    expect(bridge.countOf('unsubscribe')).toBe(1)
  })

  it('does not leave a half-registered subscription when the worker rejects', async () => {
    const bridge = new FakeBridge()
    const transport = new BridgedBleTransport(bridge)
    const peripheral = await transport.request({ services: [COYOTE_SERVICE] }, signal())
    bridge.failNext = new Error('notifications unavailable')

    await expect(peripheral.subscribe(NOTIFY_REF, () => {})).rejects.toThrow('notifications unavailable')
    // A retry must reach the worker again rather than joining a phantom entry.
    await peripheral.subscribe(NOTIFY_REF, () => {})
    expect(bridge.countOf('subscribe')).toBe(2)
  })

  it('routes notifications only to the addressed handle', async () => {
    const bridge = new FakeBridge()
    const transport = new BridgedBleTransport(bridge)
    const peripheral = await transport.request({ services: [COYOTE_SERVICE] }, signal())
    const seen: string[] = []
    await peripheral.subscribe(NOTIFY_REF, data => { seen.push(bytesToHex(data)) })

    bridge.emitNotify('other-handle', NOTIFY_REF, 'deadbeef')
    bridge.emitNotify('h1', NOTIFY_REF, 'b1000000')
    expect(seen).toEqual(['b1000000'])
  })

  it('survives a malformed frame from the worker', async () => {
    const bridge = new FakeBridge()
    const transport = new BridgedBleTransport(bridge)
    const peripheral = await transport.request({ services: [COYOTE_SERVICE] }, signal())
    const seen: string[] = []
    await peripheral.subscribe(NOTIFY_REF, data => { seen.push(bytesToHex(data)) })

    expect(() => { bridge.emitNotify('h1', NOTIFY_REF, 'not-hex') }).not.toThrow()
    bridge.emitNotify('h1', NOTIFY_REF, 'b1000000')
    expect(seen).toEqual(['b1000000'])
  })

  it('propagates a worker disconnect and then refuses writes', async () => {
    const bridge = new FakeBridge()
    const transport = new BridgedBleTransport(bridge)
    const peripheral = await transport.request({ services: [COYOTE_SERVICE] }, signal())
    const lost: number[] = []
    peripheral.onDisconnect(() => { lost.push(1) })

    bridge.emitDisconnected('h1')

    expect(lost).toHaveLength(1)
    expect(peripheral.connected).toBe(false)
    await expect(peripheral.write(REF, Uint8Array.from([1]))).rejects.toBeInstanceOf(SafetyError)
  })

  it('reports a disconnect exactly once', async () => {
    const bridge = new FakeBridge()
    const transport = new BridgedBleTransport(bridge)
    const peripheral = await transport.request({ services: [COYOTE_SERVICE] }, signal())
    const lost: number[] = []
    peripheral.onDisconnect(() => { lost.push(1) })

    bridge.emitDisconnected('h1')
    bridge.emitDisconnected('h1')
    await peripheral.disconnect()
    expect(lost).toHaveLength(1)
  })

  it('drops every peripheral on close', async () => {
    const bridge = new FakeBridge()
    const transport = new BridgedBleTransport(bridge)
    const peripheral = await transport.request({ services: [COYOTE_SERVICE] }, signal())

    await transport.close()

    expect(bridge.countOf('disconnect')).toBe(1)
    expect(peripheral.connected).toBe(false)
    // And it stopped listening, so late worker chatter is inert.
    expect(() => { bridge.emitDisconnected('h1') }).not.toThrow()
  })

  it('honours an already-aborted signal', async () => {
    const bridge = new FakeBridge()
    const transport = new BridgedBleTransport(bridge)
    const controller = new AbortController()
    controller.abort()
    await expect(transport.request({ services: [COYOTE_SERVICE] }, controller.signal)).rejects.toBeDefined()
    expect(bridge.countOf('request')).toBe(0)
  })
})
