/**
 * The safety runtime.
 *
 * Everything a model can do to a physical device passes through here, in this
 * order: lock check, channel resolution, policy validation, effect scheduling,
 * per-device serialised write with a final clamp, audit record.
 *
 * Two design notes worth knowing before editing:
 *
 * - `setLevel` is sugar over a `steady` envelope, so there is exactly **one**
 *   scheduling path and one generation-token mechanism. A separate auto-stop
 *   timer for static levels would duplicate the hardest logic in the package.
 * - After an emergency stop the registry enters `locked`. Writes already
 *   queued become no-ops for any positive level, while zero writes still pass,
 *   so a stop can never be starved by output changes queued ahead of it.
 */

import type { AuditActor, AuditLog } from './audit.ts'
import { EffectRunner, assertValidEnvelope, clampEnvelopeToCap, type EffectSnapshot, type Envelope } from './effect.ts'
import { SafetyError } from './errors.ts'
import { assertLevelWithinPolicy, clampPercentToPolicy, type ChannelPolicy, type PolicyStore } from './policy.ts'
import { SerialQueue } from './queue.ts'
import type { Channel, ChannelKind, DeviceBackend, DeviceLifecycle } from './types.ts'
import type { Clock } from '../ports/clock.ts'
import type { WaveformLibrary } from '../waveform/library.ts'
import type { Waveform } from '../waveform/types.ts'

/** A static level held for a bounded time. */
export interface LevelCommand {
  readonly deviceId: string
  readonly channelId: string
  /** 0-100; 0 stops the channel. */
  readonly percent: number
  /** Required for any positive level. Indefinite output is not available. */
  readonly durationSec?: number
}

/** A background envelope on one channel. */
export interface PatternCommand {
  readonly deviceId: string
  readonly channelId: string
  readonly envelope: Envelope
  readonly durationSec: number
  /**
   * Waveform to play under the envelope.
   *
   * Only meaningful on a channel that reports `supportsWaveform`. Omitting it
   * leaves whatever waveform is already selected in place, so an agent can
   * change amplitude shape without disturbing texture.
   */
  readonly waveformId?: string
}

export interface ChannelSnapshot {
  readonly id: string
  readonly kind: ChannelKind
  readonly label: string
  readonly supportsWaveform: boolean
  /**
   * Percentage of full output the smallest non-zero command already produces,
   * or 0 when the mapping is linear from zero. A percentage is not comparable
   * across backends; this is how much of that is visible.
   */
  readonly outputFloorPercent: number
  /** Level most recently written to the transport. */
  readonly percent: number
  readonly maxPercent: number
  readonly maxWaveIntensity: number
  readonly maxDurationSec: number
  readonly effect: EffectSnapshot | undefined
  readonly waveform: { readonly id: string; readonly name: string } | undefined
}

export interface DeviceSnapshot {
  readonly id: string
  readonly name: string
  readonly lifecycle: DeviceLifecycle
  /** True for hub-style backends whose device set can change on demand. */
  readonly canScan: boolean
  readonly channels: readonly ChannelSnapshot[]
}

export interface RegistrySnapshot {
  readonly locked: boolean
  readonly lockedReason: string | undefined
  readonly devices: readonly DeviceSnapshot[]
}

export interface DeviceRegistryOptions {
  readonly clock: Clock
  readonly audit: AuditLog
  readonly policy: PolicyStore
  /** Resolves waveform ids for pulse-capable channels. */
  readonly waveforms?: WaveformLibrary
  /** Receives transport and shutdown failures for operator display. */
  readonly onError: (error: unknown) => void
  readonly tickMs?: number
  readonly random?: () => number
}

interface ChannelState {
  /**
   * Mutable because some backends only learn their real channel set from the
   * handshake — a MonsterParty toy reveals whether it has a separate suction
   * motor in its `pid`, long after `register`.
   */
  channel: Channel
  readonly runner: EffectRunner
  percent: number
  waveform: Waveform | undefined
}

