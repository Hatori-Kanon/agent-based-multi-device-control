/**
 * The single-call turn (B1-T10 / D6): one model request both plans and narrates.
 *
 * The model returns tool calls and text in the same stream:
 *
 * - `apply_plan` arguments are the `BeatPlan`; the plan is parsed and
 *   **dispatched as soon as the call arrives**, before the text stream ends
 *   (the executor reports `plan_resolved` immediately);
 * - text deltas accumulate into `line`, which is the turn's dialogue.
 *
 * One turn gets **one `AbortController` and one total budget** (default
 * {@link DEFAULT_TURN_TIMEOUT_MS}, D6). The timer comes from the injected
 * `Clock`, never from a bare `setTimeout`, so a `FakeClock` can drive it. The
 * caller may pass a `signal` (preempt/panic); it is forwarded into the same
 * controller, so the engine still owns only one cancellation handle.
 *
 * Failure policy (D12):
 * - **transport-class** failures (`ModelError.retryable`: timeout, network,
 *   rate limit, 5xx) are retried **once**, unless a plan was already dispatched
 *   (effects are not rolled back, so a second dispatch would double-drive the
 *   devices) or the turn budget already ran out;
 * - **invalid plans** are not retried: `parseBeatPlan` degrades them, the
 *   remaining beats are dispatched, and the turn continues. A fully invalid
 *   plan becomes an empty plan → narrative-only dispatch.
 *
 * Per-turn tool limits: at most one `apply_plan` and one `look`; later calls are
 * ignored with a warning that the engine can audit. `look` has no in-request
 * side effect in the single-call MVP (its snapshot would arrive after the
 * response), so the loop only enforces the cap.
 *
 * @module
 */

import type { Clock } from '../ports/clock.ts'
import type { DispatchDiagnostics, DispatchOptions, DispatchResult } from '../execution/executor.ts'
import { parseBeatPlan } from '../scenario/beat-plan.ts'
import type { BeatPlan, PlanContext, PlanDrop, PlanValidation } from '../scenario/beat-plan.ts'
import type { ResolveContext } from '../scenario/intents.ts'
import { isModelError, ModelError } from './model.ts'
import type {
  LlmMessage,
  ModelRunner,
  ModelTurnRequest,
  ModelTurnResult,
  ModelUsage,
  ToolCall,
  ToolDefinition,
} from './model.ts'

/** One turn's total budget in milliseconds (D6). */
export const DEFAULT_TURN_TIMEOUT_MS = 60_000

/** The control tool: the only model write path (D9). */
export const APPLY_PLAN_TOOL = 'apply_plan'

/** The snapshot tool; capped per turn even in the single-call mode. */
export const LOOK_TOOL = 'look'

/** At most one `apply_plan` per turn. */
const MAX_PLANS_PER_TURN = 1

/** At most one `look` per turn. */
const MAX_LOOKS_PER_TURN = 1

/** One retry after a transport-class failure (D12). */
const MAX_ATTEMPTS = 2

/**
 * Everything `runTurn` needs that the engine already owns.
 *
 * The engine assembles `messages` with `agent/prompt.ts` (B1-T9) and hands over
 * the same `ResolveContext` it will use for the executor, so no prose reaches
 * the resolver and no device snapshot reaches the prompt builder.
 */
export interface TurnLoopInput {
  readonly turnId: number
  /** Current phase id; injected into the plan (the model never writes it). */
  readonly phase: string
  /** Assembled conversation: system prompt, recent lines, player message. */
  readonly messages: readonly LlmMessage[]
  /** Registry/intent/region/waveform facts for plan parsing and dispatch. */
  readonly resolveContext: ResolveContext
  /** Parse limits forwarded to `parseBeatPlan` (defaults: 3 beats / 3 choices). */
  readonly maxBeats?: number
  readonly maxChoices?: number
}

/**
 * Minimal executor surface.
 *
 * `PlanExecutor` satisfies it structurally, so production passes the real
 * executor and tests pass a stub without constructing a `DeviceRegistry`.
 */
export interface TurnExecutor {
  /**
   * The optional fourth argument carries the turn's one abort signal into the
   * executor, so a preempt/timeout stops the remaining beats instead of
   * driving a plan that was already cancelled (`M2-实施计划.md` §4.8).
   */
  dispatch(
    plan: BeatPlan,
    ctx: ResolveContext,
    diagnostics?: DispatchDiagnostics,
    options?: DispatchOptions,
  ): Promise<DispatchResult>
}

