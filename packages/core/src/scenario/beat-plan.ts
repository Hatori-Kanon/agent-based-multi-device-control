/**
 * The control contract a turn hands the hardware, and the validator that
 * guards it.
 *
 * `parseBeatPlan` is the only gate between raw model output and the resolver.
 * Two properties are load-bearing:
 *
 * 1. **It never throws.** A malformed plan degrades to an empty plan plus a
 *    `dropped` list, so one bad tool call costs a narrative-only turn instead
 *    of the session.
 * 2. **It holds only what the contract allows.** Illegal beats, choices,
 *    targets and fields are removed here rather than repaired with defaults
 *    the model would then believe it asked for.
 *
 * Structural invariant (`M2-实施计划.md` §4.3): the output carries no
 * `line`/`text` field. Prose is the writer's job; the plan never contains it.
 */

import type { FeedbackIntent } from './intents.ts'

/** Reserved wildcard region that matches every level channel (§4.6.3). */
export const WHOLE_BODY_REGION = 'whole-body'

/** How hard a beat drives its channels. The only narrative intensity scale. */
export type BeatStrength = 'low' | 'med' | 'high'

/** Narrative pacing of a whole plan. */
export type PlanPacing = 'hold' | 'build' | 'release' | 'probe'

/** How one intent spreads over the channels it matched (§8.1 #5). */
export type IntentDistribution = 'synced' | 'primary' | 'round-robin'

/**
 * Optional runtime modulation of a selected waveform (D16).
 *
 * Parsed and range-checked only: M2 never applies it, so a plan may carry the
 * field without any backend learning about it. The modulation itself lands in
 * M3+ (`M2-实施计划.md` §8.6).
 */
export interface WaveformModulation {
  /** Playback rate multiplier, 0.5-2. */
  readonly rate?: number
  /** Waveform intensity multiplier, 0-1. */
  readonly intensityScale?: number
  /** Phase offset in cycles, 0-1. */
  readonly phaseOffset?: number
}

/**
 * A change to apply on top of the intent's suggestion.
 *
 * For `kind: 'level'` the target is resolved with a three-step priority
 * (D8): absolute `targetPercent` first, then `deltaPercent` relative to the
 * channel's current level, then the beat's `strength` conversion. Both
 * numeric fields may be omitted, which leaves the strength conversion in
 * charge — a strength-only level change is legal.
 */
export interface BeatChange {
  readonly kind: 'level' | 'waveform'
  /** `kind='level'`: absolute target percentage, 0-100, clamped to the channel cap. */
  readonly targetPercent?: number
  /** `kind='level'`: offset from the channel's current level, -20..+20. */
  readonly deltaPercent?: number
  /** `kind='waveform'`. */
  readonly waveformId?: string
  /**
   * Hold time in seconds, 1-600.
   *
   * `kind='waveform'` requires it. `kind='level'` also accepts it, as an
   * **authorised part of the contract** (§4.3): a level change may say how
   * long the level should be held, and the resolver keeps that duration while
   * clamping it to the channel's `maxDurationSec` at dispatch time (R4).
   */
  readonly durationSec?: number
  /**
   * Runtime modulation of the selected waveform (D16, D9's "texture travels
   * with the change").
   *
   * Parsed and range-checked only — M2 never applies it (`M2-实施计划.md`
   * §8.6). The beat-level {@link Beat.texture} field is kept as well, for
   * plans that put the modulation on the beat instead.
   */
  readonly texture?: WaveformModulation
}

/** One channel a beat drives explicitly, overriding the beat defaults field by field. */
export interface BeatTarget {
  readonly deviceId: string
  readonly channelId: string
  /** Defaults to the beat's change. */
  readonly change?: BeatChange
  /** Defaults to the beat's strength. */
  readonly strength?: BeatStrength
}

/** One narrative action inside a turn's plan. */
export interface Beat {
  /** Unique within the plan. */
  readonly id: string
  /** Must exist in the current intent table. */
  readonly intentId: string
  /** Region ids declared by the scene; never empty after parsing. */
  readonly regions: readonly string[]
  /** Overrides `intent.suggest`. */
  readonly change?: BeatChange
  readonly strength: BeatStrength
  readonly mustMention?: boolean
  /** Per-device overrides. */
  readonly targets?: readonly BeatTarget[]
  /** D16: parsed and range-checked only, never applied in M2. */
  readonly texture?: WaveformModulation
}