interface DeviceState {
  readonly backend: DeviceBackend
  readonly queue: SerialQueue
  readonly channels: Map<string, ChannelState>
  lifecycle: DeviceLifecycle
  linkLostOff: (() => void) | undefined
  channelsChangedOff: (() => void) | undefined
}

function describe(error: unknown): string {
  if (error instanceof SafetyError) return `${error.code}: ${error.message}`
  return error instanceof Error ? error.message : String(error)
}

export class DeviceRegistry {
  private readonly devices = new Map<string, DeviceState>()
  private locked = false
  private lockedReason: string | undefined
  private shuttingDown = false

  constructor(private readonly options: DeviceRegistryOptions) {}

  get isLocked(): boolean {
    return this.locked
  }

  /** Add a backend. Its channels become addressable after {@link connect}. */
  register(backend: DeviceBackend): void {
    if (this.devices.has(backend.id)) {
      throw new SafetyError('INVALID_POLICY', `device id is already registered: ${backend.id}`)
    }
    const channels = new Map<string, ChannelState>()
    for (const channel of backend.channels) {
      channels.set(channel.id, {
        channel,
        runner: this.createRunner(backend.id, channel.id),
        percent: 0,
        waveform: undefined,
      })
    }
    const state: DeviceState = {
      backend,
      queue: new SerialQueue(),
      channels,
      lifecycle: 'disconnected',
      linkLostOff: undefined,
      channelsChangedOff: undefined,
    }
    this.devices.set(backend.id, state)
    state.linkLostOff = backend.onLinkLost?.(() => { this.handleLinkLost(state) })
    // A hub-style backend gains and loses devices while connected.
    state.channelsChangedOff = backend.onChannelsChanged?.(() => {
      if (state.lifecycle !== 'ready') return
      const before = [...state.channels.keys()]
      this.syncChannels(state)
      const after = [...state.channels.keys()]
      if (before.length === after.length && before.every((id, index) => id === after[index])) return
      void this.options.audit.record({
        actor: 'system',
        action: 'channels_changed',
        result: 'ok',
        detail: { deviceId: backend.id, channels: after },
      })
    })
  }

  /**
   * Run bounded discovery on a hub-style backend, then adopt whatever appeared.
   *
   * Refused while locked: discovery is harmless, but a scan that quietly
   * repopulates channels during an emergency stop invites confusion.
   */
  async scan(actor: AuditActor, deviceId: string, durationMs: number, signal: AbortSignal): Promise<void> {
    const detail = { deviceId, durationMs }
    try {
      this.assertRunning()
      if (this.locked) {
        throw new SafetyError('LOCKED', `output is locked by a human (${this.lockedReason ?? 'emergency stop'}); a human must clear it in the app`)
      }
      const device = this.requireDevice(deviceId)
      if (device.backend.scan === undefined) {
        throw new SafetyError('WRONG_CHANNEL_KIND', `${deviceId} has nothing to scan for; it serves a single device`)
      }
      if (device.lifecycle !== 'ready') {
        throw new SafetyError('NOT_CONNECTED', `device ${deviceId} is ${device.lifecycle}; connect it first`)
      }
      if (!Number.isFinite(durationMs) || durationMs <= 0 || durationMs > 60_000) {
        throw new SafetyError('POLICY_DURATION', 'scan duration must be greater than 0 and at most 60000 milliseconds')
      }
      await device.queue.enqueue(() => device.backend.scan!(durationMs, signal))
      this.syncChannels(device)
    } catch (error) {
      await this.recordFailure(actor, 'scan', detail, error)
      throw error
    }
    await this.options.audit.record({
      actor,
      action: 'scan',
      result: 'ok',
      detail: { ...detail, channels: [...this.requireDevice(deviceId).channels.keys()] },
    })
  }