/** Options for {@link runTurn}. */
export interface TurnLoopOptions {
  readonly runner: ModelRunner
  /** Model-visible tools (`M2_MODEL_TOOLS`). */
  readonly tools: readonly ToolDefinition[]
  readonly executor: TurnExecutor
  readonly input: TurnLoopInput
  /** Timeout/cancellation source; injected so tests never wait on real time. */
  readonly clock: Clock
  /** Caller cancellation (preempt / panic / shutdown). */
  readonly signal?: AbortSignal
  /** Total budget for the turn; defaults to {@link DEFAULT_TURN_TIMEOUT_MS}. */
  readonly timeoutMs?: number
  /** Live line stream for the UI; the final line is also in the result. */
  readonly onTextDelta?: (delta: string) => void
}

/** What one turn produced. */
export interface TurnResult {
  readonly turnId: number
  /** Dialogue text; empty when the model produced no text. */
  readonly line: string
  /** Parsed plan; `undefined` when the model never called `apply_plan`. */
  readonly plan: BeatPlan | undefined
  /** Elements `parseBeatPlan` removed from the plan. */
  readonly dropped: readonly PlanDrop[]
  /** Executor result; `undefined` when nothing was dispatched. */
  readonly dispatch: DispatchResult | undefined
  /** Turn-level warnings (second plan/look, retry, parser notes). */
  readonly warnings: readonly string[]
  readonly usage?: ModelUsage
}

/**
 * Run one single-call turn.
 *
 * Resolves with the dialogue and whatever the plan dispatched; rejects with a
 * {@link ModelError} (`timeout`, `aborted`, `network`, …) when the model call
 * fails and cannot be retried, or with the executor's error when dispatch
 * itself failed. The engine turns those into a `fallback`/`timeout` outcome.
 */
