/**
 * Passive reaction probes: "did that action get a reaction?".
 *
 * One dispatched beat opens one probe. The recorder cuts two feature windows
 * around the action, settles them on the injected {@link Clock} once the
 * second window closes, and derives a reproducible verdict from the
 * aggregates — no camera pixels, no second model call, no wall clock.
 *
 * Window rules (M2 plan §4.2):
 * - baseline: `[actionAt - baselineLeadMs, actionAt)` — the action itself is
 *   **excluded**, so a behaviour cannot be its own baseline;
 * - window: `[actionAt, actionAt + windowMs]`, settled by a `Clock` timer.
 *
 * Data rules: motion comes from the newest `ok` image source, audio from the
 * newest `ok` audio source; the two may be different sources. With no usable
 * source `register` returns `undefined` without scheduling anything, which is
 * how a session without a camera degrades to narrative-only.
 */

import type { Clock, Timer } from '../ports/clock.ts'
import type { SensorRegistry } from './registry.ts'
import type { FeatureWindowStats, SensorKind, SensorQuality, SensorStatus } from './types.ts'

/** What the window comparison concluded. `unavailable` means "nothing to watch". */
export type ProbeVerdict = 'responded' | 'none' | 'ambiguous' | 'unavailable'

/** Only passive probes exist in M2; `active` is reserved for M2-A3. */
export type ProbeTrigger = 'passive'

/** Why a probe degraded instead of reaching `responded`/`none`. */
export type ProbeDegradeReason = 'no-source' | 'stale' | 'baseline-high' | 'degenerate'

/** Thresholds for the window comparison; all are overridable per recorder. */
export interface ProbeThresholds {
  /** Baseline looks this far back before the action. */
  readonly baselineLeadMs: number
  /** Settle window length after the action. */
  readonly windowMs: number
  /** Motion delta that counts as a reaction (window peak - baseline mean). */
  readonly motionDeltaMin: number
  /** Audio-level delta, in percentage points, that counts as a reaction. */
  readonly audioDeltaMinPct: number
  /** A baseline already moving this much makes the verdict ambiguous. */
  readonly baselineMotionMax: number
  /** A baseline already this loud makes the verdict ambiguous. */
  readonly baselineAudioMaxPct: number
}

/** Production defaults (M2 plan §4.2). */
export const DEFAULT_PROBE_THRESHOLDS: ProbeThresholds = {
  baselineLeadMs: 1_500,
  windowMs: 2_500,
  motionDeltaMin: 0.08,
  audioDeltaMinPct: 15,
  baselineMotionMax: 0.12,
  baselineAudioMaxPct: 30,
}

/** One device/channel pair a probe covers. */
export interface ProbeTarget {
  readonly deviceId: string
  readonly channelId: string
}

/** One dispatched action, as the recorder sees it (shape of the executor's registration). */
export interface ProbeAction {
  readonly turnId: number
  readonly beatId: string
  readonly intentId: string
  /** `Clock.now()` of the accepted dispatch, not of the registration call. */
  readonly at: number
  readonly targets: readonly ProbeTarget[]
}

/** A settled probe, exactly as the director projection and the audit trail consume it. */
export interface ProbeRecord {
  /** Session-scoped id such as `p-0007`. */
  readonly probeId: string
  readonly turnId: number
  readonly beatId: string
  readonly intentId: string
  readonly trigger: ProbeTrigger
  readonly actionAt: number
  readonly targets: readonly ProbeTarget[]
  readonly baseline: FeatureWindowStats | undefined
  readonly window: FeatureWindowStats | undefined
  /** `window.motionPeak - baseline.motionEnergyMean`, and the audio equivalent. */
  readonly delta: { readonly motion: number; readonly audioPct: number } | undefined
  readonly verdict: ProbeVerdict
  /** Present only when the verdict degraded. */
  readonly reason?: ProbeDegradeReason
}

/**
 * The one audit method the recorder uses.
 *
 * A deliberately minimal shape: `devices/audit.ts`'s `AuditLog` satisfies it
 * structurally, and the full `reaction_probe` audit contract is A2-T3's.
 */
export interface ProbeAuditSink {
  record(entry: {
    readonly actor: 'system'
    readonly action: 'reaction_probe'
    readonly result: 'ok'
    readonly detail: Readonly<Record<string, unknown>>
  }): Promise<void> | void
}

export interface ReactionProbeRecorderOptions {
  readonly clock: Clock
  readonly sensors: SensorRegistry
  /** Optional audit sink; when omitted nothing is written. */
  readonly audit?: ProbeAuditSink
  /** Per-recorder overrides merged over {@link DEFAULT_PROBE_THRESHOLDS}. */
  readonly thresholds?: Partial<ProbeThresholds>
}

interface PendingProbe {
  readonly probeId: string
  readonly action: ProbeAction
  readonly imageId: string | undefined
  readonly audioId: string | undefined
  timer: Timer | undefined
}

