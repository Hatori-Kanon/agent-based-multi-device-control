/**
 * The intent-to-command resolver: the only place narrative intent becomes a
 * device command, and the only place a narrative intensity becomes a number.
 *
 * `resolvePlan` is a **pure function**. It reads a validated plan and a
 * registry snapshot and returns commands; it never constructs a registry,
 * touches a clock, reads the audit log, or looks at prose. Two consequences
 * are load-bearing:
 *
 * 1. **Byte-stable output.** Given the same plan and snapshot the returned
 *    JSON is identical, because every collection is sorted before it leaves
 *    (`M2-实施计划.md` §4.4 step 8) and nothing time- or random-dependent is
 *    read.
 * 2. **Degradation instead of refusal.** An offline device, an unknown
 *    waveform or a region with no mapped channel produces a warning and a
 *    degraded command; only a genuinely lost target is dropped, and such a
 *    beat is reported in `narrativeOnlyBeats`.
 *
 * Narrow input, wide read: `ResolveContext.snapshot` is typed as the
 * registry's own snapshot widened with the optional `region` field, so a
 * plain `RegistrySnapshot` passes unchanged today and `Channel.region`
 * (B2-T10) needs no edit here.
 */

import type { Envelope, EnvelopePreset } from '../devices/effect.ts'
import { mapPercentThroughRange, type PercentRange } from '../devices/policy.ts'
import type { ChannelSnapshot, DeviceSnapshot, RegistrySnapshot } from '../devices/registry.ts'
import type { Waveform } from '../waveform/types.ts'
import type { WaveformLibrary } from '../waveform/library.ts'
import type {
  Beat,
  BeatChange,
  BeatPlan,
  BeatStrength,
  BeatTarget,
  IntentDistribution,
  WaveformModulation,
} from './beat-plan.ts'
import { WHOLE_BODY_REGION } from './beat-plan.ts'
import { ENVELOPE_DEFAULTS, STRENGTH_RATIO } from './default-intents.ts'

/** What an intent suggests when a beat does not override it. */
export interface IntentSuggest {
  readonly preset?: EnvelopePreset
  readonly waveform?: string
  readonly durationSec?: number
  readonly strength?: BeatStrength
}

/** One named narrative action the director can choose from. */
export interface FeedbackIntent {
  readonly id: string
  readonly meaning: string
  readonly regions: readonly string[]
  readonly suggest?: IntentSuggest
  /** Delta added by §8.1 #5: how the intent spreads over several channels. */
  readonly distribution?: IntentDistribution
}

/** `ChannelSnapshot` widened with the region that B2-T10 adds to the registry. */
export interface ResolveChannelSnapshot extends ChannelSnapshot {
  /** Narrative region id (§4.6.3); read structurally until the registry owns it. */
  readonly region?: string
}

export interface ResolveDeviceSnapshot extends Omit<DeviceSnapshot, 'channels'> {
  readonly channels: readonly ResolveChannelSnapshot[]
}

export interface ResolveRegistrySnapshot extends Omit<RegistrySnapshot, 'devices'> {
  readonly devices: readonly ResolveDeviceSnapshot[]
}

/** Everything the resolver may read. Contains no line, clock or audit handle. */
/**
 * The resolver only needs `get`; it never freezes the host into a concrete
 * library. `WaveformLibrary` satisfies this, and so does a per-session adapter
 * that also resolves packed asset ids (`builtin:x`, `<packId>:x`, bare `x`).
 */
export interface WaveformLookup {
  get(id: string): Waveform | undefined
}

export interface ResolveContext {
  readonly snapshot: ResolveRegistrySnapshot
  readonly intents: ReadonlyMap<string, FeedbackIntent>
  readonly regions: readonly string[]
  /** Used only to answer "does this waveform id exist". */
  readonly waveforms: WaveformLookup
  /** Held by the engine; the resolver never increments it. */
  readonly roundRobinCursor?: number
}

