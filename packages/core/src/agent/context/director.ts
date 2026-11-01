/**
 * The director's context projection (B2-T1).
 *
 * The director and the writer read the **same** session state through two
 * projections (`导演与写作上下文契约.md` §0). This module builds the director's
 * half: hard constraints, time, phase, the intent menu, device *capability*,
 * probe *verdicts*, a thin state/dialog summary and the output schema. It
 * deliberately contains nothing that belongs to the writer:
 *
 * - **no persona prose** — only the engine-extracted `## 导演摘要` section
 *   (`personaSummary`); the full `persona.md` is not even accepted by the
 *   signature (§4.9.3 structural test);
 * - **no corpus, no long setting text, no full dialog history** — only the
 *   last few one-line summaries and the previous turn's `line`;
 * - **no device percentages and no raw probe measurements** — device levels
 *   collapse to `low/med/high/none`, probes collapse to `verdict` + a coarse
 *   direction. The projector reads `RegistrySnapshot` because that is the
 *   only fact source, and drops every number on the way out.
 *
 * ## Purity and byte stability
 *
 * {@link buildDirectorContext} is a **pure function**: no clock, no
 * randomness, no I/O, no mutation of the input. Every collection is copied
 * and either preserved in its deterministic input order (boundaries, intent
 * regions — order carries `primary` semantics, dialog chronology) or sorted
 * with a code-unit comparator (intents by id, devices by id, probe targets
 * untouched). Object keys are written in the fixed order of
 * {@link DirectorContext}, so the same input serialises to the same bytes on
 * every call — no `localeCompare`, which would vary with the host locale.
 *
 * ## Budget and degradation
 *
 * Core carries no tokenizer, so the budget is measured in **characters**:
 * {@link DIRECTOR_CONTEXT_BUDGET_TOKENS} × {@link DIRECTOR_CHARS_PER_TOKEN}
 * ⇒ {@link DIRECTOR_CONTEXT_BUDGET_CHARS}. The 1.5 characters-per-token ratio
 * is a checked compromise for this content mix: the JSON schema, keys and ids
 * are ASCII (roughly 3–4 characters per token), while the narrative facts
 * (meanings, goal, boundaries) are Chinese (roughly one token per character).
 * Weighted by the schema's share of the projection the mix measures well above
 * 1.5 characters per token, so dividing by 1.5 counts **more** tokens than a
 * real tokenizer would — the estimate leans high, and the JSON rendering
 * (quotes, punctuation, key names) is counted too.
 *
 * Over budget, blocks are sacrificed in exactly the contract order
 * (`M2-实施计划.md` §4.9.3, director row):
 *
 * 1. fewer intent entries ({@link DIRECTOR_DEGRADED_INTENT_LIMIT});
 * 2. the dialog summary collapses to its last sentence;
 * 3. the phase goal collapses to a headline
 *    ({@link DIRECTOR_PHASE_GOAL_HEADLINE_CHARS}).
 *
 * `boundaries` is **never** cut or reordered: if the boundaries alone cannot
 * fit, the projection returns over budget on purpose, because a cut boundary
 * is a safety regression rather than a style regression (the same rule the
 * writer prompt follows, `agent/prompt.ts`).
 *
 * ## Ownership and one open seam
 *
 * `M2-实施计划.md` §4.2 specifies a `ProbeDirectorEntry` for
 * `sensors/probe-projection.ts` (A2-T4): `probeId`, `beatId`, `intentId`,
 * `verdict`, `direction`, `targets` — "只给方向，不给数值". That module has
 * since landed, but its `ProbeDirectorEntry` additionally exposes the raw
 * `delta`, the degrade `reason` and a `magnitude` band. B2-T1's hard rule is
 * that the director projection carries **no raw probe numbers**, and this
 * task's declared dependencies do not include A2-T4, so this module keeps its
 * own self-contained, digit-free `DirectorProbeEntry` (the §4.2 fields).
 * Reconciling the two shapes (and whether the director should also see
 * `magnitude`) is a Lead call; until then the local name keeps both exportable
 * from `index.ts` without a collision.
 *
 * `DirectorSessionFact` is a structural subset of `state/store.ts`'s
 * `SessionState` (§4.7.1, B2-T9): the whole `SessionState` is assignable, so
 * the engine never has to convert.
 *
 * @module
 */

