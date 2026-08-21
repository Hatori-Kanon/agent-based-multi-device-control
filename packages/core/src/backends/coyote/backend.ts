/**
 * Coyote V3 backend.
 *
 * Three properties carry the safety model:
 *
 * 1. **`BF` is written on every connect, and a failure aborts the connect.**
 *    The soft cap persists across power cycles and is never acknowledged at the
 *    protocol level, so a session that could not write it would silently run
 *    under some previous ceiling. Refusing to become controllable is the only
 *    honest response.
 * 2. **The 100 ms `B0` stream *is* the dead-man switch.** Stop writing and the
 *    box stops. Nothing here may ever "latch" output into the device, and the
 *    host process dying is therefore self-limiting.
 * 3. **Strength is only written when we want it to change.** The stream is the
 *    only authority on target strength: the physical wheel is deliberately not
 *    adopted (that feature was removed — a wheel report now makes the stream
 *    re-assert the commanded target instead of following the hand), so the
 *    cap and level the client commands are what the box plays.
 *
 * The wheel therefore has no influence over what the box plays. The client
 * (console UI, agent) decides cap and level; the emergency-stop paths are the
 * escape hatches if the client is wrong.
 *
 * One frame carries *both* channels, so the two channels are composed together
 * rather than written separately — which is exactly why keep-alive lives in the
 * backend and not in the effect scheduler.
 */

import { SafetyError } from '../../devices/errors.ts'
import type { Channel, DeviceBackend } from '../../devices/types.ts'
import type { BleCharacteristicRef, BlePeripheral, BleTransport } from '../../ports/ble.ts'
import type { Clock, Timer } from '../../ports/clock.ts'
import { clampFrameIntensity } from '../../waveform/clamp.ts'
import { frameAt, type FrameSlots, type PulseFrame, type Waveform } from '../../waveform/types.ts'
import {
  COYOTE_BATTERY_SERVICE,
  COYOTE_BLE_NAME,
  COYOTE_NOTIFY_CHARACTERISTIC,
  COYOTE_SERVICE,
  COYOTE_WRITE_CHARACTERISTIC,
  decodeNotification,
  encodeB0,
  encodeBF,
  MAX_SEQ,
  percentToStrength,
  SILENT_FREQ,
  SILENT_INTENSITY,
  type StrengthMode,
} from './protocol.ts'

export type CoyoteChannelId = 'a' | 'b'

const CHANNEL_IDS: readonly CoyoteChannelId[] = ['a', 'b']

const CHANNELS: readonly Channel[] = [
  { id: 'a', kind: 'level', label: 'A 通道', supportsWaveform: true },
  { id: 'b', kind: 'level', label: 'B 通道', supportsWaveform: true },
]

const WRITE_REF: BleCharacteristicRef = {
  service: COYOTE_SERVICE,
  characteristic: COYOTE_WRITE_CHARACTERISTIC,
}
const NOTIFY_REF: BleCharacteristicRef = {
  service: COYOTE_SERVICE,
  characteristic: COYOTE_NOTIFY_CHARACTERISTIC,
}

/**
 * Texture used when a level is set with no waveform chosen.
 *
 * A Coyote produces nothing from strength alone — it needs waveform data every
 * frame. Without this, `set_level` would appear to do nothing, which is a far
 * worse failure than a plausible default.
 */
export const COYOTE_PLAIN_FRAME: PulseFrame = {
  freq: [40, 40, 40, 40],
  intensity: [60, 60, 60, 60],
}

/** Neutral perception-shaping defaults for the two `BF` balance parameters. */
export const DEFAULT_FREQUENCY_BALANCE = 128
export const DEFAULT_INTENSITY_BALANCE = 128

/** Consecutive failed frame writes before the link is declared lost. */
const WRITE_FAILURE_LIMIT = 5

export interface CoyoteBackendOptions {
  readonly id?: string
  readonly name?: string
  readonly clock: Clock
  readonly transport: BleTransport
  /**
   * Advertised name to scan for. Defaults to the Coyote family name; a second
   * unit can be targeted by a different name (or by powering only that unit
   * during add).
   */
  readonly bleName?: string
  /** Percentage ceiling per channel; becomes the `BF` hardware soft cap. */
  readonly maxPercent: (channelId: CoyoteChannelId) => number
  /** Waveform intensity ceiling per channel, applied to every emitted frame. */
  readonly maxWaveIntensity: (channelId: CoyoteChannelId) => number
  /** 0-255, persisted in the device. Higher makes low frequencies hit harder. */
  readonly frequencyBalance?: number
  /** 0-255, persisted in the device. Higher makes low frequencies sting more. */
  readonly intensityBalance?: number
  readonly frameMs?: number
  readonly plainFrame?: PulseFrame
  readonly onError?: (error: unknown) => void
}

