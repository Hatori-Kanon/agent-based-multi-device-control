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

/** Session consent ceiling: no extra restriction until a human narrows it. */
export const DEFAULT_SESSION_CEILING = 100

/**
 * Persisted state of a {@link PolicyStore}.
 *
 * Deliberately excludes the defaults: a file written by an older build keeps
 * working after the defaults change, and a corrupted file cannot silently
 * widen every channel at once.
 */
export interface PolicySnapshot {
  /** Explicit per-channel overrides, keyed `device:channel`. */
  readonly channels: Readonly<Record<string, ChannelPolicy>>
  /** Human consent ceiling for the session, 0-100 (see the D4 decision). */
  readonly sessionCeiling: number
}

/** Version stamped into `state/policy.json`. */
export const POLICY_SNAPSHOT_VERSION = 1

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
  private sessionCeiling = DEFAULT_SESSION_CEILING

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

  /** Current session consent ceiling, 0-100. */
  ceiling(): number {
    return this.sessionCeiling
  }

  /**
   * Narrow (or release) the session ceiling.
   *
   * Human-only: there is no `setSessionCeilingByModel`, and no engine or
   * content-pack call site may reach this method — that is the D4 boundary.
   */
  setSessionCeilingByHuman(percent: number): { readonly previous: number; readonly next: number } {
    assertCeiling(percent)
    const previous = this.sessionCeiling
    this.sessionCeiling = percent
    return { previous, next: percent }
  }

  /**
   * Policy actually in force: the channel cap further bounded by the session
   * ceiling.
   *
   * The emit path and the Coyote `BF` sync read this instead of
   * {@link PolicyStore.get}, so `BF <= X` holds by construction.
   */
  effective(deviceId: string, channelId: string): ChannelPolicy {
    const base = this.get(deviceId, channelId)
    return { ...base, maxPercent: Math.min(base.maxPercent, this.sessionCeiling) }
  }

  /** Serializable state for `state/policy.json`. Sorted so writes are stable. */
  snapshot(): PolicySnapshot {
    const channels: Record<string, ChannelPolicy> = {}
    for (const internal of [...this.overrides.keys()].sort()) {
      channels[internal.replace('\u0000', ':')] = { ...this.overrides.get(internal)! }
    }
    return { channels, sessionCeiling: this.sessionCeiling }
  }

  /**
   * Restore a previously persisted snapshot.
   *
   * Validates everything first and commits atomically: a file with one unsafe
   * entry restores nothing, so a hand-edited cap cannot half-apply.
   *
   * @throws SafetyError with code `INVALID_POLICY`.
   */
  restore(snapshot: PolicySnapshot): void {
    const next = new Map<string, ChannelPolicy>()
    for (const [encoded, policy] of Object.entries(snapshot.channels)) {
      const decoded = decodeSnapshotKey(encoded)
      if (decoded === undefined) {
        throw new SafetyError('INVALID_POLICY', `policy snapshot key '${encoded}' must look like device:channel`)
      }
      assertValidPolicy(policy)
      next.set(key(decoded.deviceId, decoded.channelId), { ...policy })
    }
    assertCeiling(snapshot.sessionCeiling)
    this.overrides.clear()
    for (const [internal, policy] of next) this.overrides.set(internal, policy)
    this.sessionCeiling = snapshot.sessionCeiling
  }
}

function assertCeiling(percent: number): void {
  if (!isWholeNumber(percent) || percent < 0 || percent > ABSOLUTE_MAX_PERCENT) {
    throw new SafetyError('INVALID_POLICY', `sessionCeiling must be a whole number from 0 to ${ABSOLUTE_MAX_PERCENT}`)
  }
}

function decodeSnapshotKey(encoded: string): { deviceId: string; channelId: string } | undefined {
  // Split at the first colon only: hub channel ids (Buttplug `0:1:vibrate`)
  // contain colons themselves.
  const at = encoded.indexOf(':')
  if (at <= 0 || at === encoded.length - 1) return undefined
  return { deviceId: encoded.slice(0, at), channelId: encoded.slice(at + 1) }
}

/** Serialize a snapshot into the exact text written to `state/policy.json`. */
export function serializePolicySnapshot(snapshot: PolicySnapshot): string {
  return `${JSON.stringify(
    { version: POLICY_SNAPSHOT_VERSION, sessionCeiling: snapshot.sessionCeiling, channels: snapshot.channels },
    null,
    2,
  )}\n`
}

/**
 * Parse persisted policy text.
 *
 * Fails closed: an unknown version, a missing ceiling or any unsafe cap
 * throws, and the caller keeps the conservative defaults.
 *
 * @throws SafetyError with code `INVALID_POLICY`.
 */
export function parsePolicySnapshot(raw: unknown): PolicySnapshot {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new SafetyError('INVALID_POLICY', 'policy snapshot must be an object')
  }
  const record = raw as Record<string, unknown>
  if (record['version'] !== POLICY_SNAPSHOT_VERSION) {
    throw new SafetyError('INVALID_POLICY', `unsupported policy snapshot version: ${String(record['version'])}`)
  }
  const channels = record['channels']
  if (typeof channels !== 'object' || channels === null || Array.isArray(channels)) {
    throw new SafetyError('INVALID_POLICY', 'policy snapshot channels must be an object')
  }
  const parsed: Record<string, ChannelPolicy> = {}
  for (const [encoded, value] of Object.entries(channels as Record<string, unknown>)) {
    if (decodeSnapshotKey(encoded) === undefined) {
      throw new SafetyError('INVALID_POLICY', `policy snapshot key '${encoded}' must look like device:channel`)
    }
    if (typeof value !== 'object' || value === null) {
      throw new SafetyError('INVALID_POLICY', `policy snapshot entry '${encoded}' must be an object`)
    }
    const entry = value as Record<string, unknown>
    const policy: ChannelPolicy = {
      maxPercent: entry['maxPercent'] as number,
      maxWaveIntensity: entry['maxWaveIntensity'] as number,
      maxDurationSec: entry['maxDurationSec'] as number,
    }
    assertValidPolicy(policy)
    parsed[encoded] = policy
  }
  const sessionCeiling = record['sessionCeiling']
  if (typeof sessionCeiling !== 'number') {
    throw new SafetyError('INVALID_POLICY', 'policy snapshot sessionCeiling must be a number')
  }
  assertCeiling(sessionCeiling)
  return { channels: parsed, sessionCeiling }
}
