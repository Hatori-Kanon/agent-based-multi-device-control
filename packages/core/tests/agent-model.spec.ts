import { describe, expect, it } from 'vitest'
import { FakeClock } from '../src/ports/fake-clock.ts'
import { stubFetch } from '../src/ports/http.ts'
import { apiKeyEnvOf, DEFAULT_API_KEY_ENV, ModelError, resolveModel } from '../src/agent/model.ts'
import type { LlmConfig, ModelConfig, ModelTurnRequest, ToolCall } from '../src/agent/model.ts'
import { ChatCompletionAccumulator, streamChatCompletion } from '../src/agent/transport.ts'
import type { ChatStreamOptions } from '../src/agent/transport.ts'
import { FakeModelRunner, RecordingFetch } from './fakes/fake-model-runner.ts'

/** The plan the streamed fragments below assemble into. */
const PLAN = {
  pacing: 'build',
  beats: [{ id: 'b1', intentId: 'probe-touch', regions: ['chest'], strength: 'med' }],
}

function config(overrides: Partial<ModelConfig> = {}): ModelConfig {
  return { provider: 'deepseek', model: 'deepseek-chat', ...overrides }
}

function llmConfig(overrides: Partial<LlmConfig> = {}): LlmConfig {
  return { default: config(), director: null, writer: null, ...overrides }
}

function freshSignal(): AbortSignal {
  return new AbortController().signal
}

function streamOptions(http: RecordingFetch, overrides: Partial<ChatStreamOptions> = {}): ChatStreamOptions {
  return {
    fetch: http.fetch,
    clock: new FakeClock(),
    url: 'https://api.test/v1/chat/completions',
    headers: { authorization: 'Bearer test-key' },
    body: { model: 'test-model', messages: [] },
    signal: freshSignal(),
    timeoutMs: 60_000,
    ...overrides,
  }
}

function request(overrides: Partial<ModelTurnRequest> = {}): ModelTurnRequest {
  return {
    messages: [{ role: 'user', content: '继续' }],
    tools: [],
    timeoutMs: 60_000,
    signal: freshSignal(),
    ...overrides,
  }
}

/** One streamed completion chunk, as a provider would send it. */
function chunk(delta: Record<string, unknown>, finishReason: string | null = null): Record<string, unknown> {
  return { choices: [{ index: 0, delta, finish_reason: finishReason }] }
}

