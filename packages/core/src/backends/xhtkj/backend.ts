/**
 * 谜姬 / XHTKJ direct-BLE backend.
 *
 * A second, independent path to the same device family the MonsterParty relay
 * reaches. Because it talks to the toy directly there is **no share link and no
 * vendor server**, which removes the single-use-token problem that makes the
 * relay awkward for a long session.
 *
 * Two properties to keep in mind:
 *
 * - **No hardware dead-man switch.** One strength packet sets a level and the
 *   toy holds it. If the host dies, output continues. Same category as a
 *   Buttplug toy; the Coyote's frame stream is the exception.
 * - **Percentage is not linear here.** The vendor maps the visible range onto
 *   the motor's usable band, so the smallest non-zero command already lands at
 *   20-40% of full output. The channel publishes that floor rather than
 *   pretending otherwise.
 *
 * Device-side built-in modes and uploaded waveforms are **deliberately not
 * exposed yet**. The protocol for both is implemented and tested in
 * `protocol.ts`, but neither fits the level/waveform channel model without a
 * lossy translation, and the host-side effect scheduler already gives an agent
 * expressive amplitude control on every backend.
 */

import { SafetyError } from '../../devices/errors.ts'
import type { Channel, DeviceBackend } from '../../devices/types.ts'
import type { BleCharacteristicRef, BlePeripheral, BleTransport } from '../../ports/ble.ts'
import type { Clock, Timer } from '../../ports/clock.ts'
import {
  CLEAR_PACKET,
  DEVICE_INFORMATION_SERVICE,
  INITIALIZE_PACKET,
  PNP_ID_CHARACTERISTIC,
  STOP_MODE_PACKET,
  XHTKJ_ADVERTISING_SERVICE,
  XHTKJ_ALT_SERVICE,
  XHTKJ_ALT_STREAM_CHARACTERISTIC,
  XHTKJ_ALT_WRITE_CHARACTERISTIC,
  XHTKJ_DEVICE_SERVICE,
  XHTKJ_NOTIFY_CHARACTERISTIC,
  XHTKJ_WRITE_CHARACTERISTIC,
  capabilityOf,
  outputFloorPercent,
  parseProductId,
  strengthPacket,
  type XhtkjCapability,
} from './protocol.ts'

export type XhtkjChannelId = 'primary' | 'secondary'

const WRITE_REF: BleCharacteristicRef = {
  service: XHTKJ_DEVICE_SERVICE,
  characteristic: XHTKJ_WRITE_CHARACTERISTIC,
}
const NOTIFY_REF: BleCharacteristicRef = {
  service: XHTKJ_DEVICE_SERVICE,
  characteristic: XHTKJ_NOTIFY_CHARACTERISTIC,
}
const PNP_REF: BleCharacteristicRef = {
  service: DEVICE_INFORMATION_SERVICE,
  characteristic: PNP_ID_CHARACTERISTIC,
}

/** One known control-service layout of the 谜姬 family. */
interface XhtkjLayout {
  /** Acked setup channel: initialise and other confirmed commands. */
  readonly write: BleCharacteristicRef
  /** Live policy channel: strength, clear, and stop traffic. */
  readonly live: BleCharacteristicRef
  /** Live traffic is fire-and-forget (stream toys) rather than acked. */
  readonly liveWithoutResponse: boolean
  readonly notify: BleCharacteristicRef | undefined
}

/** Classic 谜姬 layout (0xff10/ff11/ff12): one channel for everything. */
const CLASSIC_LAYOUT: XhtkjLayout = {
  write: WRITE_REF,
  live: WRITE_REF,
  liveWithoutResponse: false,
  notify: NOTIFY_REF,
}
/**
 * ANKNI clone layout (0xdddd): ddd1 = fire-and-forget stream, ddd2 = acked
 * commands, ddd3 = read, no notify. Layout confirmed on a real ANKNI ZKRXB.
 */
