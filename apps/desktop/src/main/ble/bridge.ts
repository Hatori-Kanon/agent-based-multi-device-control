/**
 * BLE transport built on a renderer-side Web Bluetooth worker.
 *
 * Web Bluetooth only exists in a renderer, so the safety runtime in the main
 * process reaches it through a bridge. Everything that can hold a bug —
 * byte/hex conversion, one shared notification subscription per characteristic,
 * disconnect fan-out, handle bookkeeping — lives here behind {@link BleBridge}
 * and is unit-tested with a fake. The Electron-specific half is glue only.
 */

import { SafetyError } from '@embodied/core'
import type { BleCharacteristicRef, BleFilter, BlePeripheral, BleTransport } from '@embodied/core'

/** What the renderer worker offers. All payloads are JSON-serialisable. */
export interface BleBridge {
  /** Request and connect one matching device. */
  request(filter: BleFilter): Promise<{ handle: string; name?: string }>
  /** Read one characteristic, returned as hex. */
  read(handle: string, ref: BleCharacteristicRef): Promise<string>
  write(handle: string, ref: BleCharacteristicRef, hex: string, withoutResponse: boolean): Promise<void>
  /** Begin notifications; the worker pushes them through {@link BleBridge.onNotify}. */
  subscribe(handle: string, ref: BleCharacteristicRef): Promise<void>
  unsubscribe(handle: string, ref: BleCharacteristicRef): Promise<void>
  disconnect(handle: string): Promise<void>
  onNotify(listener: (event: { handle: string; ref: BleCharacteristicRef; hex: string }) => void): () => void
  onDisconnected(listener: (event: { handle: string }) => void): () => void
}

export function bytesToHex(data: Uint8Array): string {
  return [...data].map(value => value.toString(16).padStart(2, '0')).join('')
}

export function hexToBytes(hex: string): Uint8Array {
  const trimmed = hex.trim()
  if (trimmed.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(trimmed)) {
    throw new SafetyError('NOT_CONNECTED', `malformed hex payload from the BLE worker: "${hex}"`)
  }
  const out = new Uint8Array(trimmed.length / 2)
  for (let index = 0; index < out.length; index += 1) {
    out[index] = Number.parseInt(trimmed.slice(index * 2, index * 2 + 2), 16)
  }
  return out
}

function refKey(ref: BleCharacteristicRef): string {
  return `${ref.service.toLowerCase()}/${ref.characteristic.toLowerCase()}`
}

interface Subscription {
  readonly ref: BleCharacteristicRef
  readonly listeners: Set<(data: Uint8Array) => void>
}

class BridgedPeripheral implements BlePeripheral {
  private readonly subscriptions = new Map<string, Subscription>()
  private readonly disconnectListeners = new Set<() => void>()
  private open = true

  constructor(
    readonly id: string,
    readonly name: string | undefined,
    private readonly bridge: BleBridge,
  ) {}

  get connected(): boolean {
    return this.open
  }

  async write(ref: BleCharacteristicRef, data: Uint8Array, withoutResponse = false): Promise<void> {
    this.assertOpen()
    await this.bridge.write(this.id, ref, bytesToHex(data), withoutResponse)
  }

  async read(ref: BleCharacteristicRef): Promise<Uint8Array> {
    this.assertOpen()
    return hexToBytes(await this.bridge.read(this.id, ref))
  }

  async subscribe(ref: BleCharacteristicRef, onData: (data: Uint8Array) => void): Promise<() => void> {
    this.assertOpen()
    const key = refKey(ref)
    const existing = this.subscriptions.get(key)
    if (existing !== undefined) {
      // One bridge subscription per characteristic; extra callers just join it.
      existing.listeners.add(onData)
      return () => { this.removeListener(key, onData) }
    }
    const subscription: Subscription = { ref, listeners: new Set([onData]) }
    this.subscriptions.set(key, subscription)
    try {
      await this.bridge.subscribe(this.id, ref)
    } catch (error) {
      this.subscriptions.delete(key)
      throw error
    }
    return () => { this.removeListener(key, onData) }
  }

  onDisconnect(listener: () => void): () => void {
    this.disconnectListeners.add(listener)
    return () => { this.disconnectListeners.delete(listener) }
  }

  async disconnect(): Promise<void> {
    if (!this.open) return
    try {
      await this.bridge.disconnect(this.id)
    } finally {
      this.markClosed()
    }
  }

  /** Called by the transport when the worker reports data for this handle. */
  deliver(ref: BleCharacteristicRef, data: Uint8Array): void {
    for (const listener of [...(this.subscriptions.get(refKey(ref))?.listeners ?? [])]) {
      listener(Uint8Array.from(data))
    }
  }

  /** Called by the transport when the worker reports the link is gone. */
  markClosed(): void {
    if (!this.open) return
    this.open = false
    this.subscriptions.clear()
    for (const listener of [...this.disconnectListeners]) listener()
  }

  private removeListener(key: string, onData: (data: Uint8Array) => void): void {
    const subscription = this.subscriptions.get(key)
    if (subscription === undefined) return
    subscription.listeners.delete(onData)
    if (subscription.listeners.size > 0) return
    this.subscriptions.delete(key)
    // Best effort: the link may already be gone, which is not an error here.
    void this.bridge.unsubscribe(this.id, subscription.ref).catch(() => {})
  }

  private assertOpen(): void {
    if (!this.open) throw new SafetyError('NOT_CONNECTED', `BLE device ${this.id} is disconnected`)
  }
}

export class BridgedBleTransport implements BleTransport {
  private readonly peripherals = new Map<string, BridgedPeripheral>()
  private readonly detach: (() => void)[] = []

  constructor(private readonly bridge: BleBridge) {
    this.detach.push(bridge.onNotify(event => {
      const peripheral = this.peripherals.get(event.handle)
      if (peripheral === undefined) return
      try {
        peripheral.deliver(event.ref, hexToBytes(event.hex))
      } catch {
        // A malformed frame from the worker must not tear down the transport.
      }
    }))
    this.detach.push(bridge.onDisconnected(event => {
      const peripheral = this.peripherals.get(event.handle)
      this.peripherals.delete(event.handle)
      peripheral?.markClosed()
    }))
  }

  async request(filter: BleFilter, signal: AbortSignal): Promise<BlePeripheral> {
    signal.throwIfAborted()
    const { handle, name } = await this.bridge.request(filter)
    const peripheral = new BridgedPeripheral(handle, name, this.bridge)
    this.peripherals.set(handle, peripheral)
    if (signal.aborted) {
      await peripheral.disconnect()
      signal.throwIfAborted()
    }
    return peripheral
  }

  /** Drop every peripheral and stop listening to the worker. */
  async close(): Promise<void> {
    const peripherals = [...this.peripherals.values()]
    this.peripherals.clear()
    for (const off of this.detach.splice(0)) off()
    await Promise.all(peripherals.map(peripheral => peripheral.disconnect().catch(() => {})))
  }
}
