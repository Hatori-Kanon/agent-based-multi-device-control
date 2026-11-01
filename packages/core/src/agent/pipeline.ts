/**
 * The turn pipeline: one request (D6) or two (B2-T3), same execution path.
 *
 * `agent/loop.ts` owns the single-call turn: one model request returns both the
 * `apply_plan` tool call and the dialogue text. This module is the facade the
 * engine talks to; it chooses between that loop and the split mode:
 *
 * ```
 * single: llm.director == null && llm.writer == null
 *   prompt ─► one request ─► (plan dispatches on the tool call) ─► line
 *
 * split:  either role configured
 *   director context ─► request #1 ─► apply_plan ─► dispatch starts
 *                                                   └─► writer context ─► request #2 ─► line
 * ```
 *
 * The mode is decided **only by the `LlmConfig`** (`导演与写作上下文契约.md`
 * §10): an operator turns the split on by filling `llm.director` / `llm.writer`
 * in the settings file, never by changing the caller. Both modes share the same
 * executor, the same audit contract and the same `TurnPipelineResult`; the
 * single-call mode simply delegates to {@link runTurn} and keeps its one
 * `AbortController` and 60 s budget (D6), while split mode owns one controller
 * and one timeout per role (`split.directorTimeoutMs` / `split.writerTimeoutMs`).
 *
 * ## Ordering guarantees
 *
 * Dispatch starts **inside the director's `onToolCall` callback**, before the
 * writer request is created. The writer is not awaited against dispatch: the
 * action can reach hardware while the prose is still being generated, which is
 * exactly the "plan first, prose later" contract (`导演与写作上下文契约.md`
 * §7.4). Dispatch is awaited before this function resolves/rejects, so an
 * executor failure is never lost.
 *
 * ## Failure policy
 *
 * - writer failure/timeout → {@link WRITER_TEMPLATE_LINE}, one `writer_fallback`
 *   audit row, and the plan's actions stay in force (C-6);
 * - director failure/timeout → empty narrative plan, one `plan_fallback` audit
 *   row, the writer still runs; the turn is reported as `fallback`;
 * - an invalid `apply_plan` is not an error: `parseBeatPlan` drops the bad
 *   elements and dispatch continues (C-5);
 * - caller abort/preemption is re-thrown after the in-flight dispatch settles;
 *   the engine owns the `preempted` / `writer_preempted` audit rows (B2-T4), so
 *   this module never invents a second one;
 * - a missing `mustMention` beat is a warning in {@link TurnPipelineResult}
 *   only. §4.11 has no action for it, and adding one would break the replay
 *   contract, so nothing blocks and nothing is invented.
 *
 * ## Engine seam
 *
 * The rich entry point is `run(input: TurnInput)` (the plan's `TurnInput` plus
 * the session/pack facts the two projections need). For `TurnEngine`, which
 * passes a {@link TurnRequest}, the same method accepts a bare request when the
 * constructor received a {@link TurnContextProvider}; the overload set makes
 * `TurnPipeline` structurally assignable to `TurnRunner`.
 *
 * @module
 */

import type { AuditLog } from '../devices/audit.ts'
import type { DispatchResult } from '../execution/executor.ts'
import type { TurnOutcome } from '../engine/state-machine.ts'
import type { TurnRequest, TurnRunner } from '../engine/turn-engine.ts'
import type { Clock } from '../ports/clock.ts'
import type { ProbeRecord } from '../sensors/probe.ts'
import {
  parseBeatPlan,
  type Beat,
  type BeatPlan,
  type PlanContext,
  type PlanDrop,
  type PlayerChoice,
} from '../scenario/beat-plan.ts'
import type { FeedbackIntent, ResolveContext } from '../scenario/intents.ts'
import type { PhaseMachine } from '../scenario/phases.ts'
import {
  buildDirectorContext,
  type DirectorSessionFact,
} from './context/director.ts'
import {
  buildWriterContext,
  WRITER_TEMPLATE_LINE,
  type RegionLabelSource,
  type WriterContext,
} from './context/writer.ts'
import { APPLY_PLAN_TOOL, DEFAULT_TURN_TIMEOUT_MS, runTurn, type TurnExecutor } from './loop.ts'
import {
  isModelError,
  ModelError,
  type LlmConfig,
  type LlmMessage,
  type ModelRunner,
  type ModelTurnRequest,
  type ModelTurnResult,
  type ModelUsage,
  type ToolCall,
  type ToolDefinition,
} from './model.ts'
import { buildSystemPrompt, buildTurnMessages } from './prompt.ts'
import { M2_TOOL_SCHEMAS_BY_NAME } from './tools.ts'