const ALT_LAYOUT: XhtkjLayout = {
  write: { service: XHTKJ_ALT_SERVICE, characteristic: XHTKJ_ALT_WRITE_CHARACTERISTIC },
  live: { service: XHTKJ_ALT_SERVICE, characteristic: XHTKJ_ALT_STREAM_CHARACTERISTIC },
  liveWithoutResponse: true,
  notify: undefined,
}
/** Tried in order; the first one that accepts the INITIALIZE write wins. */
const XHTKJ_LAYOUTS: readonly XhtkjLayout[] = [CLASSIC_LAYOUT, ALT_LAYOUT]

const SECONDARY_LABEL: Readonly<Record<XhtkjCapability, string>> = {
  heat: '加热',
  electric: '电刺激',
  shock: '冲击',
  vibration: '副震动',
  generic: '副路',
}

/**
 * Floor for the secondary output, where the encoding is clearly an amplitude.
 *
 * `heat` scales linearly from zero, and the electric layout's words are not a
 * plain amplitude at all, so no floor is claimed for those. Guessing would be
 * worse than admitting the mapping is only partly understood.
 */
function secondaryFloorPercent(capability: XhtkjCapability, productId: number | undefined): number {
  switch (capability) {
    case 'shock':
      return 30
    case 'vibration':
    case 'generic':
      return outputFloorPercent(productId)
    case 'heat':
    case 'electric':
      return 0
  }
}

/** Minimum gap between transport writes. BLE cannot absorb a 20 Hz stream. */
const DEFAULT_MIN_WRITE_INTERVAL_MS = 100

export interface XhtkjBackendOptions {
  readonly id?: string
  readonly name?: string
  readonly clock: Clock
  readonly transport: BleTransport
  /**
   * Advertised name to scan for. The family service UUID alone matches every
   * 谜姬-family toy; a specific unit (dual-motor, rotation, etc.) is targeted
   * by its name when several are around.
   */
  readonly bleName?: string
  readonly minWriteIntervalMs?: number
  readonly onError?: (error: unknown) => void
}

export class XhtkjBackend implements DeviceBackend {
  readonly id: string

  private peripheral: BlePeripheral | undefined
  private notifyOff: (() => void) | undefined
  private disconnectOff: (() => void) | undefined
  private productId: number | undefined
  private capability: XhtkjCapability = 'generic'
  private ready = false
  /** Control-service layout adopted by the connect handshake. */
  private layout: XhtkjLayout = CLASSIC_LAYOUT

  private primary = 0
  private secondary = 0
  private needsClear = true

  private dirty = false
  private writing = false
  private scheduled = false
  private timer: Timer | undefined
  private writeChain: Promise<void> = Promise.resolve()
  private nextAllowedAt = 0

  /** Last notification, hex-encoded, for operator diagnostics. */
  lastNotificationHex: string | undefined

  private readonly linkLostListeners = new Set<() => void>()

  constructor(private readonly options: XhtkjBackendOptions) {
    this.id = options.id ?? 'xhtkj'
  }

  get name(): string {
    const base = this.options.name ?? '谜姬 BLE toy'
    // Always carry the capability and product id: it is the evidence needed
    // to map a unit's channel layout (rotation toys, dual motors, ...).
    return this.productId === undefined
      ? base
      : `${base} (${this.capability}, pid ${this.productId})`
  }

  /** Product id read from the standard PnP ID characteristic, when available. */
  get reportedProductId(): number | undefined {
    return this.productId
  }

  get reportedCapability(): XhtkjCapability {
    return this.capability
  }

  /**
   * Channels depend on the product id, which is only known after connect, so
   * this is a getter and the registry re-reads it.
   *
   * An unidentified product exposes only the main output: inventing a secondary
   * channel we cannot encode correctly would be worse than offering less.
   */
  get channels(): readonly Channel[] {
    const primary: Channel = {
      id: 'primary',
      kind: 'level',
      label: '主输出',
      outputFloorPercent: outputFloorPercent(this.productId),
    }
    if (this.capability === 'generic') return [primary]
    return [primary, {
      id: 'secondary',
      kind: 'level',
      label: SECONDARY_LABEL[this.capability],
      outputFloorPercent: secondaryFloorPercent(this.capability, this.productId),
    }]
  }

