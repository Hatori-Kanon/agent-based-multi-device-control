/**
 * ANKNI stream backend.
 *
 * The ANKNI family speaks companion frames (AA 08 04 ...) over the shared
 * 谜姬-family service set: the toy advertises 0xd34e, the control layout is
 * adopted by the same INITIALIZE handshake (a clone serves 0xdddd/ddd1/ddd2),
 * and the live motor slot is a fire-and-forget stream on the layout's live
 * characteristic.
 *
 * Safety property worth knowing: the stream IS the dead-man switch. The box
 * keeps what the last frame said and decays; a host that stops feeding frames
 * lets output sink to nothing. Nothing here may ever "latch" into the device.
 *
 * Channel model: one `rotation` channel (main motor at frame byte 3) until a
 * second slot is confirmed on a unit; additional slots are added per model as
 * they are verified. Like every backend, the registry enforces the human cap
 * before applyLevel reaches here.
 */

import { SafetyError } from '../../devices/errors.ts'
import type { Channel, DeviceBackend } from '../../devices/types.ts'
import type { BlePeripheral, BleTransport } from '../../ports/ble.ts'
import type { Clock, Timer } from '../../ports/clock.ts'
import { adoptControlLayout, type XhtkjLayout } from '../xhtkj/layout.ts'
import {
  DEVICE_INFORMATION_SERVICE,
  PNP_ID_CHARACTERISTIC,
  XHTKJ_ADVERTISING_SERVICE,
  XHTKJ_ALT_SERVICE,
  XHTKJ_DEVICE_SERVICE,
} from '../xhtkj/protocol.ts'
import { ANKNI_STOP_FRAME, encodeAnkniFrame } from './protocol.ts'

export type AnkniChannelId = 'rotation'

const CHANNELS: readonly Channel[] = [
  { id: 'rotation', kind: 'level', label: '旋转' },
]

const PNP_REF = {
  service: DEVICE_INFORMATION_SERVICE,
  characteristic: PNP_ID_CHARACTERISTIC,
}

const DEFAULT_FRAME_MS = 200

export interface AnkniBackendOptions {
  readonly id?: string
  readonly name?: string
  readonly clock: Clock
  readonly transport: BleTransport
  /** Advertised name to scan for; pins a specific unit among the family. */
  readonly bleName?: string
  readonly frameMs?: number
  readonly onError?: (error: unknown) => void
}

export class AnkniBackend implements DeviceBackend {
  readonly id: string
  readonly name: string
  readonly channels = CHANNELS

  private peripheral: BlePeripheral | undefined
  private layout: XhtkjLayout | undefined
  private notifyOff: (() => void) | undefined
  private disconnectOff: (() => void) | undefined
  private ticker: Timer | undefined
  private ready = false
  private target = 0
  private writing = false
  private writeChain: Promise<void> = Promise.resolve()

  private readonly linkLostListeners = new Set<() => void>()

  constructor(private readonly options: AnkniBackendOptions) {
    this.id = options.id ?? 'ankni'
    this.name = options.name ?? '安可尼 流式玩具'
  }

  async connect(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    this.resetState()

    const peripheral = await this.options.transport.request({
      services: [XHTKJ_ADVERTISING_SERVICE],
      optionalServices: [XHTKJ_DEVICE_SERVICE, DEVICE_INFORMATION_SERVICE, XHTKJ_ALT_SERVICE],
      ...(this.options.bleName === undefined ? {} : { name: this.options.bleName }),
    }, signal)
    this.peripheral = peripheral
    this.disconnectOff = peripheral.onDisconnect(() => { this.handleLinkLost() })

    try {
      const adopted = await adoptControlLayout(
        peripheral,
        data => { this.options.onError?.(new Error(`[ankni] notification: ${[...data].map(b => b.toString(16).padStart(2, '0')).join(' ')}`)) },
        error => { this.options.onError?.(error) },
      )
      this.layout = adopted.layout
      this.notifyOff = adopted.notifyOff

      // Capability detection is best effort: the product id describes the slot
      // layout; an unreadable id still gets the confirmed main slot.
      try {
        await peripheral.read(PNP_REF)
      } catch {
        // Unknown model: the main rotation slot remains.
      }
    } catch (error) {
      await this.teardown()
      throw error
    }

    this.ready = true
    const frameMs = this.options.frameMs ?? DEFAULT_FRAME_MS
    this.ticker = this.options.clock.interval(frameMs, () => { void this.pushFrame() })
    void this.pushFrame()
  }

  async applyLevel(channelId: string, percent: number): Promise<void> {
    this.requireChannel(channelId)
    this.assertReady()
    this.target = Math.min(Math.max(percent, 0), 100)
    await this.pushFrame()
  }

  async stopAll(): Promise<void> {
    this.target = 0
    if (this.peripheral?.connected !== true) return
    await this.flushFrame(ANKNI_STOP_FRAME)
  }

  /** Raw frame from a human protocol experiment, via the adopted live channel. */
  async writeRaw(data: Uint8Array): Promise<void> {
    this.assertReady()
    await this.flushFrame(Uint8Array.from(data))
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

  /** Resolve once no frame write is in flight. Used by tests and shutdown. */
  async settled(): Promise<void> {
    while (this.writing) await this.writeChain.catch(() => {})
  }

  onLinkLost(listener: () => void): () => void {
    this.linkLostListeners.add(listener)
    return () => { this.linkLostListeners.delete(listener) }
  }

  private async pushFrame(): Promise<void> {
    if (this.writing) return
    const frame = encodeAnkniFrame({ main: this.target })
    await this.deliver(frame)
  }

  private async flushFrame(frame: Uint8Array): Promise<void> {
    await this.writeChain.catch(() => {})
    await this.deliver(frame)
  }

  private async deliver(data: Uint8Array): Promise<void> {
    const peripheral = this.peripheral
    const layout = this.layout
    if (peripheral === undefined || layout === undefined) return
    this.writing = true
    try {
      await peripheral.write(layout.live, data, layout.liveWithoutResponse)
    } catch (error) {
      this.options.onError?.(error)
      this.handleLinkLost()
    } finally {
      this.writing = false
    }
  }

  private handleLinkLost(): void {
    if (this.ticker === undefined && this.peripheral === undefined) return
    this.ticker?.cancel()
    this.ticker = undefined
    this.target = 0
    for (const listener of [...this.linkLostListeners]) {
      try {
        listener()
      } catch (error) {
        this.options.onError?.(error)
      }
    }
  }

  private async teardown(): Promise<void> {
    this.ticker?.cancel()
    this.ticker = undefined
    this.ready = false
    this.notifyOff?.()
    this.notifyOff = undefined
    this.disconnectOff?.()
    this.disconnectOff = undefined
    const peripheral = this.peripheral
    this.peripheral = undefined
    this.layout = undefined
    if (peripheral?.connected === true) {
      try {
        await peripheral.disconnect()
      } catch (error) {
        this.options.onError?.(error)
      }
    }
  }

  private resetState(): void {
    this.ready = false
    this.target = 0
    this.writing = false
    this.writeChain = Promise.resolve()
  }

  private requireChannel(channelId: string): AnkniChannelId {
    if (channelId !== 'rotation') {
      throw new SafetyError('UNKNOWN_CHANNEL', `安可尼 stream toy has channel "rotation"; received "${channelId}"`)
    }
    return channelId
  }

  private assertReady(): void {
    if (!this.ready || this.peripheral?.connected !== true) {
      throw new SafetyError('NOT_CONNECTED', `${this.id} is not connected; connect it first`)
    }
  }
}