/** Single request (D6) or two requests (B2-T3), decided by the config alone. */
export type TurnPipelineMode = 'single' | 'split'

/** Split-mode per-role budgets (`M2-实施计划.md` §4.9.3). */
export interface SplitTimeouts {
  /** Director planning budget; contract §2's "2s" is superseded by the engine's 5s. */
  readonly directorTimeoutMs: number
  /** Writer narration budget. */
  readonly writerTimeoutMs: number
}

/** Director budget when the caller does not override it. */
export const DEFAULT_SPLIT_DIRECTOR_TIMEOUT_MS = 5_000

/** Writer budget when the caller does not override it. */
export const DEFAULT_SPLIT_WRITER_TIMEOUT_MS = 30_000

/**
 * Per-turn facts the two projections need.
 *
 * This is the plan's §4.9.4 `TurnInput` plus the resolved session/pack context:
 * a pipeline has no clock-driven view of the pack, so the caller (the host
 * session) supplies the phase machine, the resolver context and the narrative
 * blocks. Every field is read-only and the projections take copies, so the
 * input object may be reused.
 */
export interface TurnInput extends TurnRequest {
  /** The minimal session facts the director may read. */
  readonly state: DirectorSessionFact
  /** Phase graph; `phase` above must be its current id (engine-injected). */
  readonly phaseMachine: PhaseMachine
  /** Snapshot/intents/regions/waveforms used by the executor. */
  readonly resolveContext: ResolveContext
  /** Settled probes visible to the director (latest three survive). */
  readonly probes: readonly ProbeRecord[]
  /** Previous lines, oldest first; the writer keeps the latest twenty. */
  readonly recentLines: readonly string[]
  /** Hard constraints; never truncated. */
  readonly boundaries: readonly string[]
  /** Full persona text (`persona.md`), writer only. */
  readonly persona: string
  /** Full host voice (`host.md`), writer only. */
  readonly host: string
  /** Setting text (`setting.md`), writer only. */
  readonly scene: string
  /** The `## 导演摘要` extract; never the full persona. */
  readonly personaSummary?: string
  /** `host.md` rhythm/forbidden/closing sections; never the full host text. */
  readonly hostRhythm?: string
  /** One-line dialog summaries, oldest first (director only). */
  readonly dialogSummary?: readonly string[]
  /** Retrieved corpus excerpts, best first (writer only). */
  readonly corpusExcerpts?: readonly string[]
  /** Narrative probe sentence; must already be digit-free. */
  readonly probeBrief?: string
  /** Extra digit-free narrative facts (e.g. the sensor prompt block). */
  readonly briefs?: readonly string[]
  /** Current phase prose (`phases/<id>.md`). */
  readonly phaseNote?: string
  /** Deterministic summary used when the writer history is compressed. */
  readonly recentSummary?: string
  /** Scenario region labels (`regions[].id -> label`). */
  readonly regionLabels?: RegionLabelSource
  /** Planned session length in minutes; `null`/omitted = open-ended. */
  readonly plannedMin?: number | null
  /** Elapsed minutes when the current phase was entered. */
  readonly phaseEnteredMin?: number
  /** Parse limits forwarded to `parseBeatPlan` (default 3 beats / 3 choices). */
  readonly maxBeats?: number
  readonly maxChoices?: number
  /** Live text stream for the UI; the final line is also in the result. */
  readonly onTextDelta?: (delta: string) => void
}

