/**
 * The executor: the only path from a resolved plan to hardware.
 *
 * `PlanExecutor.dispatch` is deliberately thin. Resolution is a pure function
 * (`scenario/intents.ts`), and the safety runtime (`DeviceRegistry`) owns
 * locking, policy clamping, effect scheduling and the final transport write.
 * The executor walks the resolved commands in order, hands each one to the
 * registry with actor `'model'`, records one `plan_resolved` audit entry with
 * per-beat status, and registers one reaction probe per beat that actually
 * reached hardware.
 *
 * Three invariants:
 *
 * 1. **The registry is the only handle.** A backend is never accepted and
 *    never imported — dispatching around the safety runtime would bypass the
 *    human's caps, so the constructor rejects anything that is not a
 *    `DeviceRegistry`.
 * 2. **A refused command never cancels the rest.** Every command is wrapped;
 *    a safety refusal becomes `status: 'rejected'` with its reason, and the
 *    batch continues. No retry, no escalation.
 * 3. **Probe registration follows dispatch events, not time.** The registry
 *    emits exactly one event per accepted command and never per 50 ms tick,
 *    so a pattern that runs for a minute produces one probe, not a thousand.
 * 4. **Preemption stops between commands, never inside one.** The optional
 *    abort signal is checked before every command (and therefore between
 *    beats): the rest of the plan is dropped, while effects already handed to
 *    the registry are never rolled back (`M2-实施计划.md` §4.8).
 */

import type { AuditLog } from '../devices/audit.ts'
import type { DispatchEvent } from '../devices/events.ts'
import { DeviceRegistry } from '../devices/registry.ts'
import type { Clock } from '../ports/clock.ts'
import type { BeatPlan, PlanDrop, PlanValidation } from '../scenario/beat-plan.ts'
import { resolvePlan, type ResolveContext, type ResolvedCommand, type WaveformLookup } from '../scenario/intents.ts'
import type { WaveformLibrary } from '../waveform/library.ts'

// The probe shape is owned by the recorder (A2-T1); duplicating it here made
// `index.ts` export two different types under the same name.
import type { ProbeAction, ProbeTarget } from '../sensors/probe.ts'

/**
 * The minimal reaction-probe interface the executor needs.
 *
 * A2-T1's `ReactionProbeRecorder` satisfies this structurally. Tests and
 * hosts without a sensor stack may pass nothing at all, in which case probe
 * registration is skipped without changing dispatch behaviour.
 */
export interface ProbeRegistrar {
  /** @returns the new probe id, or `undefined` when no sensor source can watch. */
  register(action: ProbeAction): string | undefined
}

export interface PlanExecutorOptions {
  /** The safety runtime. Never a backend: see the module doc. */
  readonly registry: DeviceRegistry
  readonly audit: AuditLog
  /**
   * Same library the resolver validated against. The executor re-checks a
   * waveform id just before dispatch, because the library can change between
   * resolution and dispatch (a session-scope clear), and a stale id would
   * otherwise turn a working beat into a rejected command.
   */
  readonly waveforms: WaveformLookup
  /** Optional: no recorder means narrative-only probing. */
  readonly probes?: ProbeRegistrar
  readonly clock: Clock
}

/** How one resolved command ended. */
export interface DispatchStatus {
  readonly beatId: string
  readonly deviceId: string
  readonly channelId: string
  readonly status: 'dispatched' | 'clamped' | 'degraded' | 'rejected'
  /** Actual target level that was handed to the registry. */
  readonly percent?: number
  /** Safety refusal code or message; only for `'rejected'`. */
  readonly reason?: string
}

export interface DispatchResult {
  readonly planId: string
  readonly turnId: number
  readonly actions: readonly DispatchStatus[]
  /** True when the registry is locked; no device was touched. */
  readonly blocked: boolean
  /**
   * True when dispatch stopped early because `options.signal` aborted.
   *
   * Additive and optional: a normal dispatch leaves it `undefined`, so every
   * pre-existing `DispatchResult` literal keeps compiling and comparing.
   */
  readonly preempted?: boolean
  /**
   * Beat ids whose commands were not dispatched because of the abort, in
   * command order and deduplicated. Only present when {@link preempted} is
   * true; effects already dispatched are never rolled back.
   */
  readonly remainingBeats?: readonly string[]
}

