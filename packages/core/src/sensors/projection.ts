/**
 * Model-facing perception projections.
 *
 * Two shapes, both **facts only**:
 * - {@link sensorsListPayload} — the `sensors_list` tool payload.
 * - {@link sensorPromptBlock} — the short block injected into a turn's system
 *   prompt.
 *
 * There is deliberately no emotion label, no inference, and no advice here:
 * a source is either usable or not, one of the six measured qualities, and how
 * old its last sample is. The model decides what, if anything, to do with that.
 *
 * Nothing in this module writes, waits, or allocates a resource; an empty
 * world renders as an empty string so the prompt simply has no sensor section.
 * Probe facts are **not** part of this block: A2-T5 adds a separate
 * `probePromptBlock` (M2 plan §4.2), which owns the `ProbeRecord` type.
 */

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