  async connect(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    this.resetState()

    const peripheral = await this.options.transport.request({
      // Only 0xd34e is advertised; the control and info services are not, so
      // every one of them must be granted up front (Web Bluetooth refuses
      // access to undeclared services).
      services: [XHTKJ_ADVERTISING_SERVICE],
      optionalServices: [XHTKJ_DEVICE_SERVICE, DEVICE_INFORMATION_SERVICE, XHTKJ_ALT_SERVICE],
      ...(this.options.bleName === undefined ? {} : { name: this.options.bleName }),
    }, signal)
    this.peripheral = peripheral
    this.disconnectOff = peripheral.onDisconnect(() => { this.handleLinkLost() })

    try {
      // Capability detection is best effort: an unreadable id degrades to
      // main-output-only rather than failing the connect.
      try {
        this.productId = parseProductId(await peripheral.read(PNP_REF))
      } catch (error) {
        this.options.onError?.(error)
      }
      this.capability = capabilityOf(this.productId)

      // Adopt the control layout by handshake: clones (ANKNI ZKRXB...) serve
      // 0xdddd instead of 0xff10 and expose no notify characteristic, so the
      // classic layout must fail over cleanly. Probe failures are expected
      // here (a clone has no 0xff10 at all) and stay out of the error panel;
      // only a notify failure on the ADOPTED layout is worth reporting.
      let adopted: XhtkjLayout | undefined
      let lastError: unknown
      let probeNotifyError: unknown
      for (const layout of XHTKJ_LAYOUTS) {
        this.notifyOff?.()
        this.notifyOff = undefined
        if (layout.notify !== undefined) {
          try {
            this.notifyOff = await peripheral.subscribe(layout.notify, data => {
              this.lastNotificationHex = [...data].map(byte => byte.toString(16).padStart(2, '0')).join('')
            })
          } catch (error) {
            probeNotifyError = error
          }
        }
        try {
          await peripheral.write(layout.write, INITIALIZE_PACKET, false)
          adopted = layout
          break
        } catch (error) {
          lastError = error
        }
      }
      if (adopted === undefined) {
        await this.teardown()
        throw new SafetyError(
          'NOT_CONNECTED',
          `initialize handshake failed on every known layout (classic 0xff10 and ANKNI 0xdddd): ${lastError instanceof Error ? lastError.message : String(lastError)}`,
        )
      }
      if (adopted.notify !== undefined && this.notifyOff === undefined && probeNotifyError !== undefined) {
        this.options.onError?.(probeNotifyError)
      }
      this.layout = adopted
    } catch (error) {
      await this.teardown()
      throw error
    }

    this.ready = true
    this.nextAllowedAt = this.options.clock.now()
  }

  async applyLevel(channelId: string, percent: number): Promise<void> {
    this.assertReady()
    const value = clampPercent(percent)
    if (channelId === 'primary') {
      this.primary = value
    } else if (channelId === 'secondary') {
      if (this.capability === 'generic') {
        throw new SafetyError(
          'UNKNOWN_CHANNEL',
          `${this.id} could not identify the product, so only the main output is available`,
        )
      }
      this.secondary = value
    } else {
      throw new SafetyError('UNKNOWN_CHANNEL', `${this.id} has channels "primary" and "secondary"; received "${channelId}"`)
    }
    this.dirty = true
    this.pump()
  }

  async stopAll(): Promise<void> {
    this.primary = 0
    this.secondary = 0
    if (this.peripheral?.connected !== true) return
    // A stop must not wait out the rate limit.
    this.cancelSchedule()
    await this.writeChain.catch(() => {})
    this.dirty = false
    try {
      await this.write(STOP_MODE_PACKET)
      await this.write(CLEAR_PACKET)
      this.needsClear = true
    } catch (error) {
      this.options.onError?.(error)
    }
  }