/** Supplies the rich input for an engine-facing `run(request: TurnRequest)`. */
export interface TurnContextProvider {
  /** Build the per-turn context; may be async (e.g. reads a pack document). */
  inputFor(request: TurnRequest): TurnInput | Promise<TurnInput>
}

/** A provider object or its function shorthand. */
export type TurnContextSource =
  | TurnContextProvider
  | ((request: TurnRequest) => TurnInput | Promise<TurnInput>)

/** Options for {@link TurnPipeline}. */
export interface TurnPipelineOptions {
  /** Fallback runner for both roles (the single-call runner in production). */
  readonly runner: ModelRunner
  /** Director-only runner; used when `llm.director` names a distinct model. */
  readonly directorRunner?: ModelRunner
  /** Writer-only runner; used when `llm.writer` names a distinct model. */
  readonly writerRunner?: ModelRunner
  /** Model-visible tools (`M2_MODEL_TOOLS`). The director sees only `apply_plan`. */
  readonly tools: readonly ToolDefinition[]
  readonly executor: TurnExecutor
  /** Decides the mode and (for hosts) which role runners to build. */
  readonly llm: LlmConfig
  readonly clock: Clock
  readonly audit: AuditLog
  /** Single-call total budget (D6); defaults to {@link DEFAULT_TURN_TIMEOUT_MS}. */
  readonly turnTimeoutMs?: number
  /** Per-role budgets; only read in split mode. */
  readonly split?: Partial<SplitTimeouts>
  /** Required only for the engine-facing `run(request: TurnRequest)` overload. */
  readonly context?: TurnContextSource
}

/** What one pipeline turn produced (the plan's §4.9.4 `TurnResult`). */
export interface TurnPipelineResult {
  readonly turnId: number
  /** Dialogue text; {@link WRITER_TEMPLATE_LINE} when the writer failed. */
  readonly line: string
  /** Parsed plan; `undefined` when the turn is narrative-only. */
  readonly plan: BeatPlan | undefined
  /** Elements `parseBeatPlan` removed. */
  readonly dropped: readonly PlanDrop[]
  /** Executor result; `undefined` when nothing was dispatched. */
  readonly dispatch: DispatchResult | undefined
  readonly outcome: TurnOutcome
  /** Turn-level warnings: parser notes, retry notes, missing `mustMention`. */
  readonly warnings: readonly string[]
  /** Plan choices, when the plan carried any (director-owned, B2-T6). */
  readonly choices?: readonly PlayerChoice[]
  /** Sum of the role requests' usage, when the provider reported any. */
  readonly usage?: ModelUsage
}

/** Turn stages as the engine names them; used to suppress backwards reports. */
type Stage = 'planning' | 'executing' | 'writing'

/** Ordering guard; the engine throws on an illegal transition, so never regress. */
const STAGE_RANK: Readonly<Record<Stage, number>> = {
  planning: 0,
  executing: 1,
  writing: 2,
}

/** Guards split mode's requirement that a plan is a `BeatPlan` even when empty. */
const EMPTY_PACING = 'hold' as const

/**
 * Two-request-capable turn facade.
 *
 * Construct once per session (the engine keeps it as its {@link TurnRunner}):
 * the mode and the role runners live in the config, so a config change followed
 * by a rebuild switches modes without touching this class.
 */
export class TurnPipeline implements TurnRunner {
  /** The mode this instance will use; useful for the debug panel and tests. */
  readonly mode: TurnPipelineMode

  private readonly runner: ModelRunner
  private readonly directorRunner: ModelRunner
  private readonly writerRunner: ModelRunner
  private readonly tools: readonly ToolDefinition[]
  private readonly executor: TurnExecutor
  private readonly clock: Clock
  private readonly audit: AuditLog
  private readonly turnTimeoutMs: number
  private readonly split: SplitTimeouts
  private readonly context: TurnContextSource | undefined
  private readonly directorTool: ToolDefinition