/** One player-facing option. Selecting one is a player message. */
export interface PlayerChoice {
  /** Unique within the plan, e.g. `'c1'`..`'c3'`. */
  readonly id: string
  /** 1-20 characters, no digits, no device parameters. */
  readonly label: string
  readonly tag: 'resist' | 'passive' | 'plead' | 'comply' | (string & {})
}

/** Everything the executor needs for one turn. Contains no prose. */
export interface BeatPlan {
  /** Injected by the engine; the model never writes it. */
  readonly turnId: number
  /** Injected by the engine. */
  readonly phase: string
  readonly pacing: PlanPacing
  /** Suggested gap before the next turn; the engine clamps it to [10, 60]. */
  readonly nextTurnAfterSec?: number
  readonly beats: readonly Beat[]
  readonly choices?: readonly PlayerChoice[]
  readonly lineGuidance?: {
    readonly tone?: string
    /** Redundant field: `beats[].mustMention` wins (§8.1 #10). */
    readonly mustMentionBeatIds?: readonly string[]
  }
}

/** What the validator needs to know about the current pack. */
export interface PlanContext {
  readonly intents: ReadonlyMap<string, FeedbackIntent>
  readonly regions: readonly string[]
  /**
   * Engine-injected turn identity. `parseBeatPlan` takes `turnId`/`phase`
   * **only** from here: the raw plan is model output, so copies found in it
   * are ignored with an "engine field ignored" warning (R3). Absent ⇒ `0`
   * silently — a caller without an engine context (schema-conformance tests,
   * read-only use) must not see warnings.
   */
  readonly turnId?: number
  /** Engine-injected phase id; same rule as {@link PlanContext.turnId}. Absent ⇒ `''`. */
  readonly phase?: string
  /** Default 3. */
  readonly maxBeats?: number
  /** Default 3. */
  readonly maxChoices?: number
}

/** One rejected element, kept for the `plan_resolved` audit detail. */
export interface PlanDrop {
  readonly beatId?: string
  readonly choiceId?: string
  /**
   * The rule that rejected the element:
   * `'intent' | 'region' | 'strength' | 'change' | 'choices' | 'target'`
   * per §4.3, plus `'plan' | 'pacing' | 'beats' | 'beat'` for plan-level and
   * beat-identity failures (`PlanDrop.rule` is a `string`, so this only
   * documents the canonical values).
   */
  readonly rule: string
  readonly reason: string
}

export interface PlanValidation {
  /** Illegal beats removed; every beat illegal ⇒ `beats: []`. */
  readonly plan: BeatPlan
  readonly dropped: readonly PlanDrop[]
  readonly warnings: readonly string[]
}

const DEFAULT_MAX_BEATS = 3
const DEFAULT_MAX_CHOICES = 3
const MAX_CHOICE_LABEL = 20
const MAX_RATE = 2
const MIN_RATE = 0.5
const MAX_DELTA_PERCENT = 20
const MAX_TARGET_PERCENT = 100
const MAX_CHANGE_DURATION_SEC = 600
const MIN_CHANGE_DURATION_SEC = 1
const DIGITS = /\p{Nd}/u

const PACING_VALUES: readonly PlanPacing[] = ['hold', 'build', 'release', 'probe']
const STRENGTH_VALUES: readonly BeatStrength[] = ['low', 'med', 'high']
const KNOWN_TOP_LEVEL = new Set([
  'beats',
  'choices',
  'lineGuidance',
  'nextTurnAfterSec',
  'pacing',
  'phase',
  'turnId',
])

type UnknownRecord = Record<string, unknown>

function asRecord(value: unknown): UnknownRecord | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  return value as UnknownRecord
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isBeatStrength(value: unknown): value is BeatStrength {
  return typeof value === 'string' && (STRENGTH_VALUES as readonly string[]).includes(value)
}

function isPlanPacing(value: unknown): value is PlanPacing {
  return typeof value === 'string' && (PACING_VALUES as readonly string[]).includes(value)
}

/** Human-readable rendering for drop reasons; must not throw on odd input. */
function describe(value: unknown): string {
  if (typeof value === 'string') return `"${value}"`
  if (typeof value === 'number' || typeof value === 'boolean' || value === undefined || value === null) {
    return String(value)
  }
  if (value instanceof Error) return value.message
  try {
    const json = JSON.stringify(value)
    if (json !== undefined) return json
  } catch {
    // Cyclic or otherwise unstringifiable: fall through to the type tag.
  }
  try {
    return Object.prototype.toString.call(value)
  } catch {
    return typeof value
  }
}

