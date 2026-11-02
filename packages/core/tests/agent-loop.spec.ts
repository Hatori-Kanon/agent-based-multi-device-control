import { describe, expect, it } from 'vitest'
import { FakeClock } from '../src/ports/fake-clock.ts'
import { DEFAULT_TURN_TIMEOUT_MS, runTurn } from '../src/agent/loop.ts'
import type { TurnExecutor, TurnLoopInput } from '../src/agent/loop.ts'
import { ModelError } from '../src/agent/model.ts'
import type { ModelRunner, ModelTurnRequest, ModelTurnResult, ToolCall } from '../src/agent/model.ts'
import { M2_MODEL_TOOLS } from '../src/agent/tools.ts'
import { DEFAULT_INTENTS } from '../src/scenario/default-intents.ts'
import type { ResolveContext } from '../src/scenario/intents.ts'
import type { BeatPlan } from '../src/scenario/beat-plan.ts'
import type { DispatchResult } from '../src/execution/executor.ts'
import { WaveformLibrary } from '../src/waveform/library.ts'

const PLAN_ARGS = {
  pacing: 'build',
  beats: [{ id: 'b1', intentId: 'probe-touch', regions: ['chest'], strength: 'med' }],
}

const APPLY_PLAN_CALL: ToolCall = { id: 'call_plan', name: 'apply_plan', arguments: PLAN_ARGS }
const SECOND_PLAN_CALL: ToolCall = {
  id: 'call_plan_2',
  name: 'apply_plan',
  arguments: { pacing: 'hold', beats: [{ id: 'b2', intentId: 'soothe', regions: ['chest'], strength: 'low' }] },
}
const LOOK_CALL: ToolCall = { id: 'call_look_1', name: 'look', arguments: {} }
const SECOND_LOOK_CALL: ToolCall = { id: 'call_look_2', name: 'look', arguments: { sourceId: 'cam' } }

function resolveContextFixture(): ResolveContext {
  return {
    snapshot: { locked: false, lockedReason: undefined, devices: [] },
    intents: new Map(DEFAULT_INTENTS.map(intent => [intent.id, intent])),
    regions: ['chest'],
    waveforms: new WaveformLibrary(),
  }
}

function inputFixture(overrides: Partial<TurnLoopInput> = {}): TurnLoopInput {
  return {
    turnId: 7,
    phase: 'probe',
    messages: [{ role: 'user', content: '继续' }],
    resolveContext: resolveContextFixture(),
    ...overrides,
  }
}

interface DispatchCall {
  readonly plan: BeatPlan
  readonly ctx: ResolveContext
}

/** A synchronous-recording executor stub; the real `PlanExecutor` is passed in production. */
function recordingExecutor(options: { readonly onDispatch?: (plan: BeatPlan) => void } = {}) {
  const calls: DispatchCall[] = []
  const executor: TurnExecutor = {
    dispatch(plan, ctx): Promise<DispatchResult> {
      calls.push({ plan, ctx })
      options.onDispatch?.(plan)
      return Promise.resolve({ planId: 'p-test', turnId: plan.turnId, actions: [], blocked: false })
    },
  }
  return { calls, executor }
}

function textTurn(deltas: readonly string[], usage?: { inputTokens: number; outputTokens: number }): ModelTurnResult {
  return {
    text: deltas.join(''),
    toolCalls: [],
    finishReason: 'stop',
    ...(usage === undefined ? {} : { usage }),
  }
}

/** Collect text deltas through the runner's `onTextDelta` callback. */
function emitText(request: ModelTurnRequest, deltas: readonly string[]): void {
  for (const delta of deltas) request.onTextDelta?.(delta)
}

/** Capture a rejection as an Error so its fields can be asserted. */
async function failure(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error))
  }
  throw new Error('expected the promise to reject')
}

/** Spin the microtask queue until a condition holds. */
async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return
    await Promise.resolve()
  }
  throw new Error('condition never became true')
}