  constructor(options: TurnPipelineOptions) {
    this.runner = options.runner
    this.directorRunner = options.directorRunner ?? options.runner
    this.writerRunner = options.writerRunner ?? options.runner
    this.tools = [...options.tools]
    this.executor = options.executor
    this.clock = options.clock
    this.audit = options.audit
    this.mode = isSplitConfig(options.llm) ? 'split' : 'single'
    this.turnTimeoutMs = positiveTimeout(options.turnTimeoutMs, DEFAULT_TURN_TIMEOUT_MS)
    this.split = {
      directorTimeoutMs: positiveTimeout(
        options.split?.directorTimeoutMs,
        DEFAULT_SPLIT_DIRECTOR_TIMEOUT_MS,
      ),
      writerTimeoutMs: positiveTimeout(
        options.split?.writerTimeoutMs,
        DEFAULT_SPLIT_WRITER_TIMEOUT_MS,
      ),
    }
    this.context = options.context
    this.directorTool = this.tools.find(tool => tool.name === APPLY_PLAN_TOOL)
      ?? M2_TOOL_SCHEMAS_BY_NAME.apply_plan
  }

  /**
   * Run one turn.
   *
   * The engine calls the `TurnRequest` overload; hosts/tests may call the rich
   * `TurnInput` overload directly. Both share the same mode decision and the
   * same executor.
   */
  run(input: TurnInput): Promise<TurnPipelineResult>
  run(request: TurnRequest): Promise<TurnPipelineResult>
  async run(input: TurnInput | TurnRequest): Promise<TurnPipelineResult> {
    const rich = await this.resolveInput(input)
    return this.mode === 'single' ? await this.runSingle(rich) : await this.runSplit(rich)
  }

  /** Build the rich input for the engine-facing overload. */
  private async resolveInput(input: TurnInput | TurnRequest): Promise<TurnInput> {
    if (isTurnInput(input)) return input
    const source = this.context
    if (source === undefined) {
      throw new TypeError(
        'TurnPipeline.run(TurnRequest) needs a context provider; '
          + 'pass options.context or call run(TurnInput)',
      )
    }
    return typeof source === 'function' ? await source(input) : await source.inputFor(input)
  }

  /** Single-call mode: exactly the existing `runTurn`, one controller, one budget. */
  private async runSingle(input: TurnInput): Promise<TurnPipelineResult> {
    const stages = createStageReporter(input)
    const result = await runTurn({
      runner: this.directorRunner,
      tools: this.tools,
      executor: this.stagedExecutor(stages),
      input: {
        turnId: input.turnId,
        phase: input.phase,
        messages: singleCallMessages(input),
        resolveContext: input.resolveContext,
        ...(input.maxBeats === undefined ? {} : { maxBeats: input.maxBeats }),
        ...(input.maxChoices === undefined ? {} : { maxChoices: input.maxChoices }),
      },
      clock: this.clock,
      signal: input.signal,
      timeoutMs: this.turnTimeoutMs,
      onTextDelta: (delta: string) => {
        stages.report('writing')
        input.onTextDelta?.(delta)
      },
    })
    const warnings = [
      ...result.warnings,
      ...missingMentionWarnings(result.plan, input.resolveContext.intents, result.line),
    ]
    return {
      turnId: input.turnId,
      line: result.line,
      plan: result.plan,
      dropped: result.dropped,
      dispatch: result.dispatch,
      outcome: 'completed',
      warnings,
      ...(result.plan?.choices === undefined ? {} : { choices: result.plan.choices }),
      ...(result.usage === undefined ? {} : { usage: result.usage }),
    }
  }