function resolveLimit(value: number | undefined, fallback: number, minimum: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback
  return Math.max(minimum, Math.floor(value))
}

function emptyPlan(turnId: number, phase: string): BeatPlan {
  return { turnId, phase, pacing: 'hold', beats: [] }
}

function beatIdOf(value: unknown): string | undefined {
  const record = asRecord(value)
  if (record === undefined) return undefined
  const id = record['id']
  return isNonEmptyString(id) ? id : undefined
}

/**
 * Validate raw model output into a plan.
 *
 * Never throws: anything unreadable becomes an empty plan with a `dropped`
 * entry, and every individually illegal element is removed while the rest of
 * the plan survives.
 *
 * `turnId`/`phase` are engine fields (R3): they come from `ctx` only, never
 * from the model's JSON.
 */
export function parseBeatPlan(raw: unknown, ctx: PlanContext): PlanValidation {
  try {
    return parsePlan(raw, ctx)
  } catch (error) {
    return {
      plan: emptyPlan(readTurnId(ctx), readPhase(ctx)),
      dropped: [{ rule: 'plan', reason: 'the beat plan could not be read; it was replaced by an empty plan' }],
      warnings: [`beat plan parser recovered from an unexpected value (${describe(error)})`],
    }
  }
}

function parsePlan(raw: unknown, ctx: PlanContext): PlanValidation {
  const dropped: PlanDrop[] = []
  const warnings: string[] = []
  const turnId = readTurnId(ctx)
  const phase = readPhase(ctx)
  const record = asRecord(raw)
  if (record === undefined) {
    dropped.push({ rule: 'plan', reason: `a beat plan must be a JSON object, got ${describe(raw)}` })
    return { plan: emptyPlan(turnId, phase), dropped, warnings }
  }

  warnIgnoredEngineFields(record, warnings)
  const pacing = readPacing(record, dropped)
  if (pacing === undefined) return { plan: emptyPlan(turnId, phase), dropped, warnings }

  // Forward compatibility (§4.3 rule 10): a newer model may send fields this
  // build does not know. They are ignored, but say so once per field.
  for (const key of Object.keys(record).filter(name => !KNOWN_TOP_LEVEL.has(name)).sort()) {
    warnings.push(`unknown top-level field ${describe(key)} was ignored`)
  }

  const beats = parseBeats(record['beats'], ctx, dropped, warnings)
  const choices = parseChoices(
    record['choices'],
    resolveLimit(ctx.maxChoices, DEFAULT_MAX_CHOICES, 0),
    dropped,
    warnings,
  )
  const lineGuidance = parseLineGuidance(record['lineGuidance'], new Set(beats.map(beat => beat.id)), warnings)
  const nextTurnAfterSec = readNextTurnAfterSec(record, warnings)

  const plan: BeatPlan = {
    turnId,
    phase,
    pacing,
    beats,
    ...(nextTurnAfterSec === undefined ? {} : { nextTurnAfterSec }),
    ...(choices === undefined ? {} : { choices }),
    ...(lineGuidance === undefined ? {} : { lineGuidance }),
  }
  return { plan, dropped, warnings }
}

/**
 * `turnId`/`phase` are engine fields: read them from the context only (R3).
 *
 * The raw plan is model output, so a copy found there proves nothing — it is
 * ignored and reported. A context without engine fields (schema-conformance
 * tests, read-only callers) is normal, not an error: it gets a safe default
 * and **no warning**, so `warnings` stays assertable and only ever describes
 * model output. An unusable supplied value is likewise defaulted silently —
 * the safety property comes from never trusting the raw JSON.
 */
function readTurnId(ctx: PlanContext): number {
  const value = ctx.turnId
  if (value === undefined) return 0
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) return value
  return 0
}

function readPhase(ctx: PlanContext): string {
  const value = ctx.phase
  if (value === undefined) return ''
  if (typeof value === 'string') return value
  return ''
}

/** Raw copies of engine fields are ignored (R3); say so once per field. */
function warnIgnoredEngineFields(record: UnknownRecord, warnings: string[]): void {
  for (const field of ['turnId', 'phase'] as const) {
    if (Object.prototype.hasOwnProperty.call(record, field)) {
      warnings.push(`engine field ${describe(field)} was ignored; the parser takes it from the context`)
    }
  }
}