/**
 * Optional cancellation for {@link PlanExecutor.dispatch}.
 *
 * `signal` is the turn's single abort controller (hard abort / timeout,
 * `M2-实施计划.md` §4.8). The executor checks it before each command, so an
 * abort drops the remaining beats without touching the in-flight one.
 */
export interface DispatchOptions {
  readonly signal?: AbortSignal
}

/**
 * Optional parse diagnostics, so `plan_resolved` can carry what the validator
 * removed before the executor ever saw the plan.
 *
 * `parseBeatPlan` returns a `PlanValidation`, which satisfies this shape, so
 * the caller can pass its result straight through:
 * `dispatch(validation.plan, ctx, validation)`.
 */
export type DispatchDiagnostics = Pick<PlanValidation, 'dropped' | 'warnings'>

/** The audit verb this module owns. */
const PLAN_RESOLVED = 'plan_resolved'

/** Actor for every command the model's plan causes. */
const PLAN_ACTOR = 'model'

/** Event kinds that represent an effect worth probing. */
const PROBEABLE_EVENTS: ReadonlySet<DispatchEvent['kind']> = new Set<DispatchEvent['kind']>(['level', 'pattern'])

interface ProbeDraft {
  at: number
  readonly targets: ProbeTarget[]
}

interface AuditInput {
  readonly plan: BeatPlan
  readonly planId: string
  readonly blocked: boolean
  readonly blockedReason: string | undefined
  readonly dropped: readonly PlanDrop[]
  readonly actions: readonly DispatchStatus[]
  readonly narrativeOnly: readonly string[]
  readonly warnings: readonly string[]
  /** True when the signal stopped the batch before every beat ran. */
  readonly preempted: boolean
  /** Beats whose commands were never attempted; empty unless preempted. */
  readonly remainingBeats: readonly string[]
}

export class PlanExecutor {
  constructor(private readonly options: PlanExecutorOptions) {
    // Structurally a backend cannot satisfy this type, but a host can always
    // cast. Fail loudly at construction rather than discovering at dispatch
    // time that commands skipped the safety runtime.
    if (!(options.registry instanceof DeviceRegistry)) {
      throw new TypeError(
        'PlanExecutor requires the DeviceRegistry as its dispatcher; a backend must never be dispatched directly',
      )
    }
  }