  /**
   * Split wrapper: owns the two role controllers and cancels their listeners.
   *
   * The per-turn engine signal is short-lived, but removing the listeners in a
   * `finally` keeps a long-lived custom signal from retaining the pipeline.
   */
  private async runSplit(input: TurnInput): Promise<TurnPipelineResult> {
    const stages = createStageReporter(input)
    const directorController = new AbortController()
    const writerController = new AbortController()
    const forwardAbort = (): void => {
      directorController.abort()
      writerController.abort()
    }
    const forwardPreempt = (): void => {
      const stage = stages.current()
      if (stage === 'planning') directorController.abort()
      else if (stage === 'writing') writerController.abort()
      // `executing`: the engine's 500ms grace owns the hard abort; the pipeline
      // lets the in-flight dispatch settle and skips the writer below.
    }
    const listenerCleanup = new AbortController()
    input.signal.addEventListener('abort', forwardAbort, {
      once: true,
      signal: listenerCleanup.signal,
    })
    input.preemptSignal?.addEventListener('abort', forwardPreempt, {
      once: true,
      signal: listenerCleanup.signal,
    })
    try {
      return await this.runSplitTurn(input, stages, directorController, writerController)
    } finally {
      listenerCleanup.abort()
    }
  }

  /** Split body: director request → immediate dispatch → writer request. */
  private async runSplitTurn(
    input: TurnInput,
    stages: StageReporter,
    directorController: AbortController,
    writerController: AbortController,
  ): Promise<TurnPipelineResult> {
    if (isAborted(input.signal) || isAborted(input.preemptSignal)) throw abortedError()
    const warnings: string[] = []

    const planContext = planContextOf(input)
    const handledToolCallIds = new Set<string>()
    let plan: BeatPlan | undefined
    let dropped: readonly PlanDrop[] = []
    let applied = false
    let pendingDispatch: Promise<void> | undefined
    let dispatched: DispatchResult | undefined
    let dispatchError: unknown
    let directorTimedOut = false

    /** Parse and start dispatching one `apply_plan`; dispatch starts immediately. */
    const acceptToolCall = (call: ToolCall): void => {
      if (handledToolCallIds.has(call.id)) return
      handledToolCallIds.add(call.id)
      if (call.name !== APPLY_PLAN_TOOL) return
      if (applied) {
        warnings.push(
          'apply_plan was called again in the same turn; the extra call was ignored (one plan per turn)',
        )
        return
      }
      applied = true
      const validation = parseBeatPlan(call.arguments, planContext)
      plan = validation.plan
      dropped = validation.dropped
      warnings.push(...validation.warnings)
      stages.report('executing')
      pendingDispatch = (async () => {
        try {
          dispatched = await this.executor.dispatch(validation.plan, input.resolveContext, {
            dropped: validation.dropped,
            warnings: validation.warnings,
          })
        } catch (error) {
          dispatchError = error
        }
      })()
    }

    const directorTimer = this.clock.timeout(this.split.directorTimeoutMs, () => {
      directorTimedOut = true
      directorController.abort()
    })

    let directorResult: ModelTurnResult | undefined
    let directorFailure: unknown
    try {
      const request: ModelTurnRequest = {
        messages: directorMessages(input),
        // D9: the director's only write path is `apply_plan`.
        tools: [this.directorTool],
        timeoutMs: this.split.directorTimeoutMs,
        signal: directorController.signal,
        onToolCall: acceptToolCall,
      }
      directorResult = await this.directorRunner.run(request)
    } catch (error) {
      directorFailure = error
    } finally {
      directorTimer.cancel()
    }

    // A runner that only fills `result.toolCalls` (no callback) still works.
    for (const call of directorResult?.toolCalls ?? []) acceptToolCall(call)

    const directorFailed = directorFailure !== undefined
      || directorTimedOut
      || directorResult?.finishReason === 'timeout'
      || directorResult?.finishReason === 'error'
    if (directorFailed && !applied) {
      const reason = directorTimedOut
        ? 'timeout'
        : describeFailure(directorFailure ?? new Error(`director finish reason ${directorResult?.finishReason ?? 'unknown'}`), 'director failed')
      warnings.push(`director failed (${reason}); continuing with an empty narrative plan`)
      await this.audit.record({
        actor: 'system',
        action: 'plan_fallback',
        result: 'error',
        reason,
        detail: { turnId: input.turnId, reason, attempts: 1, beats: 0 },
      })
    } else if (directorFailure !== undefined) {
      // A plan arrived before the failure (e.g. a late timeout): the dispatched
      // actions are valid, so only the prose is affected.
      warnings.push(`director failed after apply_plan (${describeFailure(directorFailure, 'director failed')})`)
    }

    // Preemption during planning/executing wins before a writer request starts.
    if (isAborted(input.signal) || isAborted(input.preemptSignal)) {
      await pendingDispatch
      if (dispatchError !== undefined) throw dispatchError
      throw abortedError()
    }

    const writerPlan = plan ?? emptyPlan(input)
    const writerContext = buildWriterContext({
      plan: writerPlan,
      persona: input.persona,
      host: input.host,
      scene: input.scene,
      intents: input.resolveContext.intents,
      recentLines: input.recentLines,
      corpusExcerpts: input.corpusExcerpts ?? [],
      probeBrief: input.probeBrief,
      boundaries: input.boundaries,
      ...(input.phaseNote === undefined ? {} : { phaseNote: input.phaseNote }),
      ...(input.recentSummary === undefined ? {} : { recentSummary: input.recentSummary }),
      ...(input.regionLabels === undefined ? {} : { regionLabels: input.regionLabels }),
    })

    stages.report('writing')
    let writerTimedOut = false
    const writerTimer = this.clock.timeout(this.split.writerTimeoutMs, () => {
      writerTimedOut = true
      writerController.abort()
    })

    let writerResult: ModelTurnResult | undefined
    let writerFailure: unknown
    const streamed: string[] = []
    try {
      const request: ModelTurnRequest = {
        messages: writerMessages(input, writerContext),
        // Pure prose: the writer has no tools and no write path.
        tools: [],
        timeoutMs: this.split.writerTimeoutMs,
        signal: writerController.signal,
        onTextDelta: (delta: string) => {
          if (delta === '') return
          streamed.push(delta)
          input.onTextDelta?.(delta)
        },
      }
      writerResult = await this.writerRunner.run(request)
    } catch (error) {
      writerFailure = error
    } finally {
      writerTimer.cancel()
    }

    // Preempted/aborted while writing: keep already-dispatched effects, never
    // back-fill a line. The engine writes `writer_preempted` (B2-T4).
    if (isAborted(input.signal) || isAborted(input.preemptSignal)) {
      await pendingDispatch
      if (dispatchError !== undefined) throw dispatchError
      throw abortedError()
    }

    const writerTimedOutOrFailed = writerFailure !== undefined || writerTimedOut
    const writerFailed = writerTimedOutOrFailed
      || writerResult?.finishReason === 'timeout'
      || writerResult?.finishReason === 'error'
    let line = streamed.length > 0 ? streamed.join('') : (writerResult?.text ?? '')
    let writerFallback = false
    if (writerFailed) {
      const reason = writerTimedOut
        ? 'timeout'
        : describeFailure(
            writerFailure ?? new Error(`writer finish reason ${writerResult?.finishReason ?? 'unknown'}`),
            'writer failed',
          )
      line = WRITER_TEMPLATE_LINE
      writerFallback = true
      warnings.push(`writer failed (${reason}); using the template line`)
      await this.audit.record({
        actor: 'system',
        action: 'writer_fallback',
        result: 'error',
        reason,
        detail: { turnId: input.turnId, reason },
      })
    } else {
      warnings.push(...missingMentionWarnings(plan, input.resolveContext.intents, line))
    }

    if (pendingDispatch !== undefined) await pendingDispatch
    if (dispatchError !== undefined) throw dispatchError

    const usage = addUsage(directorResult?.usage, writerResult?.usage)
    return {
      turnId: input.turnId,
      line,
      plan,
      dropped,
      dispatch: dispatched,
      outcome: writerFallback || (directorFailed && !applied) ? 'fallback' : 'completed',
      warnings,
      ...(plan?.choices === undefined ? {} : { choices: plan.choices }),
      ...(usage === undefined ? {} : { usage }),
    }
  }

