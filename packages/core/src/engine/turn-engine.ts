/**
 * The turn engine: one scheduler, one turn at a time, one priority ladder.
 *
 * It owns *when* a turn runs and *who* may interrupt it. It never talks to a
 * device and never parses model output: the injected {@link TurnRunner} does
 * the work (single-call pipeline in M2), and the executor below it is the only
 * dispatch path. That split is what makes the state machine testable with a
 * fake runner and a `FakeClock`.
 *
 * Scope of this module (M2-B1/B2): the state machine, single-call
 * timeout/abort, P1 preemption with the §4.8 grace window, pause/resume/end,
 * panic/unlock, and the P2/P3 queue rules. The ladder and the queue itself
 * live in `scheduler.ts` (B2-T4). Autopilot *timing* (B2-T5), choices timeouts
 * (B2-T6) and session persistence hooks (B2-T7) plug in through the optional
 * hooks below.
 */

import type { AuditLog } from '../devices/audit.ts'
import type { Clock, Timer } from '../ports/clock.ts'
import type { PlayerChoice } from '../scenario/beat-plan.ts'
import {
  planPreemption,
  PriorityQueue,
  startsTurn,
  TURN_PRIORITY_ORDER,
  type TurnPriority,
  type TurnTrigger,
} from './scheduler.ts'
import {
  assertTransition,
  isTerminalState,
  refusesNewTurns,
  type TurnOutcome,
  type TurnState,
} from './state-machine.ts'

/** Placeholder line when the model/text path failed (`导演与写作上下文契约.md` §3). */
export const TEMPLATE_LINE = '（短暂停顿）'

/**
 * One request for a turn.
 *
 * `onStage` is how the engine learns that the plan arrived (`executing`) and
 * that text started streaming (`writing`) inside a single-call turn: without
 * it the engine could only observe the whole request.
 *
 * `preemptSignal` (B2-T4) is the *cooperative* half of P1 preemption: it fires
 * as soon as a player input is accepted, while `signal` is the hard abort
 * (immediate in `planning`/`writing`, delayed by `preemptGraceMs` in
 * `executing`). A runner that dispatches beats listens here to finish the
 * in-flight beat, drop the rest and resolve; runners that ignore it are still
 * hard-aborted at the grace deadline. Its `reason` is `'player'` or `'writer'`.
 */
export interface TurnRequest {
  readonly turnId: number
  readonly phase: string
  readonly signal: AbortSignal
  readonly preemptSignal?: AbortSignal
  readonly playerText?: string
  readonly choiceId?: string
  readonly checkpoint?: number
  /** Called by the runner as the request advances; must be cheap and sync. */
  readonly onStage?: (stage: 'executing' | 'writing') => void
}

/** What the runner reports back. */
export interface TurnRunnerResult {
  readonly line?: string
  readonly choices?: readonly PlayerChoice[]
  /** Defaults to `completed`. A runner may report `fallback` for a degraded turn. */
  readonly outcome?: TurnOutcome
}

/**
 * The single-call (or split) pipeline behind a turn.
 *
 * Structural on purpose: B1-T10's `runTurn` and B2-T3's split pipeline both
 * satisfy it without the engine importing either.
 */
export interface TurnRunner {
  run(request: TurnRequest): Promise<TurnRunnerResult>
}

/** Engine tuning. Defaults match `回合引擎与调度-设计草案.md` §9 as amended by D6/D12. */
export interface EngineConfig {
  /** D6: single-call mode = one controller + one total timeout. */
  readonly turnTimeoutMs: number
  /** Only meaningful once the director/writer split exists (M3+). */
  readonly split?: {
    readonly directorTimeoutMs: number
    readonly writerTimeoutMs: number
  }
  /** P1 preemption grace while a beat is being dispatched. */
  readonly preemptGraceMs: number
  readonly autopilot: { readonly minSec: number; readonly maxSec: number; readonly defaultSec: number }
  readonly choices: {
    readonly enabled: boolean
    readonly max: number
    readonly timeoutSec: number
    readonly fallback: 'passive'
  }
  readonly checkpoints: readonly number[]
  readonly endGraceMin: number
  readonly maxConsecutiveFailures: number
  readonly snapshotEveryTurn: boolean
}

