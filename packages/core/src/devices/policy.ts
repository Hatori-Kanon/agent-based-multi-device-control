/**
 * Human-owned output bounds.
 *
 * There is deliberately no `setByModel`. The model has no tool that reaches
 * this store, so the only way a bound moves is a human action in the UI, which
 * is recorded in the audit trail. Absolute bounds additionally protect against
 * a mis-drag in that UI.
 *
 * A channel now owns an **output range** rather than a single cap: a strength
 * interval (`minPercent`-`maxPercent`) and a waveform frequency band
 * (`minFreq`-`maxFreq`). The model still writes 0-100 relative percentages;
 * {@link mapPercentThroughRange} turns those into absolute levels inside the
 * human's interval, while {@link clampPercentToRange} is the absolute gate used
 * by the registry and by direct human control.
 *
 * **Pulse width is different.** The v3 UI replaced the pulse-width ceiling with
 * the frequency band, but the pulse-width limit itself is still needed: it is
 * retained as an **internal safety cap** ({@link ChannelPolicy.maxWaveIntensity},
 * default 80) and is deliberately not configurable from the UI or API. The
 * frequency band is the human-configurable waveform control; the emit path
 * (`clampFrameIntensity`) enforces the internal cap on every frame. Only
 * `setByHuman` can write it, and the host does not expose it.
 *
 * Mapping uses the **effective** interval: `PolicyStore.effective` folds the
 * legacy session ceiling into `maxPercent` before the resolver maps a relative
 * percentage, so the mapping itself is already inside the ceiling gate (the
 * registry's final clamp is still the absolute gate). See review S-2.
 */

import { SafetyError } from './errors.ts'
import { MAX_FREQ, MIN_FREQ } from '../waveform/types.ts'

/** High end of the strength interval no human input may exceed. */
export const ABSOLUTE_MAX_PERCENT = 100
/**
 * Protocol ceiling for waveform pulse width.
 *
 * 100 is the protocol maximum and corresponds to roughly a 100 µs pulse, which
 * the vendor's own V2 notes flag as the onset of stinging. Retained as the
 * validation bound for the internal safety cap; it is not a UI/API option.
 */
export const ABSOLUTE_MAX_WAVE_INTENSITY = 100
/** Longest single command any human may authorise, in seconds. */
export const ABSOLUTE_MAX_DURATION_SEC = 600

/** Bounds applied to one channel. */
export interface ChannelPolicy {
  /** Lowest percentage the channel may be driven to, 0-99 and < `maxPercent`. */
  readonly minPercent: number
  /** Highest percentage the channel may be driven to, 1-100. */
  readonly maxPercent: number
  /**
   * Internal pulse-width safety cap, 0-100.
   *
   * Independent of {@link ChannelPolicy.maxPercent}: that one bounds amplitude,
   * this one bounds pulse width. It is **not** exposed to the model or the UI;
   * the host keeps it out of the policy API, and the Coyote emit path clamps
   * every intensity byte to it. The default (80) keeps waveform output clear of
   * the vendor's ~100 µs stinging threshold.
   */
  readonly maxWaveIntensity: number
  /** Lowest waveform frequency in protocol units, `MIN_FREQ`-`MAX_FREQ` and < `maxFreq`. */
  readonly minFreq: number
  /** Highest waveform frequency in protocol units, `MIN_FREQ`-`MAX_FREQ`. */
  readonly maxFreq: number
  /** Longest single command, in seconds. */
  readonly maxDurationSec: number
}

/**
 * Conservative starting point.
 *
 * 20% is deliberately low. On hardware with a non-linear encoding it is already
 * a substantial fraction of the real range — one 谜姬 family maps a 20% command
 * onto roughly 44% of the motor's band — and the reference implementation for
 * that family ships the same default after real testing. Raising a bound is one
 * drag in the UI; a first session that surprises someone is not undoable.
 *
 * The frequency band starts at the full protocol range, which is the identity
 * mapping: a waveform plays exactly as authored until a human narrows it.
 *
 * `maxWaveIntensity` is the internal pulse-width safety cap described on
 * {@link ChannelPolicy}; it is not a UI/API knob.
 */
export const DEFAULT_CHANNEL_POLICY: ChannelPolicy = {
  minPercent: 0,
  maxPercent: 20,
  maxWaveIntensity: 80,
  minFreq: MIN_FREQ,
  maxFreq: MAX_FREQ,
  maxDurationSec: 60,
}

/** Result of a human bound change, shaped for the audit trail. */
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
  /**
   * True when a version-1 file was upgraded in memory.
   *
   * Not serialized. The host can use it to force a rewrite so the on-disk file
   * becomes a version-2 file instead of being re-migrated on every start.
   */
  readonly migrated?: boolean
}

