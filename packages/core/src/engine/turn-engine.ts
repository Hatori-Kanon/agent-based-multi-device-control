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
 * panic/unlock, the P2/P3 queue rules, autopilot pacing plus the session time
 * budget (B2-T5), and choice timeouts/audit (B2-T6). The ladder and the queue
 * itself live in `scheduler.ts` (B2-T4); session persistence hooks (B2-T7)
 * plug in through the optional hooks below.
 */

import type { AuditLog } from '../devices/audit.ts'
import type { Clock, Timer } from '../ports/clock.ts'
import type { PlayerChoice } from '../scenario/beat-plan.ts'
import { MUST_RESOLVE_RATIO } from '../scenario/phases.ts'
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
  canTransition,
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
  /**
   * True when this turn must produce a closing plan (B2-T5): from the 90%
   * checkpoint on, and for the forced resolve turn at
   * `plannedMinutes + endGraceMin`.
   */
  readonly mustResolve?: boolean
  /** Called by the runner as the request advances; must be cheap and sync. */
  readonly onStage?: (stage: 'executing' | 'writing') => void
}

/** What the runner reports back. */
export interface TurnRunnerResult {
  readonly line?: string
  readonly choices?: readonly PlayerChoice[]
  /**
   * The plan's `BeatPlan.nextTurnAfterSec` suggestion (B2-T5). The engine
   * clamps it into `[autopilot.minSec, autopilot.maxSec]` and adopts it for
   * the next autopilot tick; `undefined` keeps the current interval.
   */
  readonly nextTurnAfterSec?: number
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
  /**
   * Minimum aftercare duration in minutes (B2-T5, `session.aftercareMin`, S12).
   *
   * Optional on purpose: absent means "no minimum" (an immediate `ended`),
   * because the guard waits on the injected clock and a default would stall
   * every caller that ends a session. Hosts pass the pack value here
   * (`scenario.session.aftercareMin`, whose own default is 5).
   */
  readonly aftercareMin?: number
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
  /** Highest time checkpoint reached (B2-T5); `undefined` before 50%. */
  readonly checkpoint: number | undefined
  /** True from the 90% checkpoint on: the next turn must produce a closing plan. */
  readonly mustResolve: boolean
  /** Human-facing autopilot state: enabled flag, adopted interval and its bounds. */
  readonly autopilot: {
    readonly enabled: boolean
    readonly intervalSec: number
    readonly minSec: number
    readonly maxSec: number
  }
}

/**
 * One time-checkpoint notification (B2-T5).
 *
 * 50% and 80% only inject a reminder; from 90% on `mustResolve` flips so the
 * next turn may only produce a closing plan (§7 of the design draft).
 */
export interface CheckpointUpdate {
  /** Fraction of the planned budget that was reached, e.g. `0.5`. */
  readonly checkpoint: number
  readonly mustResolve: boolean
  /** One-sentence reminder to inject into the next director prompt. */
  readonly reminder: string
}

