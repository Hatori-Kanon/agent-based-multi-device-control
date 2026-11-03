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
  /**
   * Optional expansion from a plan's region id to the player's channel names.
   *
   * A content pack names body parts in its own vocabulary (`inner-thigh`),
   * while the human may label the matching channel with a different word
   * (`阴蒂`). Matching only on `channel.region === region` then finds nothing
   * and falls back to *every* online channel, driving unrelated parts and
   * marking the command `no-region-match` (play-session audit). The host
   * builds the map per turn; the resolver only reads it, so it stays pure.
   */
  readonly regionAliases?: ReadonlyMap<string, readonly string[]>
  /**
   * Optional session default waveform (`内容包规范.md` §4.5).
   *
   * When a plan references an unknown waveform id, the resolver falls back to
   * this id instead of a plain pattern: the channel keeps its texture and the
   * command is still marked `unknown-waveform` for the audit. The host wires
   * it to the pack's default/fallback asset; absent keeps the old plain
   * pattern behaviour.
   */
  readonly defaultWaveformId?: string
  /**
   * Session-wide hold for looping waveforms, in seconds (用户想法 2).
   *
   * A content pack marks textures it wants to keep playing as `loop: true`.
   * Without this, a short beat's pattern stops at its own duration and the
   * channel falls silent while the model "thinks" before the next turn. When
   * set (host passes e.g. 60), a looping waveform's pattern is raised to this
   * hold — still capped by the channel's `maxDurationSec` — so it sustains
   * until the next plan replaces or stops it. Non-loop textures, levels and
   * stops are unaffected. Absent/<=0 keeps the short duration.
   */
  readonly sustainLoopSec?: number
  /** Used only to answer "does this waveform id exist". */
  readonly waveforms: WaveformLookup
  /**
   * Rotation seed for the `round-robin` distribution.
   *
   * Supplied by the caller (today: the play host, once per turn) and treated as
   * read-only here: the resolver is a pure function and never increments it.
   */
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

/**
 * The model's pre-mapping intensity request, carried into dispatch and audit.
 *
 * `requestedPercent` is the 0-100 interval percentage the model asked for,
 * *before* `mapPercentThroughRange` turns it into the channel's absolute
 * output. Recording it lets operators answer "did the model ask for 15, or did
 * the engine map a larger request down?" without exposing the cap itself.
 */
export interface ResolvedIntensityRequest {
  readonly strength: BeatStrength
  readonly targetPercent?: number
  readonly deltaPercent?: number
  readonly requestedPercent: number
}

export interface ResolvedCommand {
  readonly beatId: string
  readonly deviceId: string
  readonly channelId: string
  readonly body: ResolvedCommandBody
  readonly clamped: boolean
  readonly degraded?: 'offline' | 'no-region-match' | 'unsupported-waveform' | 'unknown-waveform'
  /** Effective intensity request behind this command (not the mapped output). */
  readonly request?: ResolvedIntensityRequest
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
  readonly request: ResolvedIntensityRequest
}

/** A beat's resolved channel matches plus how they were found. */
interface CollectedMatches {
  readonly matches: ChannelMatch[]
  /**
   * True only when the matches came from `beats[].targets`; false for region
   * expansion (including the target→region fallback), which must honour the
   * intent's distribution policy (ui-v12-review §P2-2).
   */
  readonly fromTargets: boolean
}

/**
 * Turn one plan into dispatchable commands.
 *
 * Commands are generated in plan order, then collapsed per `(device, channel)`
 * so one turn drives each channel at most once (see
 * {@link mergeChannelCommands}). The command list is sorted by
 * `(beatId, deviceId, channelId)`; the beat list keeps `narrativeOnlyBeats`
 * sorted; warnings are emitted in plan order and then in command order. All
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

  const merged = mergeChannelCommands(commands, warnings, ctx)
  // Sustain applies to the *surviving* command only: doing it before the merge
  // let a sustained loop's hold leak into a later non-loop/level body through
  // the merge's duration=max (ui-v12-review §P2-1).
  const sustained = merged.map((command): ResolvedCommand => {
    const channel = channelSnapshotOf(ctx, command.deviceId, command.channelId)
    return channel === undefined ? command : sustainLoopCommand(command, channel, ctx)
  })
  sustained.sort(compareCommands)

  return {
    turnId: plan.turnId,
    planId: makePlanId(plan),
    commands: sustained,
    narrativeOnlyBeats: [...narrativeOnly].sort(compareStrings),
    warnings,
  }
}

interface ChannelMerge {
  /** Last command generated for this channel: its body is the final state. */
  last: ResolvedCommand
  /** Longest non-stop hold requested for this channel anywhere in the turn. */
  maxDurationSec: number
}

