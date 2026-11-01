/**
 * Writer-side context projection (B2-T2): the narrative half of the split.
 *
 * The writer and the director read the **same session state through different
 * projections** (`导演与写作上下文契约.md` §0). The director gets structured
 * facts and decides the plan; the writer gets prose and the plan's human
 * version, and decides nothing about the hardware. This module builds the
 * writer's projection and nothing else: it is a pure function with no clock,
 * random source, environment or I/O.
 *
 * ## What the writer can and cannot see
 *
 * Allowed (`导演与写作上下文契约.md` §3): the full persona, the full host voice,
 * scene and phase hint, the last ten to twenty dialogue rounds, three retrieved
 * corpus excerpts at most, a **narrative** probe brief, the boundaries, the
 * humanized plan with its `mustMention` marks, and the constraint sentence.
 *
 * Forbidden: device ids, channel values, percentages, caps, raw probe numbers,
 * the audit trail, and every numeric field of `BeatPlan`
 * (`turnId`, `nextTurnAfterSec`, `change.targetPercent`, `change.deltaPercent`,
 * `change.durationSec`, `texture.*`). `humanizePlan` reads only narrative
 * fields — intent meaning, region, strength, pacing, `mustMention` — and
 * removes every decimal digit from the text it emits, so even a malformed
 * intent table cannot leak a number into the prompt.
 *
 * ## Budget and degradation
 *
 * Core is dependency-free and has no tokenizer, so the 8–16k-token budget
 * (`导演与写作上下文契约.md` §3) is enforced in characters: one CJK character is
 * counted as roughly one token and {@link DEFAULT_WRITER_CONTEXT_BUDGET_CHARS}
 * sits at the midpoint of the documented range. Over budget, blocks are
 * sacrificed in exactly the documented order (`§3`, `§6`):
 *
 * 1. fewer corpus excerpts;
 * 2. recent lines compressed to a summary plus the last five rounds;
 * 3. the setting (`scene`, `phaseNote`) dropped;
 * 4. the minimal context (boundaries + plan + constraints) is returned; a
 *    caller that still cannot run the writer must emit
 *    {@link WRITER_TEMPLATE_LINE} instead of calling the model (B2-T3).
 *
 * `boundaries` is never truncated or dropped: an over-budget prompt with intact
 * boundaries is a style regression, a cut boundary is a safety regression.
 *
 * @module
 */

import type { Beat, BeatPlan, BeatStrength } from '../../scenario/beat-plan.ts'
import type { FeedbackIntent } from '../../scenario/intents.ts'

/** One `mustMention` beat as the engine joins it back to the plan. */
export interface WriterMustMention {
  /** Engine join key; not rendered into `planText` (it may contain digits). */
  readonly beatId: string
  /** Humanized, digit-free description of the action to mention. */
  readonly text: string
}

/** What the writer model reads for one turn (`M2-实施计划.md` §4.9.3). */
export interface WriterContext {
  readonly boundaries: readonly string[]
  /** Full persona text. */
  readonly persona: string
  /** Full host text. */
  readonly host: string
  /** Setting text; the phase note is kept separately. */
  readonly scene: string
  /** Current phase hint (`phases/<id>.md`), never a plan id or number. */
  readonly phaseNote: string | undefined
  /** Humanized plan, guaranteed to contain no decimal digit. */
  readonly planText: string
  /** One entry per beat the prose has to mention, in plan order. */
  readonly mustMention: readonly WriterMustMention[]
  /** Most recent dialogue rounds, oldest first. */
  readonly recentLines: readonly string[]
  /** Retrieved corpus excerpts, at most {@link MAX_CORPUS_EXCERPTS}. */
  readonly corpusExcerpts: readonly string[]
  /** Narrative probe sentence; absent when there is no reaction fact. */
  readonly probeBrief: string | undefined
  /** Hard writer constraints, always present. */
  readonly constraints: readonly string[]
}

/** A region label map: the scenario's `regions[]` or a plain record. */
export type RegionLabelSource = ReadonlyMap<string, string> | Readonly<Record<string, string>>