async function collect(stream: AsyncIterable<string>): Promise<string[]> {
  const payloads: string[] = []
  for await (const payload of stream) payloads.push(payload)
  return payloads
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

describe('resolveModel', () => {
  it('resolves director and writer to the default model when they are null', () => {
    const fallback = config()
    const llm: LlmConfig = { default: fallback, director: null, writer: null }
    expect(resolveModel(llm, 'director')).toBe(fallback)
    expect(resolveModel(llm, 'writer')).toBe(fallback)
    // Omitted roles follow the same rule.
    expect(resolveModel({ default: fallback }, 'director')).toBe(fallback)
    expect(resolveModel({ default: fallback }, 'writer')).toBe(fallback)
  })

  it('prefers a role-specific model over the default', () => {
    const fallback = config()
    const director = config({ model: 'deepseek-reasoner', temperature: 0.2 })
    const writer = config({ model: 'deepseek-chat', temperature: 1 })
    const llm: LlmConfig = { default: fallback, director, writer }
    expect(resolveModel(llm, 'director')).toBe(director)
    expect(resolveModel(llm, 'writer')).toBe(writer)
    expect(llmConfig({ director }).director).toBe(director)
  })

  it('defaults the api key env name and keeps an explicit one', () => {
    expect(DEFAULT_API_KEY_ENV).toBe('EMBODIED_LLM_API_KEY')
    expect(apiKeyEnvOf(config())).toBe(DEFAULT_API_KEY_ENV)
    expect(apiKeyEnvOf(config({ apiKeyEnv: 'MY_LLM_KEY' }))).toBe('MY_LLM_KEY')
  })
})

describe('chat completion stream', () => {
  it('reports a tool call as soon as it completes, before the text stream ends', async () => {
    const order: string[] = []
    const calls: ToolCall[] = []
    const http = new RecordingFetch([{
      sse: [
        chunk({ role: 'assistant', content: '他轻轻' }),
        // The arguments arrive in two fragments, split mid-JSON.
        chunk({ tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'apply_plan', arguments: '{"pacing":"build","beats":[{"id":"b1",' } }] }),
        chunk({ tool_calls: [{ index: 0, function: { arguments: '"intentId":"probe-touch","regions":["chest"],"strength":"med"}]}' } }] }),
        chunk({ content: '，靠近你。' }),
        chunk({}, 'tool_calls'),
      ],
    }])
    const accumulator = new ChatCompletionAccumulator({
      onTextDelta: delta => order.push(`text:${delta}`),
      onToolCall: call => { order.push(`tool:${call.name}`); calls.push(call) },
    })
    for await (const payload of streamChatCompletion(streamOptions(http))) accumulator.push(payload)
    const result = accumulator.finish()

    // The tool call is reported while the text stream still has deltas to come.
    expect(order).toEqual(['text:他轻轻', 'tool:apply_plan', 'text:，靠近你。'])
    expect(calls).toHaveLength(1)
    expect(calls[0]?.id).toBe('call_1')
    expect(calls[0]?.arguments).toEqual(PLAN)
    expect(result.text).toBe('他轻轻，靠近你。')
    expect(result.toolCalls).toEqual(calls)
    expect(result.finishReason).toBe('tool-calls')
  })

  it('accumulates a non-streaming aggregate completion', () => {
    const accumulator = new ChatCompletionAccumulator()
    accumulator.push({
      choices: [{
        message: {
          role: 'assistant',
          content: '好。',
          tool_calls: [{ id: 'call_7', type: 'function', function: { name: 'apply_plan', arguments: JSON.stringify(PLAN) } }],
        },
        finish_reason: 'tool_calls',
      }],
      usage: { prompt_tokens: 11, completion_tokens: 7 },
    })
    const result = accumulator.finish()
    expect(result.text).toBe('好。')
    expect(result.toolCalls).toHaveLength(1)
    expect(result.toolCalls[0]?.arguments).toEqual(PLAN)
    expect(result.usage).toEqual({ inputTokens: 11, outputTokens: 7 })
    expect(accumulator.sawChoice).toBe(true)
  })

  it('keeps a tool call whose argument json never parses as raw text', () => {
    const accumulator = new ChatCompletionAccumulator()
    accumulator.push(chunk({ tool_calls: [{ index: 0, id: 'call_bad', function: { name: 'apply_plan', arguments: '{"pacing":' } }] }))
    const result = accumulator.finish()
    expect(result.toolCalls).toHaveLength(1)
    expect(result.toolCalls[0]?.id).toBe('call_bad')
    expect(result.toolCalls[0]?.arguments).toBe('{"pacing":')
  })

  it('decodes sse events split across chunk boundaries', async () => {
    const http = new RecordingFetch([{
      chunks: [
        'data: {"choices":[{"delta":{"content":"he"}}]}\n\ndata: {"cho',
        'ices":[{"delta":{"content":"llo"}}]}\n\n',
      ],
    }])
    const payloads = await collect(streamChatCompletion(streamOptions(http)))
    expect(payloads).toHaveLength(2)
    expect(JSON.parse(payloads[0] ?? '')).toEqual({ choices: [{ delta: { content: 'he' } }] })
    expect(JSON.parse(payloads[1] ?? '')).toEqual({ choices: [{ delta: { content: 'llo' } }] })
  })

  it('stops at the done sentinel and ignores comments and event names', async () => {
    const http = new RecordingFetch([{
      chunks: [
        ': keep-alive\n\n',
        'data:\n\n',
        'event: message\ndata: {"choices":[{"delta":{"content":"a"}}]}\n\n',
        'data: [DONE]\n\n',
        'data: {"choices":[{"delta":{"content":"ignored"}}]}\n\n',
      ],
    }])
    const payloads = await collect(streamChatCompletion(streamOptions(http)))
    expect(payloads).toHaveLength(1)
  })

  it('treats a table-driven json reply as one aggregate chunk', async () => {
    const completion = {
      choices: [{ message: { role: 'assistant', content: '完全体' }, finish_reason: 'stop' }],
    }
    const fetch = stubFetch(() => ({ body: completion }))
    const payloads = await collect(streamChatCompletion(streamOptions(
      new RecordingFetch([{ json: {} }]),
      { fetch },
    )))
    expect(payloads).toHaveLength(1)
    expect(JSON.parse(payloads[0] ?? '')).toEqual(completion)
  })

  it('aborts the request when the signal fires', async () => {
    const http = new RecordingFetch([{ stall: true }])
    const controller = new AbortController()
    const pending = collect(streamChatCompletion(streamOptions(http, { signal: controller.signal })))
    await waitFor(() => http.callCount === 1)
    controller.abort()
    const error = await failure(pending)
    expect(error).toBeInstanceOf(ModelError)
    expect((error as ModelError).code).toBe('aborted')
    expect(http.requests[0]?.signal?.aborted).toBe(true)
  })

  it('applies timeoutMs through the injected clock', async () => {
    const clock = new FakeClock()
    const http = new RecordingFetch([{ stall: true }])
    const pending = collect(streamChatCompletion(streamOptions(http, { clock, timeoutMs: 60_000 })))
    await waitFor(() => http.callCount === 1)
    clock.advance(60_000)
    const error = await failure(pending)
    expect((error as ModelError).code).toBe('timeout')
    expect(http.requests[0]?.signal?.aborted).toBe(true)
  })

  it('surfaces a non-2xx status with the provider body', async () => {
    const http = new RecordingFetch([{ status: 429, text: '{"error":{"message":"slow down"}}' }])
    const error = await failure(collect(streamChatCompletion(streamOptions(http))))
    expect(error).toBeInstanceOf(ModelError)
    expect((error as ModelError).code).toBe('http')
    expect((error as ModelError).status).toBe(429)
    expect((error as ModelError).detail).toContain('slow down')
  })

  it('reports a transport failure as a network error', async () => {
    const http = new RecordingFetch([{ error: new Error('connect ECONNREFUSED 127.0.0.1') }])
    const error = await failure(collect(streamChatCompletion(streamOptions(http))))
    expect((error as ModelError).code).toBe('network')
    expect(error.message).toContain('ECONNREFUSED')
  })
})