  /** Wrap the shared executor so `planning → executing` is reported once. */
  private stagedExecutor(stages: StageReporter): TurnExecutor {
    return {
      dispatch: async (plan, ctx, diagnostics, options) => {
        stages.report('executing')
        // Forward the abort signal: without it a preempted single-call turn
        // would still dispatch the remaining beats (wave-4 review B-3).
        return this.executor.dispatch(plan, ctx, diagnostics, options)
      },
    }
  }
}

/** A forward-only stage reporter; reporting the same/earlier stage is a no-op. */
interface StageReporter {
  report(stage: Stage): void
  current(): Stage
}

function createStageReporter(input: TurnInput): StageReporter {
  let currentStage: Stage = 'planning'
  return {
    report(stage) {
      if (STAGE_RANK[stage] <= STAGE_RANK[currentStage]) return
      currentStage = stage
      if (stage === 'planning') return
      input.onStage?.(stage)
    },
    current() {
      return currentStage
    },
  }
}

/** True when the config asks for the two-call path (either role configured). */
function isSplitConfig(llm: LlmConfig): boolean {
  return llm.director !== null && llm.director !== undefined
    || llm.writer !== null && llm.writer !== undefined
}

/** The engine-induced plan context; `turnId`/`phase` never come from model JSON. */
function planContextOf(input: TurnInput): PlanContext {
  return {
    intents: input.resolveContext.intents,
    regions: input.resolveContext.regions,
    turnId: input.turnId,
    phase: input.phase,
    ...(input.maxBeats === undefined ? {} : { maxBeats: input.maxBeats }),
    ...(input.maxChoices === undefined ? {} : { maxChoices: input.maxChoices }),
  }
}