import type { RegistrySnapshot } from '../../devices/registry.ts'
import type { IntentDistribution } from '../../scenario/beat-plan.ts'
import type { FeedbackIntent } from '../../scenario/intents.ts'
import type { PhaseMachine } from '../../scenario/phases.ts'
import type { ProbeRecord, ProbeTarget, ProbeVerdict } from '../../sensors/probe.ts'
import { PROMPT_TRUNCATION_MARK } from '../prompt.ts'
import { M2_TOOL_SCHEMAS_BY_NAME } from '../tools.ts'

/** Approximate token ceiling for the director projection (2–4k per contract §2). */
export const DIRECTOR_CONTEXT_BUDGET_TOKENS = 4_000

/**
 * Characters per token assumed when no tokenizer exists.
 *
 * Conservative for Chinese-heavy prompt text; see the module doc. Truncating
 * a little early is safe, leaking a block past the context window is not.
 */
export const DIRECTOR_CHARS_PER_TOKEN = 1.5

/** Character budget derived from {@link DIRECTOR_CONTEXT_BUDGET_TOKENS}. */
export const DIRECTOR_CONTEXT_BUDGET_CHARS = Math.floor(
  DIRECTOR_CONTEXT_BUDGET_TOKENS * DIRECTOR_CHARS_PER_TOKEN,
)

/** How many dialog summaries survive the base projection (contract: 3–5). */
export const DIRECTOR_DIALOG_SUMMARY_LIMIT = 5

/** How many settled probes the director sees (contract §2: the latest 3). */
export const DIRECTOR_PROBE_LIMIT = 3

/** How many previous beats the director sees (contract §2: the latest 2). */
export const DIRECTOR_RECENT_BEAT_LIMIT = 2

/** Intent entries kept by degradation step ① (the menu only shrinks if larger). */
export const DIRECTOR_DEGRADED_INTENT_LIMIT = 8

/** Phase-goal headline length kept by degradation step ③. */
export const DIRECTOR_PHASE_GOAL_HEADLINE_CHARS = 60

/**
 * How strong a channel was last driven. A band, never a percentage.
 *
 * `none` means "not driven (or driven to zero) since the last snapshot", per
 * `导演与写作上下文契约.md` §2. The draft's `cooling` value is gone: M2 has no
 * forced cooldown (D23, 冻结修订记录), and the director must not believe in one.
 */
export type DirectorLevel = 'none' | 'low' | 'med' | 'high'

/** Coarse change direction of a probe; the raw deltas never leave this module. */
export type DirectorProbeDirection = 'up' | 'flat' | 'unknown'

/**
 * The part of `SessionState` (§4.7.1) the director may read.
 *
 * A structural subset: a full `SessionState` is assignable unchanged. `flags`
 * and `player` are passed through as the caller's JSON values (the only
 * narrative continuity the director needs besides `lastLine`/`recentBeats`);
 * long prose such as `scene`/`npcs` is intentionally not read.
 */
export interface DirectorSessionFact {
  /** Whole minutes since the session started (`SessionState.elapsedMin`). */
  readonly elapsedMin: number
  /** Turn counter, used only as a label in the state summary. */
  readonly turn?: number
  /** `active | paused | recovered | ended`; passed through when present. */
  readonly status?: string
  /** Story flags (`SessionState.flags`). */
  readonly flags?: Readonly<Record<string, unknown>>
  /** Player resources / form of address (`SessionState.player`). */
  readonly player?: Readonly<Record<string, unknown>>
  /** The previous turn's line, verbatim; the only prose the director sees. */
  readonly lastLine?: string
  /** The last two turns' intent ids, oldest first. */
  readonly recentBeats?: readonly string[]
}

