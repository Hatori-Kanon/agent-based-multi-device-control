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
  /**
   * Request and connect one matching device.
   *
   * `deviceId` pins the choice when the platform chooser already ran; omitted,
   * the worker asks the OS to pick.
   */
  request(filter: BleFilter, deviceId?: string): Promise<{ handle: string; name?: string }>
  /**
   * Open the platform chooser for a filter and resolve with the chosen device
   * id, or `undefined` when nothing suitable appeared. The caller drives the
   * retry.
   */
  selectDevice?: (filter: BleFilter, signal: AbortSignal) => Promise<string | undefined>
  /**
   * How many candidate advertisements the platform produced during the most
   * recent {@link BleBridge.selectDevice}, so a failure can distinguish
   * "Bluetooth is off" (zero) from "the toy is not advertising" (some).
   */
  readonly lastSelectionSize?: number
  /**
   * Raw platform error from the most recent selection — typically the real
   * reason `requestDevice` was refused (adapter off, unavailable, denied).
   */
  readonly lastSelectionError: string | undefined
  /**
   * Execution trace of the most recent selection, surfaced in the failure
   * message because terminal stdout can be buffered and lost.
   */
  readonly lastSelectionTrace: readonly string[] | undefined
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
    console.log(`[ble] BridgedBleTransport constructed; selectDevice: ${typeof bridge.selectDevice}`)
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
    console.log(`[ble] transport.request start; chooser: ${this.bridge.selectDevice !== undefined}`)

    // A BLE scan cache takes a moment to populate. Each attempt opens its own
    // collection window, so a powered-on device does not lose to timing.
    const attempts = this.bridge.selectDevice === undefined ? 1 : 2
    let lastError: unknown
    let totalCandidates = 0

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      signal.throwIfAborted()
      try {
        // Call through the object, never detached: `const chooser = bridge.selectionMethod; chooser(...)` loses `this`, and the method's first `this.` reference throws. The fake in tests did not catch this because it uses an arrow-function property.
        const deviceId = this.bridge.selectDevice === undefined
          ? undefined
          : await this.bridge.selectDevice(filter, signal)
        totalCandidates += this.bridge.lastSelectionSize ?? 0
        // A selection that found nothing means "scan again", not "connect to
        // nothing": skip straight to the next attempt without asking the OS.
        if (this.bridge.selectDevice !== undefined && deviceId === undefined) continue
        const { handle, name } = await this.bridge.request(filter, deviceId)
        const peripheral = new BridgedPeripheral(handle, name, this.bridge)
        this.peripherals.set(handle, peripheral)
        if (signal.aborted) {
          await peripheral.disconnect()
          signal.throwIfAborted()
        }
        return peripheral
      } catch (error) {
        lastError = error
      }
    }

    // The candidate count splits the two failure modes: none at all means the
    // Bluetooth stack itself produced nothing, whereas some-but-unmatched means
    // the toy is simply not advertising (off, far, or held by another app).
    // When the platform refused the request outright, its own words belong in
    // the message too.
    const platformError = totalCandidates === 0 && this.bridge.lastSelectionError !== undefined
      ? `; the Bluetooth stack reported: ${this.bridge.lastSelectionError}`
      : ''
    const guidance = totalCandidates === 0
      ? 'no Bluetooth devices were found at all; check that Windows Bluetooth is on and the toy is powered on'
      : `found ${totalCandidates} device(s) but none matched; make sure the toy is powered on, nearby, and not already connected to another app`
    const trace = this.bridge.lastSelectionTrace !== undefined && this.bridge.lastSelectionTrace.length > 0
      ? `; selection trace: [${this.bridge.lastSelectionTrace.join(' | ')}]`
      : ''
    const cause = lastError === undefined
      ? ''
      : `; inner cause: ${describeUnknown(lastError)}`
    throw new SafetyError(
      'NOT_CONNECTED',
      `no BLE device matched this request after ${attempts} attempt(s)${describeFilter(filter)}; ${guidance}${platformError}${trace}${cause}`,
    )
  }

  /** Drop every peripheral and stop listening to the worker. */
  async close(): Promise<void> {
    const peripherals = [...this.peripherals.values()]
    this.peripherals.clear()
    for (const off of this.detach.splice(0)) off()
    await Promise.all(peripherals.map(peripheral => peripheral.disconnect().catch(() => {})))
  }
}

/** Human-readable hint about what a filter was looking for. */
function describeFilter(filter: BleFilter): string {
  const wanted = filter.name ?? filter.namePrefix ?? filter.services[0]
  return wanted === undefined ? '' : ` (wanted: ${wanted})`
}

/**
 * Best-effort description of a thrown value. DOMException is not an `Error`
 * instance and its `toString` can degrade to "[object Object]", so pull the
 * fields that matter first.
 */
function describeUnknown(error: unknown): string {
  if (error === null || error === undefined) return String(error)
  if (error instanceof Error) return `${error.name}: ${error.message}`
  const candidate = error as { name?: unknown; message?: unknown }
  if (typeof candidate.name === 'string' || typeof candidate.message === 'string') {
    return `${String(candidate.name ?? 'Error')}: ${String(candidate.message ?? '')}`
  }
  return String(error)
}