function readPacing(record: UnknownRecord, dropped: PlanDrop[]): PlanPacing | undefined {
  const value = record['pacing']
  if (isPlanPacing(value)) return value
  dropped.push({
    rule: 'pacing',
    reason: `pacing must be one of ${PACING_VALUES.join('/')}, got ${describe(value)}; the whole plan was dropped`,
  })
  return undefined
}

function readNextTurnAfterSec(record: UnknownRecord, warnings: string[]): number | undefined {
  const value = record['nextTurnAfterSec']
  if (value === undefined) return undefined
  if (isFiniteNumber(value) && value > 0) return value
  warnings.push(`nextTurnAfterSec must be a finite positive number, got ${describe(value)}; using the engine default`)
  return undefined
}

function parseBeats(raw: unknown, ctx: PlanContext, dropped: PlanDrop[], warnings: string[]): Beat[] {
  if (!Array.isArray(raw)) {
    dropped.push({ rule: 'beats', reason: `beats must be an array, got ${describe(raw)}` })
    return []
  }
  if (raw.length === 0) {
    dropped.push({ rule: 'beats', reason: 'beats must contain at least one beat' })
    return []
  }
  const maxBeats = resolveLimit(ctx.maxBeats, DEFAULT_MAX_BEATS, 1)
  const beats: Beat[] = []
  const acceptedIds = new Set<string>()
  for (let index = 0; index < raw.length; index += 1) {
    const item = raw[index]
    if (beats.length >= maxBeats) {
      const beatId = beatIdOf(item)
      dropped.push({
        rule: 'beats',
        reason: `a plan accepts at most ${maxBeats} beats; ${raw.length - index} extra beat(s) were dropped`,
        ...(beatId === undefined ? {} : { beatId }),
      })
      continue
    }
    const beat = parseBeat(item, index, ctx, acceptedIds, dropped, warnings)
    if (beat !== undefined) {
      beats.push(beat)
      acceptedIds.add(beat.id)
    }
  }
  return beats
}

function parseBeat(
  raw: unknown,
  index: number,
  ctx: PlanContext,
  acceptedIds: ReadonlySet<string>,
  dropped: PlanDrop[],
  warnings: string[],
): Beat | undefined {
  const record = asRecord(raw)
  if (record === undefined) {
    dropped.push({ rule: 'beat', reason: `beat #${index + 1} must be an object, got ${describe(raw)}` })
    return undefined
  }

  const id = beatIdOf(record)
  if (id === undefined) {
    dropped.push({ rule: 'beat', reason: `beat #${index + 1} has no usable id` })
    return undefined
  }
  if (acceptedIds.has(id)) {
    dropped.push({ beatId: id, rule: 'beat', reason: `duplicate beat id ${describe(id)}; the later beat was dropped` })
    return undefined
  }

  const intentIdRaw = record['intentId']
  if (!isNonEmptyString(intentIdRaw)) {
    dropped.push({ beatId: id, rule: 'intent', reason: 'intentId must be a non-empty string' })
    return undefined
  }
  const intentId = intentIdRaw
  if (!ctx.intents.has(intentId)) {
    dropped.push({ beatId: id, rule: 'intent', reason: `unknown intentId ${describe(intentId)}` })
    return undefined
  }

  const strengthRaw = record['strength']
  if (!isBeatStrength(strengthRaw)) {
    dropped.push({
      beatId: id,
      rule: 'strength',
      reason: `strength must be one of ${STRENGTH_VALUES.join('/')}, got ${describe(strengthRaw)}`,
    })
    return undefined
  }
  const strength = strengthRaw

  const change = parseChange(record['change'], id, dropped, warnings)
  const regions = normaliseRegions(record['regions'], ctx, id, dropped, warnings)
  const targets = parseTargets(record['targets'], id, change, strength, dropped, warnings)
  const texture = parseTexture(record['texture'], id, warnings)

  let mustMention: boolean | undefined
  const mustMentionRaw = record['mustMention']
  if (mustMentionRaw !== undefined) {
    if (typeof mustMentionRaw === 'boolean') mustMention = mustMentionRaw
    else warnings.push(`beat ${id}: mustMention must be a boolean, got ${describe(mustMentionRaw)}; ignored`)
  }

  const beat: Beat = {
    id,
    intentId,
    regions,
    strength,
    ...(change === undefined ? {} : { change }),
    ...(mustMention === undefined ? {} : { mustMention }),
    ...(targets === undefined ? {} : { targets }),
    ...(texture === undefined ? {} : { texture }),
  }
  return beat
}

