/**
 * Turn priorities, the P2 queue, and the preemption matrix.
 *
 * This is the "who wins" half of the turn engine (`M2-实施计划.md` §4.8,
 * `回合引擎与调度-设计草案.md` §2/§5). It owns *ordering* and *cancellation
 * policy* only: no clock, no audit sink, no model, no device. The engine drives
 * it and writes the audit rows, which keeps the rules unit-testable in
 * isolation.
 *
 * The ladder is fixed and total:
 *
 * | priority | trigger                         | behind a busy turn |
 * |----------|---------------------------------|--------------------|
 * | P0       | panic / global stop             | never queued       |
 * | P1       | player message / choice         | preempts           |
 * | P2       | checkpoint / end / must-resolve | queue              |
 * | P3       | autopilot timer                 | **dropped**        |
 * | P4       | observe / probe                 | never starts a turn |
 * | P5       | maintenance / flush             | never starts a turn |
 *
 * P0 has no {@link TurnPriority} value on purpose: panic bypasses the queue
 * completely, so giving it a seat here would invite it to be queued by mistake.
 */

/** Trigger priority, P1..P5. Lower rank wins. */
export type TurnPriority = 'player' | 'session' | 'autopilot' | 'observe' | 'maintenance'

/** What produced a trigger. Kept separate from priority: a choice is P1 like a message. */
export type TurnTriggerKind =
  | 'player'
  | 'choice'
  | 'autopilot'
  | 'checkpoint'
  | 'end'
  | 'resume'
  | 'observe'
  | 'maintenance'

/** One cause for a turn. */
export interface TurnTrigger {
  readonly priority: TurnPriority
  readonly kind: TurnTriggerKind
  /** Clock timestamp of the trigger. */
  readonly at: number
  readonly payload?: {
    readonly text?: string
    readonly choiceId?: string
    /** 0..1 position of a time checkpoint (0.5 / 0.8 / 0.9). */
    readonly checkpoint?: number
  }
}

/** Numeric ordering for "who wins" questions. Lower wins. */
export const TURN_PRIORITY_ORDER: Readonly<Record<TurnPriority, number>> = {
  player: 1,
  session: 2,
  autopilot: 3,
  observe: 4,
  maintenance: 5,
}

/** Numeric rank of one priority; exposed so callers stop re-deriving the table. */
export function priorityRank(priority: TurnPriority): number {
  return TURN_PRIORITY_ORDER[priority]
}

/** Triggers that queue behind a busy turn instead of being dropped. */
export function queuesWhenBusy(priority: TurnPriority): boolean {
  return priority === 'player' || priority === 'session'
}

/** Priority P4/P5 triggers never start a turn; they only refresh context. */
export function startsTurn(priority: TurnPriority): boolean {
  return priority !== 'observe' && priority !== 'maintenance'
}

/**
 * Queue order: priority first (lower wins), then arrival time, then insertion
 * order. The insertion tiebreak is what makes two checkpoints stamped with the
 * same clock tick deterministic.
 */
export function compareTriggers(a: TurnTrigger, b: TurnTrigger): number {
  const byPriority = priorityRank(a.priority) - priorityRank(b.priority)
  if (byPriority !== 0) return byPriority
  if (a.at !== b.at) return a.at - b.at
  return 0
}

/** What {@link PriorityQueue.submit} did with a trigger. */
export type PriorityQueueDecision =
  /** P2: stored; a later `drain()` will return it. */
  | 'queued'
  /** P3 while busy: deliberately thrown away (never queued). */
  | 'dropped'
  /** P0/P1/P4/P5: not this queue's business. */
  | 'ignored'

interface QueueEntry {
  readonly trigger: TurnTrigger
  /** Monotonic insertion number; the final tiebreak inside equal `at`. */
  readonly seq: number
}

/**
 * The P2-only run queue.
 *
 * Rules from §4.8 are enforced *here*, not in the engine:
 *
 * - only `session` (P2) triggers enter the queue;
 * - `autopilot` (P3) is reported as `dropped` so a busy engine can discard it
 *   without ever growing the queue ("忙则丢弃，不排队");
 * - P4/P5 (and P1, which has its own preempt path) are `ignored`.
 *
 * Ordering is stable: same priority sorts by `at`, and equal `at` keeps the
 * order of submission. The queue never fires anything by itself — the engine
 * decides when a turn may start.
 */