  /**
   * Reconcile the channel map with what the backend now reports.
   *
   * Existing channels keep their runner and recorded level so a reconnect does
   * not disturb anything in flight; channels that disappeared have their effect
   * cancelled before removal.
   */
  private syncChannels(device: DeviceState): void {
    const present = new Set<string>()
    for (const channel of device.backend.channels) {
      present.add(channel.id)
      const existing = device.channels.get(channel.id)
      if (existing === undefined) {
        device.channels.set(channel.id, {
          channel,
          runner: this.createRunner(device.backend.id, channel.id),
          percent: 0,
          waveform: undefined,
        })
      } else {
        existing.channel = channel
      }
    }
    for (const [id, state] of [...device.channels]) {
      if (present.has(id)) continue
      state.runner.cancel()
      device.channels.delete(id)
    }
  }

  /**
   * React to transport loss.
   *
   * Output has already stopped — the link is gone — so the recorded level goes
   * to zero and effects are cancelled rather than left running against nothing.
   */
  private handleLinkLost(device: DeviceState): void {
    if (device.lifecycle === 'disconnected') return
    device.lifecycle = 'failed'
    for (const state of device.channels.values()) {
      state.runner.cancel()
      state.percent = 0
      state.waveform = undefined
    }
    void this.options.audit.record({
      actor: 'system',
      action: 'link_lost',
      result: 'error',
      detail: { deviceId: device.backend.id },
      reason: 'transport disconnected; output has stopped',
    })
  }

  /**
   * Send one raw frame to a backend's transport, bypassing channel semantics.
   *
   * Human-only protocol debugging: validates a frame we do not yet know how to
   * map onto channels. Locked runtime and malformed hex refuse; the attempt is
   * audited either way.
   */
  async rawWrite(actor: AuditActor, deviceId: string, hex: string, channel: 'live' | 'setup' = 'live'): Promise<void> {
    const detail = { deviceId, hex, channel }
    const trimmed = hex.trim()
    try {
      if (trimmed.length === 0 || trimmed.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(trimmed)) {
        throw new SafetyError('POLICY_ENVELOPE', 'raw frame must be non-empty even-length hex')
      }
      const bytes = Uint8Array.from(trimmed.match(/../g)!.map(part => Number.parseInt(part, 16)))
      this.assertRunning()
      if (this.locked) {
        throw new SafetyError('LOCKED', `output is locked by a human (${this.lockedReason ?? 'emergency stop'}); a human must clear it in the app`)
      }
      const device = this.requireDevice(deviceId)
      if (device.lifecycle !== 'ready') {
        throw new SafetyError('NOT_CONNECTED', `device ${deviceId} is ${device.lifecycle}; connect it first`)
      }
      if (device.backend.writeRaw === undefined) {
        throw new SafetyError('WRONG_CHANNEL_KIND', `${deviceId} has no raw frame channel`)
      }
      await device.queue.enqueue(() => device.backend.writeRaw!(bytes, channel), true)
    } catch (error) {
      await this.recordFailure(actor, 'raw_write', detail, error)
      throw error
    }
    await this.options.audit.record({ actor, action: 'raw_write', result: 'ok', detail })
  }

  /** Drop a backend from the runtime: stop output, close the transport, remove it. */
  async unregister(deviceId: string): Promise<void> {
    const device = this.devices.get(deviceId)
    if (device === undefined) {
      throw new SafetyError('UNKNOWN_DEVICE', `no such device: ${deviceId}`)
    }
    device.linkLostOff?.()
    device.linkLostOff = undefined
    device.channelsChangedOff?.()
    device.channelsChangedOff = undefined
    for (const state of device.channels.values()) {
      state.runner.cancel()
      state.percent = 0
      state.waveform = undefined
    }
    try {
      await device.queue.enqueue(() => device.backend.close(), true)
    } finally {
      this.devices.delete(deviceId)
    }
    await this.options.audit.record({
      actor: 'human',
      action: 'device_removed',
      result: 'ok',
      detail: { deviceId },
    })
  }