/** Version stamped into `state/policy.json`. */
export const POLICY_SNAPSHOT_VERSION = 2

function isWholeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value)
}

/** The only fields mapping and clamping need; a full {@link ChannelPolicy} satisfies it. */
export type PercentRange = Pick<ChannelPolicy, 'minPercent' | 'maxPercent'>

/** Reject a policy that is malformed or outside the absolute bounds. */
export function assertValidPolicy(policy: ChannelPolicy): void {
  if (!isWholeNumber(policy.minPercent) || policy.minPercent < 0 || policy.minPercent >= ABSOLUTE_MAX_PERCENT) {
    throw new SafetyError('INVALID_POLICY', `minPercent must be a whole number from 0 to ${ABSOLUTE_MAX_PERCENT - 1}`)
  }
  if (!isWholeNumber(policy.maxPercent) || policy.maxPercent < 1 || policy.maxPercent > ABSOLUTE_MAX_PERCENT) {
    throw new SafetyError('INVALID_POLICY', `maxPercent must be a whole number from 1 to ${ABSOLUTE_MAX_PERCENT}`)
  }
  if (policy.minPercent >= policy.maxPercent) {
    throw new SafetyError('INVALID_POLICY', 'minPercent must be less than maxPercent')
  }
  if (
    !isWholeNumber(policy.maxWaveIntensity) ||
    policy.maxWaveIntensity < 0 ||
    policy.maxWaveIntensity > ABSOLUTE_MAX_WAVE_INTENSITY
  ) {
    throw new SafetyError(
      'INVALID_POLICY',
      `maxWaveIntensity must be a whole number from 0 to ${ABSOLUTE_MAX_WAVE_INTENSITY}`,
    )
  }
  if (!isWholeNumber(policy.minFreq) || policy.minFreq < MIN_FREQ || policy.minFreq >= MAX_FREQ) {
    throw new SafetyError('INVALID_POLICY', `minFreq must be a whole number from ${MIN_FREQ} to ${MAX_FREQ - 1}`)
  }
  if (!isWholeNumber(policy.maxFreq) || policy.maxFreq <= MIN_FREQ || policy.maxFreq > MAX_FREQ) {
    throw new SafetyError('INVALID_POLICY', `maxFreq must be a whole number from ${MIN_FREQ + 1} to ${MAX_FREQ}`)
  }
  if (policy.minFreq >= policy.maxFreq) {
    throw new SafetyError('INVALID_POLICY', 'minFreq must be less than maxFreq')
  }
  if (!isWholeNumber(policy.maxDurationSec) || policy.maxDurationSec <= 0 || policy.maxDurationSec > ABSOLUTE_MAX_DURATION_SEC) {
    throw new SafetyError('INVALID_POLICY', `maxDurationSec must be a whole number from 1 to ${ABSOLUTE_MAX_DURATION_SEC}`)
  }
}

/**
 * Reject a command that policy does not allow.
 *
 * Rejection rather than silent clamping is deliberate: the model should learn
 * the bound from the error text. The registry clamps absolute input into the
 * interval before this check, so this is the structural/duration guard; the
 * emit path clamps as well, so a bypass still cannot leave the range.
 */
export function assertLevelWithinPolicy(policy: ChannelPolicy, percent: number, durationSec: number): void {
  if (!isWholeNumber(percent)) {
    throw new SafetyError(
      'POLICY_PERCENT',
      `percent must be a whole number from ${policy.minPercent} to ${policy.maxPercent} for this channel`,
    )
  }
  if (percent === 0) {
    if (durationSec !== 0) {
      throw new SafetyError('POLICY_DURATION', 'percent 0 stops immediately; omit duration')
    }
    return
  }
  if (percent < policy.minPercent || percent > policy.maxPercent) {
    throw new SafetyError(
      'POLICY_PERCENT',
      `percent must be a whole number from ${policy.minPercent} to ${policy.maxPercent} for this channel`,
    )
  }
  if (!Number.isFinite(durationSec) || durationSec <= 0 || durationSec > policy.maxDurationSec) {
    throw new SafetyError(
      'POLICY_DURATION',
      `durationSec must be greater than 0 and at most ${policy.maxDurationSec} for this channel; indefinite output is not available`,
    )
  }
}

