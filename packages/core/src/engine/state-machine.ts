/**
 * Turn lifecycle vocabulary.
 *
 * One rule dominates this module: **`fallback`, `cancelled`, `preempted` are
 * outcomes, not states** (`M2-实施计划.md` §4.8). A turn is always in exactly
 * one of the states below; how it left `settling` is recorded separately as a
 * {@link TurnOutcome}, so a preempted turn and a timed-out turn look different
 * in the audit without inventing extra states.
 *
 * The engine is the only writer of state, and every transition goes through
 * {@link assertTransition}: an illegal edge is a programming error, not a
 * user-facing condition, so it throws.
 */

/** Where a turn is in its lifecycle. `ended` is terminal. */
export type TurnState =
  | 'idle'
  | 'planning'
  | 'executing'
  | 'writing'
  | 'settling'
  | 'paused'
  | 'locked'
  | 'ending'
  | 'ended'

/** How a turn finished. Recorded separately from {@link TurnState}. */
export type TurnOutcome = 'completed' | 'cancelled' | 'preempted' | 'fallback' | 'timeout' | 'blocked'

/**
 * Trigger priority, P1..P5 (`回合引擎与调度-设计草案.md` §2).
 *
 * P0 (panic) never enters the queue, so it has no value here.
 */
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

/** Triggers that queue behind a busy turn instead of being dropped. */
export function queuesWhenBusy(priority: TurnPriority): boolean {
  return priority === 'player' || priority === 'session'
}

/** Priority P4 triggers never start a turn; they only refresh context. */
export function startsTurn(priority: TurnPriority): boolean {
  return priority !== 'observe' && priority !== 'maintenance'
}

const ALLOWED: Readonly<Record<TurnState, readonly TurnState[]>> = {
  idle: ['planning', 'paused', 'locked', 'ending'],
  // executing: the plan tool call arrived; writing: text started streaming.
  planning: ['executing', 'writing', 'settling', 'idle', 'locked'],
  executing: ['writing', 'settling', 'idle', 'locked'],
  writing: ['settling', 'idle', 'locked'],
  settling: ['idle', 'planning', 'paused', 'ending', 'locked'],
  paused: ['idle', 'ending', 'locked'],
  locked: ['idle', 'ending'],
  ending: ['ended', 'locked'],
  ended: [],
}

/** Every state, in lifecycle order. Handy for tests and the debug panel. */
export const TURN_STATES: readonly TurnState[] = Object.keys(ALLOWED) as TurnState[]

/** True when `from -> to` is an edge the engine may take. */
export function canTransition(from: TurnState, to: TurnState): boolean {
  return ALLOWED[from].includes(to)
}

/** @throws Error when the edge is illegal; this is a programming error. */
export function assertTransition(from: TurnState, to: TurnState): void {
  if (!canTransition(from, to)) throw new Error(`illegal turn transition ${from} -> ${to}`)
}

/** `ended` never leaves. */
export function isTerminalState(state: TurnState): boolean {
  return state === 'ended'
}

/** States in which no new turn may start. */
export function refusesNewTurns(state: TurnState): boolean {
  return state === 'locked' || state === 'ending' || state === 'ended'
}