/**
 * Regions degrade rather than reject (§4.3 rule 3): unknown ids are removed
 * and reported both as a warning and as a `rule:'region'` drop detail, and a
 * beat left with nothing usable falls back to the wildcard region so the turn
 * can still act somewhere.
 */
function normaliseRegions(
  raw: unknown,
  ctx: PlanContext,
  beatId: string,
  dropped: PlanDrop[],
  warnings: string[],
): string[] {
  const declared = new Set(ctx.regions)
  const regions: string[] = []
  if (Array.isArray(raw)) {
    for (const value of raw) {
      if (!isNonEmptyString(value)) {
        warnings.push(`beat ${beatId}: region entries must be non-empty strings; ${describe(value)} was ignored`)
        continue
      }
      if (regions.includes(value)) continue
      if (value === WHOLE_BODY_REGION || declared.has(value)) {
        regions.push(value)
      } else {
        dropped.push({ beatId, rule: 'region', reason: `region ${describe(value)} is not declared by the pack` })
        warnings.push(`beat ${beatId}: region ${describe(value)} is not declared by the pack; removed`)
      }
    }
  } else if (raw !== undefined) {
    dropped.push({ beatId, rule: 'region', reason: `regions must be an array, got ${describe(raw)}` })
    warnings.push(`beat ${beatId}: regions must be an array, got ${describe(raw)}`)
  }
  if (regions.length === 0) {
    dropped.push({
      beatId,
      rule: 'region',
      reason: `no usable region was declared; fell back to ${describe(WHOLE_BODY_REGION)}`,
    })
    warnings.push(`beat ${beatId}: no usable region was given; falling back to ${describe(WHOLE_BODY_REGION)}`)
    regions.push(WHOLE_BODY_REGION)
  }
  return regions
}

function parseChange(
  raw: unknown,
  beatId: string,
  dropped: PlanDrop[],
  warnings: string[],
): BeatChange | undefined {
  if (raw === undefined) return undefined
  const record = asRecord(raw)
  if (record === undefined) {
    dropped.push({ beatId, rule: 'change', reason: `change must be an object, got ${describe(raw)}` })
    warnings.push(`beat ${beatId}: invalid change dropped; falling back to the intent suggestion`)
    return undefined
  }
  const kind = record['kind']
  if (kind === 'waveform') {
    const change = parseWaveformChange(record, beatId, dropped, warnings)
    if (change !== undefined) {
      warnIgnoredKeys(record, ['kind', 'waveformId', 'durationSec', 'texture'], beatId, 'change', warnings)
    }
    return change
  }
  if (kind === 'level') {
    const change = parseLevelChange(record, beatId, dropped, warnings)
    if (change !== undefined) {
      warnIgnoredKeys(
        record,
        ['kind', 'targetPercent', 'deltaPercent', 'durationSec', 'texture'],
        beatId,
        'change',
        warnings,
      )
    }
    return change
  }
  dropped.push({
    beatId,
    rule: 'change',
    reason: `change.kind must be 'level' or 'waveform', got ${describe(kind)}`,
  })
  warnings.push(`beat ${beatId}: invalid change dropped; falling back to the intent suggestion`)
  return undefined
}

/**
 * A level change is legal even with neither number present: both
 * `targetPercent` and `deltaPercent` are optional, and the strength
 * conversion stays in charge when they are absent (D8 priority).
 */