/** The fields of a settled probe this projection reads. `ProbeRecord` is assignable. */
export type DirectorProbeFact = Pick<
  ProbeRecord,
  'probeId' | 'beatId' | 'intentId' | 'verdict' | 'actionAt' | 'targets' | 'delta'
>

/** One device as the director sees it: region, level band, availability. No numbers. */
export interface DirectorDeviceView {
  readonly deviceId: string
  /** The one region every level channel declares, or `undefined` when they differ. */
  readonly region: string | undefined
  /** Every region declared by a level channel, sorted; `whole-body` stays literal. */
  readonly regions: readonly string[]
  /** Number of addressable `level` channels on the device. */
  readonly channels: number
  /** Highest band across the device's level channels; `none` when nothing was driven. */
  readonly level: DirectorLevel
  /** True when at least one level channel accepts a waveform. */
  readonly waveformAvailable: boolean
  /** True when the registry reports `lifecycle: 'ready'`. */
  readonly available: boolean
}

/** One intent the director may choose, with the regions it can reach. */
export interface DirectorIntentView {
  readonly id: string
  readonly meaning: string
  /** Declaration order is preserved: `distribution: 'primary'` reads the first one. */
  readonly regions: readonly string[]
  /** The pack's choice, or the resolver's own fallback (`synced`). */
  readonly distribution: IntentDistribution
}

/** One settled probe, projected so that no measurement survives (§4.2 fields). */
export interface DirectorProbeEntry {
  readonly probeId: string
  readonly beatId: string
  readonly intentId: string
  readonly verdict: ProbeVerdict
  /** Coarse direction derived from `verdict` (+ the sign of a delta when present). */
  readonly direction: DirectorProbeDirection
  readonly targets: readonly ProbeTarget[]
}

/** Time budget and closing pressure. */
export interface DirectorTimeView {
  readonly elapsedMin: number
  /** `null` for an open-ended session. */
  readonly remainingMin: number | null
  /** True from 90% of the planned time on: the next plan must resolve. */
  readonly mustResolve: boolean
}

/** The current phase: where the session is, where it may go, how long it has sat. */
export interface DirectorPhaseView {
  readonly id: string
  /** Long prose when there is budget; a headline after degradation step ③. */
  readonly goal: string
  readonly allowedNext: readonly string[]
  readonly dwellMin: number
}

/**
 * The director's whole world.
 *
 * Key order is frozen: `JSON.stringify` of this object is the byte-stable
 * snapshot the snapshot tests compare. Adding a field means appending it and
 * updating the projections' spec.
 */
export interface DirectorContext {
  /** Hard constraints, highest priority, first block, never truncated. */
  readonly boundaries: readonly string[]
  readonly time: DirectorTimeView
  readonly phase: DirectorPhaseView
  readonly intents: readonly DirectorIntentView[]
  readonly devices: readonly DirectorDeviceView[]
  readonly probes: readonly DirectorProbeEntry[]
  readonly recentBeats: readonly string[]
  /** Minimal continuity set: current phase, turn/status, flags, player. */
  readonly state: Readonly<Record<string, unknown>>
  readonly dialogSummary: readonly string[]
  readonly lastLine: string | undefined
  readonly personaSummary: string | undefined
  readonly hostRhythm: string | undefined
  /** `BeatPlan` JSON schema minus the engine fields (`apply_plan` arguments). */
  readonly outputSchema: Readonly<Record<string, unknown>>
}