  async connect(deviceId: string, signal: AbortSignal): Promise<void> {
    this.assertRunning()
    const device = this.requireDevice(deviceId)
    device.lifecycle = 'connecting'
    try {
      await device.queue.enqueue(() => device.backend.connect(signal))
      // A backend may only discover its real channel set during the handshake.
      this.syncChannels(device)
      device.lifecycle = 'ready'
      await this.options.audit.record({
        actor: 'system',
        action: 'connect',
        result: 'ok',
        detail: { deviceId, channels: [...device.channels.keys()] },
      })
    } catch (error) {
      device.lifecycle = 'failed'
      await this.options.audit.record({
        actor: 'system',
        action: 'connect',
        result: 'error',
        detail: { deviceId },
        reason: describe(error),
      })
      throw error
    }
  }

  /** Hold one level for a bounded time. `percent: 0` stops the channel. */
  async setLevel(actor: AuditActor, command: LevelCommand): Promise<void> {
    const detail = { ...command }
    if (command.percent === 0) {
      await this.stop(actor, command.deviceId, command.channelId)
      return
    }
    try {
      const policy = this.prepare(command.deviceId, command.channelId)
      const durationSec = command.durationSec ?? 0
      // Validate as a level first so the refusal names percent or duration
      // rather than an envelope field the caller never wrote.
      assertLevelWithinPolicy(policy, command.percent, durationSec)
      const envelope: Envelope = {
        preset: 'steady',
        minPercent: command.percent,
        maxPercent: command.percent,
        periodMs: 1_000,
        jitter: 0,
      }
      assertValidEnvelope(envelope, policy.maxPercent)
      this.channelState(command.deviceId, command.channelId).runner.start(envelope, durationSec * 1_000)
    } catch (error) {
      await this.recordFailure(actor, 'set_level', detail, error)
      throw error
    }
    await this.options.audit.record({ actor, action: 'set_level', result: 'ok', detail })
  }

  /** Run a background envelope on one channel, replacing any effect there. */
  async runPattern(actor: AuditActor, command: PatternCommand): Promise<void> {
    // Author content plays inside the cap: an envelope that asks for more runs
    // at the cap (the human's boundary), while malformed shapes still refuse.
    let envelope = command.envelope
    const detail: Record<string, unknown> = {
      deviceId: command.deviceId,
      channelId: command.channelId,
      envelope: { ...envelope },
      durationSec: command.durationSec,
      ...(command.waveformId === undefined ? {} : { waveformId: command.waveformId }),
    }
    try {
      const policy = this.prepare(command.deviceId, command.channelId)
      this.assertDuration(command.durationSec, policy)
      envelope = clampEnvelopeToCap(envelope, policy.maxPercent)
      detail.envelope = { ...envelope }
      assertValidEnvelope(envelope, policy.maxPercent)
      if (command.waveformId !== undefined) {
        await this.selectWaveform(command.deviceId, command.channelId, command.waveformId)
        detail.waveformIntensityCap = policy.maxWaveIntensity
      }
      this.channelState(command.deviceId, command.channelId).runner.start(envelope, command.durationSec * 1_000)
    } catch (error) {
      await this.recordFailure(actor, 'run_pattern', detail, error)
      throw error
    }
    await this.options.audit.record({ actor, action: 'run_pattern', result: 'ok', detail })
  }

  /**
   * Choose the waveform a channel plays, or clear it with `undefined`.
   *
   * Separate from {@link runPattern} so texture can be changed without
   * restarting the amplitude envelope, and so the UI has an explicit way to
   * clear one.
   */
  async setWaveform(actor: AuditActor, deviceId: string, channelId: string, waveformId?: string): Promise<void> {
    const detail = { deviceId, channelId, waveformId: waveformId ?? null }
    try {
      this.prepare(deviceId, channelId)
      await this.selectWaveform(deviceId, channelId, waveformId)
    } catch (error) {
      await this.recordFailure(actor, 'set_waveform', detail, error)
      throw error
    }
    await this.options.audit.record({ actor, action: 'set_waveform', result: 'ok', detail })
  }