export async function runTurn(options: TurnLoopOptions): Promise<TurnResult> {
  const { runner, tools, executor, input, clock } = options
  const timeoutMs = normalizeTimeout(options.timeoutMs)
  const callerSignal = options.signal
  if (isAborted(callerSignal)) throw abortedError()

  // D6: exactly one controller and one timeout for the whole turn, shared by
  // the first attempt and the single retry.
  const controller = new AbortController()
  let timedOut = false
  const timer = clock.timeout(timeoutMs, () => {
    timedOut = true
    controller.abort()
  })
  const forwardAbort = (): void => {
    controller.abort()
  }
  callerSignal?.addEventListener('abort', forwardAbort, { once: true })

  // Wave-3 review blocker B-4: a runner (or a dispatch) that ignores the abort
  // signal must not make the turn hang, and an abort after the deadline must
  // never turn into a success. Every await below races this rejection.
  let abortReject: () => void = () => {}
  const abortRace = new Promise<never>((_, reject) => {
    abortReject = () => reject(timedOut ? timeoutError(timeoutMs) : abortedError())
    if (controller.signal.aborted) abortReject()
    else controller.signal.addEventListener('abort', abortReject, { once: true })
  })
  // The rejection is observed by whoever awaits it; keep Node from treating a
  // late duplicate as unhandled when the turn already returned.
  abortRace.catch(() => {})

  const settleDispatch = async (): Promise<void> => {
    if (pendingDispatch === undefined) return
    await Promise.race([pendingDispatch, abortRace])
    if (dispatchError !== undefined) throw dispatchError
  }

  const lineParts: string[] = []
  const warnings: string[] = []
  const handledToolCallIds = new Set<string>()
  let plan: BeatPlan | undefined
  let dropped: readonly PlanDrop[] = []
  let dispatched: DispatchResult | undefined
  let applied = false
  let looks = 0
  let pendingDispatch: Promise<void> | undefined
  let dispatchError: unknown

  const planContextOf = (): PlanContext => ({
    intents: input.resolveContext.intents,
    regions: input.resolveContext.regions,
    // R3: the engine fields come from the context, never from model JSON.
    turnId: input.turnId,
    phase: input.phase,
    ...(input.maxBeats === undefined ? {} : { maxBeats: input.maxBeats }),
    ...(input.maxChoices === undefined ? {} : { maxChoices: input.maxChoices }),
  })

  /** Parse and dispatch one `apply_plan` call; dispatch starts immediately. */
  const applyPlan = (call: ToolCall): void => {
    if (applied) {
      warnings.push('apply_plan was called again in the same turn; the extra call was ignored (one plan per turn)')
      return
    }
    applied = true
    const validation: PlanValidation = parseBeatPlan(call.arguments, planContextOf())
    plan = validation.plan
    dropped = validation.dropped
    warnings.push(...validation.warnings)
    // Start dispatching inside the callback: this is what lets effects begin
    // before the text stream ends. The promise is awaited before returning.
    pendingDispatch = (async () => {
      try {
        dispatched = await executor.dispatch(
          validation.plan,
          input.resolveContext,
          {
            dropped: validation.dropped,
            warnings: validation.warnings,
          },
          // The turn's one controller: caller abort, timeout and preempt all
          // land here, so the executor can drop the beats that never ran.
          { signal: controller.signal },
        )
      } catch (error) {
        dispatchError = error
      }
    })()
  }

  const onToolCall = (call: ToolCall): void => {
    if (handledToolCallIds.has(call.id)) return
    handledToolCallIds.add(call.id)
    if (call.name === APPLY_PLAN_TOOL) {
      applyPlan(call)
      return
    }
    if (call.name === LOOK_TOOL) {
      if (looks >= MAX_LOOKS_PER_TURN) {
        warnings.push('look was called more than once in the same turn; the extra call was ignored (one look per turn)')
        return
      }
      looks += 1
      return
    }
    // Read-only queries have no in-request effect in the single-call MVP; the
    // engine/audit layer handles them after the turn.
  }

  const onTextDelta = (delta: string): void => {
    if (delta === '') return
    lineParts.push(delta)
    options.onTextDelta?.(delta)
  }

  const request: ModelTurnRequest = {
    messages: input.messages,
    tools,
    timeoutMs,
    signal: controller.signal,
    onTextDelta,
    onToolCall,
  }

  try {
    let result: ModelTurnResult | undefined
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      let failure: unknown
      try {
        result = await Promise.race([runner.run(request), abortRace])
      } catch (error) {
        failure = error
      }
      if (failure === undefined && result?.finishReason !== 'timeout') break // success
      if (failure === undefined) {
        failure = new ModelError('the model reported a timeout', { code: 'timeout', retryable: true })
      }

      if (timedOut) throw timeoutError(timeoutMs)
      if (isAborted(callerSignal) || controller.signal.aborted) throw abortedError()
      // A retry must not double-dispatch: effects already running are final.
      const retryable = attempt + 1 < MAX_ATTEMPTS
        && pendingDispatch === undefined
        && !applied
        && isRetryableTurnError(failure)
      if (!retryable) {
        await settleDispatch()
        throw failure
      }
      warnings.push(`transport failure retried once (${describeError(failure)})`)
      lineParts.length = 0 // discard a partially streamed line from the failed attempt
    }
    if (result === undefined) throw new ModelError('the model produced no result', { code: 'invalid-response' })
    // A non-streaming runner fills `result.text` instead of emitting deltas;
    // dropping it would silently mute the turn (wave-4 review S-7).
    if (lineParts.length === 0 && result.text !== '') lineParts.push(result.text)
    if (timedOut) throw timeoutError(timeoutMs)
    if (isAborted(callerSignal)) throw abortedError()

    // A runner that only fills `result.toolCalls` (no callback) still works.
    for (const call of result.toolCalls) onToolCall(call)
    await settleDispatch()
    // A late dispatch that resolves after the deadline must not be reported as
    // a successful turn.
    if (timedOut) throw timeoutError(timeoutMs)
    if (isAborted(callerSignal)) throw abortedError()

    return {
      turnId: input.turnId,
      line: lineParts.join(''),
      plan,
      dropped,
      dispatch: dispatched,
      warnings,
      ...(result.usage === undefined ? {} : { usage: result.usage }),
    }
  } finally {
    timer.cancel()
    controller.signal.removeEventListener('abort', abortReject)
    callerSignal?.removeEventListener('abort', forwardAbort)
  }
}

/** Narrow an optional cancellation signal to its aborted state. */
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true
}

/** Retryable in the D12 sense: transport-class only. */
function isRetryableTurnError(error: unknown): boolean {
  return isModelError(error) && error.retryable
}

function normalizeTimeout(timeoutMs: number | undefined): number {
  if (timeoutMs === undefined || !Number.isFinite(timeoutMs) || timeoutMs <= 0) return DEFAULT_TURN_TIMEOUT_MS
  return Math.floor(timeoutMs)
}

function abortedError(): ModelError {
  return new ModelError('the turn was aborted', { code: 'aborted' })
}

function timeoutError(timeoutMs: number): ModelError {
  return new ModelError(`the turn timed out after ${timeoutMs}ms`, { code: 'timeout' })
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