/**
 * Everything the projector may read.
 *
 * Structural guarantee (§4.9.3): there is **no** `persona` field — only
 * `personaSummary`, the engine-extracted `## 导演摘要` section. There is also
 * no clock, no audit log and no `line` from earlier turns.
 *
 * `state.recentBeats` / `state.lastLine` carry the plan-row's `recentBeats` /
 * `lastLine` inputs (§3.4): they are session facts, not separate parameters.
 */
export interface DirectorContextInput {
  readonly state: DirectorSessionFact
  readonly phase: PhaseMachine
  readonly intents: ReadonlyMap<string, FeedbackIntent>
  readonly snapshot: RegistrySnapshot
  readonly probes: readonly DirectorProbeFact[]
  readonly boundaries: readonly string[]
  /** The `## 导演摘要` extract; never the full persona text. */
  readonly personaSummary: string | undefined
  /** `host.md`'s rhythm/forbidden/closing sections; never the full host text. */
  readonly hostRhythm: string | undefined
  /** The last few one-line dialog summaries, oldest first. */
  readonly dialogSummary: readonly string[]
  /** Planned session length in minutes; `null`/omitted = open-ended. */
  readonly plannedMin?: number | null
  /** Elapsed minutes when the current phase was entered; defaults to 0. */
  readonly phaseEnteredMin?: number
  /** Character-budget override; primarily for tests and embedding. */
  readonly budgetChars?: number
}

/** Limits used by the degradation ladder; `Infinity` = "do not cut". */
interface DirectorLimits {
  readonly intentLimit: number
  readonly dialogLimit: number
  readonly phaseGoalChars: number
}

const FULL_LIMITS: DirectorLimits = {
  intentLimit: Number.POSITIVE_INFINITY,
  dialogLimit: DIRECTOR_DIALOG_SUMMARY_LIMIT,
  phaseGoalChars: Number.POSITIVE_INFINITY,
}

/** Cumulative stages, in the contract's sacrifice order. */
const DEGRADATION_LADDER: readonly DirectorLimits[] = [
  FULL_LIMITS,
  { ...FULL_LIMITS, intentLimit: DIRECTOR_DEGRADED_INTENT_LIMIT },
  { ...FULL_LIMITS, intentLimit: DIRECTOR_DEGRADED_INTENT_LIMIT, dialogLimit: 1 },
  {
    ...FULL_LIMITS,
    intentLimit: DIRECTOR_DEGRADED_INTENT_LIMIT,
    dialogLimit: 1,
    phaseGoalChars: DIRECTOR_PHASE_GOAL_HEADLINE_CHARS,
  },
]

/** The `apply_plan` argument schema: the only output the director may produce. */
const DIRECTOR_OUTPUT_SCHEMA = M2_TOOL_SCHEMAS_BY_NAME.apply_plan.parameters

const LEVEL_ORDER: Readonly<Record<DirectorLevel, number>> = {
  none: 0,
  low: 1,
  med: 2,
  high: 3,
}

/**
 * Build the director's projection of one turn.
 *
 * Pure: no clock, no randomness, no I/O, no input mutation. The returned
 * object always has the same key order for the same input, so
 * `JSON.stringify(buildDirectorContext(input))` is byte-stable.
 *
 * Degradation order (only when the result would exceed `budgetChars`):
 * ① fewer intents, ② dialog summary → last sentence, ③ phase goal → headline.
 * Boundaries are never cut (see the module doc).
 */
export function buildDirectorContext(input: DirectorContextInput): DirectorContext {
  const budgetChars = resolveBudgetChars(input.budgetChars)
  for (const limits of DEGRADATION_LADDER) {
    const context = assemble(input, limits)
    if (JSON.stringify(context).length <= budgetChars) return context
  }
  // Even the last stage is over budget (boundaries alone can do that): return
  // the most-degraded projection rather than cut a hard constraint.
  return assemble(input, DEGRADATION_LADDER[DEGRADATION_LADDER.length - 1]!)
}

