/**
 * World facts for the M2 single-call turn: the compact projection the model
 * reads before it plans (B2-T4).
 *
 * `导演与写作上下文契约.md` §0 separates the session state into projections: the
 * director gets structured facts, the writer gets prose. The single-call turn
 * runs one model for both roles, so it needs a third, deliberately small
 * projection — just enough for it to produce a valid `apply_plan` beat:
 *
 * 1. **Intent menu** — the *only* ids the current pack accepts, with their
 *    meanings (`可用意图：`).
 * 2. **Region vocabulary** — what region ids mean, with the wildcard
 *    `whole-body` always available and always first (`可用部位：`).
 * 3. **Readiness** — which declared body parts have a ready channel behind
 *    them right now (`已就位部位：`), so the model does not aim at hardware
 *    that is not there.
 *
 * The host passes these lines verbatim as `briefs`; `prompt.ts` renders each
 * as `- item`. Every line is a plain fact, never an instruction paragraph.
 *
 * Properties the callers rely on:
 *
 * - **No measurements.** Labels and meanings are stripped of every decimal
 *   digit, so a percentage/cap/duration/output value can never reach the
 *   prompt even when a pack authors one into a label. The **ids are the one
 *   documented exception**: they keep their digits because they are contract
 *   identifiers that must match `intents[].id` / `regions[].id` byte for byte
 *   (an id like `sensation2` is a name, not a number), and stripping them
 *   would silently rename an enum value the schema then advertises.
 * - **Pure and deterministic.** No clock, random source, environment or I/O,
 *   and the input is never mutated.
 * - **Budgeted.** Without a tokenizer in core, the upper bound is counted in
 *   characters. Over budget, the readiness line is dropped first (it is a
 *   convenience fact), then the remainder is code-point-truncated with an
 *   ellipsis — the same degradation style as `sensors/projection.ts`.
 *
 * @module
 */

import { WHOLE_BODY_REGION } from '../../scenario/beat-plan.ts'

/** Hard upper bound on the emitted lines, in characters; default 600. */
export const DEFAULT_WORLD_FACTS_BUDGET = 600

/** One intent the current pack declares. */
export interface WorldFactsIntent {
  readonly id: string
  readonly meaning: string
}

/** One region the current pack declares. */
export interface WorldFactsRegion {
  readonly id: string
  readonly label: string
}

/** One output channel the host could target right now. */
export interface WorldFactsChannel {
  /** Region id the human labelled the channel with; `undefined` = unlabelled. */
  readonly region: string | undefined
  /** True when the backend is connected and the channel can take output. */
  readonly ready: boolean
}

/** Everything {@link buildWorldFacts} may read. Contains no caps or live values. */
export interface WorldFactsInput {
  readonly intents: readonly WorldFactsIntent[]
  readonly regions: readonly WorldFactsRegion[]
  readonly channels: readonly WorldFactsChannel[]
  /** Hard upper bound on the total emitted characters; default 600. */
  readonly budgetChars?: number
}

/** The wildcard entry, rendered once at the head of the region vocabulary. */
const WHOLE_BODY_ENTRY = `${WHOLE_BODY_REGION}=全身（作用于全部通道）`

/** Digit runs removed from labels and meanings; ids are exempt (see module note). */
const DIGIT_RUN = /\p{Nd}+/gu

/** Strip decimal digits and collapse whitespace in generated prose. */
function digitFree(text: string | undefined): string {
  if (text === undefined) return ''
  return text.replace(DIGIT_RUN, '').replace(/\s+/gu, ' ').trim()
}

/** A pack intent after trimming, dedupe and digit removal. */
interface NormalizedIntent {
  readonly id: string
  readonly meaning: string
}

/**
 * Trim, deduplicate (first occurrence wins) and strip digits from the menu.
 *
 * The id is only trimmed, never digit-stripped: it is an enum value the
 * runtime schema advertises, so changing it would break `apply_plan`.
 */
