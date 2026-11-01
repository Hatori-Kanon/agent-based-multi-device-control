/**
 * Phase progression and drift detection.
 *
 * A scenario pack declares a small graph of phases (`phases[].next`); the
 * machine below is the only component allowed to change `current`. Two rules
 * keep it honest:
 *
 * 1. **`advanceTo` only accepts an edge that exists.** A model output can never
 *    teleport the session into a later phase — advancing is an engine decision
 *    derived from the graph plus the clock, not a narrative claim.
 * 2. **`driftHint` is advisory.** When the director plans a resolve-shaped turn
 *    while the session is still in an early phase, the engine injects one
 *    reminder into the next prompt instead of dropping the plan. Detection
 *    explains, it does not police (`剧本系统设计.md` §4).
 *
 * Time checkpoints follow `回合引擎与调度-设计草案.md` §7: 50% and 80% only add
 * a reminder, 90% flips `mustResolve` so the next turn can only produce a
 * closing plan. The hard stop at planned time + `session.endGraceMin` lives in
 * the turn engine, not here.
 */

/** Min/max phase node the machine needs; `ScenarioPhase` satisfies it. */
export interface PhaseNode {
  readonly id: string
  readonly goal: string
  readonly next: readonly string[]
}

/** Default reminder/closing checkpoints as fractions of the planned session. */
export const DEFAULT_CHECKPOINTS: readonly number[] = [0.5, 0.8, 0.9]

/** From this fraction on, the next turn must be a resolve turn. */
export const MUST_RESOLVE_RATIO = 0.9

/** Beats that read as closing rather than escalation. */
const CLOSING_INTENTS: ReadonlySet<string> = new Set(['stop', 'soothe'])

/**
 * The part of a `BeatPlan` drift detection needs.
 *
 * Kept structural (instead of importing `scenario/beat-plan.ts`) so a full
 * `BeatPlan` is assignable without coupling this module to the parser's export
 * surface. `phase` is engine-injected in production; when present it lets the
 * check catch a plan written for another phase.
 */
export interface PhasePlanView {
  readonly phase?: string
  readonly pacing?: string
  readonly beats: readonly { readonly intentId: string }[]
}

/** What to do at a given point in the planned time budget. */
export interface PhaseCheckpoint {
  /** Highest checkpoint already reached, e.g. `0.5`; absent before the first. */
  readonly checkpoint?: number
  /** True from {@link MUST_RESOLVE_RATIO} on: the next plan must resolve. */
  readonly mustResolve: boolean
}

export class PhaseMachine {
  private readonly phases: readonly PhaseNode[]
  private readonly index: ReadonlyMap<string, PhaseNode>
  private readonly checkpoints: readonly number[]
  private currentId: string

  /**
   * @param phases - Non-empty phase graph in declaration order (the first one
   *   is the starting phase).
   * @param current - Starting phase id; defaults to the first phase.
   */
  constructor(phases: readonly PhaseNode[], current?: string) {
    if (phases.length === 0) throw new Error('PhaseMachine needs at least one phase')
    this.phases = [...phases]
    this.index = new Map(this.phases.map(phase => [phase.id, phase]))
    if (this.index.size !== this.phases.length) throw new Error('PhaseMachine phases must have unique ids')
    const start = current ?? this.phases[0]!.id
    if (!this.index.has(start)) throw new Error(`unknown starting phase "${start}"`)
    this.currentId = start
    this.checkpoints = [...DEFAULT_CHECKPOINTS].sort((left, right) => left - right)
  }

  /** Id of the current phase. */
  get current(): string {
    return this.currentId
  }

  /** Current phase node (goal, advanceWhen, allowed transitions). */
  get currentPhase(): PhaseNode {
    return this.index.get(this.currentId)!
  }

  /** Phase ids the session may legally advance to; empty in a terminal phase. */
  get allowedNext(): readonly string[] {
    return this.currentPhase.next
  }

  /** True when the current phase has no outgoing edges. */
  get isTerminal(): boolean {
    return this.allowedNext.length === 0
  }

  /**
   * Advance along one declared edge.
   *
   * @throws Error when `id` is not in {@link allowedNext}; the current phase
   *   is left untouched in that case.
   */
  advanceTo(id: string): void {
    if (!this.allowedNext.includes(id)) {
      const allowed = this.allowedNext.length === 0 ? 'none (terminal phase)' : this.allowedNext.join(', ')
      throw new Error(`cannot advance from phase "${this.currentId}" to "${id}"; allowed next: ${allowed}`)
    }
    this.currentId = id
  }

  /**
   * What the time budget says right now.
   *
   * @param ratio - elapsed / planned, `0..1+`. `null` budgets are open-ended;
   *   callers pass `0` for them.
   */
  at(ratio: number): PhaseCheckpoint {
    const safe = Number.isFinite(ratio) ? Math.max(0, ratio) : 0
    let checkpoint: number | undefined
    for (const candidate of this.checkpoints) {
      if (safe >= candidate) checkpoint = candidate
    }
    const mustResolve = safe >= MUST_RESOLVE_RATIO
    return checkpoint === undefined ? { mustResolve } : { checkpoint, mustResolve }
  }

  /**
   * One-sentence reminder when a plan drifts from the current phase, or
   * `undefined` when the plan fits. Never throws on malformed model output —
   * an empty or unknown-intent plan simply produces no hint.
   */
  driftHint(plan: PhasePlanView): string | undefined {
    if (typeof plan !== 'object' || plan === null) return undefined

    // A plan stamped with another phase is the clearest drift signal.
    if (plan.phase !== undefined && plan.phase !== this.currentId) {
      if (!this.allowedNext.includes(plan.phase)) {
        return `the plan was written for phase "${plan.phase}" but the session is in "${this.currentId}"; plan inside the current phase`
      }
    }

    const beats = Array.isArray(plan.beats) ? plan.beats : []
    const resolveShaped = plan.pacing === 'release' || (beats.length > 0 && beats.every(beat => CLOSING_INTENTS.has(beat.intentId)))
    if (!resolveShaped || this.isTerminal) return undefined

    const terminal = this.phases.find(phase => phase.next.length === 0)
    const target = terminal === undefined ? 'a terminal phase' : `the final phase "${terminal.id}"`
    return `this plan is resolve-shaped (release pacing / only stop-soothe beats) but phase "${this.currentId}" is still running; save the closing beat for ${target} or for a mustResolve turn`
  }
}
