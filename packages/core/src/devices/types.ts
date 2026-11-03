/**
 * The contract every device backend implements.
 *
 * One rule dominates this interface: **keep-alive belongs to the backend, not
 * to the caller.** `applyLevel` sets a target; a streaming device (Coyote
 * writes every 100 ms, Ankni JH1 resends every 500 ms) must keep that target
 * alive on its own, while a stateful device (Buttplug) simply writes once.
 * The effect scheduler above only answers "what is the target right now".
 */

import type { Waveform } from '../waveform/types.ts'

/**
 * What a channel accepts.
 *
 * `level` is a 0-100 scalar that holds until changed. `motion` is a positional
 * target reached over a travel time; only multi-axis hardware uses it and no
 * backend implements it before M6.
 */
export type ChannelKind = 'level' | 'motion'

/** One independently addressable output on a device. */
export interface Channel {
  readonly id: string
  readonly kind: ChannelKind
  /** Human-readable name, also shown to the model, e.g. "A 通道". */
  readonly label: string
  /**
   * Whether the channel accepts a waveform alongside its level.
   *
   * On pulse hardware the two are orthogonal: level is amplitude, waveform is
   * texture. Scalar hardware such as a vibrator has no waveform concept.
   */
  readonly supportsWaveform?: boolean

  /**
   * Percentage of full output that the *smallest non-zero* command already
   * produces, when the hardware has such a floor.
   *
   * Some vendors map the user-visible 0-100 onto a motor's *usable* band, so a
   * 1% command is not 1% of sensation — one 谜姬 family lands at roughly 31% of
   * range. Publishing the floor keeps the model from probing 1, 2, 3 percent
   * expecting fine control, and makes explicit that **a percentage is not
   * comparable across backends**.
   *
   * Omitted or 0 means the mapping is linear from zero.
   */
  readonly outputFloorPercent?: number

  /**
   * Narrative region id this channel drives, e.g. `chest` (`M2-实施计划.md`
   * §4.6.3).
   *
   * Packs speak regions, never device ids, so this is the join between an
   * intent and the hardware it reaches. A backend may declare a sensible
   * default here (a dual-channel Coyote is usually not one region), but most
   * hardware is unlabeled: a human assigns the label in the app and the
   * registry's `RegionStore` override wins over this field. Absent means "no
   * region", which makes the channel only reachable by `whole-body` intents.
   */
  readonly region?: string
}

/** Connection state of a backend as observed by the registry. */
export type DeviceLifecycle = 'disconnected' | 'connecting' | 'ready' | 'failed'

export interface DeviceBackend {
  /** Stable identity used in commands and the audit trail. */
  readonly id: string
  readonly name: string
  readonly channels: readonly Channel[]
  /**
   * Platform identity of the connected unit (`BluetoothDevice.id`), when the
   * transport reports one.
   *
   * The host persists this to keep a device card bound to the same physical
   * unit when several units share one advertised name. Backends that do not
   * connect over Web Bluetooth leave it `undefined`.
   */
  readonly platformDeviceId: string | undefined

  /** Establish the transport and reach a controllable state. */
  connect(signal: AbortSignal): Promise<void>

  /**
   * Set a channel's target level.
   *
   * @param percent - Already validated and clamped against policy by the
   *   registry. Backends may clamp again but must not raise the value.
   */
  applyLevel(channelId: string, percent: number, signal?: AbortSignal): Promise<void>

  /** Drive every channel to zero as directly as the transport allows. */
  stopAll(): Promise<void>

  /**
   * Select the waveform a channel plays under its level.
   *
   * Implemented only by backends whose channels report `supportsWaveform`.
   * Passing `undefined` returns the channel to plain output.
   */
  applyWaveform?(channelId: string, waveform: Waveform | undefined): Promise<void>

  /**
   * Re-assert hardware-enforced bounds.
   *
   * Called after a human moves a cap. A Coyote persists its `BF` soft cap
   * across power cycles and never acknowledges it, so a cap change that does
   * not reach the device would leave the old ceiling silently in force.
   */
  applyBounds?(channelId: string): Promise<void>

  /**
   * Observe transport loss, so the registry can mark the device unavailable
   * instead of accepting commands into a void.
   *
   * @returns A function that removes the listener.
   */
  onLinkLost?(listener: () => void): () => void

  /**
   * Observe a change to {@link DeviceBackend.channels}.
   *
   * Needed by backends that front a whole hub rather than one toy: an Intiface
   * server gains and loses devices while connected, so its channel set is not
   * fixed at connect time.
   */
  onChannelsChanged?(listener: () => void): () => void

  /**
   * Run bounded discovery.
   *
   * Only hub-style backends implement this. A single-device backend finds its
   * one toy during {@link DeviceBackend.connect} and has nothing to scan for.
   */
  scan?(durationMs: number, signal: AbortSignal): Promise<void>

  /**
   * Send one raw frame to the transport, bypassing channel semantics.
   *
   * Human-only protocol debugging: a frame we do not yet know how to map onto
   * channels can be validated on the real device. `channel` picks the path:
   * 'live' (fire-and-forget stream) or 'setup' (acked command channel).
   * Audited like every other human control action.
   */
  writeRaw?(data: Uint8Array, channel?: 'live' | 'setup'): Promise<void>

  /** Stop output and release the transport. */
  close(): Promise<void>
}