  private async selectWaveform(deviceId: string, channelId: string, waveformId: string | undefined): Promise<void> {
    const device = this.requireDevice(deviceId)
    const state = this.channelState(deviceId, channelId)
    if (state.channel.supportsWaveform !== true) {
      throw new SafetyError(
        'WRONG_CHANNEL_KIND',
        `channel ${channelId} on ${deviceId} has no waveform stage; only pulse hardware does`,
      )
    }
    let waveform: Waveform | undefined
    if (waveformId !== undefined) {
      const library = this.options.waveforms
      if (library === undefined) {
        throw new SafetyError('UNKNOWN_WAVEFORM', 'no waveform library is configured for this runtime')
      }
      waveform = library.require(waveformId)
    }
    await device.queue.enqueue(async () => {
      await device.backend.applyWaveform?.(channelId, waveform)
      state.waveform = waveform
    })
  }

  /**
   * Stop one channel, one device, or everything.
   *
   * Stops are permitted while locked — that is the point of a stop.
   */
  async stop(actor: AuditActor, deviceId?: string, channelId?: string): Promise<void> {
    const detail = {
      deviceId: deviceId ?? 'all',
      channelId: channelId ?? 'all',
    }
    let targets: { device: DeviceState; state: ChannelState }[]
    try {
      targets = this.resolveTargets(deviceId, channelId)
    } catch (error) {
      await this.recordFailure(actor, 'stop', detail, error)
      throw error
    }
    for (const { state } of targets) state.runner.cancel()
    await Promise.all(targets.map(async ({ device, state }) => {
      try {
        await this.write(device, state.channel.id, 0, true)
      } catch (error) {
        this.options.onError(error)
      }
    }))
    await this.options.audit.record({ actor, action: 'stop', result: 'ok', detail })
  }

  /**
   * Human emergency stop. Cancels every effect, drives output to zero, and
   * latches `locked` until a human clears it.
   *
   * The audit record is written before the transport work so that the event
   * survives even if a link is wedged.
   */
  async emergencyStop(source: string): Promise<void> {
    this.locked = true
    this.lockedReason = `emergency stop from ${source}`
    for (const device of this.devices.values()) {
      for (const state of device.channels.values()) state.runner.cancel()
    }
    await this.options.audit.record({ actor: 'human', action: 'panic', result: 'ok', detail: { source } })
    await Promise.all([...this.devices.values()].map(async device => {
      try {
        await device.queue.enqueue(async () => {
          await device.backend.stopAll()
          for (const state of device.channels.values()) state.percent = 0
        }, true)
      } catch (error) {
        this.options.onError(error)
      }
    }))
  }

  /** Clear the emergency-stop latch. Only a human may call this. */
  async unlock(_actor: 'human', note?: string): Promise<void> {
    this.locked = false
    this.lockedReason = undefined
    await this.options.audit.record({
      actor: 'human',
      action: 'unlock',
      result: 'ok',
      ...(note === undefined ? {} : { detail: { note } }),
    })
  }

  /** Apply a human cap change and record the before/after values. */
  async setPolicyByHuman(deviceId: string, channelId: string, patch: Partial<ChannelPolicy>): Promise<void> {
    let change
    try {
      change = this.options.policy.setByHuman(deviceId, channelId, patch)
    } catch (error) {
      await this.recordFailure('human', 'policy_change', { deviceId, channelId, patch }, error)
      throw error
    }
    await this.options.audit.record({
      actor: 'human',
      action: 'policy_change',
      result: 'ok',
      detail: { deviceId, channelId, previous: change.previous, next: change.next },
    })
    await this.applyPolicyChangeNow(deviceId, channelId)
  }