interface CoyoteChannelState {
  /** Strength we want, 0-200. */
  target: number
  /** Strength the box last reported. `-1` until the first report. */
  known: number
  waveform: Waveform | undefined
  cursor: number
}

function freshChannel(): CoyoteChannelState {
  // `known: -1` can never equal a target, so the first frame always asserts an
  // absolute strength and the box cannot keep a previous session's level.
  return { target: 0, known: -1, waveform: undefined, cursor: 0 }
}

export class CoyoteBackend implements DeviceBackend {
  readonly id: string
  readonly name: string
  readonly channels = CHANNELS

  private peripheral: BlePeripheral | undefined
  private notifyOff: (() => void) | undefined
  private disconnectOff: (() => void) | undefined
  private ticker: Timer | undefined
  private readonly state: Record<CoyoteChannelId, CoyoteChannelState> = {
    a: freshChannel(),
    b: freshChannel(),
  }
  private seq = 0
  private pendingSeq: number | undefined
  private writing = false
  private writeChain: Promise<void> = Promise.resolve()
  private writeFailures = 0
  private readonly linkLostListeners = new Set<() => void>()

  constructor(private readonly options: CoyoteBackendOptions) {
    this.id = options.id ?? 'coyote'
    this.name = options.name ?? 'DG-LAB Coyote 3.0'
  }

  /** True once `BF` landed and the frame stream is running. */
  get streaming(): boolean {
    return this.ticker !== undefined && this.peripheral?.connected === true
  }

  async connect(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    for (const id of CHANNEL_IDS) this.state[id] = freshChannel()
    this.seq = 0
    this.pendingSeq = undefined
    this.writeFailures = 0

    const peripheral = await this.options.transport.request({
      name: this.options.bleName ?? COYOTE_BLE_NAME,
      services: [COYOTE_SERVICE, COYOTE_BATTERY_SERVICE],
    }, signal)
    this.peripheral = peripheral
    this.disconnectOff = peripheral.onDisconnect(() => { this.handleLinkLost() })

    try {
      this.notifyOff = await peripheral.subscribe(NOTIFY_REF, data => { this.receive(data) })
      // The ceiling must land before anything can be driven.
      await this.writeBoundsNow()
    } catch (error) {
      await this.teardown()
      throw new SafetyError(
        'NOT_CONNECTED',
        `could not establish the Coyote hardware ceiling: ${error instanceof Error ? error.message : String(error)}; refusing to drive the device without it`,
      )
    }

    const frameMs = this.options.frameMs ?? 100
    this.ticker = this.options.clock.interval(frameMs, () => { this.onTick() })
    // Assert strength 0 immediately rather than waiting a frame.
    this.pushFrame(false)
  }

  // These are `async` on purpose. A method typed `Promise<void>` that throws
  // synchronously hands an uncaught exception to any caller that only attached
  // a `.catch()`, so validation failures must surface as rejections.

  async applyLevel(channelId: string, percent: number): Promise<void> {
    const id = this.requireChannel(channelId)
    this.assertStreaming()
    this.state[id].target = percentToStrength(percent)
  }

  async applyWaveform(channelId: string, waveform: Waveform | undefined): Promise<void> {
    const id = this.requireChannel(channelId)
    this.assertStreaming()
    this.state[id].waveform = waveform
    this.state[id].cursor = 0
  }

  /** Re-assert the persisted soft cap after a human moved a policy bound. */
  async applyBounds(_channelId: string): Promise<void> {
    if (this.peripheral?.connected !== true) return
    await this.writeBoundsNow()
  }

  async stopAll(): Promise<void> {
    for (const id of CHANNEL_IDS) this.state[id].target = 0
    if (this.peripheral?.connected !== true) return
    await this.flushFrame()
  }

  /** Resolve once no frame write is in flight. */
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

  private async writeBoundsNow(): Promise<void> {
    const peripheral = this.peripheral
    if (peripheral === undefined) throw new Error('not connected')
    const frequencyBalance = this.options.frequencyBalance ?? DEFAULT_FREQUENCY_BALANCE
    const intensityBalance = this.options.intensityBalance ?? DEFAULT_INTENSITY_BALANCE
    const data = encodeBF({
      softCapA: percentToStrength(this.options.maxPercent('a')),
      softCapB: percentToStrength(this.options.maxPercent('b')),
      freqBalanceA: frequencyBalance,
      freqBalanceB: frequencyBalance,
      intensityBalanceA: intensityBalance,
      intensityBalanceB: intensityBalance,
    })
    // With response: this one must be known to have landed.
    await peripheral.write(WRITE_REF, data, false)
  }