export const DEFAULT_ENGINE_CONFIG: EngineConfig = {
  turnTimeoutMs: 60_000,
  preemptGraceMs: 500,
  autopilot: { minSec: 10, maxSec: 60, defaultSec: 20 },
  choices: { enabled: true, max: 3, timeoutSec: 60, fallback: 'passive' },
  checkpoints: [0.5, 0.8, 0.9],
  endGraceMin: 5,
  maxConsecutiveFailures: 2,
  snapshotEveryTurn: true,
}

/** Observability for the debug panel and tests. */
export interface EngineEvent {
  readonly type: 'state' | 'turn' | 'line' | 'choices' | 'error'
  readonly at: number
  readonly detail: unknown
}

/** What the console and the model-facing state read. */
export interface EngineSnapshot {
  readonly state: TurnState
  readonly turnId: number
  readonly phase: string
  readonly elapsedMin: number
  readonly remainingMin: number | null
  readonly lastLine: string | undefined
  readonly choices: readonly PlayerChoice[] | undefined
  readonly outcome: TurnOutcome | undefined
}

/** Hooks the host fills in as later tasks land. All optional for B1-T11. */
export interface TurnEngineHooks {
  /** Current phase id; defaults to `scene`. */
  readonly phase?: () => string
  /** Planned session length, for `elapsedMin` / `remainingMin`. */
  readonly plannedMinutes?: number
  /** Persist the turn snapshot (B2-T7). */
  readonly onSettle?: (snapshot: EngineSnapshot) => Promise<void> | void
  /** Stop every effect on entering `paused` (B2-T9 wires `registry.stop`). */
  readonly onPause?: () => Promise<void> | void
  readonly onResume?: () => void
  /** Out-of-band stop (the registry audits `panic` itself). */
  readonly onPanic?: (source: string) => Promise<void> | void
  /** aftercare / forced resolve (B2-T5). */
  readonly onEnd?: (reason: EndReason) => Promise<void> | void
  readonly onEvent?: (event: EngineEvent) => void
}

/** Why a session ended; matches the ledger's `endReason` set minus `unexpected_exit`. */
export type EndReason = 'completed' | 'left_early' | 'stop'

export interface TurnEngineOptions extends TurnEngineHooks {
  readonly clock: Clock
  readonly audit: AuditLog
  readonly runner: TurnRunner
  readonly config?: Partial<EngineConfig>
}

interface ActiveTurn {
  readonly turnId: number
  readonly controller: AbortController
  /** Cooperative preemption notice; hard abort stays on `controller`. */
  readonly preemptController: AbortController
  readonly startedAt: number
  stage: 'planning' | 'executing' | 'writing'
  /** Set once a P1 preempt has been accepted for this turn. */
  preempted: boolean
  /** Hard-abort backstop while an executing beat uses its grace window. */
  preemptTimer: Timer | undefined
}

function mergeConfig(partial: Partial<EngineConfig> | undefined): EngineConfig {
  if (partial === undefined) return DEFAULT_ENGINE_CONFIG
  return {
    ...DEFAULT_ENGINE_CONFIG,
    ...partial,
    autopilot: { ...DEFAULT_ENGINE_CONFIG.autopilot, ...partial.autopilot },
    choices: { ...DEFAULT_ENGINE_CONFIG.choices, ...partial.choices },
  }
}

/** One scheduler, one turn at a time, one priority ladder. */
export class TurnEngine {
  private readonly clock: Clock
  private readonly audit: AuditLog
  private readonly runner: TurnRunner
  private readonly config: EngineConfig
  private readonly hooks: TurnEngineHooks

  private turnState: TurnState = 'idle'
  private currentTurnId = 0
  private lastOutcome: TurnOutcome | undefined
  private lastLine: string | undefined
  private currentChoices: readonly PlayerChoice[] | undefined
  private active: ActiveTurn | undefined
  private currentRun: Promise<void> | undefined
  private readonly queue = new PriorityQueue()
  private readonly startedAt: number
  private consecutiveFailures = 0
  private timedOut = false
  /** P1 inputs waiting for the preempted turn to settle; blocks queue drain. */
  private playerInputsPending = 0
  private pauseRequested = false
  /** P0 landed during the active turn; its outcome is `cancelled`, not a model fallback. */
  private panicked = false
  private disposed = false

