import { describe, expect, it } from 'vitest'
import { TurnPipeline } from '../src/agent/pipeline.ts'
import type { TurnContextProvider, TurnInput } from '../src/agent/pipeline.ts'
import type { LlmConfig, ModelRunner, ToolCall } from '../src/agent/model.ts'
import { ModelError } from '../src/agent/model.ts'
import { M2_MODEL_TOOLS } from '../src/agent/tools.ts'
import { WRITER_TEMPLATE_LINE } from '../src/agent/context/writer.ts'
import { FakeModelRunner } from './fakes/fake-model-runner.ts'
import type { FakeTurn } from './fakes/fake-model-runner.ts'
import { FakeClock } from '../src/ports/fake-clock.ts'
import { AuditLog, type AuditRecord } from '../src/devices/audit.ts'
import { MemoryAppendOnlyStore } from '../src/ports/storage.ts'
import { PhaseMachine } from '../src/scenario/phases.ts'
import { DEFAULT_INTENTS } from '../src/scenario/default-intents.ts'
import type { ResolveContext } from '../src/scenario/intents.ts'
import type { DispatchResult } from '../src/execution/executor.ts'
import type { TurnExecutor } from '../src/agent/loop.ts'
import type { TurnRequest, TurnRunner } from '../src/engine/turn-engine.ts'
import { WaveformLibrary } from '../src/waveform/library.ts'

const INTENTS: ReadonlyMap<string, (typeof DEFAULT_INTENTS)[number]> = new Map(
  DEFAULT_INTENTS.map(intent => [intent.id, intent] as const),
)

const PERSONA = '人设：嘴硬心软，称呼玩家为「你」，不说教。'
const HOST = '主持风格：短句、克制，留白多于说明。'
const SCENE = '场景：深夜的房间，只有台灯亮着。'

const PLAN_ARGS = {
  pacing: 'build',
  beats: [
    { id: 'b1', intentId: 'probe-touch', regions: ['chest'], strength: 'med', mustMention: true },
  ],
}

const APPLY_PLAN_CALL: ToolCall = { id: 'call_plan', name: 'apply_plan', arguments: PLAN_ARGS }

const SINGLE_LLM: LlmConfig = {
  default: { provider: 'deepseek', model: 'deepseek-chat' },
  director: null,
  writer: null,
}

const SPLIT_LLM: LlmConfig = {
  default: { provider: 'deepseek', model: 'deepseek-chat' },
  director: { provider: 'deepseek', model: 'director-chat', temperature: 0.3 },
  writer: { provider: 'deepseek', model: 'writer-chat', temperature: 0.9 },
}

/** Director returns the plan tool call and no prose. */
function directorTurn(): FakeTurn {
  return {
    events: [{ type: 'tool-call', call: APPLY_PLAN_CALL }],
    finishReason: 'tool-calls',
  }
}

/** Writer streams the line; the default line mentions the flagged beat. */
function writerTurn(text = '他轻轻靠近，短促试探了一下。'): FakeTurn {
  return { events: [{ type: 'text', delta: text }], finishReason: 'stop' }
}

function resolveContextFixture(): ResolveContext {
  return {
    snapshot: { locked: false, lockedReason: undefined, devices: [] },
    intents: INTENTS,
    regions: ['chest'],
    waveforms: new WaveformLibrary(),
  }
}

function inputFixture(overrides: Partial<TurnInput> = {}): TurnInput {
  const signal = new AbortController().signal
  return {
    turnId: 7,
    phase: 'probe',
    signal,
    phaseMachine: new PhaseMachine([{ id: 'probe', goal: '试探，确认反应', next: [] }]),
    state: {
      elapsedMin: 3,
      turn: 2,
      status: 'active',
      lastLine: '她别过头去。',
      recentBeats: ['probe-touch'],
    },
    resolveContext: resolveContextFixture(),
    probes: [],
    recentLines: ['她别过头去。'],
    boundaries: ['不越过玩家明确说出的底线'],
    persona: PERSONA,
    host: HOST,
    scene: SCENE,
    personaSummary: '嘴硬心软，先试探再靠近。',
    hostRhythm: '短句、克制，收尾留白。',
    dialogSummary: ['她别过头去。'],
    corpusExcerpts: [],
    ...overrides,
  }
}

interface RecordingExecutor {
  readonly calls: number[]
  readonly executor: TurnExecutor
}

