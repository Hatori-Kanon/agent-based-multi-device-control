/**
 * Probe projections: one settled probe, two audiences.
 *
 * - {@link probeDirectorJson} — structured facts for the director: the verdict
 *   plus a coarse direction/magnitude band and the raw window deltas. Numbers
 *   are allowed here (they are facts, not prose); the audit line owns the same
 *   facts (A2-T3).
 * - {@link probeWriterBrief} — one fixed Chinese sentence per verdict, with
 *   **no Arabic digit anywhere**. This is a pure template lookup, not a third
 *   LLM call (`M2-实施计划.md` §4.2, `导演与写作上下文契约.md` §5).
 *
 * The writer side deliberately loses `reason`, device targets and every delta:
 * "数字只进导演与审计，不进写作". `unavailable` is a factual "can't see the
 * body right now", never a negative judgement about the player.
 *
 * Pure functions: no clock, no I/O, no allocation beyond the returned value.
 */

import {
  DEFAULT_PROBE_THRESHOLDS,
  type ProbeDegradeReason,
  type ProbeRecord,
  type ProbeTarget,
  type ProbeVerdict,
} from './probe.ts'

/** Coarse direction of the measured change; never a raw value. */
export type ProbeDirection = 'up' | 'flat' | 'unknown'

/**
 * Coarse size of the change, relative to the default reaction thresholds.
 *
 * `small` = below 2x the threshold, `medium` = 2x..4x, `large` = 4x or more,
 * taking the stronger of the motion and audio ratios. Records settled under
 * custom `ProbeThresholds` are therefore banded against the defaults: the band
 * is an approximation, the raw `delta` stays exact.
 */
export type ProbeMagnitude = 'small' | 'medium' | 'large' | 'unknown'

/** One probe as the director sees it (M2 plan §4.2). */
export interface ProbeDirectorEntry {
  readonly probeId: string
  readonly beatId: string
  readonly intentId: string
  readonly verdict: ProbeVerdict
  /** Direction band only; the raw delta is in {@link ProbeDirectorEntry.delta}. */
  readonly direction: ProbeDirection
  /** Magnitude band only; see {@link ProbeMagnitude} for the bands. */
  readonly magnitude: ProbeMagnitude
  readonly targets: readonly ProbeTarget[]
  /**
   * Raw facts; `undefined` when the windows were not comparable. A modality
   * that only one side observed is omitted rather than reported as zero.
   */
  readonly delta: { readonly motion?: number; readonly audioPct?: number } | undefined
  /** Present only when the verdict degraded; never projected to the writer. */
  readonly reason?: ProbeDegradeReason
}

const MAGNITUDE_MEDIUM_RATIO = 2
const MAGNITUDE_LARGE_RATIO = 4

/** The one fixed narrative sentence per verdict (template, not generation). */
const WRITER_SENTENCE: Readonly<Record<ProbeVerdict, string>> = {
  responded: '刚才那一下，对方明显有反应。',
  none: '刚才那一下，对方几乎没有反应。',
  ambiguous: '对方刚动过，说不清那是反应还是动作。',
  unavailable: '（对方似乎暂时不在画面/没有佩戴）',
}

/**
 * Project settled probes into director-facing structured facts, in input order.
 *
 * Targets are copied down to `{deviceId, channelId}`: a probe target carries no
 * device level, and the projection must not become one by accident.
 */
export function probeDirectorJson(records: readonly ProbeRecord[]): readonly ProbeDirectorEntry[] {
  return records.map(record => ({
    probeId: record.probeId,
    beatId: record.beatId,
    intentId: record.intentId,
    verdict: record.verdict,
    direction: directionOf(record),
    magnitude: magnitudeOf(record),
    targets: record.targets.map(target => ({ deviceId: target.deviceId, channelId: target.channelId })),
    delta: record.delta === undefined
      ? undefined
      : {
          ...(record.delta.motion === undefined ? {} : { motion: record.delta.motion }),
          ...(record.delta.audioPct === undefined ? {} : { audioPct: record.delta.audioPct }),
        },
    ...(record.reason === undefined ? {} : { reason: record.reason }),
  }))
}

/**
 * Project settled probes into narrative sentences, one per record, oldest first.
 *
 * The result contains no Arabic digits (`\p{Nd}` is empty by contract) and no
 * `reason`: the writer only gets what a person could have seen, not the
 * measurement. Returns `''` for an empty input so a caller can append it
 * unconditionally.
 */
export function probeWriterBrief(records: readonly ProbeRecord[]): string {
  return records.map(record => WRITER_SENTENCE[record.verdict]).join('\n')
}

/**
 * Coarse measured direction.
 *
 * `responded` always rose; `none` is flat. An `ambiguous` verdict still has a
 * measured sign (the window may have risen while the baseline was already
 * moving), so it reports that sign when a delta exists — the verdict says the
 * reading cannot be trusted, not that nothing moved. `unavailable` has nothing
 * to report.
 */
function directionOf(record: ProbeRecord): ProbeDirection {
  if (record.verdict === 'responded') return 'up'
  if (record.verdict === 'none') return 'flat'
  if (record.verdict === 'ambiguous' && record.delta !== undefined) {
    return (record.delta.motion ?? 0) > 0 || (record.delta.audioPct ?? 0) > 0 ? 'up' : 'flat'
  }
  return 'unknown'
}

/** Band the delta relative to the default thresholds; untrusted verdicts stay unknown. */
function magnitudeOf(record: ProbeRecord): ProbeMagnitude {
  if (record.verdict === 'ambiguous' || record.verdict === 'unavailable' || record.delta === undefined) {
    return 'unknown'
  }
  const motionRatio = (record.delta.motion ?? 0) / DEFAULT_PROBE_THRESHOLDS.motionDeltaMin
  const audioRatio = (record.delta.audioPct ?? 0) / DEFAULT_PROBE_THRESHOLDS.audioDeltaMinPct
  const ratio = Math.max(0, motionRatio, audioRatio)
  if (ratio >= MAGNITUDE_LARGE_RATIO) return 'large'
  if (ratio >= MAGNITUDE_MEDIUM_RATIO) return 'medium'
  return 'small'
}