describe('runTurn (single-call turn)', () => {
  it('retries once when the model returns neither prose nor a plan', async () => {
    const { executor } = recordingExecutor()
    const narration = '（触手从暗处浮出，贴着腰侧停住。）咕啾~'
    const requests: ModelTurnRequest[] = []
    const runner: ModelRunner = {
      async run(request) {
        requests.push(request)
        if (requests.length === 1) {
          // The failure mode seen with DeepSeek: only a read-only tool call (or
          // nothing at all) and an empty content field.
          return { text: '', toolCalls: [], finishReason: 'stop' }
        }
        const call: ToolCall = {
          id: 'call_after_reminder',
          name: 'apply_plan',
          arguments: { ...PLAN_ARGS, narration },
        }
        request.onToolCall?.(call)
        return { text: '', toolCalls: [call], finishReason: 'tool-calls' }
      },
    }

    const result = await runTurn({
      runner,
      tools: M2_MODEL_TOOLS,
      executor,
      input: inputFixture(),
      clock: new FakeClock(),
    })
    expect(requests).toHaveLength(2)
    expect(requests[1]?.messages.at(-1)).toMatchObject({ role: 'user' })
    expect((requests[1]?.messages.at(-1)?.content ?? '')).toContain('narration')
    expect(result.line).toBe(narration)
    expect(result.warnings.some(warning => warning.includes('empty model reply'))).toBe(true)
  })

  it('uses apply_plan.narration when the provider sends no content text', async () => {
    const { executor } = recordingExecutor()
    const narration = '（暗室的湿冷裹上来，触手从阴影里浮出。）咕啾~……'
    const call: ToolCall = {
      id: 'call_plan_narration',
      name: 'apply_plan',
      arguments: { ...PLAN_ARGS, narration },
    }
    const runner: ModelRunner = {
      async run(request) {
        // DeepSeek-style tool call: no content delta, prose only in arguments.
        request.onToolCall?.(call)
        return { text: '', toolCalls: [call], finishReason: 'tool-calls' }
      },
    }

    const result = await runTurn({
      runner,
      tools: M2_MODEL_TOOLS,
      executor,
      input: inputFixture(),
      clock: new FakeClock(),
    })
    expect(result.line).toBe(narration)
    expect(result.plan?.beats).toHaveLength(1)
  })

  it('dispatches as soon as the tool call completes, before the text stream ends', async () => {
    const order: string[] = []
    const { calls, executor } = recordingExecutor({ onDispatch: () => order.push('dispatch') })
    const runner: ModelRunner = {
      async run(request) {
        emitText(request, ['他轻轻'])
        order.push('text:before-tool')
        request.onToolCall?.(APPLY_PLAN_CALL)
        order.push('text:after-tool-call')
        await Promise.resolve()
        emitText(request, ['，靠近你。'])
        return {
          text: '他轻轻，靠近你。',
          toolCalls: [APPLY_PLAN_CALL],
          finishReason: 'tool-calls',
        }
      },
    }

    const result = await runTurn({
      runner,
      tools: M2_MODEL_TOOLS,
      executor,
      input: inputFixture(),
      clock: new FakeClock(),
    })

    // Dispatch ran inside the tool-call callback, before the runner continued
    // streaming text — that is what makes effects start before the line ends.
    expect(order).toEqual(['text:before-tool', 'dispatch', 'text:after-tool-call'])
    expect(calls).toHaveLength(1)
    expect(result.line).toBe('他轻轻，靠近你。')
    expect(result.plan?.beats).toHaveLength(1)
    expect(result.plan?.turnId).toBe(7)
    expect(result.plan?.phase).toBe('probe')
    expect(result.dispatch?.blocked).toBe(false)
    expect(calls[0]?.plan.beats[0]?.id).toBe('b1')
    expect(calls[0]?.ctx.regions).toEqual(['chest'])
  })

  it('rejects a second apply_plan in the same turn', async () => {
    const { calls, executor } = recordingExecutor()
    const runner: ModelRunner = {
      async run(request) {
        request.onToolCall?.(APPLY_PLAN_CALL)
        request.onToolCall?.(SECOND_PLAN_CALL)
        emitText(request, ['好。'])
        return { text: '好。', toolCalls: [APPLY_PLAN_CALL, SECOND_PLAN_CALL], finishReason: 'tool-calls' }
      },
    }

    const result = await runTurn({
      runner,
      tools: M2_MODEL_TOOLS,
      executor,
      input: inputFixture(),
      clock: new FakeClock(),
    })

    expect(calls).toHaveLength(1)
    expect(calls[0]?.plan.beats.map(beat => beat.id)).toEqual(['b1'])
    expect(result.plan?.beats.map(beat => beat.id)).toEqual(['b1'])
    expect(result.warnings.some(warning => warning.includes('one plan per turn'))).toBe(true)
    expect(result.line).toBe('好。')
  })

  it('allows at most one look per turn', async () => {
    const { calls, executor } = recordingExecutor()
    const runner: ModelRunner = {
      async run(request) {
        request.onToolCall?.(LOOK_CALL)
        request.onToolCall?.(SECOND_LOOK_CALL)
        emitText(request, ['看过了。'])
        return { text: '看过了。', toolCalls: [LOOK_CALL, SECOND_LOOK_CALL], finishReason: 'stop' }
      },
    }

    const result = await runTurn({
      runner,
      tools: M2_MODEL_TOOLS,
      executor,
      input: inputFixture(),
      clock: new FakeClock(),
    })

    expect(calls).toHaveLength(0)
    expect(result.plan).toBeUndefined()
    expect(result.dispatch).toBeUndefined()
    expect(result.warnings.filter(warning => warning.includes('look'))).toEqual([
      'look was called more than once in the same turn; the extra call was ignored (one look per turn)',
    ])
    expect(result.line).toBe('看过了。')
  })

  it('emits a narrative-only turn when the model calls no tool', async () => {
    const clock = new FakeClock()
    const { calls, executor } = recordingExecutor()
    const runner: ModelRunner = {
      async run(request) {
        emitText(request, ['他只是', '看着你。'])
        return textTurn(['他只是', '看着你。'], { inputTokens: 12, outputTokens: 5 })
      },
    }

    const result = await runTurn({
      runner,
      tools: M2_MODEL_TOOLS,
      executor,
      input: inputFixture(),
      clock,
    })

    expect(calls).toHaveLength(0)
    expect(result.line).toBe('他只是看着你。')
    expect(result.plan).toBeUndefined()
    expect(result.dispatch).toBeUndefined()
    expect(result.dropped).toEqual([])
    expect(result.warnings).toEqual([])
    expect(result.usage).toEqual({ inputTokens: 12, outputTokens: 5 })
    // The turn timer is cleaned up on the success path.
    expect(clock.pendingCount).toBe(0)
  })

  it('uses exactly one abort controller and a 60s total timeout', async () => {
    const RealAbortController = globalThis.AbortController
    let created = 0
    class CountingAbortController extends RealAbortController {
      constructor() {
        super()
        created += 1
      }
    }
    globalThis.AbortController = CountingAbortController as unknown as typeof AbortController
    try {
      const clock = new FakeClock()
      let request: ModelTurnRequest | undefined
      const runner: ModelRunner = {
        run(req) {
          request = req
          return new Promise<ModelTurnResult>((_resolve, reject) => {
            req.signal.addEventListener('abort', () => {
              reject(new ModelError('aborted', { code: 'aborted' }))
            }, { once: true })
          })
        },
      }
      const { calls, executor } = recordingExecutor()
      const pending = runTurn({ runner, tools: M2_MODEL_TOOLS, executor, input: inputFixture(), clock })
      await waitFor(() => request !== undefined)

      expect(created).toBe(1)
      expect(DEFAULT_TURN_TIMEOUT_MS).toBe(60_000)
      expect(request?.timeoutMs).toBe(DEFAULT_TURN_TIMEOUT_MS)
      // Exactly one injected-clock timer covers the whole turn.
      expect(clock.pendingCount).toBe(1)
      clock.advance(59_999)
      expect(clock.pendingCount).toBe(1)

      clock.advance(1)
      const error = await failure(pending)
      expect((error as ModelError).code).toBe('timeout')
      expect(clock.pendingCount).toBe(0)
      expect(calls).toHaveLength(0)
    } finally {
      globalThis.AbortController = RealAbortController
    }
  })

  it('retries a transport failure once and then succeeds', async () => {
    let runs = 0
    const { calls, executor } = recordingExecutor()
    const runner: ModelRunner = {
      async run(request) {
        runs += 1
        if (runs === 1) throw new ModelError('socket hang up', { code: 'network', retryable: true })
        emitText(request, ['好。'])
        return textTurn(['好。'])
      },
    }

    const result = await runTurn({
      runner,
      tools: M2_MODEL_TOOLS,
      executor,
      input: inputFixture(),
      clock: new FakeClock(),
    })

    expect(runs).toBe(2)
    expect(result.line).toBe('好。')
    expect(calls).toHaveLength(0)
    expect(result.warnings.some(warning => warning.includes('retried once'))).toBe(true)
  })

  it('does not retry an invalid plan', async () => {
    let runs = 0
    const { calls, executor } = recordingExecutor()
    const invalidCall: ToolCall = {
      id: 'call_invalid',
      name: 'apply_plan',
      arguments: { pacing: 'build', beats: [{ nonsense: true }] },
    }
    const runner: ModelRunner = {
      async run(request) {
        runs += 1
        request.onToolCall?.(invalidCall)
        return { text: '', toolCalls: [invalidCall], finishReason: 'tool-calls' }
      },
    }

    const result = await runTurn({
      runner,
      tools: M2_MODEL_TOOLS,
      executor,
      input: inputFixture(),
      clock: new FakeClock(),
    })

    // Parsing is the only gate; a bad plan degrades instead of re-asking.
    expect(runs).toBe(1)
    expect(calls).toHaveLength(1)
    expect(result.plan?.beats).toEqual([])
    expect(result.dropped.length).toBeGreaterThan(0)
  })

  it('injects the engine turn id and phase instead of the model copies', async () => {
    const { calls, executor } = recordingExecutor()
    const rawArgs = {
      ...PLAN_ARGS,
      turnId: 99,
      phase: 'hacked',
    }
    const call: ToolCall = { id: 'call_plan', name: 'apply_plan', arguments: rawArgs }
    const runner: ModelRunner = {
      async run(request) {
        request.onToolCall?.(call)
        return { text: '', toolCalls: [call], finishReason: 'tool-calls' }
      },
    }

    const result = await runTurn({
      runner,
      tools: M2_MODEL_TOOLS,
      executor,
      input: inputFixture(),
      clock: new FakeClock(),
    })

    expect(calls).toHaveLength(1)
    expect(calls[0]?.plan.turnId).toBe(7)
    expect(calls[0]?.plan.phase).toBe('probe')
    expect(result.plan?.turnId).toBe(7)
    expect(result.plan?.phase).toBe('probe')
    expect(result.warnings.some(warning => warning.includes('engine field'))).toBe(true)
  })

  it('streams line deltas through the optional callback', async () => {
    const deltas: string[] = []
    const runner: ModelRunner = {
      async run(request) {
        emitText(request, ['他', '靠近'])
        return textTurn(['他', '靠近'])
      },
    }
    const { executor } = recordingExecutor()
    const result = await runTurn({
      runner,
      tools: M2_MODEL_TOOLS,
      executor,
      input: inputFixture(),
      clock: new FakeClock(),
      onTextDelta: delta => deltas.push(delta),
    })
    expect(deltas).toEqual(['他', '靠近'])
    expect(result.line).toBe('他靠近')
  })

  it('honors a caller abort before the turn starts', async () => {
    let runs = 0
    const controller = new AbortController()
    controller.abort()
    const runner: ModelRunner = {
      async run() {
        runs += 1
        return textTurn([])
      },
    }
    const { executor } = recordingExecutor()
    const error = await failure(runTurn({
      runner,
      tools: M2_MODEL_TOOLS,
      executor,
      input: inputFixture(),
      clock: new FakeClock(),
      signal: controller.signal,
    }))
    expect((error as ModelError).code).toBe('aborted')
    expect(runs).toBe(0)
  })

  it('never dispatches twice when a failure arrives after the plan was dispatched', async () => {
    let runs = 0
    const { calls, executor } = recordingExecutor()
    const runner: ModelRunner = {
      async run(request) {
        runs += 1
        request.onToolCall?.(APPLY_PLAN_CALL)
        throw new ModelError('connection reset', { code: 'network', retryable: true })
      },
    }
    const error = await failure(runTurn({
      runner,
      tools: M2_MODEL_TOOLS,
      executor,
      input: inputFixture(),
      clock: new FakeClock(),
    }))
    expect((error as ModelError).code).toBe('network')
    expect(runs).toBe(1)
    expect(calls).toHaveLength(1)
  })
})