/**
 * Estimate the tokens of a rendered projection.
 *
 * Character-based approximation for a core that has no tokenizer: see
 * {@link DIRECTOR_CHARS_PER_TOKEN}. UTF-16 length is used (surrogate pairs
 * count twice), which only ever over-estimates.
 */
export function estimateDirectorTokens(text: string): number {
  return Math.ceil(text.length / DIRECTOR_CHARS_PER_TOKEN)
}

function assemble(input: DirectorContextInput, limits: DirectorLimits): DirectorContext {
  const phase = input.phase
  const elapsedMin = nonNegative(input.state.elapsedMin) ?? 0
  // A non-positive planned length is "no plan", not a zero-length session.
  const planned = input.plannedMin
  const plannedMin = planned !== null && planned !== undefined && Number.isFinite(planned) && planned > 0
    ? planned
    : null
  const remainingMin = plannedMin === null ? null : Math.max(0, plannedMin - elapsedMin)
  // Open-ended sessions pass 0; `PhaseMachine.at` clamps defensively anyway.
  const ratio = plannedMin === null ? 0 : elapsedMin / plannedMin
  const phaseEnteredMin = nonNegative(input.phaseEnteredMin) ?? 0

  const intents = [...input.intents.values()]
    .sort((left, right) => compareStrings(left.id, right.id))
    .slice(0, limits.intentLimit)
    .map(intent => ({
      id: intent.id,
      meaning: intent.meaning,
      regions: [...intent.regions],
      // Same fallback the resolver uses (`scenario/intents.ts`), so the menu
      // never claims a distribution the executor would not apply.
      distribution: intent.distribution ?? 'synced',
    }) satisfies DirectorIntentView)

  const devices = [...input.snapshot.devices]
    .sort((left, right) => compareStrings(left.id, right.id))
    .map(device => projectDevice(device))

  const probes = [...input.probes]
    .sort(compareProbes)
    // Chronological order is preserved; the caller gets the latest 3 only.
    .slice(-DIRECTOR_PROBE_LIMIT)
    .map(probe => projectProbe(probe))

  const state: Readonly<Record<string, unknown>> = {
    // The phase machine is the only writer of the current phase (§4.7.1).
    currentPhase: phase.current,
    ...(input.state.turn === undefined ? {} : { turn: input.state.turn }),
    ...(input.state.status === undefined ? {} : { status: input.state.status }),
    ...(input.state.flags === undefined ? {} : { flags: input.state.flags }),
    ...(input.state.player === undefined ? {} : { player: input.state.player }),
  }

  return {
    boundaries: [...input.boundaries],
    time: {
      elapsedMin,
      remainingMin,
      mustResolve: phase.at(ratio).mustResolve,
    },
    phase: {
      id: phase.current,
      goal: clipHeadline(phase.currentPhase.goal, limits.phaseGoalChars),
      allowedNext: [...phase.allowedNext],
      dwellMin: Math.max(0, elapsedMin - phaseEnteredMin),
    },
    intents,
    devices,
    probes,
    recentBeats: (input.state.recentBeats ?? []).slice(-DIRECTOR_RECENT_BEAT_LIMIT),
    state,
    dialogSummary: input.dialogSummary.slice(-limits.dialogLimit),
    lastLine: input.state.lastLine,
    personaSummary: input.personaSummary,
    hostRhythm: input.hostRhythm,
    outputSchema: DIRECTOR_OUTPUT_SCHEMA,
  }
}