/**
 * Collapse a turn's commands so each channel is driven at most once.
 *
 * Beats are independent narrative units but they land on one hardware state:
 * a later beat on the same `(device, channel)` replaces the earlier one.
 * Dispatching both in plan order let the later command truncate the earlier
 * (audit turn 13: a 40 s level was cut to 4 s by a pattern on the same part)
 * and made the player feel the same part move twice. The final body is the
 * last command's body (percent/envelope/waveform); the hold time is the
 * longest **non-stop** duration requested anywhere in the turn, so a long hold
 * survives a later short texture change. A final stop stays a stop: `percent:
 * 0` clears the channel and has no meaningful duration to merge.
 *
 * The merge keeps the surviving command in the slot where it was generated and
 * records one warning per superseded command, so the audit explains why a
 * beat's command is absent from `commands`. A superseded command that was
 * playing a looping texture also gets an ordering warning: a loop must be the
 * last beat on its channel (future queue constraint), because an earlier
 * duplicate on the same channel would be cut by the later body. A loop
 * followed by a stop on the same channel is the legal termination, so it is
 * exempt from that warning.
 */
function mergeChannelCommands(
  commands: readonly ResolvedCommand[],
  warnings: string[],
  ctx: ResolveContext,
): ResolvedCommand[] {
  const groups = new Map<string, ChannelMerge>()
  for (const command of commands) {
    const key = matchKey(command.deviceId, command.channelId)
    const durationSec = nonStopDurationSec(command)
    const existing = groups.get(key)
    if (existing === undefined) {
      groups.set(key, { last: command, maxDurationSec: durationSec })
    } else {
      existing.last = command
      existing.maxDurationSec = Math.max(existing.maxDurationSec, durationSec)
    }
  }

  const merged: ResolvedCommand[] = []
  for (const command of commands) {
    const group = groups.get(matchKey(command.deviceId, command.channelId))
    if (group === undefined) continue // unreachable: every command has a group
    if (group.last !== command) {
      warnings.push(
        `beat ${command.beatId}: command on ${command.deviceId}/${command.channelId}`
        + ` superseded by beat ${group.last.beatId} in the same turn`,
      )
      // A looping texture cannot share its channel with a later beat: the
      // later body wins and the loop would have been cut. Surface the ordering
      // mistake now so a future queue can reject it before dispatch. Ending a
      // loop with a stop is the legal termination, not an ordering mistake.
      const supersededBody = command.body
      const finalIsStop = isStopBody(group.last.body)
      if (
        !finalIsStop
        && supersededBody.kind === 'pattern'
        && supersededBody.waveformId !== undefined
        && ctx.waveforms.get(supersededBody.waveformId)?.loop === true
      ) {
        warnings.push(
          `beat ${command.beatId}: loop output must be the last beat on`
          + ` ${command.deviceId}/${command.channelId}; earlier beats need a fixed duration`,
        )
      }
      continue
    }
    merged.push(withMergedDuration(command, group.maxDurationSec))
  }
  return merged
}

/** Requested hold, or 0 for a stop (which clears the channel instead). */
/** True when the body is a stop (`setLevel(percent: 0)` clears the channel). */
function isStopBody(body: ResolvedCommand['body']): boolean {
  return body.kind === 'level' && body.percent === 0
}