  /**
   * Resolve a plan and dispatch it through the registry.
   *
   * Locked ⇒ no device is touched, `blocked: true` is returned, and the audit
   * still records the attempt so the UI can explain why nothing happened.
   *
   * Preempted ⇒ `options.signal` aborted before or during the batch: the
   * remaining commands are skipped, the result carries `preempted` and the
   * beats that never ran, and effects already dispatched stay untouched.
   */
  async dispatch(
    plan: BeatPlan,
    ctx: ResolveContext,
    diagnostics?: DispatchDiagnostics,
    options?: DispatchOptions,
  ): Promise<DispatchResult> {
    const resolved = resolvePlan(plan, ctx)
    const dropped = diagnostics?.dropped ?? []
    const warnings = [...(diagnostics?.warnings ?? []), ...resolved.warnings]
    const signal = options?.signal

    // `ctx.snapshot.locked` is the resolver's view; the live latch closes the
    // gap between snapshotting and dispatching. Neither reads a device.
    if (ctx.snapshot.locked || this.options.registry.isLocked) {
      const blockedReason = ctx.snapshot.lockedReason ?? 'the device registry is locked'
      await this.recordResolved({
        plan,
        planId: resolved.planId,
        blocked: true,
        blockedReason,
        dropped,
        actions: [],
        narrativeOnly: resolved.narrativeOnlyBeats,
        warnings,
        preempted: false,
        remainingBeats: [],
      })
      return { planId: resolved.planId, turnId: plan.turnId, actions: [], blocked: true }
    }

    // Aborted before the first command: never touch hardware. The audit still
    // records which beats the preemption dropped.
    if (isAborted(signal)) {
      const remainingBeats = remainingBeatIds(resolved.commands)
      await this.recordResolved({
        plan,
        planId: resolved.planId,
        blocked: false,
        blockedReason: undefined,
        dropped,
        actions: [],
        narrativeOnly: resolved.narrativeOnlyBeats,
        warnings,
        preempted: true,
        remainingBeats,
      })
      return {
        planId: resolved.planId,
        turnId: plan.turnId,
        actions: [],
        blocked: false,
        preempted: true,
        remainingBeats,
      }
    }

    const events: DispatchEvent[] = []
    const unsubscribe = this.options.registry.subscribe(event => {
      events.push(event)
    })
    const actions: DispatchStatus[] = []
    const probeDrafts = new Map<string, ProbeDraft>()
    const intentByBeat = new Map<string, string>(
      plan.beats.map((beat): [string, string] => [beat.id, beat.intentId]),
    )
    let preempted = false

    try {
      for (const command of resolved.commands) {
        // Checked before every command, so a beat that already started keeps
        // its effect while the rest of the plan is dropped (§4.8).
        if (isAborted(signal)) {
          preempted = true
          break
        }
        const seen = events.length
        const result = await this.dispatchCommand(command, warnings)
        actions.push(result.status)
        if (result.status.status === 'rejected') continue
        this.noteProbeTarget(result.accepted, events.slice(seen), command, probeDrafts)
      }
    } finally {
      unsubscribe()
    }

    // One action per command, so the suffix that never ran starts at
    // `actions.length`. Deduplicated in command order: a beat with several
    // channels appears once, and a partially dispatched beat appears when some
    // of its commands were still pending.
    const remainingBeats = preempted ? remainingBeatIds(resolved.commands.slice(actions.length)) : []

    if (this.options.probes !== undefined) {
      for (const beat of plan.beats) {
        const draft = probeDrafts.get(beat.id)
        if (draft === undefined) continue
        const action: ProbeAction = {
          turnId: plan.turnId,
          beatId: beat.id,
          intentId: intentByBeat.get(beat.id) ?? beat.intentId,
          at: draft.at,
          targets: draft.targets,
        }
        try {
          this.options.probes.register(action)
        } catch (error) {
          warnings.push(`probe registration failed for beat ${beat.id}: ${describeError(error)}`)
        }
      }
    }

    await this.recordResolved({
      plan,
      planId: resolved.planId,
      blocked: false,
      blockedReason: undefined,
      dropped,
      actions,
      narrativeOnly: resolved.narrativeOnlyBeats,
      warnings,
      preempted,
      remainingBeats,
    })

    return {
      planId: resolved.planId,
      turnId: plan.turnId,
      actions,
      blocked: false,
      ...(preempted ? { preempted: true, remainingBeats } : {}),
    }
  }

  /**
   * Record a dispatched command's beat as probeable and collect its targets.
   *
   * Only commands that were accepted by the safety runtime and produced a
   * `level`/`pattern` event count: `stop` and `setWaveform` are bypasses in
   * the probe contract (`感知闭环与控制分离-设计草案.md` §2.4, D3).
   */
  private noteProbeTarget(
    accepted: boolean,
    dispatched: readonly DispatchEvent[],
    command: ResolvedCommand,
    drafts: Map<string, ProbeDraft>,
  ): void {
    if (!accepted) return
    const probeable = dispatched.some(
      event => PROBEABLE_EVENTS.has(event.kind)
        && event.deviceId === command.deviceId
        && event.channelId === command.channelId,
    )
    if (!probeable) return

    const first = dispatched.find(event => event.deviceId === command.deviceId && event.channelId === command.channelId)
    const draft = drafts.get(command.beatId)
    const target: ProbeTarget = { deviceId: command.deviceId, channelId: command.channelId }
    if (draft === undefined) {
      drafts.set(command.beatId, { at: first?.at ?? this.options.clock.now(), targets: [target] })
      return
    }
    if (!draft.targets.some(entry => entry.deviceId === target.deviceId && entry.channelId === target.channelId)) {
      draft.targets.push(target)
    }
  }