/** Reminder sentence for a time checkpoint; the engine never blocks on it. */
export function checkpointReminder(ratio: number, mustResolve: boolean): string {
  const percent = Math.round(ratio * 100)
  if (mustResolve) {
    return `预计时长已过 ${percent}%，下一回合必须收束：只产出收尾/aftercare 意图，并停止升级。`
  }
  return `预计时长已过 ${percent}%，放慢升级节奏，把剩余时间留给收束。`
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
  /**
   * The adopted autopilot interval after clamping (B2-T5), in seconds.
   *
   * Observability only: the engine already adopted the value, so a host that
   * ignores this hook still gets the right pacing.
   */
  readonly onPlanPacing?: (seconds: number) => void
  /** A time checkpoint was reached; inject `reminder` into the next prompt. */
  readonly onCheckpoint?: (update: CheckpointUpdate) => void
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
  /** Tail of the P1 queue: two messages must never start two turns at once. */
  private playerQueueTail: Promise<void> = Promise.resolve()
  private playerQueueDepth = 0
  private disposed = false

  // B2-T5: autopilot pacing and the session time budget.
  private autopilotOn = false
  private autopilotTimer: Timer | undefined
  private intervalSec: number
  private sessionStarted = false
  private checkpointTimers: Timer[] = []
  private deadlineTimer: Timer | undefined
  private lastCheckpoint: number | undefined
  private mustResolveFlag = false
  /** A forced resolve arrived while paused; it fires on resume. */
  private forcedResolvePending = false

  // B2-T6: the choice menu and its passive fallback.
  private choiceTimer: Timer | undefined
  private currentChoicesTurnId: number | undefined

  // B2-T5: the aftercare minimum guard.
  private aftercareTimer: Timer | undefined
  private aftercareResolve: (() => void) | undefined

  constructor(options: TurnEngineOptions) {
    this.clock = options.clock
    this.audit = options.audit
    this.runner = options.runner
    this.config = mergeConfig(options.config)
    this.hooks = options
    this.startedAt = this.clock.now()
    this.intervalSec = this.clampAutopilotSec(this.config.autopilot.defaultSec)
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

  /** True while the P3 autopilot timer is enabled (B2-T5). */
  get autopilotEnabled(): boolean {
    return this.autopilotOn
  }

  /** Adopted gap between autopilot turns, already clamped to `[minSec,maxSec]`. */
  get autopilotIntervalSec(): number {
    return this.intervalSec
  }

  /**
   * Change the adopted autopilot interval (human setting, seconds).
   *
   * Clamped into `[autopilot.minSec, autopilot.maxSec]`; an armed timer is
   * re-armed so the new gap applies from now, not after the old tick. The
   * engine still adopts a plan's `nextTurnAfterSec` afterwards (that is the
   * model's pacing suggestion), so a host slider is a starting point rather
   * than a lock. Returns the clamped value.
   */
  setAutopilotInterval(seconds: number): number {
    const next = this.clampAutopilotSec(seconds)
    if (next === this.intervalSec) return next
    this.intervalSec = next
    if (this.autopilotOn) {
      this.scheduleAutopilotTick()
      // The auto choice timeout follows the autopilot interval: a player who
      // does not pick should not stall auto mode for a separate 60s budget.
      this.maybeArmChoiceTimeout()
    }
    this.publishPacing()
    return next
  }

  /** Highest time checkpoint reached so far (`0.5` / `0.8` / `0.9`), if any. */
  get checkpoint(): number | undefined {
    return this.lastCheckpoint
  }

  /** True from the 90% checkpoint on: the next turn must produce a closing plan. */
  get mustResolve(): boolean {
    return this.mustResolveFlag
  }

  /**
   * Turn the P3 autopilot timer on or off (B2-T5).
   *
   * Idempotent. A tick only *offers* a turn: it is dropped while another turn
   * runs or while a choice menu waits for the player, and never starts in
   * `paused` / `locked` / `ending` / `ended`. The adopted interval starts as
   * `autopilot.defaultSec` and changes only through a clamped
   * `BeatPlan.nextTurnAfterSec`.
   */
  setAutopilot(enabled: boolean): void {
    if (this.disposed || this.autopilotOn === enabled) return
    this.autopilotOn = enabled
    if (enabled) {
      this.scheduleAutopilotTick()
      this.maybeArmChoiceTimeout()
    } else {
      this.cancelAutopilotTick()
      this.cancelChoiceTimer()
    }
    this.emit('turn', { autopilot: enabled })
  }

  /** Convenience alias for `setAutopilot(true)`. */
  startAutopilot(): void {
    this.setAutopilot(true)
  }

  /** Convenience alias for `setAutopilot(false)`. */
  stopAutopilot(): void {
    this.setAutopilot(false)
  }

  /**
   * Arm the session time budget (B2-T5): checkpoint reminders plus the hard
   * `plannedMinutes + endGraceMin` forced-resolve turn.
   *
   * Hosts call it once when the session opens (the engine deliberately does
   * not arm long-lived timers at construction, so turn-only hosts and tests
   * stay timer-free). It is a no-op without a positive `plannedMinutes` and
   * idempotent on repeated calls.
   */
  startSession(): void {
    if (this.disposed || this.sessionStarted) return
    this.sessionStarted = true
    const planned = this.hooks.plannedMinutes
    if (planned === undefined || !Number.isFinite(planned) || planned <= 0) return
    const plannedMs = planned * 60_000
    const elapsedMs = this.clock.now() - this.startedAt
    const ratios = new Set<number>()
    for (const ratio of this.config.checkpoints) {
      if (Number.isFinite(ratio) && ratio > 0 && ratio <= 1) ratios.add(ratio)
    }
    // From 90% on the next turn must resolve (C-7); keep that regardless of
    // how a pack configures the reminder list.
    ratios.add(MUST_RESOLVE_RATIO)
    for (const ratio of [...ratios].sort((left, right) => left - right)) {
      const delayMs = Math.round(plannedMs * ratio - elapsedMs)
      if (delayMs <= 0) this.applyCheckpoint(ratio)
      else this.checkpointTimers.push(this.clock.timeout(delayMs, () => this.applyCheckpoint(ratio)))
    }
    const graceMin = Number.isFinite(this.config.endGraceMin) ? Math.max(0, this.config.endGraceMin) : 0
    const deadlineMs = Math.round(plannedMs + graceMin * 60_000 - elapsedMs)
    if (deadlineMs <= 0) this.forceResolve()
    else this.deadlineTimer = this.clock.timeout(deadlineMs, () => this.forceResolve())
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
      checkpoint: this.lastCheckpoint,
      mustResolve: this.mustResolveFlag,
      autopilot: {
        enabled: this.autopilotOn,
        intervalSec: this.intervalSec,
        minSec: this.config.autopilot.minSec,
        maxSec: this.config.autopilot.maxSec,
      },
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
    // A pause is a full stop (decision 4): a waiting choice menu and the
    // autopilot cadence stop with it; resume re-arms both.
    this.cancelChoiceTimer()
    this.cancelAutopilotTick()
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
    if (this.forcedResolvePending) {
      // The session budget deadline landed while paused; honor it now.
      this.forcedResolvePending = false
      this.submit({ priority: 'session', kind: 'checkpoint', at: this.clock.now(), payload: { checkpoint: 1 } })
      return
    }
    this.scheduleAutopilotTick()
    this.maybeArmChoiceTimeout()
    this.drainQueue()
  }

  /** P0: out-of-band stop. Never queued, never blocked by a busy turn. */
  async panic(source: string): Promise<void> {
    this.queue.clear()
    this.setAutopilot(false)
    this.cancelTimeBudget()
    this.cancelChoiceWait()
    this.releaseAftercare()
    this.panicked = true
    this.abortActive()
    // S-6 (wave-4 review): the latch goes in *before* the host hook. A slow
    // `onPanic` must not leave a window where a trigger can start a turn, and
    // a throwing hook must not roll the lock back either.
    this.lockForPanic()
    try {
      await this.hooks.onPanic?.(source)
    } catch (error) {
      this.emit('error', {
        phase: 'panic',
        source,
        message: error instanceof Error ? error.message : String(error),
      })
    }
    this.emit('state', { state: this.turnState, reason: 'panic' })
  }

  /** Human unlock; the only way out of `locked`. */
  unlock(note?: string): void {
    if (this.turnState !== 'locked') return
    this.setState('idle')
    this.emit('state', { state: this.turnState, ...(note === undefined ? {} : { note }) })
    this.drainQueue()
  }

  /**
   * End the session: wait for the active turn, then run the end hooks.
   *
   * B2-T5 adds the aftercare guard: when `aftercareMin` is configured, the
   * engine stays in `ending` for at least that many minutes of injected-clock
   * time after `onEnd` started, then audits `session_end` and enters `ended`.
   */
  async end(reason: EndReason): Promise<void> {
    if (isTerminalState(this.turnState) || this.turnState === 'ending') return
    this.queue.clear()
    this.setAutopilot(false)
    this.cancelTimeBudget()
    this.cancelChoiceWait()
    await this.currentRun
    if (isTerminalState(this.turnState)) return
    const endingStartedAt = this.clock.now()
    if (this.turnState === 'locked') {
      // A panicked session ends from `locked` too; ending is allowed from it.
      this.setState('ending')
    } else {
      this.setState('ending')
    }
    await this.hooks.onEnd?.(reason)
    const aftercareMin = this.config.aftercareMin
    const aftercareMs = aftercareMin === undefined || !Number.isFinite(aftercareMin)
      ? 0
      : Math.max(0, aftercareMin) * 60_000
    await this.waitForAftercare(endingStartedAt, aftercareMs)
    await this.audit.record({ actor: 'human', action: 'session_end', result: 'ok', detail: { reason } })
    if (this.liveState() !== 'ending') return
    this.setState('ended')
    this.emit('state', { state: this.turnState, reason })
  }

  /** Cancel timers; tests call it so `FakeClock.pendingCount` returns to zero. */
  dispose(): void {
    this.disposed = true
    this.queue.clear()
    this.autopilotOn = false
    this.cancelAutopilotTick()
    this.cancelTimeBudget()
    this.cancelChoiceWait()
    this.releaseAftercare()
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

  /**
   * Force the emergency latch, even from a state whose table lacks the edge.
   *
   * Every live state already allows `locked`; the fallback exists so a state
   * added later cannot make panic throw. `ended` stays terminal: a panic after
   * the session closed must not resurrect the engine.
   */
  private lockForPanic(): void {
    const current = this.turnState
    if (current === 'locked' || isTerminalState(current)) return
    if (canTransition(current, 'locked')) {
      this.setState('locked')
      return
    }
    this.turnState = 'locked'
    this.emit('state', { state: 'locked' })
  }

  /** P1 path shared by messages and choices. */
  private submitPlayerInput(input: { kind: 'player' | 'choice'; text?: string; choiceId?: string }): Promise<void> {
    // B-1: a burst of player lines becomes one turn per line, in order — never
    // two overlapping turns.
    // B-3: the preemption is announced NOW, at submit time, so a queued turn
    // does not wait for a turn it was supposed to interrupt. The runner gets
    // the cooperative signal and, past the grace window, the hard abort.
    const active = this.active
    if (active !== undefined && this.currentRun !== undefined && !active.preempted) {
      void this.preempt(active)
    }
    const run = (): Promise<void> => this.runPlayerInput(input)
    this.playerQueueDepth += 1
    const next = this.playerQueueDepth === 1 ? run() : this.playerQueueTail.then(run, run)
    this.playerQueueTail = next.catch(() => {})
    return next.finally(() => {
      this.playerQueueDepth -= 1
    })
  }

  private async runPlayerInput(input: { kind: 'player' | 'choice'; text?: string; choiceId?: string }): Promise<void> {
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
    const resumed = this.liveState()
    if (resumed === 'locked' || resumed === 'ending' || isTerminalState(resumed)) return

    if (input.kind === 'choice' && input.choiceId !== undefined) {
      if (!(await this.acceptChoice(input.choiceId))) return
    } else {
      // Typing is also a player move: the offered menu becomes stale.
      this.cancelChoiceWait()
    }

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
    // A player input restarts the autopilot cadence (draft §7).
    this.scheduleAutopilotTick()
    await this.start(trigger)
  }

  /**
   * Validate and audit a picked option, then drop the menu (B2-T6).
   *
   * Selecting is a human action and is recorded as `choice_selected` before
   * the new turn's `turn_started`, so an audit replay sees the pick first.
   * An id that was not offered while a menu is open is refused instead of
   * being turned into a phantom player message; `false` means "no turn".
   */
  private async acceptChoice(choiceId: string): Promise<boolean> {
    const offered = this.currentChoices?.find(choice => choice.id === choiceId)
    const menuOpen = (this.currentChoices?.length ?? 0) > 0
    if (menuOpen && offered === undefined) {
      this.emit('error', { reason: 'unknown_choice', choiceId })
      return false
    }
    const turnId = this.currentChoicesTurnId ?? this.currentTurnId
    // Audit first: while it is in flight the menu is still "open", so an
    // autopilot tick cannot slip a P3 turn in before this P1 input.
    await this.audit.record({
      actor: 'human',
      action: 'choice_selected',
      result: 'ok',
      detail: {
        turnId,
        choiceId,
        ...(offered === undefined ? {} : { tag: offered.tag }),
      },
    })
    this.cancelChoiceWait()
    return true
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
      this.cancelAutopilotTick()
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
    // A new turn invalidates the previous menu; its timeout goes with it.
    this.cancelChoiceWait()

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
    /** Clamped `BeatPlan.nextTurnAfterSec`; adopted only after a clean turn. */
    let pacedSec: number | undefined
    try {
      const result = await this.runner.run({
        turnId,
        phase: this.currentPhase(),
        signal: controller.signal,
        preemptSignal: preemptController.signal,
        ...(trigger.payload?.text === undefined ? {} : { playerText: trigger.payload.text }),
        ...(trigger.payload?.choiceId === undefined ? {} : { choiceId: trigger.payload.choiceId }),
        ...(trigger.payload?.checkpoint === undefined ? {} : { checkpoint: trigger.payload.checkpoint }),
        ...(this.mustResolveFlag ? { mustResolve: true } : {}),
        onStage: stage => {
          if (this.active?.turnId !== turnId) return
          active.stage = stage
          this.setState(stage)
        },
      })
      if (this.active?.turnId !== turnId) return
      if (!active.preempted && !this.panicked) {
        if (result.line !== undefined) {
          this.lastLine = result.line
          this.emit('line', { turnId, text: result.line })
        }
        if (result.nextTurnAfterSec !== undefined) {
          pacedSec = this.clampAutopilotSec(result.nextTurnAfterSec)
        }
        if (result.choices !== undefined) {
          await this.offerChoices(turnId, result.choices)
        }
      }
      // P0 wins even when the runner resolves cleanly: a cancelled turn must
      // not back-fill a line or count as completed (wave-4 review B-4). A
      // preempted turn likewise stays preempted inside its grace window.
      outcome = this.panicked
        ? 'cancelled'
        : active.preempted
          ? 'preempted'
          : result.outcome ?? 'completed'
      this.noteOutcome(outcome)
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
        this.enforceFailurePolicy()
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
      this.cancelChoiceTimer()
      this.cancelAutopilotTick()
      this.setState('paused')
      await this.hooks.onPause?.()
      await this.audit.record({ actor: 'human', action: 'session_paused', result: 'ok' })
      this.pauseRequested = false
      return
    }
    this.setState('idle')
    this.emit('turn', { turnId, outcome })
    // B2-T5: adopt the plan's clamped pacing before rescheduling the timer.
    if (pacedSec !== undefined) {
      this.intervalSec = pacedSec
      this.publishPacing()
    }
    this.drainQueue()
    this.scheduleAutopilotTick()
    // B2-T6: a menu only starts its passive timeout once the engine is idle.
    if (this.turnState === 'idle') this.maybeArmChoiceTimeout()
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

  // ── B2-T5: autopilot pacing ───────────────────────────────────────────

  /** Clamp a plan suggestion (or the config default) into the autopilot range. */
  private clampAutopilotSec(seconds: number): number {
    const { minSec, maxSec } = this.config.autopilot
    const low = Number.isFinite(minSec) && minSec > 0 ? minSec : 10
    const high = Number.isFinite(maxSec) && maxSec >= low ? maxSec : Math.max(low, 60)
    const candidate = Number.isFinite(seconds) ? seconds : this.config.autopilot.defaultSec
    return Math.min(high, Math.max(low, candidate))
  }

  /** Arm (or re-arm) the single pending autopilot tick. */
  private scheduleAutopilotTick(): void {
    this.cancelAutopilotTick()
    if (this.disposed || !this.autopilotOn) return
    const delayMs = Math.max(1, Math.trunc(this.intervalSec * 1000))
    this.autopilotTimer = this.clock.timeout(delayMs, () => {
      this.autopilotTimer = undefined
      this.onAutopilotTick()
    })
  }

  private cancelAutopilotTick(): void {
    this.autopilotTimer?.cancel()
    this.autopilotTimer = undefined
  }

  /** One P3 tick: offer a turn when idle, otherwise drop it and reschedule. */
  private onAutopilotTick(): void {
    if (this.disposed || !this.autopilotOn) return
    if (this.canAutopilotStart()) {
      this.submit({ priority: 'autopilot', kind: 'autopilot', at: this.clock.now() })
    } else {
      this.emit('turn', {
        skipped: true,
        priority: 'autopilot',
        reason: this.awaitingChoice() ? 'choices' : 'busy',
      })
    }
    // Always reschedule: a skipped slot is never queued and never replayed.
    this.scheduleAutopilotTick()
  }

  private canAutopilotStart(): boolean {
    return this.turnState === 'idle'
      && this.currentRun === undefined
      && this.active === undefined
      && !this.pauseRequested
      && !this.awaitingChoice()
  }

  /** A menu with at least one option is waiting for a human decision. */
  private awaitingChoice(): boolean {
    return this.currentChoices !== undefined && this.currentChoices.length > 0
  }

  private publishPacing(): void {
    try {
      this.hooks.onPlanPacing?.(this.intervalSec)
    } catch (error) {
      this.emit('error', {
        phase: 'pacing',
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }

  /** Failure streaks pause autopilot only; manual play keeps working. */
  private noteOutcome(outcome: TurnOutcome): void {
    if (outcome === 'completed') {
      this.consecutiveFailures = 0
      return
    }
    // A preempt is a player decision, not a model failure.
    if (outcome === 'preempted' || outcome === 'cancelled') return
    this.consecutiveFailures += 1
    this.enforceFailurePolicy()
  }

  private enforceFailurePolicy(): void {
    if (this.consecutiveFailures < this.config.maxConsecutiveFailures) return
    if (!this.autopilotOn) return
    this.setAutopilot(false)
    this.emit('error', { reason: 'autopilot_paused', failures: this.consecutiveFailures })
  }

  // ── B2-T5: session time budget ────────────────────────────────────────

  /** 50/80/90% checkpoint: reminder only, never a turn (draft §7). */
  private applyCheckpoint(ratio: number): void {
    if (this.disposed) return
    const state = this.liveState()
    if (state === 'ending' || state === 'ended' || state === 'locked') return
    if (this.lastCheckpoint !== undefined && ratio <= this.lastCheckpoint) return
    this.lastCheckpoint = ratio
    const mustResolve = this.mustResolveFlag || ratio >= MUST_RESOLVE_RATIO
    this.mustResolveFlag = mustResolve
    const update: CheckpointUpdate = {
      checkpoint: ratio,
      mustResolve,
      reminder: checkpointReminder(ratio, mustResolve),
    }
    try {
      this.hooks.onCheckpoint?.(update)
    } catch (error) {
      this.emit('error', {
        phase: 'checkpoint',
        message: error instanceof Error ? error.message : String(error),
      })
    }
    this.emit('turn', { checkpoint: ratio, mustResolve, reminder: update.reminder })
  }

  /**
   * Planned time plus `endGraceMin` elapsed: queue a resolve turn (P2).
   *
   * The turn is a checkpoint trigger with `payload.checkpoint = 1`; it queues
   * behind a busy turn, waits out a pause, and never bypasses `locked`.
   */
  private forceResolve(): void {
    this.deadlineTimer = undefined
    if (this.disposed) return
    const state = this.liveState()
    if (state === 'ending' || state === 'ended' || state === 'locked') return
    this.mustResolveFlag = true
    this.emit('turn', { forcedResolve: true })
    if (state === 'paused') {
      // No turn may start while paused; resume replays this one deadline only.
      this.forcedResolvePending = true
      return
    }
    this.submit({
      priority: 'session',
      kind: 'checkpoint',
      at: this.clock.now(),
      payload: { checkpoint: 1 },
    })
  }

  private cancelTimeBudget(): void {
    for (const timer of this.checkpointTimers) timer.cancel()
    this.checkpointTimers = []
    this.deadlineTimer?.cancel()
    this.deadlineTimer = undefined
  }

  // ── B2-T5: aftercare minimum ──────────────────────────────────────────

  /** Wait until `minimumMs` of clock time passed since `ending` was entered. */
  private waitForAftercare(endingStartedAt: number, minimumMs: number): Promise<void> {
    if (minimumMs <= 0 || this.turnState !== 'ending') return Promise.resolve()
    const remainingMs = minimumMs - (this.clock.now() - endingStartedAt)
    if (remainingMs <= 0) return Promise.resolve()
    return new Promise<void>(resolve => {
      this.aftercareResolve = resolve
      this.aftercareTimer = this.clock.timeout(remainingMs, () => {
        this.aftercareTimer = undefined
        const done = this.aftercareResolve
        this.aftercareResolve = undefined
        done?.()
      })
    })
  }

  /** Release a pending aftercare wait (panic / dispose / second end). */
  private releaseAftercare(): void {
    this.aftercareTimer?.cancel()
    this.aftercareTimer = undefined
    const done = this.aftercareResolve
    this.aftercareResolve = undefined
    done?.()
  }

  // ── B2-T6: choices ────────────────────────────────────────────────────

  /** Cap to 0–3, dedupe, publish and audit an offered menu. */
  private async offerChoices(turnId: number, choices: readonly PlayerChoice[]): Promise<void> {
    if (!this.config.choices.enabled) return
    const limit = this.choiceLimit()
    const seen = new Set<string>()
    const offered: PlayerChoice[] = []
    for (const choice of choices) {
      if (offered.length >= limit) break
      if (seen.has(choice.id)) continue
      seen.add(choice.id)
      offered.push(choice)
    }
    this.currentChoices = offered
    this.currentChoicesTurnId = turnId
    this.emit('choices', { turnId, choices: offered })
    await this.audit.record({
      actor: 'system',
      action: 'choices_offered',
      result: 'ok',
      detail: { turnId, ids: offered.map(choice => choice.id) },
    })
  }

  private choiceLimit(): number {
    const configured = this.config.choices.max
    if (!Number.isFinite(configured)) return 3
    return Math.max(0, Math.min(3, Math.trunc(configured)))
  }

  /**
   * Arm the passive fallback timer.
   *
   * Only while autopilot is on (draft §4.1): with autopilot off the engine
   * waits for the player indefinitely instead of deciding for them. In auto
   * mode the timeout follows the adopted autopilot interval (10–60s), so a
   * menu never stalls auto mode longer than the configured cadence.
   */
  private maybeArmChoiceTimeout(): void {
    if (this.disposed || !this.autopilotOn) {
      this.cancelChoiceTimer()
      return
    }
    if (this.turnState !== 'idle' || this.active !== undefined) return
    if (!this.awaitingChoice()) return
    const configured = this.autopilotOn ? this.intervalSec : this.config.choices.timeoutSec
    const seconds = Number.isFinite(configured) ? Math.max(0, configured) : 60
    this.cancelChoiceTimer()
    this.choiceTimer = this.clock.timeout(Math.max(0, Math.trunc(seconds * 1000)), () => {
      this.choiceTimer = undefined
      this.handleChoiceTimeout()
    })
  }

  private cancelChoiceTimer(): void {
    this.choiceTimer?.cancel()
    this.choiceTimer = undefined
  }

  /** Drop the menu and its timer without auditing (new turn / pause). */
  private cancelChoiceWait(): void {
    this.cancelChoiceTimer()
    this.currentChoices = undefined
    this.currentChoicesTurnId = undefined
  }

  /** Autopilot-on timeout: `passive` (no action) and the director continues. */
  private handleChoiceTimeout(): void {
    if (this.disposed) return
    const turnId = this.currentChoicesTurnId
    this.currentChoices = undefined
    this.currentChoicesTurnId = undefined
    this.emit('choices', { turnId, timedOut: true })
    // Start the audit before the next turn so replay ordering stays readable.
    void this.audit.record({
      actor: 'system',
      action: 'choice_timeout',
      result: 'ok',
      ...(turnId === undefined ? {} : { detail: { turnId } }),
    })
    if (!this.autopilotOn) return
    if (this.turnState !== 'idle' || this.currentRun !== undefined || this.pauseRequested) return
    this.submit({ priority: 'autopilot', kind: 'autopilot', at: this.clock.now() })
    this.scheduleAutopilotTick()
  }

  /** Exposed for tests and the failure-streak policy in B2-T5. */
  get consecutiveFailureCount(): number {
    return this.consecutiveFailures
  }

  /** Priority ladder, re-exported from the scheduler for older callers. */
  static readonly priority: Readonly<Record<TurnPriority, number>> = TURN_PRIORITY_ORDER
}