export type ResolvedCommandBody =
  | { readonly kind: 'level'; readonly percent: number; readonly durationSec: number }
  | {
      readonly kind: 'pattern'
      readonly envelope: Envelope
      readonly durationSec: number
      readonly waveformId?: string
      /** D16: passed through only; M2 never applies modulation. */
      readonly modulation?: WaveformModulation
    }
  | { readonly kind: 'waveform'; readonly waveformId: string }

export interface ResolvedCommand {
  readonly beatId: string
  readonly deviceId: string
  readonly channelId: string
  readonly body: ResolvedCommandBody
  readonly clamped: boolean
  readonly degraded?: 'offline' | 'no-region-match' | 'unsupported-waveform' | 'unknown-waveform'
}

export interface ResolvedPlan {
  readonly turnId: number
  readonly planId: string
  readonly commands: readonly ResolvedCommand[]
  readonly narrativeOnlyBeats: readonly string[]
  readonly warnings: readonly string[]
}

/** Engine-recognised intent whose resolution is "drive to zero". */
const STOP_INTENT_ID = 'stop'
/** Fallback effect length when nothing suggests one (§4.4 step 3). */
const DEFAULT_DURATION_SEC = 2
/** Guard for a snapshot whose cap is unusable; a policy cap is always >= 1. */
const MIN_DURATION_SEC = 1

type EnvelopeDefaults = { readonly minRatio: number; readonly periodMs: number; readonly jitter: number }

interface ChannelMatch {
  readonly device: ResolveDeviceSnapshot
  readonly channel: ResolveChannelSnapshot
  readonly target: BeatTarget | undefined
  /** True when the region(s) matched nothing and this is the whole-body fallback. */
  readonly fromFallback: boolean
}

interface BodyResult {
  readonly body: ResolvedCommandBody
  readonly clamped: boolean
  readonly degraded: ResolvedCommand['degraded']
}

/**
 * Turn one plan into dispatchable commands.
 *
 * The command list is sorted by `(beatId, deviceId, channelId)`; the beat list
 * keeps `narrativeOnlyBeats` sorted; warnings are emitted in plan order. All
 * three are stable for the same input, which is what makes the audit replay
 * and the snapshot tests meaningful.
 */
export function resolvePlan(plan: BeatPlan, ctx: ResolveContext): ResolvedPlan {
  const commands: ResolvedCommand[] = []
  const narrativeOnly = new Set<string>()
  const warnings: string[] = []

  for (const beat of plan.beats) {
    resolveBeat(beat, ctx, commands, narrativeOnly, warnings)
  }

  commands.sort(compareCommands)

  return {
    turnId: plan.turnId,
    planId: makePlanId(plan),
    commands,
    narrativeOnlyBeats: [...narrativeOnly].sort(compareStrings),
    warnings,
  }
}

function resolveBeat(
  beat: Beat,
  ctx: ResolveContext,
  commands: ResolvedCommand[],
  narrativeOnly: Set<string>,
  warnings: string[],
): void {
  const intent = ctx.intents.get(beat.intentId)
  if (intent === undefined) {
    warnings.push(`beat ${beat.id}: intent "${beat.intentId}" is not in the intent table; nothing was resolved`)
    narrativeOnly.add(beat.id)
    return
  }

  for (const region of beat.regions) {
    if (region !== WHOLE_BODY_REGION && !ctx.regions.includes(region)) {
      warnings.push(`beat ${beat.id}: region "${region}" is not in this session's region vocabulary`)
    }
  }

  const matches = collectMatches(beat, ctx, warnings)
  if (matches.length === 0) {
    warnings.push(`beat ${beat.id}: no channel matched; the beat stays narrative-only`)
    narrativeOnly.add(beat.id)
    return
  }

  const selected = selectMatches(matches, beat, intent, ctx)
  let dispatched = 0
  for (const match of selected) {
    const command = buildCommand(beat, intent, match, ctx, warnings)
    if (command === undefined) continue
    commands.push(command)
    dispatched += 1
  }
  if (dispatched === 0) narrativeOnly.add(beat.id)
}

