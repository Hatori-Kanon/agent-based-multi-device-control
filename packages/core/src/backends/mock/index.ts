/**
 * Simulated devices that model both real keep-alive semantics.
 *
 * The distinction matters more than it looks:
 *
 * - **Stateful** (`keepAliveMs: undefined`) models Buttplug. One write and the
 *   hardware holds that level forever. If the host process dies, output
 *   *continues* — this is the failure mode a host-side timer cannot cover.
 * - **Streaming** (`keepAliveMs` set) models Coyote and Ankni JH1. The backend
 *   must refresh the hardware on its own cadence; stop refreshing and output
 *   decays to zero. This is a free hardware dead-man switch.
 *
 * `simulateHostDeath` stops the refresh loop *without* a graceful zero write,
 * which is how the M0 acceptance test proves the difference.
 */

import type { Clock, Timer } from '../../ports/clock.ts'
import type { Channel, DeviceBackend } from '../../devices/types.ts'

/** One transport write, for test assertions. */
export interface MockWrite {
  readonly atMs: number
  readonly channelId: string
  readonly percent: number
}

export interface MockBackendOptions {
  readonly id: string
  readonly name?: string
  /** Defaults to a single `level` channel called `main`. */
  readonly channels?: readonly Channel[]
  readonly clock: Clock
  /**
   * Milliseconds the simulated hardware holds a level without a refresh.
   * Omit for stateful hardware that holds indefinitely.
   */
  readonly keepAliveMs?: number
  /** Cadence of the backend's own refresh loop. Defaults to `keepAliveMs / 2`. */
  readonly refreshMs?: number
  /** Return an error to simulate a transport failure. */
  readonly failOnApply?: (channelId: string, percent: number) => Error | undefined
}

interface ChannelRuntime {
  target: number
  frameLevel: number
  lastFrameAt: number
}

const DEFAULT_CHANNELS: readonly Channel[] = [{ id: 'main', kind: 'level', label: 'Main' }]

export class MockBackend implements DeviceBackend {
  readonly id: string
  readonly name: string
  readonly channels: readonly Channel[]
  /** Every write the registry performed, in order. */
  readonly writes: MockWrite[] = []

  private readonly clock: Clock
  private readonly keepAliveMs: number | undefined
  private readonly refreshMs: number
  private readonly runtime = new Map<string, ChannelRuntime>()
  private refreshTimer: Timer | undefined
  private hostAlive = true
  private connected = false
  closeCount = 0
  stopAllCount = 0

  constructor(private readonly options: MockBackendOptions) {
    this.id = options.id
    this.name = options.name ?? options.id
    this.channels = options.channels ?? DEFAULT_CHANNELS
    this.clock = options.clock
    this.keepAliveMs = options.keepAliveMs
    this.refreshMs = options.refreshMs ?? Math.max(1, Math.floor((options.keepAliveMs ?? 200) / 2))
    for (const channel of this.channels) {
      this.runtime.set(channel.id, { target: 0, frameLevel: 0, lastFrameAt: this.clock.now() })
    }
  }

  /** True for hardware that needs continuous refreshing. */
  get isStreaming(): boolean {
    return this.keepAliveMs !== undefined
  }

  connect(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    this.connected = true
    this.hostAlive = true
    if (this.keepAliveMs !== undefined && this.refreshTimer === undefined) {
      this.refreshTimer = this.clock.interval(this.refreshMs, () => { this.refresh() })
    }
    return Promise.resolve()
  }

  applyLevel(channelId: string, percent: number): Promise<void> {
    const failure = this.options.failOnApply?.(channelId, percent)
    if (failure !== undefined) return Promise.reject(failure)
    const state = this.runtime.get(channelId)
    if (state === undefined) return Promise.reject(new Error(`mock ${this.id} has no channel ${channelId}`))
    this.writes.push({ atMs: this.clock.now(), channelId, percent })
    state.target = percent
    if (this.hostAlive) {
      state.frameLevel = percent
      state.lastFrameAt = this.clock.now()
    }
    return Promise.resolve()
  }

  stopAll(): Promise<void> {
    this.stopAllCount += 1
    for (const [channelId, state] of this.runtime) {
      if (state.target !== 0) this.writes.push({ atMs: this.clock.now(), channelId, percent: 0 })
      state.target = 0
      state.frameLevel = 0
      state.lastFrameAt = this.clock.now()
    }
    return Promise.resolve()
  }

  async close(): Promise<void> {
    this.closeCount += 1
    await this.stopAll()
    this.refreshTimer?.cancel()
    this.refreshTimer = undefined
    this.connected = false
    return Promise.resolve()
  }

  /** Target level most recently written by the registry. */
  appliedLevel(channelId: string): number {
    return this.runtime.get(channelId)?.target ?? 0
  }

  /**
   * What the simulated hardware is actually outputting.
   *
   * For streaming hardware this decays to zero once the refresh loop stops,
   * which is the property the Coyote 100 ms frame stream gives us for free.
   */
  deviceLevel(channelId: string): number {
    const state = this.runtime.get(channelId)
    if (state === undefined) return 0
    if (this.keepAliveMs === undefined) return state.target
    if (!this.hostAlive) {
      return this.clock.now() - state.lastFrameAt > this.keepAliveMs ? 0 : state.frameLevel
    }
    return state.frameLevel
  }

  /** True when any channel is still producing output at the hardware. */
  get outputting(): boolean {
    return this.channels.some(channel => this.deviceLevel(channel.id) > 0)
  }

  /**
   * Model an abrupt host process death: the refresh loop stops and no
   * graceful zero is written.
   */
  simulateHostDeath(): void {
    this.hostAlive = false
    this.refreshTimer?.cancel()
    this.refreshTimer = undefined
  }

  private refresh(): void {
    if (!this.hostAlive || !this.connected) return
    const now = this.clock.now()
    for (const state of this.runtime.values()) {
      state.frameLevel = state.target
      state.lastFrameAt = now
    }
  }
}