/** Narrative-only plan for the writer when the director produced none. */
function emptyPlan(input: TurnInput): BeatPlan {
  return {
    turnId: input.turnId,
    phase: input.phase,
    pacing: EMPTY_PACING,
    beats: [],
  }
}

/** Single-call prompt: the existing layered system prompt plus the recent line. */
function singleCallMessages(input: TurnInput): readonly LlmMessage[] {
  const briefs = [...(input.briefs ?? []), ...(input.probeBrief === undefined ? [] : [input.probeBrief])]
  const system = buildSystemPrompt({
    boundaries: input.boundaries,
    host: input.host,
    persona: input.persona,
    scene: input.scene,
    ...(briefs.length === 0 ? {} : { briefs }),
  })
  return buildTurnMessages({
    ...(system === '' ? {} : { system }),
    recentLines: input.recentLines,
    ...(input.playerText === undefined ? {} : { playerText: input.playerText }),
  })
}

/** The director sees structured facts only; its tool surface is `apply_plan`. */
function directorMessages(input: TurnInput): readonly LlmMessage[] {
  const context = buildDirectorContext({
    state: input.state,
    phase: input.phaseMachine,
    intents: input.resolveContext.intents,
    snapshot: input.resolveContext.snapshot,
    probes: input.probes,
    boundaries: input.boundaries,
    personaSummary: input.personaSummary,
    hostRhythm: input.hostRhythm,
    dialogSummary: input.dialogSummary ?? [],
    ...(input.plannedMin === undefined ? {} : { plannedMin: input.plannedMin }),
    ...(input.phaseEnteredMin === undefined ? {} : { phaseEnteredMin: input.phaseEnteredMin }),
  })
  const boundaries = context.boundaries.length === 0
    ? ''
    : `## 边界（最高优先级，必须遵守）\n${context.boundaries.map(line => `- ${line}`).join('\n')}\n\n`
  return [
    {
      role: 'system',
      content:
        '你是本回合的导演。只通过 apply_plan 工具提交动作计划，不要写台词，不要解释。\n'
        + '只能从意图表里选意图；turnId 与 phase 由引擎注入，不要自己写。\n\n'
        + boundaries
        + `## 当前事实（JSON）\n${JSON.stringify(context, null, 2)}`,
    },
    { role: 'user', content: playerPrompt(input) },
  ]
}

/** The writer sees prose and the humanized plan; it has no tools. */
function writerMessages(input: TurnInput, context: WriterContext): readonly LlmMessage[] {
  return buildTurnMessages({
    system: writerSystemPrompt(input, context),
    recentLines: context.recentLines,
    ...(input.playerText === undefined ? {} : { playerText: input.playerText }),
  })
}

