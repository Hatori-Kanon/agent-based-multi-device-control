/**
 * BLE boundary.
 *
 * Shaped around what every target platform can actually do rather than around
 * the richest one. Web Bluetooth — the Electron path on Windows — has no
 * free-form "scan and return a list" primitive in stable builds; it has
 * `requestDevice(filters)`, which yields at most one device. Modelling the port
 * as "request one device matching a filter" therefore keeps the Electron
 * implementation honest, and `react-native-ble-plx` can satisfy the same
 * contract by scanning internally on Android in M4b.
 *
 * Nothing in this file imports a platform API.
 */

/** Canonical 128-bit form of a 16-bit Bluetooth SIG UUID. */
export function bleUuid(short: number): string {
  if (!Number.isInteger(short) || short < 0 || short > 0xffff) {
    throw new RangeError(`not a 16-bit UUID: ${short}`)
  }
  return `0000${short.toString(16).padStart(4, '0')}-0000-1000-8000-00805f9b34fb`
}

/** Which device to ask the platform for. */
export interface BleFilter {
  /** Exact advertised name, when the vendor publishes one. */
  readonly name?: string
  /** Prefix match, for vendors that append a serial. */
  readonly namePrefix?: string
  /**
   * Services the device must **advertise**. Used for matching.
   *
   * Keep this to what actually appears in the advertisement: a 谜姬 toy
   * advertises `0xd34e` but keeps its control characteristics under `0xff10`,
   * so demanding both here matches nothing.
   */
  readonly services: readonly string[]
  /**
   * Services we need **access** to but which may not be advertised.
   *
   * Web Bluetooth denies any service that was not declared up front, and the
   * standard Device Information service holding a product id is never
   * advertised, so it belongs here rather than in the match.
   */
  readonly optionalServices?: readonly string[]
}

/** Address of one characteristic. */
export interface BleCharacteristicRef {
  readonly service: string
  readonly characteristic: string
}

export interface BlePeripheral {
  /** Platform-assigned identity; not stable across pairings on every platform. */
  readonly id: string
  readonly name: string | undefined
  readonly connected: boolean

  /**
   * Write one value.
   *
   * @param withoutResponse - Prefer write-without-response where the device
   *   supports it. A 10 Hz command stream does not need an ack per frame, and
   *   waiting for one can starve the stream.
   */
  write(ref: BleCharacteristicRef, data: Uint8Array, withoutResponse?: boolean): Promise<void>

  /**
   * Read one characteristic.
   *
   * Needed for capability detection: several vendors publish a product id in
   * the standard PnP ID characteristic, and the encoding of every subsequent
   * command depends on it.
   */
  read(ref: BleCharacteristicRef): Promise<Uint8Array>

  /** Subscribe to notifications. Resolves to an unsubscribe function. */
  subscribe(ref: BleCharacteristicRef, onData: (data: Uint8Array) => void): Promise<() => void>

  /** Observe link loss. Returns a function that removes the listener. */
  onDisconnect(listener: () => void): () => void

  disconnect(): Promise<void>
}

export interface BleTransport {
  /**
   * Ask the platform for one device matching `filter` and return it connected.
   *
   * Implementations may surface a chooser; the Electron implementation answers
   * it programmatically so an operator sees one click, not two.
   */
  request(filter: BleFilter, signal: AbortSignal): Promise<BlePeripheral>
}