/**
 * Map a model-relative percentage through a channel interval.
 *
 * The model's contract is 0-100 relative units: 0 stops, and 100 means the
 * human's upper bound. Values in between land proportionally inside
 * `[minPercent, maxPercent]`, so raising the lower bound shifts the whole
 * expressive band rather than clipping its bottom.
 *
 * A positive request must never round down to zero: zero is the stop signal,
 * so `percent: 1` on a narrow band such as the default `[0, 20]` would
 * otherwise silently become "stop" instead of the lightest output. Positive
 * requests therefore floor at `max(1, minPercent)`, capped by `maxPercent`.
 *
 * Non-finite input fails closed to zero for the same reason as
 * {@link clampPercentToRange}: a broken calculation must never become output.
 */
export function mapPercentThroughRange(policy: PercentRange, percent: number): number {
  if (!Number.isFinite(percent) || percent <= 0) return 0
  const relative = Math.min(100, percent)
  const min = policy.minPercent
  const span = policy.maxPercent - min
  const mapped = span <= 0 ? policy.maxPercent : min + ((relative / 100) * span)
  return Math.min(policy.maxPercent, Math.max(Math.max(1, min), Math.round(mapped)))
}

/**
 * Clamp an **absolute** percentage into the channel interval.
 *
 * Zero always stays zero so stop paths are never turned into output. Values
 * above the interval's floor are raised to it: the interval is the human's
 * declared output band, and direct control is specified against it.
 *
 * If a narrowed session ceiling leaves `maxPercent < minPercent`, the ceiling
 * wins (the result is bounded by the upper value); that combination is only
 * reachable through the legacy session ceiling and safety takes precedence.
 */
export function clampPercentToRange(policy: PercentRange, percent: number): number {
  if (!Number.isFinite(percent) || percent <= 0) return 0
  const upper = policy.maxPercent
  const lower = Math.min(policy.minPercent, upper)
  return Math.min(upper, Math.max(lower, Math.round(percent)))
}

function key(deviceId: string, channelId: string): string {
  return `${deviceId}\u0000${channelId}`
}

/** Per-channel bound storage with human-only mutation. */
export class PolicyStore {
  private readonly overrides = new Map<string, ChannelPolicy>()
  private sessionCeiling = DEFAULT_SESSION_CEILING
  private restored = false

  /** @param defaults - Applied to any channel without an explicit override. */
  constructor(private readonly defaults: ChannelPolicy = DEFAULT_CHANNEL_POLICY) {
    assertValidPolicy(defaults)
  }

  get(deviceId: string, channelId: string): ChannelPolicy {
    return this.overrides.get(key(deviceId, channelId)) ?? this.defaults
  }

