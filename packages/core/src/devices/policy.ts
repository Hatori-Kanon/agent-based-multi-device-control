/**
 * Human-owned output bounds.
 *
 * There is deliberately no `setByModel`. The model has no tool that reaches
 * this store, so the only way a cap moves is a human action in the UI, which
 * is recorded in the audit trail. Absolute bounds additionally protect against
 * a mis-drag in that UI.
 */

import { SafetyError } from './errors.ts'

/** Ceiling no human input may exceed. */
export const ABSOLUTE_MAX_PERCENT = 100
/**
 * Ceiling for waveform pulse width.
 *
 * 100 is the protocol maximum and corresponds to roughly a 100 µs pulse, which
 * the vendor's own V2 notes flag as the onset of stinging.
 */
export const ABSOLUTE_MAX_WAVE_INTENSITY = 100
/** Longest single command any human may authorise, in seconds. */
export const ABSOLUTE_MAX_DURATION_SEC = 600

/** Caps applied to one channel. */
export interface ChannelPolicy {
  /** Highest percentage the channel may be driven to, 0-100. */
  readonly maxPercent: number
  /**
   * Highest waveform intensity, 0-100.
   *
   * Independent of {@link ChannelPolicy.maxPercent}: that one bounds amplitude,
   * this one bounds pulse width. Only pulse hardware uses it.
   */
  readonly maxWaveIntensity: number
  /** Longest single command, in seconds. */
  readonly maxDurationSec: number
}

/**
 * Conservative starting point.
 *
 * 20% is deliberately low. On hardware with a non-linear encoding it is already
 * a substantial fraction of the real range — one 谜姬 family maps a 20% command
 * onto roughly 44% of the motor's band — and the reference implementation for
 * that family ships the same default after real testing. Raising a cap is one
 * drag in the UI; a first session that surprises someone is not undoable.
 *
 * 80 keeps pulse width clear of the ~100 µs stinging threshold.
 */
export const DEFAULT_CHANNEL_POLICY: ChannelPolicy = {
  maxPercent: 20,
  maxWaveIntensity: 80,
  maxDurationSec: 60,
}

/** Result of a human cap change, shaped for the audit trail. */
export interface PolicyChange {
  readonly deviceId: string
  readonly channelId: string
  readonly previous: ChannelPolicy
  readonly next: ChannelPolicy
}

function isWholeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value)
}

/** Reject a policy that is malformed or outside the absolute bounds. */
export function assertValidPolicy(policy: ChannelPolicy): void {
  if (!isWholeNumber(policy.maxPercent) || policy.maxPercent < 0 || policy.maxPercent > ABSOLUTE_MAX_PERCENT) {
    throw new SafetyError('INVALID_POLICY', `maxPercent must be a whole number from 0 to ${ABSOLUTE_MAX_PERCENT}`)
  }
  if (
    !isWholeNumber(policy.maxWaveIntensity)
    || policy.maxWaveIntensity < 0
    || policy.maxWaveIntensity > ABSOLUTE_MAX_WAVE_INTENSITY
  ) {
    throw new SafetyError('INVALID_POLICY', `maxWaveIntensity must be a whole number from 0 to ${ABSOLUTE_MAX_WAVE_INTENSITY}`)
  }
  if (!isWholeNumber(policy.maxDurationSec) || policy.maxDurationSec <= 0 || policy.maxDurationSec > ABSOLUTE_MAX_DURATION_SEC) {
    throw new SafetyError('INVALID_POLICY', `maxDurationSec must be a whole number from 1 to ${ABSOLUTE_MAX_DURATION_SEC}`)
  }
}

/**
 * Reject a command that policy does not allow.
 *
 * Rejection rather than silent clamping is deliberate: the model should learn
 * the bound from the error text. The emit path clamps as well, so a bypass of
 * this check still cannot exceed the cap.
 */
export function assertLevelWithinPolicy(policy: ChannelPolicy, percent: number, durationSec: number): void {
  if (!isWholeNumber(percent) || percent < 0 || percent > policy.maxPercent) {
    throw new SafetyError('POLICY_PERCENT', `percent must be a whole number from 0 to ${policy.maxPercent} for this channel`)
  }
  if (percent === 0) {
    if (durationSec !== 0) {
      throw new SafetyError('POLICY_DURATION', 'percent 0 stops immediately; omit duration')
    }
    return
  }
  if (!Number.isFinite(durationSec) || durationSec <= 0 || durationSec > policy.maxDurationSec) {
    throw new SafetyError(
      'POLICY_DURATION',
      `durationSec must be greater than 0 and at most ${policy.maxDurationSec} for this channel; indefinite output is not available`,
    )
  }
}

/**
 * Final guard on the emit path. Never raises a value.
 *
 * Non-finite input fails closed to zero rather than to the cap: `NaN` or
 * `Infinity` reaching this point means a calculation went wrong upstream, and
 * a silent jump to maximum output is the worst possible response to a bug.
 */
export function clampPercentToPolicy(policy: ChannelPolicy, percent: number): number {
  if (!Number.isFinite(percent) || percent <= 0) return 0
  return Math.min(policy.maxPercent, Math.round(percent))
}

function key(deviceId: string, channelId: string): string {
  return `${deviceId}\u0000${channelId}`
}

/** Per-channel cap storage with human-only mutation. */
export class PolicyStore {
  private readonly overrides = new Map<string, ChannelPolicy>()

  /** @param defaults - Applied to any channel without an explicit override. */
  constructor(private readonly defaults: ChannelPolicy = DEFAULT_CHANNEL_POLICY) {
    assertValidPolicy(defaults)
  }

  get(deviceId: string, channelId: string): ChannelPolicy {
    return this.overrides.get(key(deviceId, channelId)) ?? this.defaults
  }

  /**
   * Apply a human cap change.
   *
   * @returns Before and after values so the caller can audit the change.
   * @throws SafetyError with code `INVALID_POLICY` when the result is unsafe.
   */
  setByHuman(deviceId: string, channelId: string, patch: Partial<ChannelPolicy>): PolicyChange {
    const previous = this.get(deviceId, channelId)
    const next: ChannelPolicy = {
      maxPercent: patch.maxPercent ?? previous.maxPercent,
      maxWaveIntensity: patch.maxWaveIntensity ?? previous.maxWaveIntensity,
      maxDurationSec: patch.maxDurationSec ?? previous.maxDurationSec,
    }
    assertValidPolicy(next)
    this.overrides.set(key(deviceId, channelId), next)
    return { deviceId, channelId, previous, next }
  }
}