  constructor(options: TurnEngineOptions) {
    this.clock = options.clock
    this.audit = options.audit
    this.runner = options.runner
    this.config = mergeConfig(options.config)
    this.hooks = options
    this.startedAt = this.clock.now()
  }

  get state(): TurnState {
    return this.turnState
  }

  /** True while a turn is in flight (planning/executing/writing/settling). */
  get busy(): boolean {
    return this.currentRun !== undefined
  }

  /** Number of P2 triggers waiting behind the active turn (debug panel / tests). */
  get queueSize(): number {
    return this.queue.size
  }

  snapshot(): EngineSnapshot {
    const elapsedMs = this.clock.now() - this.startedAt
    const planned = this.hooks.plannedMinutes
    return {
      state: this.turnState,
      turnId: this.currentTurnId,
      phase: this.currentPhase(),
      elapsedMin: Math.floor(elapsedMs / 60_000),
      remainingMin: planned === undefined ? null : Math.max(0, planned - Math.floor(elapsedMs / 60_000)),
      lastLine: this.lastLine,
      choices: this.currentChoices,
      outcome: this.lastOutcome,
    }
  }

  /**
   * P2/P3/P4/P5 entry point.
   *
   * The queue rules live in {@link PriorityQueue} (B2-T4): P2 queues, P3 is
   * dropped while busy, P4/P5 never start a turn. P1 (`player`) is routed to
   * the preempt path so a trigger record from the host behaves like a message.
   * P0 goes through {@link panic}.
   */
  submit(trigger: TurnTrigger): void {
    if (this.disposed || isTerminalState(this.turnState)) return
    if (refusesNewTurns(this.turnState)) {
      this.emit('error', { reason: 'locked', kind: trigger.kind })
      return
    }
    if (!startsTurn(trigger.priority)) {
      // P4/P5: context refresh only, never a turn, never a queue item.
      this.emit('turn', { ignored: true, priority: trigger.priority, kind: trigger.kind })
      return
    }
    if (trigger.priority === 'player') {
      // P1 submitted as a trigger record still preempts like a message.
      this.guardRun(this.submitPlayerInput({
        kind: trigger.kind === 'choice' ? 'choice' : 'player',
        ...(trigger.payload?.text === undefined ? {} : { text: trigger.payload.text }),
        ...(trigger.payload?.choiceId === undefined ? {} : { choiceId: trigger.payload.choiceId }),
      }))
      return
    }
    if (this.turnState === 'paused') {
      // Paused means "no turns" until a human resumes; P1 resumes explicitly
      // through submitPlayerMessage, so a queued trigger cannot sneak in.
      this.emit('turn', { ignored: true, reason: 'paused', priority: trigger.priority, kind: trigger.kind })
      return
    }
    if (this.currentRun !== undefined) {
      const decision = this.queue.submit(trigger)
      if (decision === 'queued') this.emit('turn', { queued: true, kind: trigger.kind, priority: trigger.priority })
      else this.emit('turn', { dropped: true, kind: trigger.kind, priority: trigger.priority })
      return
    }
    this.guardRun(this.start(trigger))
  }

  /**
   * P1: a player message or choice. Always preempts: the current turn is
   * cancelled and a new one starts with this input.
   */
  async submitPlayerMessage(text: string): Promise<void> {
    await this.submitPlayerInput({ kind: 'player', text })
  }

  /** P1: picking an option is a player message with a choice id. */
  async submitChoice(id: string): Promise<void> {
    await this.submitPlayerInput({ kind: 'choice', choiceId: id })
  }

  /** Queue a pause; it lands after the current turn settles (decision 3). */
  async pause(): Promise<void> {
    if (this.disposed || this.turnState === 'paused') return
    if (refusesNewTurns(this.turnState)) return
    this.pauseRequested = true
    await this.currentRun
    this.pauseRequested = false
    // A panic or an end may have won the race while we waited.
    if (this.turnState !== 'idle') return
    this.setState('paused')
    await this.hooks.onPause?.()
    await this.audit.record({ actor: 'human', action: 'session_paused', result: 'ok' })
    this.emit('state', { state: this.turnState })
  }