/** A synchronous-recording executor stub; the real `PlanExecutor` is injected in production. */
function recordingExecutor(options: { readonly onDispatch?: () => void } = {}): RecordingExecutor {
  const calls: number[] = []
  const executor: TurnExecutor = {
    dispatch(plan): Promise<DispatchResult> {
      calls.push(plan.turnId)
      options.onDispatch?.()
      return Promise.resolve({ planId: 'p-test', turnId: plan.turnId, actions: [], blocked: false })
    },
  }
  return { calls, executor }
}

interface Harness {
  readonly pipeline: TurnPipeline
  readonly clock: FakeClock
  readonly store: MemoryAppendOnlyStore
  readonly records: () => AuditRecord[]
}

function createHarness(options: {
  readonly runner: ModelRunner
  readonly llm: LlmConfig
  readonly executor?: TurnExecutor
  readonly context?: TurnContextProvider
}): Harness {
  const clock = new FakeClock(1_000)
  const store = new MemoryAppendOnlyStore()
  const audit = new AuditLog(store, clock, () => {})
  const pipeline = new TurnPipeline({
    runner: options.runner,
    tools: M2_MODEL_TOOLS,
    executor: options.executor ?? recordingExecutor().executor,
    llm: options.llm,
    clock,
    audit,
    ...(options.context === undefined ? {} : { context: options.context }),
  })
  const records = (): AuditRecord[] => store.lines.map(line => JSON.parse(line) as AuditRecord)
  return { pipeline, clock, store, records }
}