function nonStopDurationSec(command: ResolvedCommand): number {
  const body = command.body
  if (body.kind === 'waveform') return 0
  if (isStopBody(body)) return 0
  return Number.isFinite(body.durationSec) && body.durationSec > 0 ? body.durationSec : 0
}

/** Apply the turn-wide hold time to the surviving body (stops keep their own). */
function withMergedDuration(command: ResolvedCommand, durationSec: number): ResolvedCommand {
  const body = command.body
  if (body.kind === 'waveform') return command
  // `setLevel(percent: 0)` is a stop; it ignores duration and must stay one.
  if (isStopBody(body)) return command
  if (body.durationSec === durationSec) return command
  return { ...command, body: { ...body, durationSec } }
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

  const collected = collectMatches(beat, ctx, warnings)
  if (collected.matches.length === 0) {
    warnings.push(`beat ${beat.id}: no channel matched; the beat stays narrative-only`)
    narrativeOnly.add(beat.id)
    return
  }

  const selected = selectMatches(collected.matches, collected.fromTargets, intent, ctx)
  let dispatched = 0
  for (const match of selected) {
    const command = buildCommand(beat, intent, match, ctx, warnings)
    if (command === undefined) continue
    commands.push(command)
    dispatched += 1
  }
  if (dispatched === 0) narrativeOnly.add(beat.id)
}

/**
 * Keep a looping texture playing across the thinking gap (用户想法 2).
 *
 * Runs **after** the per-channel merge, on the surviving command only: the
 * final body decides whether to sustain, so a long loop hold can never leak
 * into a later level/non-loop body through the merge's duration=max
 * (ui-v12-review §P2-1). A pack marks assets it wants sustained as
 * `loop: true`; when the host sets `sustainLoopSec`, that pattern's hold is
 * raised to the value — never past the channel's own `maxDurationSec` — so
 * the texture keeps playing until the next plan replaces or stops it.
 */
function sustainLoopCommand(
  command: ResolvedCommand,
  channel: ResolveChannelSnapshot,
  ctx: ResolveContext,
): ResolvedCommand {
  const body = command.body
  if (body.kind !== 'pattern' || body.waveformId === undefined) return command
  const sustainSec = ctx.sustainLoopSec
  if (sustainSec === undefined || !Number.isFinite(sustainSec) || sustainSec <= 0) return command
  if (ctx.waveforms.get(body.waveformId)?.loop !== true) return command
  const channelCap = Number.isFinite(channel.maxDurationSec) && channel.maxDurationSec >= MIN_DURATION_SEC
    ? channel.maxDurationSec
    : MIN_DURATION_SEC
  const targetSec = Math.min(sustainSec, channelCap)
  if (body.durationSec >= targetSec) return command
  return { ...command, body: { ...body, durationSec: targetSec } }
}

/** The live channel snapshot a surviving command points at, if still present. */
function channelSnapshotOf(
  ctx: ResolveContext,
  deviceId: string,
  channelId: string,
): ResolveChannelSnapshot | undefined {
  const device = ctx.snapshot.devices.find(candidate => candidate.id === deviceId)
  return device?.channels.find(candidate => candidate.id === channelId)
}

/* ------------------------------------------------------------------------- */
/* Target expansion: explicit targets first, then regions                     */
/* ------------------------------------------------------------------------- */

function collectMatches(beat: Beat, ctx: ResolveContext, warnings: string[]): CollectedMatches {
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
    if (matches.length > 0) return { matches: sortMatches(matches), fromTargets: true }
    // The prompt deliberately exposes regions, not device/channel ids, so a
    // model can only guess `targets` and usually guesses wrong (smoke
    // turn 1/3: deviceId "tentacle-shadow"/"tentacle" for a coyote). With no
    // match at all, falling back to the beat's regions is the only way this
    // beat can reach hardware; treat it as a region route, not as explicit
    // targets (distribution still applies). A target that *did* match a
    // device (even an offline one) never falls back: that would drive a part
    // the plan did not ask for.
    if (beat.regions.length === 0) return { matches: [], fromTargets: true }
    warnings.push(`beat ${beat.id}: no explicit target matched; falling back to region matching`)
    // Fall through to the region expansion below.
  }

  const matches: ChannelMatch[] = []
  const seen = new Set<string>()
  for (const region of beat.regions) {
    for (const device of ctx.snapshot.devices) {
      for (const channel of device.channels) {
        if (channel.kind !== 'level') continue
        if (!channelMatchesRegion(channel, region, ctx)) continue
        const key = matchKey(device.id, channel.id)
        if (seen.has(key)) continue
        seen.add(key)
        matches.push({ device, channel, target: undefined, fromFallback: false })
      }
    }
  }
  if (matches.length > 0) return { matches: sortMatches(matches, true), fromTargets: false }

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
  return { matches: sortMatches(fallback), fromTargets: false }
}