function normalizeIntents(intents: readonly WorldFactsIntent[]): NormalizedIntent[] {
  const seen = new Set<string>()
  const out: NormalizedIntent[] = []
  for (const intent of intents) {
    const id = intent.id.trim()
    if (id === '' || seen.has(id)) continue
    seen.add(id)
    const meaning = digitFree(intent.meaning)
    // A meaning that was only digits must not render as an empty `id=`.
    out.push({ id, meaning: meaning === '' ? id : meaning })
  }
  return out
}

/** A declared region after trimming, dedupe and digit removal. */
interface NormalizedRegion {
  readonly id: string
  readonly label: string
}

/**
 * Declared regions, minus the wildcard, first occurrence wins.
 *
 * A pack that also declares `whole-body` is deduplicated against the built-in
 * wildcard entry rather than rendered twice.
 */
function normalizeRegions(regions: readonly WorldFactsRegion[]): NormalizedRegion[] {
  const seen = new Set<string>([WHOLE_BODY_REGION])
  const out: NormalizedRegion[] = []
  for (const region of regions) {
    const id = region.id.trim()
    if (id === '' || seen.has(id)) continue
    seen.add(id)
    const label = digitFree(region.label)
    // Same fallback rule as an intent meaning; the id exception is documented
    // on the module because a digit-bearing id would otherwise be renamed.
    out.push({ id, label: label === '' ? id : label })
  }
  return out
}

/**
 * Declared, non-wildcard regions that have at least one ready channel.
 *
 * Only ids from {@link normalizeRegions} may appear, and they keep declaration
 * order. A channel labelled with an undeclared region is ignored: the model
 * may not target a region the pack never declared.
 */
function readyRegionIds(
  declared: readonly NormalizedRegion[],
  channels: readonly WorldFactsChannel[],
): string[] {
  const ready = new Set<string>()
  for (const channel of channels) {
    if (channel.ready === true && channel.region !== undefined) ready.add(channel.region)
  }
  return declared.filter(region => ready.has(region.id)).map(region => region.id)
}

/** The characters the host emits for a set of lines: one `\n` between each. */
function measuredLength(lines: readonly string[]): number {
  return lines.join('\n').length
}

/** Truncate on code-point boundaries; `budget - 1` code points plus an ellipsis. */
function truncateCodePoints(text: string, budget: number): string {
  if (budget <= 1) return '…'
  const points = Array.from(text)
  if (points.length <= budget) return text
  return `${points.slice(0, budget - 1).join('')}…`
}

/** Requested budget, or the default; a non-positive value means "emit nothing". */
function resolveBudget(budgetChars: number | undefined): number {
  if (budgetChars === undefined || !Number.isFinite(budgetChars)) return DEFAULT_WORLD_FACTS_BUDGET
  return Math.floor(budgetChars)
}

/**
 * Build the three world-fact lines (or fewer when the budget is tight).
 *
 * @param input - Pack vocabulary plus the current channel readiness.
 * @returns 0–3 short Chinese lines, safe to pass as prompt `briefs` verbatim.
 */
export function buildWorldFacts(input: WorldFactsInput): readonly string[] {
  const budget = resolveBudget(input.budgetChars)
  if (budget <= 0) return []

  const intents = normalizeIntents(input.intents)
  const intentLine = intents.length === 0
    ? '可用意图：无（本回合不要调用 apply_plan）'
    : `可用意图：${intents.map(intent => `${intent.id}=${intent.meaning}`).join('；')}`

  const declared = normalizeRegions(input.regions)
  const regionLine = `可用部位：${[WHOLE_BODY_ENTRY, ...declared.map(region => `${region.id}=${region.label}`)].join('；')}`

  const ready = readyRegionIds(declared, input.channels)
  const readinessLine = ready.length === 0
    ? '已就位部位：无（使用 whole-body 可作用到全部通道）'
    : `已就位部位：${ready.join('、')}`

  const lines = [intentLine, regionLine, readinessLine]
  if (measuredLength(lines) <= budget) return lines
  // ① Readiness is the convenience fact: drop it whole before cutting anything.
  const essential = [intentLine, regionLine]
  if (measuredLength(essential) <= budget) return essential
  // ② Still too long: truncate the remaining text deterministically.
  return [truncateCodePoints(essential.join('\n'), budget)]
}