function projectDevice(device: RegistrySnapshot['devices'][number]): DirectorDeviceView {
  const levelChannels = device.channels.filter(channel => channel.kind === 'level')
  const declared = new Set<string>()
  for (const channel of levelChannels) {
    const region = regionOf(channel)
    if (region !== undefined) declared.add(region)
  }
  const regions = [...declared].sort(compareStrings)
  const only = regions.length === 1 ? regions[0] : undefined
  // A single `region` is only truthful when every levelled channel agrees on
  // it; a device that spans several regions reports `undefined` plus the list.
  const region = only !== undefined && levelChannels.every(channel => regionOf(channel) === only)
    ? only
    : undefined

  let level: DirectorLevel = 'none'
  for (const channel of levelChannels) {
    const band = bandOf(channel)
    if (LEVEL_ORDER[band] > LEVEL_ORDER[level]) level = band
  }

  return {
    deviceId: device.id,
    region,
    regions,
    channels: levelChannels.length,
    level,
    waveformAvailable: levelChannels.some(channel => channel.supportsWaveform),
    available: device.lifecycle === 'ready',
  }
}

function projectProbe(probe: DirectorProbeFact): DirectorProbeEntry {
  return {
    probeId: probe.probeId,
    beatId: probe.beatId,
    intentId: probe.intentId,
    verdict: probe.verdict,
    direction: directionOf(probe),
    targets: probe.targets.map(target => ({ deviceId: target.deviceId, channelId: target.channelId })),
  }
}

/**
 * Translate a verdict (plus the *sign* of a delta) into a coarse direction.
 *
 * No threshold and no magnitude: the writer's brief owns the narrative
 * reading, and the director only needs "did it move, and which way".
 */
function directionOf(probe: DirectorProbeFact): DirectorProbeDirection {
  if (probe.verdict === 'responded') return 'up'
  if (probe.verdict === 'none') return 'flat'
  if (probe.verdict === 'unavailable') return 'unknown'
  // `ambiguous`: a positive delta is still a detected rise; otherwise unknown.
  const delta = probe.delta
  if (delta === undefined) return 'unknown'
  return delta.motion > 0 || delta.audioPct > 0 ? 'up' : 'flat'
}

/** Last written percent → band, relative to the channel's effective cap. */
function bandOf(channel: RegistrySnapshot['devices'][number]['channels'][number]): DirectorLevel {
  const percent = channel.percent
  if (!(percent > 0)) return 'none'
  const cap = channel.maxPercent
  const ratio = cap > 0 ? percent / cap : 1
  if (ratio <= 1 / 3) return 'low'
  if (ratio <= 2 / 3) return 'med'
  return 'high'
}

/**
 * Read `Channel.region` structurally until B2-T10 adds the field to
 * `ChannelSnapshot`; the cast is the same widening `scenario/intents.ts` uses,
 * so this module compiles against both shapes without a migration.
 */
function regionOf(
  channel: RegistrySnapshot['devices'][number]['channels'][number],
): string | undefined {
  const region = (channel as typeof channel & { readonly region?: string }).region
  return region === undefined || region === '' ? undefined : region
}

/** Deterministic code-unit comparison; `localeCompare` would depend on the host locale. */
function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function compareProbes(left: DirectorProbeFact, right: DirectorProbeFact): number {
  const leftAt = Number.isFinite(left.actionAt) ? left.actionAt : 0
  const rightAt = Number.isFinite(right.actionAt) ? right.actionAt : 0
  return leftAt === rightAt ? compareStrings(left.probeId, right.probeId) : leftAt - rightAt
}

/** Keep the head of a long phase goal; `Infinity` means "no cut". */
function clipHeadline(goal: string, limit: number): string {
  if (limit <= 0) return ''
  const points = Array.from(goal)
  if (points.length <= limit) return goal
  if (limit === 1) return PROMPT_TRUNCATION_MARK
  return `${points.slice(0, limit - 1).join('')}${PROMPT_TRUNCATION_MARK}`
}

function nonNegative(value: number | undefined): number | null {
  if (value === undefined || !Number.isFinite(value)) return null
  return Math.max(0, value)
}

function resolveBudgetChars(requested: number | undefined): number {
  if (requested !== undefined && Number.isFinite(requested) && requested > 0) {
    return Math.floor(requested)
  }
  return DIRECTOR_CONTEXT_BUDGET_CHARS
}