/**
 * Does one channel serve the requested region?
 *
 * Direct equality comes first: a player-named region is its own id and needs
 * no alias. Host-provided aliases then bridge the pack's vocabulary onto the
 * player's words. Explicit `beats[].targets` never reach this function — a
 * script that names devices bypasses region expansion entirely.
 */
function channelMatchesRegion(
  channel: ResolveChannelSnapshot,
  region: string,
  ctx: ResolveContext,
): boolean {
  if (region === WHOLE_BODY_REGION) return true
  if (channel.region === region) return true
  const aliases = ctx.regionAliases
  if (aliases === undefined || channel.region === undefined) return false
  const names = aliases.get(region)
  return names !== undefined && names.includes(channel.region)
}

/**
 * Apply the intent's distribution policy to region-expanded matches.
 *
 * Only matches that *actually came from* `beats[].targets` bypass the policy:
 * a script that names devices means it. The target→region fallback is a
 * region route and must honour distribution; keying off
 * `beat.targets !== undefined` let `primary`/`round-robin` silently dispatch
 * every channel (ui-v12-review §P2-2). Round-robin is only reachable when a
 * pack declares it (§4.4 step 5 / §8.1 #5).
 */
function selectMatches(
  matches: readonly ChannelMatch[],
  fromTargets: boolean,
  intent: FeedbackIntent,
  ctx: ResolveContext,
): readonly ChannelMatch[] {
  if (fromTargets) return matches
  const distribution: IntentDistribution = intent.distribution ?? 'synced'
  if (distribution === 'primary') {
    const first = matches[0]
    return first === undefined ? [] : [first]
  }
  if (distribution === 'round-robin') {
    if (matches.length === 0) return []
    // Rotate over deliverable channels when any exist: a cursor landing on an
    // offline duplicate of the same region must not silence a turn that
    // another device could play (P1-2's round-robin variant). All-offline
    // matches keep the old path and end up narrative-only.
    const ready = matches.filter(match => match.device.lifecycle === 'ready')
    const pool = ready.length > 0 ? ready : matches
    const cursor = ctx.roundRobinCursor
    const raw = cursor === undefined || !Number.isFinite(cursor) ? 0 : Math.trunc(cursor)
    const index = ((raw % pool.length) + pool.length) % pool.length
    const chosen = pool[index]
    return chosen === undefined ? [] : [chosen]
  }
  return matches
}

/**
 * Deterministic order for a beat's matches.
 *
 * Region expansion passes `readyFirst`: a registered but not-ready device
 * still matches the region, and {@link buildCommand} will drop it. If it
 * sorted ahead of a deliverable channel, `primary` would spend the beat's one
 * slot on a device that cannot run, leaving the whole beat silent even though
 * a ready channel serves the same region (adversarial review P1-2). Lifecycle
 * therefore ranks first, while the long-standing device/channel-id order is
 * kept inside each group so the resolved JSON stays byte-stable. Explicit
 * `beats[].targets` and the all-online fallback keep the original id-only
 * order (their semantics must not change).
 */
function sortMatches(matches: ChannelMatch[], readyFirst = false): ChannelMatch[] {
  return matches.sort((left, right) => {
    if (readyFirst) {
      const byReady = readyRank(left) - readyRank(right)
      if (byReady !== 0) return byReady
    }
    const byDevice = compareStrings(left.device.id, right.device.id)
    if (byDevice !== 0) return byDevice
    return compareStrings(left.channel.id, right.channel.id)
  })
}