export class PriorityQueue {
  private entries: QueueEntry[] = []
  private nextSeq = 0

  /** Number of queued P2 triggers. */
  get size(): number {
    return this.entries.length
  }

  /**
   * Offer one trigger to the queue.
   *
   * Returns `queued` only for P2. The engine calls this while busy; a P3
   * trigger submitted here is discarded rather than stored, so two autopilot
   * ticks can never stack up behind a slow turn.
   */
  submit(trigger: TurnTrigger): PriorityQueueDecision {
    if (trigger.priority === 'session') {
      this.insert({ trigger, seq: this.nextSeq })
      this.nextSeq += 1
      return 'queued'
    }
    if (trigger.priority === 'autopilot') return 'dropped'
    return 'ignored'
  }

  /**
   * Remove and return the first `limit` triggers in run order.
   *
   * `limit` defaults to everything, so `drain()` alone empties the queue.
   * Keeping a bounded drain lets the engine take exactly one trigger per idle
   * transition without copying the rest out and back in.
   */
  drain(limit: number = Number.POSITIVE_INFINITY): readonly TurnTrigger[] {
    const count = this.takeCount(limit)
    if (count === 0) return []
    const taken = this.entries.slice(0, count)
    this.entries = this.entries.slice(count)
    return taken.map(entry => entry.trigger)
  }

  /** Drop every queued trigger (panic, session end, dispose). */
  clear(): void {
    this.entries = []
  }

  private takeCount(limit: number): number {
    if (!Number.isFinite(limit)) return this.entries.length
    return Math.min(this.entries.length, Math.max(0, Math.trunc(limit)))
  }

  /** Sorted insertion keeps `drain` a prefix slice; equal keys stay FIFO. */
  private insert(entry: QueueEntry): void {
    const index = this.entries.findIndex(existing => this.precedes(entry, existing))
    if (index < 0) this.entries.push(entry)
    else this.entries.splice(index, 0, entry)
  }

  private precedes(a: QueueEntry, b: QueueEntry): boolean {
    const byPriority = compareTriggers(a.trigger, b.trigger)
    if (byPriority !== 0) return byPriority < 0
    return a.seq < b.seq
  }
}

/** The three in-turn stages a P1 may arrive in. */
export type PreemptStage = 'planning' | 'executing' | 'writing'

/** Why a turn was preempted; also the `detail.reason` written to the audit. */
export type PreemptReason = 'player' | 'writer'

/** Audit verb for a preemption (both are already in the §4.11 action table). */
export type PreemptAuditAction = 'preempted' | 'writer_preempted'

/**
 * What the engine should do when P1 arrives in a given stage.
 *
 * - `planning`: abort the model request now, drop the plan, open a new turn.
 * - `executing`: let the in-flight beat finish but no more; abort after
 *   `graceMs` at the latest. Already-dispatched effects are never rolled back.
 * - `writing`: cancel the text stream now; the executed actions stay.
 */
export interface PreemptPlan {
  readonly reason: PreemptReason
  readonly action: PreemptAuditAction
  /** Abort immediately vs. wait `graceMs` for the current beat. */
  readonly immediate: boolean
  /** Hard-abort backstop for `executing`; `0` when `immediate`. */
  readonly graceMs: number
}

/**
 * The §4.8 preemption matrix as a pure function.
 *
 * `graceMs` is the configured `preemptGraceMs` (default 500). A zero or
 * negative grace degrades to an immediate abort instead of scheduling a
 * timer that fires in the same tick.
 */
export function planPreemption(stage: PreemptStage, graceMs: number): PreemptPlan {
  const grace = Number.isFinite(graceMs) ? Math.max(0, Math.trunc(graceMs)) : 0
  if (stage === 'writing') {
    return { reason: 'writer', action: 'writer_preempted', immediate: true, graceMs: 0 }
  }
  if (stage === 'executing') {
    return {
      reason: 'player',
      action: 'preempted',
      immediate: grace === 0,
      graceMs: grace,
    }
  }
  return { reason: 'player', action: 'preempted', immediate: true, graceMs: 0 }
}