  /** Resolve when no turn is in flight (tests and the host's shutdown path). */
  async whenIdle(): Promise<void> {
    await this.currentRun
  }

  /** Leave `paused`; effects are not replayed (decision 4). */
  async resume(): Promise<void> {
    if (this.turnState !== 'paused') return
    this.setState('idle')
    this.hooks.onResume?.()
    await this.audit.record({ actor: 'human', action: 'session_resumed', result: 'ok' })
    this.emit('state', { state: this.turnState })
    this.drainQueue()
  }

  /** P0: out-of-band stop. Never queued, never blocked by a busy turn. */
  async panic(source: string): Promise<void> {
    this.queue.clear()
    this.panicked = true
    this.abortActive()
    await this.hooks.onPanic?.(source)
    if (this.turnState !== 'locked' && !isTerminalState(this.turnState)) this.setState('locked')
    this.emit('state', { state: this.turnState, reason: 'panic' })
  }

  /** Human unlock; the only way out of `locked`. */
  unlock(note?: string): void {
    if (this.turnState !== 'locked') return
    this.setState('idle')
    this.emit('state', { state: this.turnState, ...(note === undefined ? {} : { note }) })
    this.drainQueue()
  }

  /** End the session: wait for the active turn, then run the end hooks. */
  async end(reason: EndReason): Promise<void> {
    if (isTerminalState(this.turnState) || this.turnState === 'ending') return
    this.queue.clear()
    await this.currentRun
    if (isTerminalState(this.turnState)) return
    if (this.turnState === 'locked') {
      // A panicked session ends from `locked` too; ending is allowed from it.
      this.setState('ending')
    } else {
      this.setState('ending')
    }
    await this.hooks.onEnd?.(reason)
    await this.audit.record({ actor: 'human', action: 'session_end', result: 'ok', detail: { reason } })
    if (this.liveState() !== 'ending') return
    this.setState('ended')
    this.emit('state', { state: this.turnState, reason })
  }

  /** Cancel timers; tests call it so `FakeClock.pendingCount` returns to zero. */
  dispose(): void {
    this.disposed = true
    this.queue.clear()
    this.abortActive()
  }

  // ── internals ─────────────────────────────────────────────────────────

  /**
   * Read the live state through a call.
   *
   * TypeScript narrows a property across `await` even though a panic may have
   * moved it; reading it via a method defeats that false narrowing.
   */
  private liveState(): TurnState {
    return this.turnState
  }

  private currentPhase(): string {
    return this.hooks.phase?.() ?? 'scene'
  }

  /** Fire-and-forget a run without ever leaking an unhandled rejection. */
  private guardRun(run: Promise<void>): void {
    void run.catch(error => {
      this.emit('error', { phase: 'engine', message: error instanceof Error ? error.message : String(error) })
    })
  }

  private emit(type: EngineEvent['type'], detail: unknown): void {
    try {
      this.hooks.onEvent?.({ type, at: this.clock.now(), detail })
    } catch {
      // Observability must never break the control path.
    }
  }

  private setState(next: TurnState): void {
    if (this.turnState === next) return
    assertTransition(this.turnState, next)
    this.turnState = next
    this.emit('state', { state: next })
  }