describe('the turn deadline covers uncooperative work (review blocker B-4)', () => {
  it('rejects at the deadline even when the runner ignores the abort signal', async () => {
    const clock = new FakeClock()
    const runner: ModelRunner = {
      // Deliberately ignores `request.signal`: a hung transport must not hang
      // the turn forever.
      run: () => new Promise<never>(() => {}),
    }
    const { executor } = recordingExecutor()
    const pending = runTurn({ runner, tools: M2_MODEL_TOOLS, executor, input: inputFixture(), clock })
    const assertion = expect(pending).rejects.toMatchObject({ code: 'timeout' })

    clock.advance(DEFAULT_TURN_TIMEOUT_MS)
    await assertion
    expect(clock.pendingCount).toBe(0)
  })

  it('does not report success when the dispatch only settles after the deadline', async () => {
    const clock = new FakeClock()
    const runner: ModelRunner = {
      run: async () => ({ text: '好的。', toolCalls: [APPLY_PLAN_CALL], finishReason: 'tool-calls' }),
    }
    let release: (() => void) | undefined
    const executor: TurnExecutor = {
      dispatch: () => new Promise(resolve => {
        release = () => resolve({ planId: 'p-late', turnId: 7, actions: [], blocked: false })
      }),
    }

    const pending = runTurn({ runner, tools: M2_MODEL_TOOLS, executor, input: inputFixture(), clock })
    const assertion = expect(pending).rejects.toMatchObject({ code: 'timeout' })

    // Let the tool call reach the hanging dispatch, then blow the deadline.
    await Promise.resolve()
    await Promise.resolve()
    clock.advance(DEFAULT_TURN_TIMEOUT_MS)
    await assertion

    // The late settle must not surface as an unhandled rejection.
    release?.()
    await Promise.resolve()
    await Promise.resolve()
  })
})