  /** Send one resolved command through the registry; never throws. */
  private async dispatchCommand(
    command: ResolvedCommand,
    warnings: string[],
  ): Promise<{ status: DispatchStatus; accepted: boolean }> {
    const base = { beatId: command.beatId, deviceId: command.deviceId, channelId: command.channelId }
    const body = command.body
    try {
      if (body.kind === 'level') {
        // `percent: 0` is how a stop is expressed. The registry's setLevel
        // routes a zero level to `stop` (percent 0, no hold time).
        await this.options.registry.setLevel(PLAN_ACTOR, {
          deviceId: command.deviceId,
          channelId: command.channelId,
          percent: body.percent,
          durationSec: body.durationSec,
        })
        return { status: { ...base, status: statusOf(command), percent: body.percent }, accepted: true }
      }
      if (body.kind === 'pattern') {
        const waveformId = this.checkedWaveformId(body.waveformId, warnings)
        await this.options.registry.runPattern(PLAN_ACTOR, {
          deviceId: command.deviceId,
          channelId: command.channelId,
          envelope: body.envelope,
          durationSec: body.durationSec,
          ...(waveformId === undefined ? {} : { waveformId }),
        })
        return { status: { ...base, status: statusOf(command), percent: body.envelope.maxPercent }, accepted: true }
      }
      await this.options.registry.setWaveform(PLAN_ACTOR, command.deviceId, command.channelId, body.waveformId)
      return { status: { ...base, status: statusOf(command) }, accepted: true }
    } catch (error) {
      return {
        status: { ...base, status: 'rejected', reason: describeError(error) },
        accepted: false,
      }
    }
  }

  /**
   * Last look at a waveform id before it reaches the registry.
   *
   * The resolver already degraded an unknown id against the snapshot it was
   * given. The library can still lose a scratch waveform between resolution
   * and dispatch, and a throw there would reject an otherwise fine command.
   */
  private checkedWaveformId(waveformId: string | undefined, warnings: string[]): string | undefined {
    if (waveformId === undefined) return undefined
    if (this.options.waveforms.get(waveformId) !== undefined) return waveformId
    warnings.push(`waveform "${waveformId}" was gone at dispatch time; running a plain pattern instead`)
    return undefined
  }

  /** Append the one audit record this module owns. Never throws. */
  private async recordResolved(input: AuditInput): Promise<void> {
    const detail: Record<string, unknown> = {
      planId: input.planId,
      turnId: input.plan.turnId,
      phase: input.plan.phase,
      pacing: input.plan.pacing,
      blocked: input.blocked,
      dropped: input.dropped,
      actions: input.actions,
      narrativeOnly: input.narrativeOnly,
      warnings: input.warnings,
      ...(input.blockedReason === undefined ? {} : { blockedReason: input.blockedReason }),
      // Additive keys: existing records are unchanged for a normal dispatch.
      ...(input.preempted ? { preempted: true, remainingBeats: input.remainingBeats } : {}),
    }
    await this.options.audit.record({ actor: PLAN_ACTOR, action: PLAN_RESOLVED, result: 'ok', detail })
  }
}

/**
 * Unique beat ids of the commands that were never attempted, in command order.
 *
 * Commands are sorted by `(beatId, deviceId, channelId)`, so this keeps the
 * plan's beat order for the audit and the returned result.
 */
function remainingBeatIds(commands: readonly ResolvedCommand[]): string[] {
  const remaining: string[] = []
  const seen = new Set<string>()
  for (const command of commands) {
    if (seen.has(command.beatId)) continue
    seen.add(command.beatId)
    remaining.push(command.beatId)
  }
  return remaining
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true
}

/**
 * Map a resolved command to its dispatch status.
 *
 * `degraded` wins over `clamped`: a `no-region-match` fallback that was also
 * capped is better explained by the route than by the cap.
 */
function statusOf(command: ResolvedCommand): DispatchStatus['status'] {
  if (command.degraded !== undefined) return 'degraded'
  if (command.clamped) return 'clamped'
  return 'dispatched'
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as { readonly code?: unknown }).code
    return typeof code === 'string' ? `${code}: ${error.message}` : error.message
  }
  return String(error)
}