/**
 * Periodically settles windows for actions dispatched by the executor.
 *
 * A recorder is cheap and synchronous in {@link register}: one timer per
 * pending probe, no polling. {@link settleAll} and {@link dispose} let tests
 * and session shutdown run without a live capture loop.
 */
export class ReactionProbeRecorder {
  private readonly clock: Clock
  private readonly sensors: SensorRegistry
  private readonly audit: ProbeAuditSink | undefined
  private readonly thresholds: ProbeThresholds
  private readonly pending = new Map<string, PendingProbe>()
  private readonly settled: ProbeRecord[] = []
  private readonly inFlight = new Set<Promise<void>>()
  private probeSerial = 0
  private disposed = false

  constructor(options: ReactionProbeRecorderOptions) {
    this.clock = options.clock
    this.sensors = options.sensors
    this.audit = options.audit
    this.thresholds = {
      baselineLeadMs: options.thresholds?.baselineLeadMs ?? DEFAULT_PROBE_THRESHOLDS.baselineLeadMs,
      windowMs: options.thresholds?.windowMs ?? DEFAULT_PROBE_THRESHOLDS.windowMs,
      motionDeltaMin: options.thresholds?.motionDeltaMin ?? DEFAULT_PROBE_THRESHOLDS.motionDeltaMin,
      audioDeltaMinPct: options.thresholds?.audioDeltaMinPct ?? DEFAULT_PROBE_THRESHOLDS.audioDeltaMinPct,
      baselineMotionMax: options.thresholds?.baselineMotionMax ?? DEFAULT_PROBE_THRESHOLDS.baselineMotionMax,
      baselineAudioMaxPct: options.thresholds?.baselineAudioMaxPct ?? DEFAULT_PROBE_THRESHOLDS.baselineAudioMaxPct,
    }
  }

  /** The effective thresholds (defaults merged with the injected overrides). */
  get effectiveThresholds(): ProbeThresholds {
    return this.thresholds
  }

  /**
   * Register one dispatched action.
   *
   * @returns the probe id, or `undefined` when no `ok` image/audio source can
   * watch. In that case nothing changes: no timer, no id is consumed, and no
   * audit line is written.
   */
  register(action: ProbeAction): string | undefined {
    if (this.disposed) return undefined
    const watched = this.selectSources()
    if (watched === undefined) return undefined

    this.probeSerial += 1
    const probe: PendingProbe = {
      probeId: `p-${String(this.probeSerial).padStart(4, '0')}`,
      action,
      imageId: watched.imageId,
      audioId: watched.audioId,
      timer: undefined,
    }
    this.pending.set(probe.probeId, probe)
    this.schedule(probe)
    return probe.probeId
  }

  /** The last `limit` settled probes, oldest first (so the newest is last). */
  recent(limit = 3): readonly ProbeRecord[] {
    if (limit <= 0) return []
    return this.settled.slice(Math.max(0, this.settled.length - limit))
  }

  /**
   * Settle every pending window now.
   *
   * Used by tests and by session shutdown; a window that has not finished yet
   * is settled on the data available so far.
   */
  async settleAll(): Promise<void> {
    for (const probe of [...this.pending.values()]) {
      await this.settle(probe)
    }
    while (this.inFlight.size > 0) await Promise.all([...this.inFlight])
  }

  /** Cancel every pending timer without settling. The recorder is inert after. */
  dispose(): void {
    this.disposed = true
    for (const probe of this.pending.values()) probe.timer?.cancel()
    this.pending.clear()
  }

  private schedule(probe: PendingProbe): void {
    const delay = Math.max(0, probe.action.at + this.thresholds.windowMs - this.clock.now())
    probe.timer = this.clock.timeout(delay, () => {
      const settling = this.settle(probe)
      this.inFlight.add(settling)
      void settling.then(() => { this.inFlight.delete(settling) })
    })
  }

  private async settle(probe: PendingProbe): Promise<void> {
    if (!this.pending.has(probe.probeId)) return
    this.pending.delete(probe.probeId)
    probe.timer?.cancel()

    const record = this.evaluate(probe)
    this.settled.push(record)

    if (this.audit !== undefined) {
      try {
        await this.audit.record({
          actor: 'system',
          action: 'reaction_probe',
          result: 'ok',
          detail: {
            probeId: record.probeId,
            turnId: record.turnId,
            beatId: record.beatId,
            intentId: record.intentId,
            trigger: record.trigger,
            actionAt: record.actionAt,
            targets: record.targets,
            baseline: record.baseline,
            window: record.window,
            delta: record.delta,
            verdict: record.verdict,
            ...(record.reason === undefined ? {} : { reason: record.reason }),
          },
        })
      } catch {
        // A diagnostic sink must never break probe settling (A2-T3 keeps the
        // real failure policy; AuditLog.record itself never throws).
      }
    }
  }

