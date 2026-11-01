/**
 * Model-facing perception projections.
 *
 * Three shapes, all **facts only**:
 * - {@link sensorsListPayload} — the `sensors_list` tool payload.
 * - {@link sensorPromptBlock} — the short block injected into a turn's system
 *   prompt.
 * - {@link probePromptBlock} — the probe section (A2-T5), rendered per audience:
 *   the director gets structure, the writer and the single-call model get a
 *   digit-free narrative brief.
 *
 * There is deliberately no emotion label, no inference, and no advice here:
 * a source is either usable or not, one of the six measured qualities, and how
 * old its last sample is. The model decides what, if anything, to do with that.
 *
 * Nothing in this module writes, waits, or allocates a resource; an empty
 * world renders as an empty string so the prompt simply has no sensor section.
 */

import type { ProbeRecord, ProbeVerdict } from './probe.ts'
import {
  probeDirectorJson,
  probeWriterBrief,
  type ProbeDirection,
  type ProbeMagnitude,
} from './probe-projection.ts'
import type { SensorKind, SensorQuality, SensorStatus } from './types.ts'

/** Shape of the `sensors_list` tool payload. */
export interface SensorsListPayload {
  readonly sources: readonly {
    readonly id: string
    readonly kind: SensorKind
    readonly label: string
    readonly quality: SensorQuality
    readonly freshnessMs: number | undefined
  }[]
}

/** Project statuses into the structured `sensors_list` payload. */
export function sensorsListPayload(statuses: readonly SensorStatus[]): SensorsListPayload {
  return {
    sources: statuses.map(status => ({
      id: status.id,
      kind: status.kind,
      label: status.label,
      quality: status.quality,
      freshnessMs: status.freshnessMs,
    })),
  }
}

/** Default prompt budget, in characters. */
export const DEFAULT_SENSOR_BLOCK_BUDGET = 200

/** Factual wording for each measured quality. */
const QUALITY_TEXT: Readonly<Record<SensorQuality, string>> = {
  ok: '可用',
  dim: '偏暗',
  bright: '过曝',
  blocked: '被遮挡',
  stale: '无新数据',
  unavailable: '不可用',
}

/**
 * Kind wording.
 *
 * A camera is described by what it sees ("画面"); a microphone only ever
 * reports its level ("音量") — the block must not assume every source produces
 * a frame. `hr` sources have no M2 implementation and are skipped entirely.
 */
const KIND_TEXT: Readonly<Record<Exclude<SensorKind, 'hr'>, string>> = {
  image: '画面',
  audio: '音量',
}

function describe(status: SensorStatus, includeFreshness: boolean): string {
  // Only image and audio reach here; `hr` is filtered out before rendering.
  const kindText = KIND_TEXT[status.kind as Exclude<SensorKind, 'hr'>]
  const freshness = includeFreshness && status.freshnessMs !== undefined
    ? `，${(Math.max(0, status.freshnessMs) / 1_000).toFixed(1)}s前`
    : ''
  return `${status.label}（${kindText}）${QUALITY_TEXT[status.quality]}${freshness}`
}

/** Truncate on code-point boundaries so a multi-byte label never splits. */
function truncate(text: string, budget: number): string {
  if (budget <= 0) return ''
  if (text.length <= budget) return text
  const points = Array.from(text)
  if (points.length <= budget) return text
  if (budget === 1) return '…'
  return `${points.slice(0, budget - 1).join('')}…`
}

/**
 * Render the perception section of a turn's prompt.
 *
 * Returns `''` when nothing is registered (no "no sensors" noise). The block
 * is a plain fact list; its only numbers are ages of samples.
 *
 * @param statuses - Registered sources; `hr` entries are skipped.
 * @param budgetChars - Hard upper bound on the returned string length.
 *
 * Degradation order when the facts do not fit:
 * 1. drop the per-source freshness suffix;
 * 2. keep only sources whose quality is not `ok` (the actionable facts);
 * 3. hard-truncate the most degraded remaining text with an ellipsis.
 */
