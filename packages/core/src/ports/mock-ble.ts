/**
 * In-memory {@link BleTransport} for tests.
 *
 * Records every write with a timestamp so a test can assert on stream cadence
 * — which is the whole safety story for a streaming pulse box — and lets a
 * test push notifications and drop the link on demand.
 */

import type { BleCharacteristicRef, BleFilter, BlePeripheral, BleTransport } from './ble.ts'
import type { Clock } from './clock.ts'

/** One recorded write. */
export interface MockBleWrite {
  readonly atMs: number
  readonly service: string
  readonly characteristic: string
  readonly data: Uint8Array
  readonly withoutResponse: boolean
}

function refKey(ref: BleCharacteristicRef): string {
  return `${ref.service}/${ref.characteristic}`
}

export interface MockBlePeripheralOptions {
  readonly id?: string
  readonly name?: string
  readonly clock: Clock
  /** Return an error to fail a specific write. */
  readonly failWrite?: (ref: BleCharacteristicRef, data: Uint8Array) => Error | undefined
  /** Values `read` returns, keyed by `service/characteristic` in lower case. */
  readonly reads?: Readonly<Record<string, Uint8Array>>
}

export class MockBlePeripheral implements BlePeripheral {
  readonly id: string
  readonly name: string | undefined
  readonly writes: MockBleWrite[] = []
  /** Characteristics `read` was called on, in order. */
  readonly reads: string[] = []

  private readonly readValues = new Map<string, Uint8Array>()
  private readonly subscribers = new Map<string, Set<(data: Uint8Array) => void>>()
  private readonly disconnectListeners = new Set<() => void>()
  private open = true

  constructor(private readonly options: MockBlePeripheralOptions) {
    this.id = options.id ?? 'mock-peripheral'
    this.name = options.name
    for (const [key, value] of Object.entries(options.reads ?? {})) {
      this.readValues.set(key.toLowerCase(), Uint8Array.from(value))
    }
  }

  get connected(): boolean {
    return this.open
  }

  /** Set what a later `read` returns. */
  setRead(ref: BleCharacteristicRef, data: Uint8Array): void {
    this.readValues.set(refKey(ref), Uint8Array.from(data))
  }

  read(ref: BleCharacteristicRef): Promise<Uint8Array> {
    if (!this.open) return Promise.reject(new Error('mock peripheral is disconnected'))
    const key = refKey(ref)
    this.reads.push(key)
    const value = this.readValues.get(key)
    if (value === undefined) return Promise.reject(new Error(`mock peripheral has no value for ${key}`))
    return Promise.resolve(Uint8Array.from(value))
  }

  write(ref: BleCharacteristicRef, data: Uint8Array, withoutResponse = false): Promise<void> {
    if (!this.open) return Promise.reject(new Error('mock peripheral is disconnected'))
    const failure = this.options.failWrite?.(ref, data)
    if (failure !== undefined) return Promise.reject(failure)
    this.writes.push({
      atMs: this.options.clock.now(),
      service: ref.service,
      characteristic: ref.characteristic,
      data: Uint8Array.from(data),
      withoutResponse,
    })
    return Promise.resolve()
  }

  subscribe(ref: BleCharacteristicRef, onData: (data: Uint8Array) => void): Promise<() => void> {
    if (!this.open) return Promise.reject(new Error('mock peripheral is disconnected'))
    const key = refKey(ref)
    const set = this.subscribers.get(key) ?? new Set()
    set.add(onData)
    this.subscribers.set(key, set)
    return Promise.resolve(() => { set.delete(onData) })
  }

  onDisconnect(listener: () => void): () => void {
    this.disconnectListeners.add(listener)
    return () => { this.disconnectListeners.delete(listener) }
  }

  disconnect(): Promise<void> {
    this.simulateDisconnect()
    return Promise.resolve()
  }

  /** Writes to one characteristic, newest last. */
  writesTo(ref: BleCharacteristicRef): MockBleWrite[] {
    const key = refKey(ref)
    return this.writes.filter(write => refKey(write) === key)
  }

  /** Deliver a notification to every subscriber of a characteristic. */
  notify(ref: BleCharacteristicRef, data: Uint8Array): void {
    for (const listener of this.subscribers.get(refKey(ref)) ?? []) listener(Uint8Array.from(data))
  }

  /** Drop the link the way a device going out of range would. */
  simulateDisconnect(): void {
    if (!this.open) return
    this.open = false
    for (const listener of [...this.disconnectListeners]) listener()
  }
}

export interface MockBleTransportOptions {
  readonly clock: Clock
  readonly id?: string
  readonly name?: string
  /** Reject `request` with this error instead of connecting. */
  readonly failRequest?: Error
  readonly failWrite?: (ref: BleCharacteristicRef, data: Uint8Array) => Error | undefined
  readonly reads?: Readonly<Record<string, Uint8Array>>
}

/** One `request` and the peripheral it produced. */
export interface MockBleSession {
  readonly filter: BleFilter
  readonly peripheral: MockBlePeripheral
}

export class MockBleTransport implements BleTransport {
  /** Filters seen by `request`, for asserting that the backend asked correctly. */
  readonly requests: BleFilter[] = []
  /**
   * Every successful request, in order.
   *
   * One adapter really does serve several devices — a Coyote and a 谜姬 toy can
   * share it — so a test must be able to reach each peripheral rather than only
   * the most recent one.
   */
  readonly sessions: MockBleSession[] = []

  constructor(private readonly options: MockBleTransportOptions) {}

  /** The most recently handed out peripheral. */
  get peripheral(): MockBlePeripheral | undefined {
    return this.sessions.at(-1)?.peripheral
  }

  /** First peripheral whose request matched `predicate`. */
  peripheralFor(predicate: (filter: BleFilter) => boolean): MockBlePeripheral | undefined {
    return this.sessions.find(session => predicate(session.filter))?.peripheral
  }

  request(filter: BleFilter, signal: AbortSignal): Promise<MockBlePeripheral> {
    this.requests.push(filter)
    if (signal.aborted) return Promise.reject(signal.reason ?? new Error('aborted'))
    if (this.options.failRequest !== undefined) return Promise.reject(this.options.failRequest)
    const peripheral = new MockBlePeripheral({
      clock: this.options.clock,
      ...(this.options.id === undefined ? {} : { id: `${this.options.id}-${this.sessions.length + 1}` }),
      ...(this.options.name === undefined ? {} : { name: this.options.name }),
      ...(this.options.failWrite === undefined ? {} : { failWrite: this.options.failWrite }),
      ...(this.options.reads === undefined ? {} : { reads: this.options.reads }),
    })
    this.sessions.push({ filter, peripheral })
    return Promise.resolve(peripheral)
  }
}