  /** Newest `ok` image and audio sources; `undefined` when neither exists. */
  private selectSources(): { imageId: string | undefined; audioId: string | undefined } | undefined {
    const statuses = this.sensors.statuses()
    const imageId = newestOkSource(statuses, 'image')
    const audioId = newestOkSource(statuses, 'audio')
    if (imageId === undefined && audioId === undefined) return undefined
    return { imageId, audioId }
  }

  /** Merge the image and audio rings over one interval into a single window. */
  private collectWindow(probe: PendingProbe, fromTs: number, toTs: number): FeatureWindowStats | undefined {
    if (toTs < fromTs) return undefined
    const image = probe.imageId === undefined ? undefined : this.sensors.series(probe.imageId)?.stats(fromTs, toTs)
    const audio = probe.audioId === undefined ? undefined : this.sensors.series(probe.audioId)?.stats(fromTs, toTs)
    return mergeWindowStats(image, audio)
  }

  private hasWatchedSource(probe: PendingProbe): boolean {
    if (probe.imageId !== undefined && this.sensors.series(probe.imageId) !== undefined) return true
    return probe.audioId !== undefined && this.sensors.series(probe.audioId) !== undefined
  }

  private evaluate(probe: PendingProbe): ProbeRecord {
    const thresholds = this.thresholds
    // `Clock.now()` is integer milliseconds, so `actionAt - 1` excludes the
    // action sample itself from the half-open baseline window.
    const baseline = this.collectWindow(probe, probe.action.at - thresholds.baselineLeadMs, probe.action.at - 1)
    const windowTo = Math.min(this.clock.now(), probe.action.at + thresholds.windowMs)
    const window = this.collectWindow(probe, probe.action.at, windowTo)

    const comparable = baseline !== undefined && window !== undefined && baseline.samples > 0 && window.samples > 0
    const delta = comparable
      ? { motion: window.motionPeak - baseline.motionEnergyMean, audioPct: window.audioPeakPct - baseline.audioLevelMeanPct }
      : undefined

    let verdict: ProbeVerdict
    let reason: ProbeDegradeReason | undefined
    if (baseline === undefined && window === undefined) {
      verdict = 'unavailable'
      reason = this.hasWatchedSource(probe) ? 'stale' : 'no-source'
    } else if (window === undefined || window.samples < 1 || baseline === undefined || baseline.samples < 1) {
      verdict = 'ambiguous'
      reason = 'degenerate'
    } else if (
      baseline.motionEnergyMean > thresholds.baselineMotionMax
      || baseline.audioLevelMeanPct > thresholds.baselineAudioMaxPct
    ) {
      verdict = 'ambiguous'
      reason = 'baseline-high'
    } else if (delta !== undefined && (delta.motion >= thresholds.motionDeltaMin || delta.audioPct >= thresholds.audioDeltaMinPct)) {
      verdict = 'responded'
    } else {
      verdict = 'none'
    }

    return {
      probeId: probe.probeId,
      turnId: probe.action.turnId,
      beatId: probe.action.beatId,
      intentId: probe.action.intentId,
      trigger: 'passive',
      actionAt: probe.action.at,
      targets: probe.action.targets,
      baseline,
      window,
      delta,
      verdict,
      ...(reason === undefined ? {} : { reason }),
    }
  }
}

/** The id of the `ok` source of `kind` that sampled most recently. */
function newestOkSource(statuses: readonly SensorStatus[], kind: SensorKind): string | undefined {
  let bestId: string | undefined
  let bestFreshness = Number.POSITIVE_INFINITY
  for (const status of statuses) {
    if (status.kind !== kind || status.quality !== 'ok') continue
    const freshness = status.freshnessMs ?? Number.POSITIVE_INFINITY
    if (bestId === undefined || freshness < bestFreshness) {
      bestId = status.id
      bestFreshness = freshness
    }
  }
  return bestId
}

/**
 * Combine the image and audio windows.
 *
 * `FeatureWindowStats` carries both modalities because the record shape is
 * shared; motion fields come from the image ring and audio fields from the
 * audio ring, so a source of one kind never invents the other's numbers.
 */
function mergeWindowStats(image: FeatureWindowStats | undefined, audio: FeatureWindowStats | undefined): FeatureWindowStats | undefined {
  if (image === undefined && audio === undefined) return undefined
  let quality: SensorQuality = 'ok'
  if (image !== undefined && image.quality !== 'ok') quality = image.quality
  else if (audio !== undefined) quality = audio.quality
  return {
    samples: Math.max(image?.samples ?? 0, audio?.samples ?? 0),
    quality,
    motionEnergyMean: image?.motionEnergyMean ?? 0,
    motionPeak: image?.motionPeak ?? 0,
    audioLevelMeanPct: audio?.audioLevelMeanPct ?? 0,
    audioPeakPct: audio?.audioPeakPct ?? 0,
  }
}