function parseLevelChange(
  record: UnknownRecord,
  beatId: string,
  dropped: PlanDrop[],
  warnings: string[],
): BeatChange {
  let targetPercent: number | undefined
  const targetRaw = record['targetPercent']
  if (targetRaw !== undefined) {
    if (isFiniteNumber(targetRaw) && targetRaw >= 0 && targetRaw <= MAX_TARGET_PERCENT) {
      targetPercent = targetRaw
    } else {
      dropped.push({
        beatId,
        rule: 'change',
        reason: `targetPercent must be a number from 0 to ${MAX_TARGET_PERCENT}, got ${describe(targetRaw)}`,
      })
      warnings.push(`beat ${beatId}: targetPercent was ignored`)
    }
  }

  let deltaPercent: number | undefined
  const deltaRaw = record['deltaPercent']
  if (deltaRaw !== undefined) {
    if (isFiniteNumber(deltaRaw) && deltaRaw >= -MAX_DELTA_PERCENT && deltaRaw <= MAX_DELTA_PERCENT) {
      deltaPercent = deltaRaw
    } else {
      dropped.push({
        beatId,
        rule: 'change',
        reason: `deltaPercent must be a number from -${MAX_DELTA_PERCENT} to ${MAX_DELTA_PERCENT}, got ${describe(deltaRaw)}`,
      })
      warnings.push(`beat ${beatId}: deltaPercent was ignored`)
    }
  }

  let durationSec: number | undefined
  const durationRaw = record['durationSec']
  if (durationRaw !== undefined) {
    if (isFiniteNumber(durationRaw) && durationRaw >= MIN_CHANGE_DURATION_SEC && durationRaw <= MAX_CHANGE_DURATION_SEC) {
      durationSec = durationRaw
    } else {
      dropped.push({
        beatId,
        rule: 'change',
        reason: `change.durationSec must be a number from ${MIN_CHANGE_DURATION_SEC} to ${MAX_CHANGE_DURATION_SEC}, got ${describe(durationRaw)}`,
      })
      warnings.push(`beat ${beatId}: change duration was ignored`)
    }
  }

  // D16: `texture` is parsed and range-checked here too (R1); it never takes
  // effect in M2. Reuses the beat-level parser so both landing places behave
  // identically.
  const texture = parseTexture(record['texture'], beatId, warnings)

  const change: BeatChange = {
    kind: 'level',
    ...(targetPercent === undefined ? {} : { targetPercent }),
    ...(deltaPercent === undefined ? {} : { deltaPercent }),
    ...(durationSec === undefined ? {} : { durationSec }),
    ...(texture === undefined ? {} : { texture }),
  }
  return change
}

function parseWaveformChange(
  record: UnknownRecord,
  beatId: string,
  dropped: PlanDrop[],
  warnings: string[],
): BeatChange | undefined {
  const waveformIdRaw = record['waveformId']
  if (!isNonEmptyString(waveformIdRaw)) {
    dropped.push({
      beatId,
      rule: 'change',
      reason: `a waveform change needs a non-empty waveformId, got ${describe(waveformIdRaw)}`,
    })
    warnings.push(`beat ${beatId}: invalid change dropped; falling back to the intent suggestion`)
    return undefined
  }
  const durationRaw = record['durationSec']
  if (!isFiniteNumber(durationRaw) || durationRaw < MIN_CHANGE_DURATION_SEC || durationRaw > MAX_CHANGE_DURATION_SEC) {
    dropped.push({
      beatId,
      rule: 'change',
      reason: `a waveform change needs durationSec from ${MIN_CHANGE_DURATION_SEC} to ${MAX_CHANGE_DURATION_SEC}, got ${describe(durationRaw)}`,
    })
    warnings.push(`beat ${beatId}: invalid change dropped; falling back to the intent suggestion`)
    return undefined
  }
  const texture = parseTexture(record['texture'], beatId, warnings)
  return {
    kind: 'waveform',
    waveformId: waveformIdRaw,
    durationSec: durationRaw,
    ...(texture === undefined ? {} : { texture }),
  }
}

function warnIgnoredKeys(
  record: UnknownRecord,
  known: readonly string[],
  beatId: string,
  label: string,
  warnings: string[],
): void {
  const field = new Set(known)
  for (const key of Object.keys(record).filter(name => !field.has(name)).sort()) {
    warnings.push(`beat ${beatId}: unknown ${label} field ${describe(key)} was ignored`)
  }
}

/**
 * Targets inherit the beat's change and strength field by field (§4.3): the
 * parsed target always carries a strength, and carries a change only when the
 * beat (or the target itself) has one.
 */