describe('the dispatch receives the turn signal (wave-4 review B-3)', () => {
  it('passes the one controller signal used for the model request', async () => {
    const clock = new FakeClock()
    let requestSignal: AbortSignal | undefined
    let dispatchSignal: AbortSignal | undefined
    let dispatchCalls = 0
    const executor: TurnExecutor = {
      dispatch(_plan, _ctx, _diagnostics, options) {
        dispatchCalls += 1
        dispatchSignal = options?.signal
        return Promise.resolve({ planId: 'p-signal', turnId: 7, actions: [], blocked: false })
      },
    }
    const runner: ModelRunner = {
      async run(request) {
        requestSignal = request.signal
        request.onToolCall?.(APPLY_PLAN_CALL)
        return { text: '好。', toolCalls: [APPLY_PLAN_CALL], finishReason: 'tool-calls' }
      },
    }

    const result = await runTurn({ runner, tools: M2_MODEL_TOOLS, executor, input: inputFixture(), clock })

    expect(dispatchCalls).toBe(1)
    // Same object: the turn still owns exactly one cancellation handle.
    expect(dispatchSignal).toBe(requestSignal)
    expect(dispatchSignal?.aborted).toBe(false)
    expect(result.dispatch?.planId).toBe('p-signal')
    expect(clock.pendingCount).toBe(0)
  })

  it('hands an already-aborted signal when the caller aborts before the tool call', async () => {
    const clock = new FakeClock()
    const caller = new AbortController()
    let dispatchCalls = 0
    let dispatchAborted: boolean | undefined
    const executor: TurnExecutor = {
      dispatch(_plan, _ctx, _diagnostics, options) {
        dispatchCalls += 1
        dispatchAborted = options?.signal?.aborted
        // The real PlanExecutor returns this shape without touching a device.
        return Promise.resolve({
          planId: 'p-preempted',
          turnId: 7,
          actions: [],
          blocked: false,
          preempted: true,
          remainingBeats: ['b1'],
        })
      },
    }
    const runner: ModelRunner = {
      async run(request) {
        // The player message lands after the request started, before the
        // model's plan tool call is delivered.
        caller.abort()
        request.onToolCall?.(APPLY_PLAN_CALL)
        emitText(request, ['……'])
        return { text: '……', toolCalls: [APPLY_PLAN_CALL], finishReason: 'tool-calls' }
      },
    }

    const error = await failure(runTurn({
      runner,
      tools: M2_MODEL_TOOLS,
      executor,
      input: inputFixture(),
      clock,
      signal: caller.signal,
    }))

    expect((error as ModelError).code).toBe('aborted')
    expect(dispatchCalls).toBe(1)
    expect(dispatchAborted).toBe(true)
    expect(clock.pendingCount).toBe(0)
  })
})