/* ------------------------------------------------------------------------- */
/* Target expansion: explicit targets first, then regions                     */
/* ------------------------------------------------------------------------- */

function collectMatches(beat: Beat, ctx: ResolveContext, warnings: string[]): ChannelMatch[] {
  if (beat.targets !== undefined) {
    const matches: ChannelMatch[] = []
    for (const target of beat.targets) {
      const device = ctx.snapshot.devices.find(candidate => candidate.id === target.deviceId)
      if (device === undefined) {
        warnings.push(`beat ${beat.id}: target device "${target.deviceId}" is not connected; target dropped`)
        continue
      }
      const channel = device.channels.find(candidate => candidate.id === target.channelId)
      if (channel === undefined) {
        warnings.push(
          `beat ${beat.id}: device "${target.deviceId}" has no channel "${target.channelId}"; target dropped`,
        )
        continue
      }
      matches.push({ device, channel, target, fromFallback: false })
    }
    return sortMatches(matches)
  }

  const matches: ChannelMatch[] = []
  const seen = new Set<string>()
  for (const region of beat.regions) {
    for (const device of ctx.snapshot.devices) {
      for (const channel of device.channels) {
        if (channel.kind !== 'level') continue
        if (!channelMatchesRegion(channel, region)) continue
        const key = matchKey(device.id, channel.id)
        if (seen.has(key)) continue
        seen.add(key)
        matches.push({ device, channel, target: undefined, fromFallback: false })
      }
    }
  }
  if (matches.length > 0) return sortMatches(matches)

  // §4.4 step 2 / `内容包规范.md` §8 S15 ③: nothing maps to the requested
  // region, so fall back to every online level channel and mark the command.
  warnings.push(
    `beat ${beat.id}: no channel carries region(s) ${describeList(beat.regions)}; falling back to every online level channel`,
  )
  const fallback: ChannelMatch[] = []
  for (const device of ctx.snapshot.devices) {
    if (device.lifecycle !== 'ready') continue
    for (const channel of device.channels) {
      if (channel.kind !== 'level') continue
      fallback.push({ device, channel, target: undefined, fromFallback: true })
    }
  }
  return sortMatches(fallback)
}

function channelMatchesRegion(channel: ResolveChannelSnapshot, region: string): boolean {
  if (region === WHOLE_BODY_REGION) return true
  return channel.region === region
}

/**
 * Apply the intent's distribution policy to region-expanded matches.
 *
 * Explicit `beats[].targets` bypass the policy: a script that names devices
 * means it. Round-robin is only reachable when a pack declares it (§4.4
 * step 5 / §8.1 #5).
 */
function selectMatches(
  matches: readonly ChannelMatch[],
  beat: Beat,
  intent: FeedbackIntent,
  ctx: ResolveContext,
): readonly ChannelMatch[] {
  if (beat.targets !== undefined) return matches
  const distribution: IntentDistribution = intent.distribution ?? 'synced'
  if (distribution === 'primary') {
    const first = matches[0]
    return first === undefined ? [] : [first]
  }
  if (distribution === 'round-robin') {
    if (matches.length === 0) return []
    const cursor = ctx.roundRobinCursor
    const raw = cursor === undefined || !Number.isFinite(cursor) ? 0 : Math.trunc(cursor)
    const index = ((raw % matches.length) + matches.length) % matches.length
    const chosen = matches[index]
    return chosen === undefined ? [] : [chosen]
  }
  return matches
}

function sortMatches(matches: ChannelMatch[]): ChannelMatch[] {
  return matches.sort((left, right) => {
    const byDevice = compareStrings(left.device.id, right.device.id)
    if (byDevice !== 0) return byDevice
    return compareStrings(left.channel.id, right.channel.id)
  })
}

/* ------------------------------------------------------------------------- */
/* Command construction                                                      */
/* ------------------------------------------------------------------------- */