export function sensorPromptBlock(
  statuses: readonly SensorStatus[],
  budgetChars = DEFAULT_SENSOR_BLOCK_BUDGET,
): string {
  const renderable = statuses.filter(status => status.kind !== 'hr')
  if (renderable.length === 0 || budgetChars <= 0) return ''

  const problems = renderable.filter(status => status.quality !== 'ok')
  const candidates = [
    `感知：${renderable.map(status => describe(status, true)).join('；')}`,
    `感知：${renderable.map(status => describe(status, false)).join('；')}`,
    problems.length === 0 ? '' : `感知：${problems.map(status => describe(status, false)).join('；')}`,
  ]
  for (const candidate of candidates) {
    if (candidate !== '' && candidate.length <= budgetChars) return candidate
  }
  const fallback = [...candidates].reverse().find(candidate => candidate !== '') ?? ''
  return truncate(fallback, budgetChars)
}

/** Default budget for the probe block, in characters (A-5: ≤200). */
export const DEFAULT_PROBE_BLOCK_BUDGET = 200

/** Only the newest probes are injected (A-5: at most three). */
export const MAX_PROMPT_PROBES = 3

/** Which audience the probe block is rendered for. */
export type ProbePromptAudience = 'director' | 'writer' | 'model'

/** Options for {@link probePromptBlock}. */
export interface ProbePromptBlockOptions {
  readonly for: ProbePromptAudience
  /** Hard upper bound on the returned string; defaults to {@link DEFAULT_PROBE_BLOCK_BUDGET}. */
  readonly budgetChars?: number
}

const PROBE_BLOCK_PREFIX = '探测：'

/** Compact verdict wording; the writer never sees these tokens, only sentences. */
const VERDICT_TEXT: Readonly<Record<ProbeVerdict, string>> = {
  responded: '有反应',
  none: '无反应',
  ambiguous: '说不清',
  unavailable: '看不到',
}

const DIRECTION_TEXT: Readonly<Record<ProbeDirection, string>> = {
  up: '升',
  flat: '平',
  unknown: '未知',
}

const MAGNITUDE_TEXT: Readonly<Record<ProbeMagnitude, string>> = {
  small: '小',
  medium: '中',
  large: '大',
  unknown: '未知',
}

/**
 * Render the probe section of a turn's prompt (A2-T5).
 *
 * - `[]` → `''`: a session that never registered a probe gets no section at all.
 * - at most the newest {@link MAX_PROMPT_PROBES} (three) records are injected.
 * - `writer`/`model` get {@link probeWriterBrief} only: no digit anywhere.
 * - `director` gets compact structured lines
 *   (`beatId/intentId 有反应（升·中）`). When every recent probe is
 *   `unavailable` — every source stale or absent — it degrades to the same
 *   narrative sentence, so "can't see" is never turned into a negative
 *   judgement (the degradation matrix in `M2-实施计划.md` §4.2).
 * - the budget is honoured by dropping the oldest probes first, then by a
 *   code-point-safe truncation of the newest single line.
 */
export function probePromptBlock(
  records: readonly ProbeRecord[],
  options: ProbePromptBlockOptions,
): string {
  const budget = options.budgetChars ?? DEFAULT_PROBE_BLOCK_BUDGET
  if (records.length === 0 || budget <= 0) return ''
  const recent = records.slice(-MAX_PROMPT_PROBES)
  const narrative = options.for === 'writer'
    || options.for === 'model'
    || recent.every(record => record.verdict === 'unavailable')

  for (let count = recent.length; count > 0; count -= 1) {
    const candidate = renderProbeBlock(recent.slice(recent.length - count), narrative)
    if (candidate.length <= budget) return candidate
  }
  return truncate(renderProbeBlock(recent.slice(-1), narrative), budget)
}

/** One rendering pass; `narrative` is already resolved for the whole block. */
function renderProbeBlock(records: readonly ProbeRecord[], narrative: boolean): string {
  if (narrative) return `${PROBE_BLOCK_PREFIX}${probeWriterBrief(records)}`
  const entries = probeDirectorJson(records)
  const parts: string[] = []
  for (const [index, entry] of entries.entries()) {
    const record = records[index]
    if (record === undefined) continue
    if (entry.verdict === 'unavailable') {
      // A mixed batch keeps the no-camera fact narrative instead of inventing
      // a direction/magnitude band for a probe that saw nothing.
      parts.push(probeWriterBrief([record]))
      continue
    }
    const direction = DIRECTION_TEXT[entry.direction]
    const magnitude = MAGNITUDE_TEXT[entry.magnitude]
    parts.push(`${entry.beatId}/${entry.intentId} ${VERDICT_TEXT[entry.verdict]}（${direction}·${magnitude}）`)
  }
  return `${PROBE_BLOCK_PREFIX}${parts.join('；')}`
}