  /** P1 path shared by messages and choices. */
  private async submitPlayerInput(input: { kind: 'player' | 'choice'; text?: string; choiceId?: string }): Promise<void> {
    if (this.disposed || isTerminalState(this.turnState)) return
    if (this.turnState === 'locked') {
      await this.audit.record({ actor: 'human', action: 'preempted', result: 'rejected', reason: 'locked' })
      this.emit('error', { reason: 'locked', kind: input.kind })
      return
    }
    if (this.turnState === 'ending') {
      // The session is already closing; a late message must not open a turn.
      this.emit('error', { reason: 'ending', kind: input.kind })
      return
    }
    if (this.turnState === 'paused') await this.resume()

    const trigger: TurnTrigger = {
      priority: 'player',
      kind: input.kind,
      at: this.clock.now(),
      payload: {
        ...(input.text === undefined ? {} : { text: input.text }),
        ...(input.choiceId === undefined ? {} : { choiceId: input.choiceId }),
      },
    }

    // P1 always wins: preempt the turn in flight, then open a new one. The
    // pending counter stops the settling tail from starting a queued P2 turn
    // in the window between the old turn ending and this input starting.
    this.playerInputsPending += 1
    try {
      const running = this.currentRun
      const active = this.active
      if (running !== undefined && active !== undefined && !active.preempted) {
        await this.preempt(active)
      }
      // The old turn's runner decides how much of the beat completes; the new
      // turn never overlaps it.
      if (running !== undefined) await running
    } finally {
      this.playerInputsPending -= 1
    }
    await this.start(trigger)
  }

  /** Apply the §4.8 preemption matrix to the in-flight turn, then audit it. */
  private async preempt(active: ActiveTurn): Promise<void> {
    const from = active.stage
    const plan = planPreemption(from, this.config.preemptGraceMs)
    active.preempted = true
    // Control first: the runner gets the cooperative notice (and the hard abort
    // when the matrix says so) before the audit sink is touched.
    active.preemptController.abort(plan.reason)
    if (plan.immediate) {
      active.controller.abort()
    } else {
      // `executing`: let the in-flight beat finish, but no longer than the
      // grace window. Already-dispatched effects are never rolled back.
      active.preemptTimer = this.clock.timeout(plan.graceMs, () => {
        if (this.active?.turnId === active.turnId) active.controller.abort()
      })
    }
    await this.audit.record({
      actor: 'system',
      action: plan.action,
      result: 'ok',
      detail: {
        turnId: active.turnId,
        from,
        reason: plan.reason,
        ...(plan.immediate ? {} : { graceMs: plan.graceMs }),
      },
    })
  }

  /** Abort whatever is in flight, timers included (panic / dispose). */
  private abortActive(): void {
    const active = this.active
    if (active === undefined) return
    active.preemptTimer?.cancel()
    active.preemptTimer = undefined
    active.preemptController.abort('panic')
    active.controller.abort()
  }

  /** Run one trigger to completion, keeping `currentRun` observable. */
  private start(trigger: TurnTrigger): Promise<void> {
    const run = this.execute(trigger)
    this.currentRun = run
    return run.finally(() => {
      if (this.currentRun === run) this.currentRun = undefined
    })
  }