function buildCommand(
  beat: Beat,
  intent: FeedbackIntent,
  match: ChannelMatch,
  ctx: ResolveContext,
  warnings: string[],
): ResolvedCommand | undefined {
  const device = match.device
  const channel = match.channel

  if (device.lifecycle !== 'ready') {
    warnings.push(
      `beat ${beat.id}: ${device.id}/${channel.id} is ${device.lifecycle}; command not sent (narrative only)`,
    )
    return undefined
  }

  const strength = match.target?.strength ?? beat.strength
  const change = match.target?.change ?? beat.change
  const result = buildBody(beat, intent, change, strength, channel, ctx, warnings)

  const degraded = match.fromFallback ? 'no-region-match' : result.degraded
  return {
    beatId: beat.id,
    deviceId: device.id,
    channelId: channel.id,
    body: result.body,
    clamped: result.clamped,
    ...(degraded === undefined ? {} : { degraded }),
  }
}

function buildBody(
  beat: Beat,
  intent: FeedbackIntent,
  change: BeatChange | undefined,
  strength: BeatStrength,
  channel: ResolveChannelSnapshot,
  ctx: ResolveContext,
  warnings: string[],
): BodyResult {
  const policy = policyOf(channel)
  // D16/R1: `texture` may arrive on the change (D9's landing place) or on the
  // beat. It is carried through as `modulation` only — M2 never applies it.
  const modulation = change?.texture ?? beat.texture

  // `stop` is the one intent whose resolution is not a strength ratio.
  // A zero level is how the registry stops a channel: `percent 0` with no
  // hold time maps to `DeviceRegistry.setLevel(actor, {deviceId, channelId,
  // percent: 0, durationSec: 0})`, which routes straight to `stop`
  // (§4.4 step 6 / DEFAULT_INTENTS).
  if (intent.id === STOP_INTENT_ID) {
    return {
      body: { kind: 'level', percent: 0, durationSec: 0 },
      clamped: false,
      degraded: undefined,
    }
  }

  if (change?.kind === 'waveform') {
    const percent = strengthTargetPercent(policy, strength)
    const timing = clampDuration(change.durationSec, channel, beat.id, warnings)
    const waveform = resolveWaveform(change.waveformId, channel, ctx, beat.id, warnings)
    return {
      body: {
        kind: 'pattern',
        envelope: steadyEnvelope(percent),
        durationSec: timing.durationSec,
        ...(waveform.waveformId === undefined ? {} : { waveformId: waveform.waveformId }),
        ...(modulation === undefined ? {} : { modulation }),
      },
      clamped: timing.clamped,
      degraded: waveform.degraded,
    }
  }

  if (change?.kind === 'level') {
    const requested = requestPercent(change, channel, policy, strength)
    // The model's percent is relative: map it through the human interval here,
    // the only place narrative intensity becomes an absolute level.
    const percent = mapPercentThroughRange(policy, requested)
    // R4/§4.3: a level change's `durationSec` is an authorised hold time. It
    // wins over the intent's suggestion (e.g. ambient-field's 30s), else the
    // documented 2s default applies; either way it is clamped to the
    // channel's `maxDurationSec` (the registry enforces the same bound).
    const suggested = intent.suggest?.durationSec
    const timing = clampDuration(change.durationSec ?? suggested, channel, beat.id, warnings)
    return {
      body: { kind: 'level', percent, durationSec: timing.durationSec },
      clamped: requested < 0 || requested > 100 || timing.clamped,
      degraded: undefined,
    }
  }

  // No change: fall back to the intent's suggestion (§4.4 step 3).
  const suggest = intent.suggest
  const percent = strengthTargetPercent(policy, strength)
  const timing = clampDuration(suggest?.durationSec, channel, beat.id, warnings)
  const waveform = resolveWaveform(suggest?.waveform, channel, ctx, beat.id, warnings)

  if (suggest?.preset !== undefined) {
    return {
      body: {
        kind: 'pattern',
        envelope: presetEnvelope(suggest.preset, percent),
        durationSec: timing.durationSec,
        ...(waveform.waveformId === undefined ? {} : { waveformId: waveform.waveformId }),
        ...(modulation === undefined ? {} : { modulation }),
      },
      clamped: timing.clamped,
      degraded: waveform.degraded,
    }
  }

  if (suggest?.waveform !== undefined) {
    return {
      body: {
        kind: 'pattern',
        envelope: steadyEnvelope(percent),
        durationSec: timing.durationSec,
        ...(waveform.waveformId === undefined ? {} : { waveformId: waveform.waveformId }),
        ...(modulation === undefined ? {} : { modulation }),
      },
      clamped: timing.clamped,
      degraded: waveform.degraded,
    }
  }

  return {
    body: { kind: 'level', percent, durationSec: timing.durationSec },
    clamped: timing.clamped,
    degraded: undefined,
  }
}