  /**
   * Make a cap change take effect immediately rather than at the next value
   * change.
   *
   * A running `steady` effect deduplicates its writes, so lowering a cap would
   * otherwise leave the device above the new bound indefinitely. Invalidating
   * the runner covers a raised cap on the next tick; the priority re-write
   * covers a lowered cap right now, clamped by {@link write}.
   */
  private async applyPolicyChangeNow(deviceId: string, channelId: string): Promise<void> {
    const device = this.devices.get(deviceId)
    const state = device?.channels.get(channelId)
    if (device === undefined || state === undefined) return
    state.runner.invalidate()
    // Hardware-enforced ceilings must be re-asserted, not just re-checked in
    // software: a Coyote keeps its `BF` soft cap across power cycles.
    if (device.backend.applyBounds !== undefined && device.lifecycle === 'ready') {
      try {
        await device.queue.enqueue(() => device.backend.applyBounds!(channelId), true)
      } catch (error) {
        this.options.onError(error)
      }
    }
    if (state.percent <= 0) return
    try {
      await this.write(device, channelId, state.percent, true)
    } catch (error) {
      this.options.onError(error)
    }
  }

  snapshot(): RegistrySnapshot {
    return {
      locked: this.locked,
      lockedReason: this.lockedReason,
      devices: [...this.devices.values()].map(device => ({
        id: device.backend.id,
        name: device.backend.name,
        lifecycle: device.lifecycle,
        canScan: device.backend.scan !== undefined,
        channels: [...device.channels.values()].map(state => {
          const policy = this.options.policy.get(device.backend.id, state.channel.id)
          return {
            id: state.channel.id,
            kind: state.channel.kind,
            label: state.channel.label,
            supportsWaveform: state.channel.supportsWaveform === true,
            outputFloorPercent: state.channel.outputFloorPercent ?? 0,
            percent: state.percent,
            maxPercent: policy.maxPercent,
            maxWaveIntensity: policy.maxWaveIntensity,
            maxDurationSec: policy.maxDurationSec,
            effect: state.runner.snapshot(),
            waveform: state.waveform === undefined
              ? undefined
              : { id: state.waveform.id, name: state.waveform.name },
          }
        }),
      })),
    }
  }

  /** Resolve once every device queue has drained. Used by tests and shutdown. */
  async settled(): Promise<void> {
    await Promise.all([...this.devices.values()].map(device => device.queue.idle()))
  }

  /** Stop everything, close every transport, and refuse further commands. */
  async shutdown(): Promise<void> {
    if (this.shuttingDown) return
    this.shuttingDown = true
    await this.emergencyStop('shutdown')
    await Promise.all([...this.devices.values()].map(async device => {
      device.linkLostOff?.()
      device.linkLostOff = undefined
      device.channelsChangedOff?.()
      device.channelsChangedOff = undefined
      try {
        await device.queue.enqueue(() => device.backend.close(), true)
      } catch (error) {
        this.options.onError(error)
      }
      device.lifecycle = 'disconnected'
    }))
    await this.options.audit.record({ actor: 'system', action: 'shutdown', result: 'ok' })
  }

  private createRunner(deviceId: string, channelId: string): EffectRunner {
    return new EffectRunner({
      clock: this.options.clock,
      emit: async percent => {
        const device = this.devices.get(deviceId)
        if (device === undefined) return
        await this.write(device, channelId, percent, false)
      },
      onError: error => {
        this.options.onError(error)
        void this.options.audit.record({
          actor: 'system',
          action: 'emit_failed',
          result: 'error',
          detail: { deviceId, channelId },
          reason: describe(error),
        })
      },
      onFinished: () => {
        void this.options.audit.record({
          actor: 'system',
          action: 'effect_finished',
          result: 'ok',
          detail: { deviceId, channelId },
        })
      },
      ...(this.options.tickMs === undefined ? {} : { tickMs: this.options.tickMs }),
      ...(this.options.random === undefined ? {} : { random: this.options.random }),
    })
  }