/** Everything `buildWriterContext` may read. Contains no device snapshot/audit. */
export interface WriterContextInput {
  readonly plan: BeatPlan
  readonly persona: string
  readonly host: string
  readonly scene: string
  readonly intents: ReadonlyMap<string, FeedbackIntent>
  /** Previous lines, oldest first; only the last {@link MAX_RECENT_LINES} survive. */
  readonly recentLines: readonly string[]
  /** Already retrieved excerpts, best first; only the first three survive. */
  readonly corpusExcerpts: readonly string[]
  readonly probeBrief: string | undefined
  readonly boundaries: readonly string[]
  /**
   * Current phase prose. §4.9.3 lists `phaseNote` in the output but omits it
   * from the input sketch; the caller passes the pack's phase text here.
   */
  readonly phaseNote?: string | undefined
  /** Deterministic summary used when recent lines are compressed (§6). */
  readonly recentSummary?: string | undefined
  /** Scenario region labels; unknown ids fall back to a neutral body word. */
  readonly regionLabels?: RegionLabelSource | undefined
  /** Overrides {@link DEFAULT_WRITER_CONTEXT_BUDGET_CHARS} (tests, tuning). */
  readonly budgetChars?: number | undefined
}

/** Options for {@link humanizePlan}; the second parameter stays optional. */
export interface HumanizePlanOptions {
  /** Scenario region labels (`regions[].id -> regions[].label`). */
  readonly regionLabels?: RegionLabelSource | undefined
}

/**
 * Character budget for the whole writer context: the 8–16k-token contract
 * (`导演与写作上下文契约.md` §3) at the 12k midpoint, counted as characters
 * because core has no tokenizer and one CJK character is roughly one token.
 */
export const DEFAULT_WRITER_CONTEXT_BUDGET_CHARS = 12_000

/** At most this many previous lines are read ("最近 10–20 轮" in §3). */
export const MAX_RECENT_LINES = 20

/** At most this many corpus excerpts are read ("1–3 段" in §3). */
export const MAX_CORPUS_EXCERPTS = 3

/** Rounds kept verbatim when the recent history is compressed (§6). */
export const COMPRESSED_RECENT_LINES = 5

/** Length of the deterministic summary head used when nothing is injected. */
const SUMMARY_HEAD_CHARS = 24

/** The writer may only describe what the plan already authorised. */
export const WRITER_CONSTRAINTS = '只描写 plan 里的动作；不发明设备动作；不报数值'

/** Contractual placeholder when the writer cannot produce a line (§3). */
export const WRITER_TEMPLATE_LINE = '（短暂停顿）'

/** Words for the four pacing values; no numbers anywhere. */
const PACING_TEXT: Readonly<Record<BeatPlan['pacing'], string>> = {
  hold: '保持',
  build: '渐强',
  release: '渐缓',
  probe: '试探',
}

/** Words for the three narrative strengths. */
const STRENGTH_TEXT: Readonly<Record<BeatStrength, string>> = {
  low: '轻',
  med: '适中',
  high: '强',
}

/**
 * Labels for the region ids the frozen content-pack spec uses. Packs with
 * custom ids should pass `regionLabels`; unknown ids degrade to
 * {@link UNKNOWN_REGION_TEXT} rather than leaking an internal id.
 */
const DEFAULT_REGION_LABELS: Readonly<Record<string, string>> = {
  'whole-body': '全身',
  head: '头',
  face: '脸',
  neck: '颈侧',
  shoulder: '肩',
  chest: '胸口',
  back: '后背',
  waist: '腰',
  abdomen: '小腹',
  hip: '胯',
  thigh: '大腿',
  'inner-thigh': '大腿内侧',
  knee: '膝',
  calf: '小腿',
  ankle: '脚踝',
  foot: '脚',
  arm: '手臂',
  forearm: '小臂',
  wrist: '手腕',
  hand: '手',
}

/** Used when an intent id is missing or its meaning is only digits. */
const GENERIC_ACTION_TEXT = '一个动作'

/** Used when a region has no known label; never the internal region id. */
const UNKNOWN_REGION_TEXT = '身体'

const PACING_FALLBACK = '延续'
const STRENGTH_FALLBACK = '适中'

/** Matches any decimal digit; used to guarantee digit-free generated prose. */
const HAS_DIGIT = /\p{Nd}/u

/** Digit runs removed from generated prose. */
const DIGIT_RUN = /\p{Nd}+/gu

/**
 * Turn a plan into the writer's "human version" of the action.
 *
 * Only narrative fields are read: the beat's intent `meaning`, the region
 * label, the strength word, the pacing word and the `mustMention` flag. Device
 * ids, channel values, percentages, durations, waveform ids, texture and every
 * other numeric plan field never reach the string. Every decimal digit is
 * stripped defensively, so the result matches `\p{Nd}` nowhere even when a
 * content pack authors a digit inside an intent meaning.
 *
 * The beats are rendered in plan order and joined into one sentence, which is
 * what keeps the writer's prose aligned with the dispatcher's order.
 */