describe('TurnPipeline (single call / split call)', () => {
  it('uses one request when director and writer are null and two when set', async () => {
    const singleRunner = new FakeModelRunner([
      {
        events: [
          { type: 'text', delta: '他靠近，' },
          { type: 'tool-call', call: APPLY_PLAN_CALL },
          { type: 'text', delta: '短促试探了一下。' },
        ],
        finishReason: 'tool-calls',
      },
    ])
    const singleExecutor = recordingExecutor()
    const single = createHarness({
      runner: singleRunner,
      llm: SINGLE_LLM,
      executor: singleExecutor.executor,
    })
    const singleResult = await single.pipeline.run(inputFixture({ playerText: '继续' }))

    expect(single.pipeline.mode).toBe('single')
    expect(singleRunner.callCount).toBe(1)
    expect(singleExecutor.calls).toEqual([7])
    expect(singleResult.line).toBe('他靠近，短促试探了一下。')
    expect(singleResult.plan?.turnId).toBe(7)
    expect(singleResult.dispatch?.planId).toBe('p-test')
    expect(singleResult.outcome).toBe('completed')

    const splitRunner = new FakeModelRunner([directorTurn(), writerTurn()])
    const splitExecutor = recordingExecutor()
    const split = createHarness({
      runner: splitRunner,
      llm: SPLIT_LLM,
      executor: splitExecutor.executor,
    })
    const splitResult = await split.pipeline.run(inputFixture({ playerText: '继续' }))

    expect(split.pipeline.mode).toBe('split')
    expect(splitRunner.callCount).toBe(2)
    // The director sees exactly the control tool; the writer has no tools at all.
    expect(splitRunner.requests[0]?.tools.map(tool => tool.name)).toEqual(['apply_plan'])
    expect(splitRunner.requests[1]?.tools).toEqual([])
    expect(splitRunner.requests[1]?.messages[0]?.content).toContain('本回合计划')
    expect(splitExecutor.calls).toEqual([7])
    expect(splitResult.plan?.beats[0]?.id).toBe('b1')
    expect(splitResult.dispatch?.planId).toBe('p-test')
  })

  it('dispatches before the writer stream starts in split mode', async () => {
    const order: string[] = []
    const executor = recordingExecutor({ onDispatch: () => order.push('dispatch') })
    let writerTools: readonly unknown[] | undefined
    const runner: ModelRunner = {
      async run(request) {
        if (request.tools.length > 0) {
          request.onToolCall?.(APPLY_PLAN_CALL)
          return { text: '', toolCalls: [APPLY_PLAN_CALL], finishReason: 'tool-calls' }
        }
        order.push('writer')
        writerTools = request.tools
        request.onTextDelta?.('他靠近。')
        return { text: '他靠近。', toolCalls: [], finishReason: 'stop' }
      },
    }
    const h = createHarness({ runner, llm: SPLIT_LLM, executor: executor.executor })
    const result = await h.pipeline.run(inputFixture())

    expect(order).toEqual(['dispatch', 'writer'])
    expect(writerTools).toEqual([])
    expect(result.dispatch?.planId).toBe('p-test')
  })

  it('records a mustMention warning without blocking', async () => {
    const runner = new FakeModelRunner([directorTurn(), writerTurn('他低声笑了一下。')])
    const h = createHarness({ runner, llm: SPLIT_LLM })
    const result = await h.pipeline.run(inputFixture())

    // The writer line is kept verbatim and the turn resolves normally.
    expect(result.line).toBe('他低声笑了一下。')
    expect(result.outcome).toBe('completed')
    expect(result.dispatch?.planId).toBe('p-test')
    expect(result.warnings.some(warning => warning.includes('mustMention beat "b1"'))).toBe(true)
    // The warning is not a writer failure: the template line was never used.
    expect(result.line).not.toBe(WRITER_TEMPLATE_LINE)
    expect(h.records().some(record => record.action === 'writer_fallback')).toBe(false)
  })

  it('fills a template line when the writer fails', async () => {
    const runner = new FakeModelRunner([
      directorTurn(),
      { events: [{ type: 'error', error: new Error('writer exploded') }] },
    ])
    const h = createHarness({ runner, llm: SPLIT_LLM })
    const result = await h.pipeline.run(inputFixture())

    expect(result.line).toBe(WRITER_TEMPLATE_LINE)
    expect(result.dispatch?.planId).toBe('p-test')
    expect(result.plan?.beats[0]?.id).toBe('b1')
    expect(result.outcome).toBe('fallback')
    const fallback = h.records().find(record => record.action === 'writer_fallback')
    expect(fallback?.actor).toBe('system')
    expect(fallback?.result).toBe('error')
    expect(fallback?.detail?.turnId).toBe(7)
    expect(fallback?.reason).toContain('writer exploded')
  })

  it('uses split.writerTimeoutMs and templates a timed-out writer', async () => {
    let markWriterStarted: (() => void) | undefined
    const writerStarted = new Promise<void>(resolve => {
      markWriterStarted = resolve
    })
    const runner: ModelRunner = {
      async run(request) {
        if (request.tools.length > 0) {
          request.onToolCall?.(APPLY_PLAN_CALL)
          return { text: '', toolCalls: [APPLY_PLAN_CALL], finishReason: 'tool-calls' }
        }
        markWriterStarted?.()
        // Behaved like a stalled provider: reject only when the signal fires.
        return await new Promise<never>((_resolve, reject) => {
          request.signal.addEventListener(
            'abort',
            () => reject(new ModelError('the writer was aborted', { code: 'aborted' })),
            { once: true },
          )
        })
      },
    }
    const h = createHarness({ runner, llm: SPLIT_LLM })
    const pending = h.pipeline.run(inputFixture())
    await writerStarted
    h.clock.advance(30_000)
    const result = await pending

    expect(result.line).toBe(WRITER_TEMPLATE_LINE)
    expect(result.dispatch?.planId).toBe('p-test')
    expect(result.outcome).toBe('fallback')
    const fallback = h.records().find(record => record.action === 'writer_fallback')
    expect(fallback?.reason).toBe('timeout')
    expect(h.clock.pendingCount).toBe(0)
  })

  it('is an engine TurnRunner when a context provider is supplied', async () => {
    const runner = new FakeModelRunner([directorTurn(), writerTurn()])
    const provider: TurnContextProvider = {
      inputFor: (request: TurnRequest) =>
        inputFixture({ turnId: request.turnId, phase: request.phase, signal: request.signal }),
    }
    const h = createHarness({ runner, llm: SPLIT_LLM, context: provider })
    const asRunner: TurnRunner = h.pipeline
    const signal = new AbortController().signal
    const result = await asRunner.run({ turnId: 3, phase: 'probe', signal })

    expect(result.line).toBe('他轻轻靠近，短促试探了一下。')
    expect(result.outcome).toBe('completed')
    expect(runner.callCount).toBe(2)
  })

  it('uses exactly one controller in single mode', async () => {
    const singleClock = new FakeClock(1_000)
    const singleTimers: number[] = []
    const singleRunner: ModelRunner = {
      async run() {
        singleTimers.push(singleClock.pendingCount)
        return { text: '嗯。', toolCalls: [], finishReason: 'stop' }
      },
    }
    const singleStore = new MemoryAppendOnlyStore()
    const single = new TurnPipeline({
      runner: singleRunner,
      tools: M2_MODEL_TOOLS,
      executor: recordingExecutor().executor,
      llm: SINGLE_LLM,
      clock: singleClock,
      audit: new AuditLog(singleStore, singleClock, () => {}),
    })
    await single.run(inputFixture())
    // D6: the single-call loop owns exactly one controller and one timer.
    expect(singleTimers).toEqual([1])
    expect(singleClock.pendingCount).toBe(0)
  })
})