  private onTick(): void {
    if (this.peripheral?.connected !== true) return
    this.pushFrame(false)
  }

  /** Stream a frame, dropping it if a write is still in flight. */
  private pushFrame(force: boolean): void {
    if (this.writing && !force) return
    this.writeChain = this.deliver(this.composeFrame())
  }

  /** Stream a frame and wait for it, used by stop paths. */
  private async flushFrame(): Promise<void> {
    await this.writeChain.catch(() => {})
    this.writeChain = this.deliver(this.composeFrame())
    await this.writeChain
  }

  private async deliver(data: Uint8Array): Promise<void> {
    const peripheral = this.peripheral
    if (peripheral === undefined) return
    this.writing = true
    try {
      // Without response: a 10 Hz stream must not wait for a GATT ack.
      await peripheral.write(WRITE_REF, data, true)
      this.writeFailures = 0
    } catch (error) {
      this.writeFailures += 1
      this.options.onError?.(error)
      if (this.writeFailures >= WRITE_FAILURE_LIMIT) this.handleLinkLost()
    } finally {
      this.writing = false
    }
  }

  private composeFrame(): Uint8Array {
    const a = this.state.a
    const b = this.state.b
    const changeA = a.target !== a.known
    const changeB = b.target !== b.known
    const seq = changeA || changeB ? this.nextSeq() : 0
    if (seq !== 0) this.pendingSeq = seq

    const slotsA = this.slotsFor('a')
    const slotsB = this.slotsFor('b')
    for (const id of CHANNEL_IDS) {
      const state = this.state[id]
      // Advance only while the channel is actually playing, so a waveform
      // starts from its beginning when output resumes rather than mid-cycle.
      if (state.waveform !== undefined && state.target > 0) state.cursor += 1
    }

    const mode = (change: boolean): StrengthMode => (change ? 'absolute' : 'none')
    return encodeB0({
      seq,
      modeA: mode(changeA),
      modeB: mode(changeB),
      strengthA: changeA ? a.target : 0,
      strengthB: changeB ? b.target : 0,
      freqA: slotsA.freq,
      intensityA: slotsA.intensity,
      freqB: slotsB.freq,
      intensityB: slotsB.intensity,
    })
  }

  private slotsFor(id: CoyoteChannelId): { freq: FrameSlots; intensity: FrameSlots } {
    const state = this.state[id]
    if (state.target <= 0) return { freq: SILENT_FREQ, intensity: SILENT_INTENSITY }
    const source = state.waveform === undefined
      ? (this.options.plainFrame ?? COYOTE_PLAIN_FRAME)
      : frameAt(state.waveform, state.cursor)
    if (source === undefined) return { freq: SILENT_FREQ, intensity: SILENT_INTENSITY }
    const clamped = clampFrameIntensity(source, this.options.maxWaveIntensity(id))
    return { freq: clamped.freq, intensity: clamped.intensity }
  }

  private nextSeq(): number {
    this.seq = this.seq >= MAX_SEQ ? 1 : this.seq + 1
    return this.seq
  }

  private receive(data: Uint8Array): void {
    const message = decodeNotification(data)
    if (message === undefined) return
    const acked = this.pendingSeq !== undefined && message.seq === this.pendingSeq
    if (acked) this.pendingSeq = undefined

    for (const [id, strength] of [['a', message.strengthA], ['b', message.strengthB]] as const) {
      const state = this.state[id]
      state.known = strength
      // An uncommanded report (sequence 0) is the physical wheel or a leftover
      // level. The stream is the only authority on target: the next frame
      // re-asserts the commanded strength rather than following the hand.
    }
  }

  private handleLinkLost(): void {
    if (this.ticker === undefined && this.peripheral === undefined) return
    this.ticker?.cancel()
    this.ticker = undefined
    for (const id of CHANNEL_IDS) this.state[id] = freshChannel()
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

  private requireChannel(channelId: string): CoyoteChannelId {
    if (channelId !== 'a' && channelId !== 'b') {
      throw new SafetyError('UNKNOWN_CHANNEL', `Coyote has channels "a" and "b"; received "${channelId}"`)
    }
    return channelId
  }

  private assertStreaming(): void {
    if (!this.streaming) {
      throw new SafetyError('NOT_CONNECTED', `${this.id} is not streaming; connect it first`)
    }
  }
}