function parseTargets(
  raw: unknown,
  beatId: string,
  beatChange: BeatChange | undefined,
  beatStrength: BeatStrength,
  dropped: PlanDrop[],
  warnings: string[],
): BeatTarget[] | undefined {
  if (raw === undefined) return undefined
  if (!Array.isArray(raw)) {
    dropped.push({ beatId, rule: 'target', reason: `targets must be an array, got ${describe(raw)}` })
    warnings.push(`beat ${beatId}: targets were ignored`)
    return undefined
  }
  const targets: BeatTarget[] = []
  const seen = new Set<string>()
  for (const item of raw) {
    const record = asRecord(item)
    if (record === undefined) {
      dropped.push({ beatId, rule: 'target', reason: `target entries must be objects, got ${describe(item)}` })
      continue
    }
    const deviceId = record['deviceId']
    const channelId = record['channelId']
    if (!isNonEmptyString(deviceId) || !isNonEmptyString(channelId)) {
      dropped.push({ beatId, rule: 'target', reason: 'a target needs non-empty deviceId and channelId' })
      continue
    }
    const key = `${deviceId}\u0000${channelId}`
    if (seen.has(key)) {
      dropped.push({ beatId, rule: 'target', reason: `duplicate target ${deviceId}/${channelId}` })
      continue
    }
    seen.add(key)
    const change = parseChange(record['change'], beatId, dropped, warnings) ?? beatChange
    const strengthRaw = record['strength']
    let strength = beatStrength
    if (strengthRaw !== undefined) {
      if (isBeatStrength(strengthRaw)) {
        strength = strengthRaw
      } else {
        dropped.push({
          beatId,
          rule: 'strength',
          reason: `target strength must be one of ${STRENGTH_VALUES.join('/')}, got ${describe(strengthRaw)}`,
        })
        warnings.push(`beat ${beatId}: target ${deviceId}/${channelId} inherited the beat strength`)
      }
    }
    targets.push({
      deviceId,
      channelId,
      strength,
      ...(change === undefined ? {} : { change }),
    })
  }
  if (targets.length === 0) {
    warnings.push(`beat ${beatId}: no valid target remained; targets were ignored`)
    return undefined
  }
  return targets
}

/**
 * D16: `texture` is parsed and range-checked only. Invalid fields are removed
 * with a warning; a valid remainder is carried through untouched.
 */
function parseTexture(raw: unknown, beatId: string, warnings: string[]): WaveformModulation | undefined {
  if (raw === undefined) return undefined
  const record = asRecord(raw)
  if (record === undefined) {
    warnings.push(`beat ${beatId}: texture must be an object, got ${describe(raw)}; ignored`)
    return undefined
  }
  let rate: number | undefined
  const rateRaw = record['rate']
  if (rateRaw !== undefined) {
    if (isFiniteNumber(rateRaw) && rateRaw >= MIN_RATE && rateRaw <= MAX_RATE) rate = rateRaw
    else warnings.push(`beat ${beatId}: texture.rate must be ${MIN_RATE}-${MAX_RATE}, got ${describe(rateRaw)}; ignored`)
  }
  let intensityScale: number | undefined
  const intensityRaw = record['intensityScale']
  if (intensityRaw !== undefined) {
    if (isFiniteNumber(intensityRaw) && intensityRaw >= 0 && intensityRaw <= 1) intensityScale = intensityRaw
    else warnings.push(`beat ${beatId}: texture.intensityScale must be 0-1, got ${describe(intensityRaw)}; ignored`)
  }
  let phaseOffset: number | undefined
  const phaseRaw = record['phaseOffset']
  if (phaseRaw !== undefined) {
    if (isFiniteNumber(phaseRaw) && phaseRaw >= 0 && phaseRaw <= 1) phaseOffset = phaseRaw
    else warnings.push(`beat ${beatId}: texture.phaseOffset must be 0-1, got ${describe(phaseRaw)}; ignored`)
  }
  const texture: WaveformModulation = {
    ...(rate === undefined ? {} : { rate }),
    ...(intensityScale === undefined ? {} : { intensityScale }),
    ...(phaseOffset === undefined ? {} : { phaseOffset }),
  }
  if (rate === undefined && intensityScale === undefined && phaseOffset === undefined) return undefined
  return texture
}

/**
 * Choices are all-or-nothing per entry (§4.3 rule 7): a bad label or a
 * duplicate id drops that choice only. Labels are counted in code points, so
 * twenty Chinese characters fit.
 */
function parseChoices(
  raw: unknown,
  maxChoices: number,
  dropped: PlanDrop[],
  warnings: string[],
): PlayerChoice[] | undefined {
  if (raw === undefined) return undefined
  if (!Array.isArray(raw)) {
    dropped.push({ rule: 'choices', reason: `choices must be an array, got ${describe(raw)}` })
    warnings.push('choices were ignored')
    return undefined
  }
  const choices: PlayerChoice[] = []
  const ids = new Set<string>()
  const labels = new Set<string>()
  for (const item of raw) {
    if (choices.length >= maxChoices) {
      const choiceId = choiceIdOf(item)
      dropped.push({
        rule: 'choices',
        reason: `a plan accepts at most ${maxChoices} choice(s); ${raw.length - choices.length} extra choice(s) were dropped`,
        ...(choiceId === undefined ? {} : { choiceId }),
      })
      continue
    }
    const record = asRecord(item)
    if (record === undefined) {
      dropped.push({ rule: 'choices', reason: `choices must be objects, got ${describe(item)}` })
      continue
    }
    const choice = parseChoice(record, ids, labels, dropped)
    if (choice !== undefined) {
      choices.push(choice)
      ids.add(choice.id)
      labels.add(choice.label)
    }
  }
  if (choices.length === 0 && raw.length > 0) warnings.push('no valid choice remained; the plan offers none')
  if (choices.length === 0) return undefined
  return choices
}