describe('FakeModelRunner', () => {
  it('plays a scripted turn and records the request', async () => {
    const plan = { pacing: 'hold', beats: [] }
    const runner = new FakeModelRunner({
      events: [
        { type: 'text', delta: '他' },
        { type: 'tool-call', call: { id: 'call_1', name: 'apply_plan', arguments: plan } },
        { type: 'text', delta: '不说话。' },
      ],
    })
    const order: string[] = []
    const result = await runner.run(request({
      onTextDelta: delta => order.push(`text:${delta}`),
      onToolCall: call => order.push(`tool:${call.name}`),
    }))
    expect(order).toEqual(['text:他', 'tool:apply_plan', 'text:不说话。'])
    expect(result.text).toBe('他不说话。')
    expect(result.toolCalls).toHaveLength(1)
    expect(result.finishReason).toBe('tool-calls')
    expect(runner.callCount).toBe(1)
    expect(runner.lastRequest.messages).toEqual([{ role: 'user', content: '继续' }])
  })

  it('serves queued turns in order and falls back to an empty turn', async () => {
    const runner = new FakeModelRunner([
      { events: [{ type: 'text', delta: '第一' }] },
      { events: [{ type: 'text', delta: '第二' }], finishReason: 'length' },
    ])
    expect((await runner.run(request())).text).toBe('第一')
    const second = await runner.run(request())
    expect(second.text).toBe('第二')
    expect(second.finishReason).toBe('length')
    const third = await runner.run(request())
    expect(third.text).toBe('')
    expect(third.finishReason).toBe('stop')
    expect(runner.callCount).toBe(3)
  })

  it('rejects a stalled turn when the signal fires', async () => {
    const runner = new FakeModelRunner({ events: [{ type: 'stall' }] })
    const controller = new AbortController()
    const pending = runner.run(request({ signal: controller.signal }))
    await waitFor(() => runner.callCount === 1)
    controller.abort()
    const error = await failure(pending)
    expect((error as ModelError).code).toBe('aborted')
  })

  it('replays scripted errors and timeouts', async () => {
    const boom = new Error('boom')
    const failing = new FakeModelRunner({ events: [{ type: 'error', error: boom }] })
    await expect(failing.run(request())).rejects.toBe(boom)
    const timingOut = new FakeModelRunner({ events: [{ type: 'timeout' }] })
    const error = await failure(timingOut.run(request()))
    expect((error as ModelError).code).toBe('timeout')
  })
})
