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

// Trigger priorities and their ordering moved to `scheduler.ts` in B2-T4, where
// the queue lives. They are re-exported here so the existing public surface
// (`index.ts`, hosts, tests) keeps importing them from the state machine.
export type { TurnPriority, TurnTrigger, TurnTriggerKind } from './scheduler.ts'
export { queuesWhenBusy, startsTurn, TURN_PRIORITY_ORDER } from './scheduler.ts'

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