/** 0 for a deliverable device, 1 for everything else (stable partition key). */
function readyRank(match: ChannelMatch): number {
  return match.device.lifecycle === 'ready' ? 0 : 1
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
    request: result.request,
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
      // A stop is an explicit zero request; keep it in the same shape so the
      // audit shows why no intensity was applied.
      request: { strength, targetPercent: 0, requestedPercent: 0 },
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
      // A waveform change's amplitude comes from the beat strength; there is
      // no targetPercent/deltaPercent for this branch.
      request: { strength, requestedPercent: strengthRelativePercent(strength) },
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
      request: {
        strength,
        requestedPercent: requested,
        ...(change.targetPercent === undefined ? {} : { targetPercent: change.targetPercent }),
        ...(change.deltaPercent === undefined ? {} : { deltaPercent: change.deltaPercent }),
      },
    }
  }

  // No change: fall back to the intent's suggestion (§4.4 step 3).
  const suggest = intent.suggest
  const percent = strengthTargetPercent(policy, strength)
  const requestedPercent = strengthRelativePercent(strength)
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
      request: { strength, requestedPercent },
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
      request: { strength, requestedPercent },
    }
  }

  return {
    body: { kind: 'level', percent, durationSec: timing.durationSec },
    clamped: timing.clamped,
    degraded: undefined,
    request: { strength, requestedPercent },
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
 * §4.4 step 7 / §4.5: a missing waveform degrades instead of throwing. When the
 * session exposes a default waveform and the channel can play one, the request
 * falls back to that asset; otherwise it becomes a plain pattern. A channel
 * that cannot play any waveform always becomes a plain pattern.
 *
 * The returned id is the **resolved waveform's canonical id**, not the request
 * reference. The lookup accepts pack-relative references (`tentacle-crawl`),
 * `builtin:` refs and fully namespaced ids, but dispatch goes to the registry,
 * whose library is keyed by canonical ids (`tentacle-shadow:tentacle-crawl`,
 * `tide`). Echoing the reference made every packed suggestion fail at dispatch
 * with UNKNOWN_WAVEFORM after the model had already committed to the plan
 * (play-session audit).
 */
function resolveWaveform(
  reference: string | undefined,
  channel: ResolveChannelSnapshot,
  ctx: ResolveContext,
  beatId: string,
  warnings: string[],
): { waveformId?: string; degraded: ResolvedCommand['degraded'] } {
  if (reference === undefined) return { degraded: undefined }
  const waveform = ctx.waveforms.get(reference)
  if (waveform === undefined) {
    const fallback = defaultWaveformOf(ctx, channel)
    if (fallback !== undefined) {
      warnings.push(
        `beat ${beatId}: waveform "${reference}" was not found; using the session default waveform "${fallback.id}"`,
      )
      return { waveformId: fallback.id, degraded: 'unknown-waveform' }
    }
    warnings.push(`beat ${beatId}: waveform "${reference}" was not found; falling back to a plain pattern`)
    return { degraded: 'unknown-waveform' }
  }
  if (channel.supportsWaveform !== true) {
    warnings.push(
      `beat ${beatId}: ${channel.id} cannot play waveform "${reference}"; falling back to a plain pattern`,
    )
    return { degraded: 'unsupported-waveform' }
  }
  return { waveformId: waveform.id, degraded: undefined }
}

/**
 * The session default waveform an unknown reference may fall back to.
 *
 * Only a waveform-capable channel can use it; when no default is configured or
 * the lookup cannot resolve it, the caller keeps the plain-pattern degradation.
 */
function defaultWaveformOf(ctx: ResolveContext, channel: ResolveChannelSnapshot): Waveform | undefined {
  if (channel.supportsWaveform !== true) return undefined
  const id = ctx.defaultWaveformId
  if (id === undefined) return undefined
  return ctx.waveforms.get(id)
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