/** Writer system prompt: stable prefix (boundaries → host → persona → scene) + plan. */
function writerSystemPrompt(input: TurnInput, context: WriterContext): string {
  const briefs = [
    ...(input.briefs ?? []),
    ...(context.probeBrief === undefined ? [] : [context.probeBrief]),
  ]
  const base = buildSystemPrompt({
    boundaries: context.boundaries,
    host: context.host,
    persona: context.persona,
    scene: context.scene,
    ...(briefs.length === 0 ? {} : { briefs }),
  })
  const planBlock = `## 本回合计划（人话版）\n${context.planText}`
  const mentions = context.mustMention.length === 0
    ? ''
    : `\n\n## 必须提到的动作\n${context.mustMention.map(entry => `- ${entry.text}（必须提到）`).join('\n')}`
  const constraints = `\n\n## 写作约束\n${context.constraints.join('；')}`
  return base === ''
    ? `${planBlock}${mentions}${constraints}`
    : `${base}\n\n${planBlock}${mentions}${constraints}`
}

/** The player's opening message, or a neutral "continue" prompt. */
function playerPrompt(input: TurnInput): string {
  const text = input.playerText?.trim() ?? ''
  return text === '' ? '玩家没有新的输入，继续本回合。' : text
}

/**
 * Missing `mustMention` beats, as warnings.
 *
 * There is no tokenizer in core, so "mentioned" means the line contains one of
 * the intent-meaning anchors (a part of `短促试探` / `安抚/降档`). A missing mark
 * is a style warning: the turn resolves normally and the plan's actions stand.
 */
function missingMentionWarnings(
  plan: BeatPlan | undefined,
  intents: ReadonlyMap<string, FeedbackIntent>,
  line: string,
): string[] {
  if (plan === undefined) return []
  const flagged = plan.lineGuidance?.mustMentionBeatIds
  const warnings: string[] = []
  for (const beat of plan.beats) {
    if (!isMustMention(beat, flagged)) continue
    const anchors = meaningAnchors(intents.get(beat.intentId)?.meaning)
    if (anchors.length === 0) continue
    if (anchors.some(anchor => line.includes(anchor))) continue
    warnings.push(
      `mustMention beat "${beat.id}" was not mentioned in the line; recorded as a warning without blocking the turn`,
    )
  }
  return warnings
}

/** `beats[].mustMention` wins; `lineGuidance.mustMentionBeatIds` is the redundant form. */
function isMustMention(beat: Beat, lineGuidanceIds: readonly string[] | undefined): boolean {
  if (beat.mustMention !== undefined) return beat.mustMention
  return lineGuidanceIds?.includes(beat.id) ?? false
}

/** Digit-free, at least two code points, split on common separators. */
function meaningAnchors(meaning: string | undefined): string[] {
  if (meaning === undefined) return []
  return meaning
    .split(/[/、，,；;。\s]+/u)
    .map(part => part.replace(/\p{Nd}+/gu, '').trim())
    .filter(part => Array.from(part).length >= 2)
}

/** Sum two optional usage reports; `undefined` when neither provider reported. */
function addUsage(left: ModelUsage | undefined, right: ModelUsage | undefined): ModelUsage | undefined {
  if (left === undefined) return right
  if (right === undefined) return left
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
  }
}

function describeFailure(error: unknown, fallback: string): string {
  if (isModelError(error)) return error.code
  if (error instanceof Error && error.message.trim() !== '') return error.message
  return fallback
}

function positiveTimeout(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return fallback
  return Math.floor(value)
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true
}

function abortedError(): ModelError {
  return new ModelError('the turn was aborted', { code: 'aborted' })
}

/** Runtime narrowing between the rich input and a bare engine request. */
function isTurnInput(input: TurnInput | TurnRequest): input is TurnInput {
  return 'resolveContext' in input && 'state' in input && 'phaseMachine' in input
}