describe('invalid beats are dropped without silencing the turn (B-5)', () => {
  it('dispatches only the valid beat, still streams the line and records the drop', async () => {
    const clock = new FakeClock()
    const { calls, executor } = recordingExecutor()
    const args = {
      pacing: 'build',
      beats: [
        { id: 'b1', intentId: 'probe-touch', regions: ['chest'], strength: 'med' },
        { id: 'b2', intentId: 'no-such-intent', regions: ['chest'], strength: 'med' },
      ],
    }
    const runner: ModelRunner = {
      run: async () => ({
        text: '（低声）……',
        toolCalls: [{ id: 'call_bad', name: 'apply_plan', arguments: args }],
        finishReason: 'tool-calls',
      }),
    }

    const result = await runTurn({ runner, tools: M2_MODEL_TOOLS, executor, input: inputFixture(), clock })

    // Only the valid beat reaches the executor...
    expect(calls).toHaveLength(1)
    expect(calls[0]?.plan.beats.map(beat => beat.id)).toEqual(['b1'])
    // ...the drop is visible to the audit...
    expect(result.dropped.length).toBeGreaterThan(0)
    expect(result.dropped.some(drop => drop.beatId === 'b2')).toBe(true)
    // ...and the turn still speaks instead of going silent.
    expect(result.line.length).toBeGreaterThan(0)
  })
})