  private async execute(trigger: TurnTrigger): Promise<void> {
    // A panic may have landed between queueing this turn and starting it.
    if (this.liveState() === 'locked' || isTerminalState(this.liveState())) return
    if (this.pauseRequested) {
      this.setState('paused')
      await this.hooks.onPause?.()
      await this.audit.record({ actor: 'human', action: 'session_paused', result: 'ok' })
      this.pauseRequested = false
      return
    }
    const turnId = ++this.currentTurnId
    const controller = new AbortController()
    const preemptController = new AbortController()
    const active: ActiveTurn = {
      turnId,
      controller,
      preemptController,
      startedAt: this.clock.now(),
      stage: 'planning',
      preempted: false,
      preemptTimer: undefined,
    }
    this.active = active
    this.timedOut = false
    this.panicked = false
    this.lastOutcome = undefined
    this.currentChoices = undefined

    const timeout: Timer = this.clock.timeout(this.config.turnTimeoutMs, () => {
      if (this.active?.turnId !== turnId) return
      this.timedOut = true
      controller.abort()
    })

    this.setState('planning')
    this.emit('turn', { turnId, kind: trigger.kind, priority: trigger.priority })
    // §4.11: the turn lifecycle is part of the replay contract. The append is
    // started before the runner so the record is ordered ahead of dispatch;
    // it is awaited before the completion record so the pair never inverts.
    const startedAudit = this.audit.record({
      actor: 'system',
      action: 'turn_started',
      result: 'ok',
      detail: { turnId, trigger: trigger.kind, priority: trigger.priority },
    })

    let outcome: TurnOutcome = 'completed'
    try {
      const result = await this.runner.run({
        turnId,
        phase: this.currentPhase(),
        signal: controller.signal,
        preemptSignal: preemptController.signal,
        ...(trigger.payload?.text === undefined ? {} : { playerText: trigger.payload.text }),
        ...(trigger.payload?.choiceId === undefined ? {} : { choiceId: trigger.payload.choiceId }),
        ...(trigger.payload?.checkpoint === undefined ? {} : { checkpoint: trigger.payload.checkpoint }),
        onStage: stage => {
          if (this.active?.turnId !== turnId) return
          active.stage = stage
          this.setState(stage)
        },
      })
      if (this.active?.turnId !== turnId) return
      if (!active.preempted) {
        if (result.line !== undefined) {
          this.lastLine = result.line
          this.emit('line', { turnId, text: result.line })
        }
        if (result.choices !== undefined) {
          this.currentChoices = result.choices
          this.emit('choices', { turnId, choices: result.choices })
        }
      }
      // A preempted turn stays preempted even when the runner resolves cleanly
      // inside its grace window; its partial line is never back-filled.
      outcome = active.preempted ? 'preempted' : result.outcome ?? 'completed'
      this.consecutiveFailures = outcome === 'completed' ? 0 : this.consecutiveFailures + 1
    } catch (failure) {
      if (this.active?.turnId !== turnId) return
      if (this.panicked) {
        // P0: out-of-band stop, not a model degradation.
        outcome = 'cancelled'
      } else if (active.preempted) {
        outcome = 'preempted'
      } else if (this.timedOut) {
        outcome = 'timeout'
      } else {
        outcome = 'fallback'
      }
      if (outcome !== 'preempted' && outcome !== 'cancelled') {
        this.consecutiveFailures += 1
        this.lastLine = TEMPLATE_LINE
        await this.audit.record({
          actor: 'system',
          action: 'plan_fallback',
          result: 'error',
          reason: outcome,
          detail: { turnId, message: failure instanceof Error ? failure.message : String(failure) },
        })
        this.emit('error', { turnId, outcome })
      }
    } finally {
      timeout.cancel()
      active.preemptTimer?.cancel()
      active.preemptTimer = undefined
    }

    if (this.active?.turnId !== turnId) return
    this.active = undefined
    this.lastOutcome = outcome

    if (this.liveState() === 'locked' || isTerminalState(this.liveState())) {
      // P0 wins: no settle transition enters the tail, and the latch stays
      // until a human unlocks. Without this guard `locked -> idle` silently
      // released the emergency latch (wave-3 review finding).
      this.emit('turn', { turnId, outcome })
      return
    }
    this.setState('settling')
    try {
      if (this.config.snapshotEveryTurn) await this.hooks.onSettle?.(this.snapshot())
    } catch (error) {
      this.emit('error', { turnId, phase: 'settle', message: error instanceof Error ? error.message : String(error) })
    }
    await startedAudit
    await this.audit.record({
      actor: 'system',
      action: 'turn_completed',
      result: 'ok',
      detail: { turnId, outcome, durationMs: this.clock.now() - active.startedAt },
    })
    if (this.turnState === 'locked' || isTerminalState(this.turnState)) return
    if (this.pauseRequested) {
      this.setState('paused')
      await this.hooks.onPause?.()
      await this.audit.record({ actor: 'human', action: 'session_paused', result: 'ok' })
      this.pauseRequested = false
      return
    }
    this.setState('idle')
    this.emit('turn', { turnId, outcome })
    this.drainQueue()
  }

  /** Start the next queued P2 trigger, if the engine is free. */
  private drainQueue(): void {
    if (this.disposed || this.active !== undefined || this.pauseRequested) return
    if (this.playerInputsPending > 0) return
    if (this.turnState !== 'idle') return
    const [next] = this.queue.drain(1)
    if (next === undefined) return
    this.guardRun(this.start(next))
  }

  /** Exposed for tests and the failure-streak policy in B2-T5. */
  get consecutiveFailureCount(): number {
    return this.consecutiveFailures
  }

  /** Priority ladder, re-exported from the scheduler for older callers. */
  static readonly priority: Readonly<Record<TurnPriority, number>> = TURN_PRIORITY_ORDER
}