  /** Raw frame from a human protocol experiment, via the adopted live channel. */
  async writeRaw(data: Uint8Array): Promise<void> {
    this.assertReady()
    this.dirty = false
    await this.write(data)
  }

  /** Resolve once no write is in flight. Tests advance the clock for the rest. */
  async settled(): Promise<void> {
    while (this.writing) await this.writeChain.catch(() => {})
  }

  onLinkLost(listener: () => void): () => void {
    this.linkLostListeners.add(listener)
    return () => { this.linkLostListeners.delete(listener) }
  }

  async close(): Promise<void> {
    if (this.peripheral?.connected === true) {
      try {
        await this.stopAll()
      } catch (error) {
        this.options.onError?.(error)
      }
    }
    await this.teardown()
  }

  /** Coalescing, rate-limited writer. Only the newest target is ever sent. */
  private pump(): void {
    if (!this.dirty || this.writing || this.scheduled) return
    if (this.peripheral?.connected !== true) return
    const wait = this.nextAllowedAt - this.options.clock.now()
    if (wait > 0) {
      this.scheduled = true
      this.timer = this.options.clock.timeout(wait, () => {
        this.scheduled = false
        this.timer = undefined
        this.pump()
      })
      return
    }
    this.dirty = false
    this.writing = true
    this.writeChain = this.sendStrength().finally(() => {
      this.writing = false
      this.nextAllowedAt = this.options.clock.now() + (this.options.minWriteIntervalMs ?? DEFAULT_MIN_WRITE_INTERVAL_MS)
      this.pump()
    })
  }

  private async sendStrength(): Promise<void> {
    try {
      if (this.needsClear) {
        await this.write(CLEAR_PACKET)
        this.needsClear = false
      }
      const secondary = this.capability === 'generic' ? undefined : this.secondary / 100
      await this.write(strengthPacket(this.primary / 100, secondary, this.productId))
    } catch (error) {
      // Re-arm so the next pump retries rather than losing the target.
      this.dirty = true
      this.options.onError?.(error)
    }
  }

  private async write(packet: Uint8Array, live = true): Promise<void> {
    const peripheral = this.peripheral
    if (peripheral?.connected !== true) throw new SafetyError('NOT_CONNECTED', `${this.id} is not connected`)
    // Setup goes to the acked channel; live strength/stop traffic goes to the
    // live channel, fire-and-forget on stream toys.
    const ref = live ? this.layout.live : this.layout.write
    const withoutResponse = live && this.layout.liveWithoutResponse
    await peripheral.write(ref, packet, withoutResponse)
  }

  private cancelSchedule(): void {
    this.timer?.cancel()
    this.timer = undefined
    this.scheduled = false
  }

  private handleLinkLost(): void {
    if (!this.ready && this.peripheral === undefined) return
    this.cancelSchedule()
    this.ready = false
    this.dirty = false
    this.primary = 0
    this.secondary = 0
    for (const listener of [...this.linkLostListeners]) {
      try {
        listener()
      } catch (error) {
        this.options.onError?.(error)
      }
    }
  }

  private resetState(): void {
    this.productId = undefined
    this.capability = 'generic'
    this.ready = false
    this.primary = 0
    this.secondary = 0
    this.needsClear = true
    this.dirty = false
    this.lastNotificationHex = undefined
  }

  private async teardown(): Promise<void> {
    this.cancelSchedule()
    this.ready = false
    this.notifyOff?.()
    this.notifyOff = undefined
    this.disconnectOff?.()
    this.disconnectOff = undefined
    const peripheral = this.peripheral
    this.peripheral = undefined
    if (peripheral?.connected === true) {
      try {
        await peripheral.disconnect()
      } catch (error) {
        this.options.onError?.(error)
      }
    }
  }

  private assertReady(): void {
    if (!this.ready || this.peripheral?.connected !== true) {
      throw new SafetyError('NOT_CONNECTED', `${this.id} is not connected; connect it first`)
    }
  }
}

function clampPercent(percent: number): number {
  if (!Number.isFinite(percent) || percent <= 0) return 0
  return Math.min(100, Math.round(percent))
}