function choiceIdOf(value: unknown): string | undefined {
  const record = asRecord(value)
  if (record === undefined) return undefined
  const id = record['id']
  return isNonEmptyString(id) ? id : undefined
}

function parseChoice(
  record: UnknownRecord,
  ids: ReadonlySet<string>,
  labels: ReadonlySet<string>,
  dropped: PlanDrop[],
): PlayerChoice | undefined {
  // "No device parameters" (§4.3 rule 7) is not machine-checkable in prose;
  // digits are the reliable proxy, since percentages and channel names both
  // leak through them.
  const idRaw = record['id']
  if (!isNonEmptyString(idRaw)) {
    dropped.push({ rule: 'choices', reason: 'a choice needs a non-empty id' })
    return undefined
  }
  const id = idRaw
  if (ids.has(id)) {
    dropped.push({ choiceId: id, rule: 'choices', reason: `duplicate choice id ${describe(id)}` })
    return undefined
  }

  const labelRaw = record['label']
  const label = typeof labelRaw === 'string' ? labelRaw.trim() : undefined
  if (label === undefined || label.length === 0) {
    dropped.push({ choiceId: id, rule: 'choices', reason: 'a choice needs a non-empty label' })
    return undefined
  }
  const length = [...label].length
  if (length > MAX_CHOICE_LABEL) {
    dropped.push({
      choiceId: id,
      rule: 'choices',
      reason: `choice label must be at most ${MAX_CHOICE_LABEL} characters, got ${length}`,
    })
    return undefined
  }
  if (DIGITS.test(label)) {
    dropped.push({ choiceId: id, rule: 'choices', reason: `choice label must not contain digits: ${describe(label)}` })
    return undefined
  }
  if (labels.has(label)) {
    dropped.push({ choiceId: id, rule: 'choices', reason: `duplicate choice label ${describe(label)}` })
    return undefined
  }

  const tag = record['tag']
  if (!isNonEmptyString(tag)) {
    dropped.push({ choiceId: id, rule: 'choices', reason: 'a choice needs a non-empty tag' })
    return undefined
  }
  return { id, label, tag }
}

/**
 * §4.3 rule 8 / §8.1 #10: `beats[].mustMention` is authoritative, so this
 * list is only filtered and warned about — it never mutates a beat.
 */
function parseLineGuidance(
  raw: unknown,
  beatIds: ReadonlySet<string>,
  warnings: string[],
): BeatPlan['lineGuidance'] | undefined {
  if (raw === undefined) return undefined
  const record = asRecord(raw)
  if (record === undefined) {
    warnings.push(`lineGuidance must be an object, got ${describe(raw)}; ignored`)
    return undefined
  }
  let tone: string | undefined
  const toneRaw = record['tone']
  if (toneRaw !== undefined) {
    if (isNonEmptyString(toneRaw)) tone = toneRaw
    else warnings.push(`lineGuidance.tone must be a non-empty string, got ${describe(toneRaw)}; ignored`)
  }
  let mustMentionBeatIds: string[] | undefined
  const mustMentionRaw = record['mustMentionBeatIds']
  if (mustMentionRaw !== undefined) {
    if (!Array.isArray(mustMentionRaw)) {
      warnings.push(`lineGuidance.mustMentionBeatIds must be an array, got ${describe(mustMentionRaw)}; ignored`)
    } else {
      const ids: string[] = []
      for (const value of mustMentionRaw) {
        if (!isNonEmptyString(value)) {
          warnings.push(`lineGuidance.mustMentionBeatIds entries must be non-empty strings; ${describe(value)} was ignored`)
        } else if (!beatIds.has(value)) {
          warnings.push(`lineGuidance.mustMentionBeatIds refers to unknown beat ${describe(value)}; removed`)
        } else if (!ids.includes(value)) {
          ids.push(value)
        }
      }
      if (ids.length > 0) mustMentionBeatIds = ids
    }
  }
  if (tone === undefined && mustMentionBeatIds === undefined) return undefined
  return {
    ...(tone === undefined ? {} : { tone }),
    ...(mustMentionBeatIds === undefined ? {} : { mustMentionBeatIds }),
  }
}