/**
 * D8's three-step priority in **relative** percent: explicit `targetPercent`,
 * then `deltaPercent` against the channel's current position in its interval,
 * then the strength ratio.
 *
 * `deltaPercent` stays a relative quantity: the snapshot's current absolute
 * level is converted back to a relative position before the delta is applied,
 * so a +5 request always moves by 5% of the human's band regardless of where
 * that band starts or ends.
 */
function requestPercent(
  change: BeatChange,
  channel: ResolveChannelSnapshot,
  policy: PercentRange,
  strength: BeatStrength,
): number {
  if (change.targetPercent !== undefined) return change.targetPercent
  if (change.deltaPercent !== undefined) {
    const current = Number.isFinite(channel.percent) ? channel.percent : 0
    return relativePercentOf(policy, current) + change.deltaPercent
  }
  return strengthRelativePercent(strength)
}

/** Current absolute level expressed as a 0-100 position inside the interval. */
function relativePercentOf(policy: PercentRange, absolute: number): number {
  const span = policy.maxPercent - policy.minPercent
  if (span <= 0) return 0
  const relative = ((absolute - policy.minPercent) / span) * 100
  return Math.min(100, Math.max(0, relative))
}

/** D8 strength ratios expressed as the model's 0-100 relative scale. */
function strengthRelativePercent(strength: BeatStrength): number {
  return Math.round(100 * strengthRatio(strength))
}

/** Map a strength ratio through the channel interval. */
function strengthTargetPercent(policy: PercentRange, strength: BeatStrength): number {
  return mapPercentThroughRange(policy, strengthRelativePercent(strength))
}

function strengthRatio(strength: BeatStrength): number {
  const table: Record<string, number | undefined> = STRENGTH_RATIO
  return table[strength] ?? 0
}

/**
 * Only the strength interval is needed for mapping. The snapshot deliberately
 * does not carry the internal pulse-width cap: that safety value belongs to
 * the emit path, never to the resolver.
 */
function policyOf(channel: ResolveChannelSnapshot): PercentRange {
  return {
    minPercent: channel.minPercent,
    maxPercent: channel.maxPercent,
  }
}

function clampDuration(
  requested: number | undefined,
  channel: ResolveChannelSnapshot,
  beatId: string,
  warnings: string[],
): { durationSec: number; clamped: boolean } {
  let durationSec = requested ?? DEFAULT_DURATION_SEC
  if (!Number.isFinite(durationSec) || durationSec <= 0) {
    warnings.push(`beat ${beatId}: duration must be a finite positive number; using ${DEFAULT_DURATION_SEC}s`)
    durationSec = DEFAULT_DURATION_SEC
  }
  const max = Number.isFinite(channel.maxDurationSec) && channel.maxDurationSec >= MIN_DURATION_SEC
    ? channel.maxDurationSec
    : MIN_DURATION_SEC
  if (durationSec > max) {
    warnings.push(`beat ${beatId}: duration ${durationSec}s exceeds the channel cap ${max}s; clamped`)
    return { durationSec: max, clamped: true }
  }
  return { durationSec, clamped: false }
}