export function humanizePlan(
  plan: BeatPlan,
  intents: ReadonlyMap<string, FeedbackIntent>,
  options: HumanizePlanOptions = {},
): string {
  const pacing = PACING_TEXT[plan.pacing] ?? PACING_FALLBACK
  const head = `这回合的节奏是${pacing}。`
  if (plan.beats.length === 0) {
    return `${head}这一回合不安排新的动作，只接着往下写。`
  }
  const actions = plan.beats.map(beat => {
    const phrase = describeBeat(beat, intents, options.regionLabels)
    return isMustMention(beat, plan) ? `${phrase}（必须提到）` : phrase
  })
  return `${head}${actions.join('；')}。`
}

/**
 * Build the writer's context for one turn.
 *
 * Pure and byte-stable: the same input always produces the same object and the
 * same `JSON.stringify` bytes. The function never reads a clock, random source
 * or environment, and never mutates its input. The fields are emitted in the
 * documented order so the stable prefix (boundaries, host, persona, scene) can
 * be prompt-cached (§6).
 */
export function buildWriterContext(input: WriterContextInput): WriterContext {
  const budget = resolveBudget(input.budgetChars)
  const options: HumanizePlanOptions = { regionLabels: input.regionLabels }
  const planText = humanizePlan(input.plan, input.intents, options)
  const mustMention = collectMustMention(input.plan, input.intents, input.regionLabels)
  const recent = normalizeRecentLines(input.recentLines)
  const corpus = normalizeCorpus(input.corpusExcerpts)
  const probeBrief = normalizeProbeBrief(input.probeBrief)
  const boundaries = normalizeList(input.boundaries)
  const constraints = [WRITER_CONSTRAINTS]

  const base: WriterContext = {
    boundaries,
    persona: input.persona,
    host: input.host,
    scene: input.scene,
    phaseNote: normalizeOptional(input.phaseNote),
    planText,
    mustMention,
    recentLines: recent,
    corpusExcerpts: corpus,
    probeBrief,
    constraints,
  }
  if (writerContextChars(base) <= budget) return base

  // ① Fewer corpus excerpts first: drop from the tail, best excerpt stays last.
  for (let keep = corpus.length - 1; keep >= 0; keep -= 1) {
    const candidate: WriterContext = { ...base, corpusExcerpts: corpus.slice(0, keep) }
    if (writerContextChars(candidate) <= budget) return candidate
  }

  // ② Compress the recent history to "summary + last five rounds".
  const compact: WriterContext = {
    ...base,
    corpusExcerpts: [],
    recentLines: compressRecent(recent, input.recentSummary),
  }
  if (writerContextChars(compact) <= budget) return compact

  // ③ Drop the setting long text (scene and its phase hint).
  const stripped: WriterContext = { ...compact, scene: '', phaseNote: undefined }
  if (writerContextChars(stripped) <= budget) return stripped

  // ④ Minimal context: only the hard blocks survive. A caller that cannot run
  // the writer on this must use WRITER_TEMPLATE_LINE; boundaries are still
  // never cut (the documented safety exception).
  return {
    boundaries,
    persona: '',
    host: '',
    scene: '',
    phaseNote: undefined,
    planText,
    mustMention,
    recentLines: [],
    corpusExcerpts: [],
    probeBrief,
    constraints,
  }
}

/**
 * Characters of model-facing text in a writer context.
 *
 * The budget is approximate by design (no tokenizer): it sums every field that
 * reaches the model. `mustMention[].beatId` is engine bookkeeping and is not
 * counted, exactly as it is not rendered into `planText`.
 */
export function writerContextChars(context: WriterContext): number {
  const parts: readonly string[] = [
    context.boundaries.join('\n'),
    context.persona,
    context.host,
    context.scene,
    context.phaseNote ?? '',
    context.planText,
    context.mustMention.map(entry => entry.text).join('\n'),
    context.recentLines.join('\n'),
    context.corpusExcerpts.join('\n'),
    context.probeBrief ?? '',
    context.constraints.join('\n'),
  ]
  let total = 0
  for (const part of parts) total += part.length
  return total
}

/** One beat's digit-free action phrase, without the mention mark. */
function describeBeat(
  beat: Beat,
  intents: ReadonlyMap<string, FeedbackIntent>,
  regionLabels: RegionLabelSource | undefined,
): string {
  const intent = intents.get(beat.intentId)
  const meaning = digitFree(intent?.meaning) || GENERIC_ACTION_TEXT
  const labels = regionLabelsFor(beat.regions, regionLabels)
  const regionPhrase = labels.length === 0 ? '' : `，落在${labels.join('、')}`
  const strength = STRENGTH_TEXT[beat.strength] ?? STRENGTH_FALLBACK
  return `${meaning}${regionPhrase}，力度${strength}`
}