  /**
   * Apply a human bound change.
   *
   * @returns Before and after values so the caller can audit the change.
   * @throws SafetyError with code `INVALID_POLICY` when the result is unsafe.
   */
  setByHuman(deviceId: string, channelId: string, patch: Partial<ChannelPolicy>): PolicyChange {
    assertDeviceKey(deviceId)
    assertChannelKey(channelId)
    const previous = this.get(deviceId, channelId)
    const next: ChannelPolicy = {
      minPercent: patch.minPercent ?? previous.minPercent,
      maxPercent: patch.maxPercent ?? previous.maxPercent,
      maxWaveIntensity: patch.maxWaveIntensity ?? previous.maxWaveIntensity,
      minFreq: patch.minFreq ?? previous.minFreq,
      maxFreq: patch.maxFreq ?? previous.maxFreq,
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
   * Policy actually in force: the channel interval further bounded by the
   * session ceiling.
   *
   * Only the upper percentage is narrowed; the lower bound, the frequency band
   * and the internal pulse-width cap belong to the channel. The emit path and
   * the Coyote `BF` sync read this instead of {@link PolicyStore.get}, so
   * `BF <= X` holds by construction.
   *
   * A legacy ceiling can be lower than the channel's floor (for example a
   * human sets `[40, 60]` while the restored session ceiling is 20). The
   * ceiling must not be raised, so the floor is lowered instead: the result is
   * the legal interval `[maxPercent - 1, maxPercent]` rather than `[40, 20]`.
   * Without that, every positive output on the channel would be rejected and
   * the snapshot would publish an interval whose floor exceeds its ceiling.
   */
  effective(deviceId: string, channelId: string): ChannelPolicy {
    const base = this.get(deviceId, channelId)
    const maxPercent = Math.min(base.maxPercent, this.sessionCeiling)
    // A zero ceiling closes the channel completely. Keep the interval at
    // [0, 0] rather than a negative floor; no positive output can pass it.
    const minPercent = base.minPercent < maxPercent ? base.minPercent : Math.max(0, maxPercent - 1)
    return { ...base, minPercent, maxPercent }
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
   * Restore a previously persisted snapshot — **once, at startup**.
   *
   * This is the load half of persistence, not a third mutation path: it refuses
   * a second call and refuses to overwrite a store that already has explicit
   * overrides, so no engine or content-pack code path can use it to widen a
   * bound after the process is running (review blocker A-2). Callers audit the
   * restored values when they differ from the defaults.
   *
   * Validates everything first and commits atomically: a file with one unsafe
   * entry restores nothing, so a hand-edited bound cannot half-apply.
   *
   * @throws SafetyError with code `INVALID_POLICY`.
   */
  restore(snapshot: PolicySnapshot): void {
    if (this.restored) {
      throw new SafetyError('INVALID_POLICY', 'PolicyStore.restore() may only be called once, at startup')
    }
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
    if (this.overrides.size > 0) {
      throw new SafetyError('INVALID_POLICY', 'PolicyStore.restore() cannot overwrite caps that were already set in this process')
    }
    this.overrides.clear()
    for (const [internal, policy] of next) this.overrides.set(internal, policy)
    this.sessionCeiling = snapshot.sessionCeiling
    this.restored = true
  }
}

function assertCeiling(percent: number): void {
  if (!isWholeNumber(percent) || percent < 0 || percent > ABSOLUTE_MAX_PERCENT) {
    throw new SafetyError('INVALID_POLICY', `sessionCeiling must be a whole number from 0 to ${ABSOLUTE_MAX_PERCENT}`)
  }
}

/**
 * Read the v1 pulse-width ceiling.
 *
 * Older files may contain any number (or omit the key). Migration must not fail
 * on a value the old build accepted, but it also must not widen beyond the
 * protocol range: clamp into `0..100`, rounding a stray fraction, and fall back
 * to the conservative default when the value is absent or unusable.
 */
function migrateWaveIntensity(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return DEFAULT_CHANNEL_POLICY.maxWaveIntensity
  return Math.min(ABSOLUTE_MAX_WAVE_INTENSITY, Math.max(0, Math.round(raw)))
}

/**
 * `state/policy.json` keys are `device:channel`.
 *
 * A colon inside the device id would make the mapping non-injective (device
 * `a:b` + channel `c` collides with device `a` + channel `b:c`), and restoring
 * such a file could move a tightened bound onto the wrong device — a silent
 * fail-open. Channel ids may contain colons on hub backends (`0:1:vibrate`),
 * but never the internal NUL separator.
 */
function assertDeviceKey(deviceId: string): void {
  if (deviceId.length === 0 || deviceId.includes(':') || deviceId.includes('\u0000')) {
    throw new SafetyError('INVALID_POLICY', "deviceId must be non-empty and must not contain ':' or NUL")
  }
}

function assertChannelKey(channelId: string): void {
  if (channelId.length === 0 || channelId.includes('\u0000')) {
    throw new SafetyError('INVALID_POLICY', 'channelId must be non-empty and must not contain NUL')
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
 * Fails closed: an unknown version, a missing ceiling or any unsafe bound
 * throws, and the caller keeps the conservative defaults.
 *
 * Version 1 files carried a pulse-width ceiling (`maxWaveIntensity`, default
 * 80) instead of a frequency band. They are migrated, not rejected:
 * `maxPercent`, `maxWaveIntensity` and `maxDurationSec` are preserved (the
 * intensity value is clamped to 0-100; a missing value uses the default 80),
 * the strength floor starts at 0, and the frequency band starts at the full
 * protocol range (identity mapping).
 *
 * @throws SafetyError with code `INVALID_POLICY`.
 */
export function parsePolicySnapshot(raw: unknown): PolicySnapshot {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new SafetyError('INVALID_POLICY', 'policy snapshot must be an object')
  }
  const record = raw as Record<string, unknown>
  const version = record['version']
  if (version !== 1 && version !== POLICY_SNAPSHOT_VERSION) {
    throw new SafetyError('INVALID_POLICY', `unsupported policy snapshot version: ${String(version)}`)
  }
  const legacy = version === 1
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
    const policy: ChannelPolicy = legacy
      ? {
          minPercent: 0,
          maxPercent: entry['maxPercent'] as number,
          maxWaveIntensity: migrateWaveIntensity(entry['maxWaveIntensity']),
          minFreq: MIN_FREQ,
          maxFreq: MAX_FREQ,
          maxDurationSec: entry['maxDurationSec'] as number,
        }
      : {
          minPercent: entry['minPercent'] as number,
          maxPercent: entry['maxPercent'] as number,
          maxWaveIntensity: entry['maxWaveIntensity'] as number,
          minFreq: entry['minFreq'] as number,
          maxFreq: entry['maxFreq'] as number,
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
  return { channels: parsed, sessionCeiling, ...(legacy ? { migrated: true } : {}) }
}