  /** The only path to the transport. Serialised per device and clamped last. */
  private write(device: DeviceState, channelId: string, percent: number, priority: boolean): Promise<void> {
    return device.queue.enqueue(async () => {
      // A write queued before the latch must not resurrect output afterwards.
      if (this.locked && percent > 0) return
      const state = device.channels.get(channelId)
      if (state === undefined) return
      const policy = this.options.policy.get(device.backend.id, channelId)
      const clamped = clampPercentToPolicy(policy, percent)
      await device.backend.applyLevel(channelId, clamped)
      state.percent = clamped
    }, priority)
  }

  /** Shared entry checks for every model-issued output command. */
  private prepare(deviceId: string, channelId: string): ChannelPolicy {
    this.assertRunning()
    if (this.locked) {
      throw new SafetyError('LOCKED', `output is locked by a human (${this.lockedReason ?? 'emergency stop'}); a human must clear it in the app`)
    }
    const device = this.requireDevice(deviceId)
    const state = device.channels.get(channelId)
    if (state === undefined) {
      throw new SafetyError('UNKNOWN_CHANNEL', `device ${deviceId} has no channel ${channelId}`)
    }
    if (state.channel.kind !== 'level') {
      throw new SafetyError('WRONG_CHANNEL_KIND', `channel ${channelId} is a ${state.channel.kind} channel and does not accept levels`)
    }
    if (device.lifecycle !== 'ready') {
      throw new SafetyError('NOT_CONNECTED', `device ${deviceId} is ${device.lifecycle}; connect it first`)
    }
    return this.options.policy.get(deviceId, channelId)
  }

  private assertDuration(durationSec: number, policy: ChannelPolicy): void {
    if (!Number.isFinite(durationSec) || durationSec <= 0 || durationSec > policy.maxDurationSec) {
      throw new SafetyError(
        'POLICY_DURATION',
        `durationSec must be greater than 0 and at most ${policy.maxDurationSec} for this channel; indefinite output is not available`,
      )
    }
  }

  private assertRunning(): void {
    if (this.shuttingDown) throw new SafetyError('SHUTTING_DOWN', 'the device runtime is shutting down')
  }

  private requireDevice(deviceId: string): DeviceState {
    const device = this.devices.get(deviceId)
    if (device === undefined) throw new SafetyError('UNKNOWN_DEVICE', `no such device: ${deviceId}`)
    return device
  }

  private channelState(deviceId: string, channelId: string): ChannelState {
    const state = this.requireDevice(deviceId).channels.get(channelId)
    if (state === undefined) throw new SafetyError('UNKNOWN_CHANNEL', `device ${deviceId} has no channel ${channelId}`)
    return state
  }

  private resolveTargets(deviceId?: string, channelId?: string): { device: DeviceState; state: ChannelState }[] {
    const devices = deviceId === undefined ? [...this.devices.values()] : [this.requireDevice(deviceId)]
    const targets: { device: DeviceState; state: ChannelState }[] = []
    for (const device of devices) {
      if (channelId === undefined) {
        for (const state of device.channels.values()) targets.push({ device, state })
        continue
      }
      const state = device.channels.get(channelId)
      if (state === undefined) {
        throw new SafetyError('UNKNOWN_CHANNEL', `device ${device.backend.id} has no channel ${channelId}`)
      }
      targets.push({ device, state })
    }
    return targets
  }

  private async recordFailure(
    actor: AuditActor,
    action: string,
    detail: Readonly<Record<string, unknown>>,
    error: unknown,
  ): Promise<void> {
    await this.options.audit.record({
      actor,
      action,
      result: error instanceof SafetyError ? 'rejected' : 'error',
      detail,
      reason: describe(error),
    })
  }
}