/** `beats[].mustMention` wins over the redundant `lineGuidance` list (§8.1 #10). */
function isMustMention(beat: Beat, plan: BeatPlan): boolean {
  if (beat.mustMention !== undefined) return beat.mustMention
  return plan.lineGuidance?.mustMentionBeatIds?.includes(beat.id) ?? false
}

/** One entry per flagged beat, in plan order. */
function collectMustMention(
  plan: BeatPlan,
  intents: ReadonlyMap<string, FeedbackIntent>,
  regionLabels: RegionLabelSource | undefined,
): WriterMustMention[] {
  const entries: WriterMustMention[] = []
  for (const beat of plan.beats) {
    if (!isMustMention(beat, plan)) continue
    entries.push({ beatId: beat.id, text: describeBeat(beat, intents, regionLabels) })
  }
  return entries
}

/** Deduplicated labels for a beat's regions, in declaration order. */
function regionLabelsFor(regions: readonly string[], source: RegionLabelSource | undefined): string[] {
  const labels: string[] = []
  for (const region of regions) {
    const label = resolveRegionLabel(region, source)
    if (!labels.includes(label)) labels.push(label)
  }
  return labels
}

/** Caller labels first, built-in table second, neutral word last. */
function resolveRegionLabel(region: string, source: RegionLabelSource | undefined): string {
  const custom = lookupRegionLabel(source, region)
  const label = digitFree(custom ?? DEFAULT_REGION_LABELS[region] ?? UNKNOWN_REGION_TEXT)
  return label === '' ? UNKNOWN_REGION_TEXT : label
}

function lookupRegionLabel(source: RegionLabelSource | undefined, region: string): string | undefined {
  if (source === undefined) return undefined
  if (isRegionLabelMap(source)) return source.get(region)
  return Object.prototype.hasOwnProperty.call(source, region) ? source[region] : undefined
}

function isRegionLabelMap(source: RegionLabelSource): source is ReadonlyMap<string, string> {
  return typeof (source as ReadonlyMap<string, string>).get === 'function'
}

/** Remove decimal digits and collapse whitespace in generated prose. */
function digitFree(text: string | undefined): string {
  if (text === undefined) return ''
  return text.replace(DIGIT_RUN, '').replace(/\s+/gu, ' ').trim()
}

/** Drop blank entries and trim; authored formatting survives otherwise. */
function normalizeList(values: readonly string[]): string[] {
  const out: string[] = []
  for (const value of values) {
    const trimmed = value.trim()
    if (trimmed !== '') out.push(trimmed)
  }
  return out
}

function normalizeOptional(value: string | undefined): string | undefined {
  const trimmed = value?.trim() ?? ''
  return trimmed === '' ? undefined : trimmed
}

/** Last twenty rounds, oldest first, blanks dropped. */
function normalizeRecentLines(lines: readonly string[]): string[] {
  return normalizeList(lines).slice(-MAX_RECENT_LINES)
}

/** First three retrieved excerpts, best first. */
function normalizeCorpus(excerpts: readonly string[]): string[] {
  return normalizeList(excerpts).slice(0, MAX_CORPUS_EXCERPTS)
}

/**
 * A probe brief must already be narrative (`§5`). A digit means a caller
 * leaked a measurement: drop the brief instead of echoing the number.
 */
function normalizeProbeBrief(brief: string | undefined): string | undefined {
  const trimmed = brief?.trim() ?? ''
  if (trimmed === '' || HAS_DIGIT.test(trimmed)) return undefined
  return trimmed
}

/**
 * "摘要 + 最近 5 轮" (§6). The summary is injected when the caller has one;
 * otherwise the oldest dropped line is truncated deterministically.
 */
function compressRecent(lines: readonly string[], summary: string | undefined): string[] {
  const tail = lines.slice(-COMPRESSED_RECENT_LINES)
  if (lines.length <= COMPRESSED_RECENT_LINES) return [...tail]
  const injected = normalizeOptional(summary)
  if (injected !== undefined) return [injected, ...tail]
  const oldest = lines[0]
  if (oldest === undefined) return [...tail]
  return [`此前：${truncateCodePoints(oldest, SUMMARY_HEAD_CHARS)}…`, ...tail]
}

/** Truncate on code-point boundaries so a multi-byte line never splits. */
function truncateCodePoints(text: string, limit: number): string {
  const points = Array.from(text)
  return points.length <= limit ? text : points.slice(0, limit).join('')
}

function resolveBudget(budgetChars: number | undefined): number {
  if (budgetChars === undefined || !Number.isFinite(budgetChars) || budgetChars <= 0) {
    return DEFAULT_WRITER_CONTEXT_BUDGET_CHARS
  }
  return Math.floor(budgetChars)
}