function steadyEnvelope(percent: number): Envelope {
  return {
    preset: 'steady',
    minPercent: percent,
    maxPercent: percent,
    periodMs: ENVELOPE_DEFAULTS.steady.periodMs,
    jitter: ENVELOPE_DEFAULTS.steady.jitter,
  }
}

function presetEnvelope(preset: EnvelopePreset, percent: number): Envelope {
  const defaults = envelopeDefaults(preset)
  if (defaults === undefined) {
    return steadyEnvelope(percent)
  }
  const minPercent = Math.min(percent, Math.max(0, Math.round(percent * defaults.minRatio)))
  return {
    preset,
    minPercent,
    maxPercent: percent,
    periodMs: defaults.periodMs,
    jitter: defaults.jitter,
  }
}

function envelopeDefaults(preset: EnvelopePreset): EnvelopeDefaults | undefined {
  const table: Record<string, EnvelopeDefaults | undefined> = ENVELOPE_DEFAULTS
  return table[preset]
}

/**
 * §4.4 step 7: a missing waveform degrades to a plain pattern; a channel that
 * cannot play one does too. Never throws.
 */
function resolveWaveform(
  waveformId: string | undefined,
  channel: ResolveChannelSnapshot,
  ctx: ResolveContext,
  beatId: string,
  warnings: string[],
): { waveformId?: string; degraded: ResolvedCommand['degraded'] } {
  if (waveformId === undefined) return { degraded: undefined }
  const waveform = ctx.waveforms.get(waveformId)
  if (waveform === undefined) {
    warnings.push(`beat ${beatId}: waveform "${waveformId}" was not found; falling back to a plain pattern`)
    return { degraded: 'unknown-waveform' }
  }
  if (channel.supportsWaveform !== true) {
    warnings.push(
      `beat ${beatId}: ${channel.id} cannot play waveform "${waveformId}"; falling back to a plain pattern`,
    )
    return { degraded: 'unsupported-waveform' }
  }
  return { waveformId, degraded: undefined }
}

/* ------------------------------------------------------------------------- */
/* Deterministic identity                                                    */
/* ------------------------------------------------------------------------- */

const PLAN_ID_PREFIX = 'p-'
const FNV_OFFSET = 0x811c9dc5
const FNV_PRIME = 0x01000193

/**
 * A clock-free plan id.
 *
 * The engine cannot be consulted (this is a pure function), so the id is
 * derived from the turn id plus a stable hash of the plan: the same plan
 * always resolves to the same id, and two different plans in one turn remain
 * distinguishable in the audit trail.
 */
function makePlanId(plan: BeatPlan): string {
  const turn = String(plan.turnId).padStart(4, '0')
  return `${PLAN_ID_PREFIX}${turn}-${planHash(plan)}`
}

function planHash(plan: BeatPlan): string {
  let payload: string
  try {
    payload = JSON.stringify(plan)
  } catch {
    return 'unhashable'
  }
  let hash = FNV_OFFSET
  for (let index = 0; index < payload.length; index += 1) {
    hash ^= payload.charCodeAt(index)
    hash = Math.imul(hash, FNV_PRIME) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

/* ------------------------------------------------------------------------- */
/* Small deterministic helpers                                               */
/* ------------------------------------------------------------------------- */

function compareCommands(left: ResolvedCommand, right: ResolvedCommand): number {
  const byBeat = compareStrings(left.beatId, right.beatId)
  if (byBeat !== 0) return byBeat
  const byDevice = compareStrings(left.deviceId, right.deviceId)
  if (byDevice !== 0) return byDevice
  return compareStrings(left.channelId, right.channelId)
}

/** Code-unit comparison: locale-independent, so output never depends on ICU. */
function compareStrings(left: string, right: string): number {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

function matchKey(deviceId: string, channelId: string): string {
  return `${deviceId}\u0000${channelId}`
}

function describeList(values: readonly string[]): string {
  return values.map(value => `"${value}"`).join(', ')
}
