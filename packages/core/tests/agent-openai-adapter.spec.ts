import { describe, expect, it } from 'vitest'
import { FakeClock } from '../src/ports/fake-clock.ts'
import { ModelError } from '../src/agent/model.ts'
import type { ModelConfig, ModelTurnRequest, ToolCall, ToolDefinition } from '../src/agent/model.ts'
import { CapabilityCache, OpenAICompatibleRunner } from '../src/agent/adapters/openai-compatible.ts'
import type { FakeHttpReply, RecordedRequest } from './fakes/fake-model-runner.ts'
import { RecordingFetch } from './fakes/fake-model-runner.ts'

/** The plan every fallback test keeps re-discovering. */
const PLAN = {
  pacing: 'build',
  beats: [{ id: 'b1', intentId: 'probe-touch', regions: ['chest'], strength: 'med' }],
}

const APPLY_PLAN: ToolDefinition = {
  name: 'apply_plan',
  description: '本回合的动作计划',
  parameters: {
    type: 'object',
    required: ['pacing', 'beats'],
    properties: {
      pacing: { enum: ['hold', 'build', 'release', 'probe'] },
      beats: { type: 'array' },
    },
  },
}

function modelConfig(overrides: Partial<ModelConfig> = {}): ModelConfig {
  return { provider: 'deepseek', model: 'deepseek-chat', temperature: 0.8, maxTokens: 2000, ...overrides }
}

function request(overrides: Partial<ModelTurnRequest> = {}): ModelTurnRequest {
  return {
    messages: [{ role: 'system', content: '你是主持' }, { role: 'user', content: '继续' }],
    tools: [APPLY_PLAN],
    timeoutMs: 60_000,
    signal: new AbortController().signal,
    ...overrides,
  }
}

/** One streamed completion chunk, as a provider would send it. */
function chunk(delta: Record<string, unknown>, finishReason: string | null = null): Record<string, unknown> {
  return { choices: [{ index: 0, delta, finish_reason: finishReason }] }
}

/** A non-streaming completion whose assistant message is `content`. */
function messageReply(content: string, finishReason = 'stop'): FakeHttpReply {
  return {
    json: {
      choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: finishReason }],
    },
  }
}

/** A 4xx reply; 400-family statuses trigger the capability fallback chain. */
function rejectedReply(status = 400, message = 'this endpoint does not support the requested mode'): FakeHttpReply {
  return { status, json: { error: { message } } }
}

interface HarnessOptions {
  readonly replies: readonly FakeHttpReply[] | ((request: RecordedRequest, index: number) => FakeHttpReply)
  readonly config?: Partial<ModelConfig>
  readonly capabilities?: CapabilityCache
  readonly env?: Readonly<Record<string, string | undefined>>
  readonly apiKey?: string
  readonly clock?: FakeClock
}

function harness(options: HarnessOptions) {
  const clock = options.clock ?? new FakeClock()
  const http = new RecordingFetch(options.replies)
  const capabilities = options.capabilities ?? new CapabilityCache()
  const config = modelConfig(options.config ?? {})
  const runner = new OpenAICompatibleRunner({
    config,
    fetch: http.fetch,
    clock,
    capabilities,
    apiKey: options.apiKey ?? 'test-key',
    ...(options.env === undefined ? {} : { env: options.env }),
  })
  return { runner, http, clock, capabilities, config }
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

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : {}
}

describe('OpenAICompatibleRunner', () => {
  it('accumulates streamed tool_call fragments into one plan argument', async () => {
    const order: string[] = []
    const { runner, http } = harness({
      replies: [{
        sse: [
          chunk({ role: 'assistant', content: '他轻轻' }),
          // The arguments arrive in two fragments, split mid-JSON.
          chunk({ tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'apply_plan', arguments: '{"pacing":"build","beats":[{"id":"b1",' } }] }),
          chunk({ tool_calls: [{ index: 0, function: { arguments: '"intentId":"probe-touch","regions":["chest"],"strength":"med"}]}' } }] }),
          chunk({ content: '，靠近你。' }),
          chunk({}, 'tool_calls'),
        ],
      }],
    })
    const result = await runner.run(request({
      onTextDelta: delta => order.push(`text:${delta}`),
      onToolCall: call => order.push(`tool:${call.name}`),
    }))

    expect(order).toEqual(['text:他轻轻', 'tool:apply_plan', 'text:，靠近你。'])
    expect(result.text).toBe('他轻轻，靠近你。')
    expect(result.toolCalls).toHaveLength(1)
    expect(result.toolCalls[0]?.id).toBe('call_1')
    expect(result.toolCalls[0]?.arguments).toEqual(PLAN)
    expect(result.finishReason).toBe('tool-calls')

    // The wire request carries the tool definitions in OpenAI function shape.
    expect(http.requests[0]?.url).toBe('https://api.deepseek.com/v1/chat/completions')
    expect(http.requests[0]?.headers?.authorization).toBe('Bearer test-key')
    const body = http.bodyAt(0)
    expect(body.model).toBe('deepseek-chat')
    expect(body.stream).toBe(true)
    expect(body.temperature).toBe(0.8)
    expect(body.max_tokens).toBe(2000)
    expect(body.tool_choice).toBe('auto')
    expect(body.tools).toEqual([
      { type: 'function', function: { name: 'apply_plan', description: APPLY_PLAN.description, parameters: APPLY_PLAN.parameters } },
    ])
  })

  it('falls back to json_schema when the endpoint rejects tools', async () => {
    const envelope = { tool: 'apply_plan', arguments: PLAN, line: '他靠近你。' }
    const { runner, http } = harness({
      replies: [rejectedReply(400, 'tools are not supported by this model'), messageReply(JSON.stringify(envelope))],
    })
    const calls: ToolCall[] = []
    const deltas: string[] = []
    const result = await runner.run(request({
      onToolCall: call => calls.push(call),
      onTextDelta: delta => deltas.push(delta),
    }))

    expect(http.callCount).toBe(2)
    expect(http.bodyAt(0).tools).toBeDefined()
    const fallbackBody = http.bodyAt(1)
    expect(fallbackBody.tools).toBeUndefined()
    expect(asRecord(fallbackBody.response_format).type).toBe('json_schema')
    expect(calls).toHaveLength(1)
    expect(calls[0]?.name).toBe('apply_plan')
    expect(calls[0]?.arguments).toEqual(PLAN)
    expect(result.text).toBe('他靠近你。')
    expect(result.finishReason).toBe('tool-calls')
    // The buffered fallback text is emitted once, as the humanized line.
    expect(deltas).toEqual(['他靠近你。'])
    expect(runner.capabilities()).toEqual({ tools: false, jsonSchema: true })
    // The fallback prompt rides along as an extra system message.
    expect((fallbackBody.messages as unknown[]).length).toBe(3)
  })

  it('caches a capability probe per provider and model', async () => {
    const capabilities = new CapabilityCache()
    const envelope = { tool: 'apply_plan', arguments: PLAN, line: '好。' }
    const first = harness({
      capabilities,
      replies: [rejectedReply(400, 'tools unsupported'), messageReply(JSON.stringify(envelope))],
    })
    await first.runner.run(request())
    expect(first.runner.capabilities().tools).toBe(false)
    expect(capabilities.size).toBe(1)

    // Same provider+model on another runner sharing the cache: one request,
    // and it no longer wastes a round trip on tools.
    const second = harness({ capabilities, replies: [messageReply(JSON.stringify(envelope))] })
    await second.runner.run(request())
    expect(second.http.callCount).toBe(1)
    expect(second.http.bodyAt(0).tools).toBeUndefined()

    // A different model is a different entry: it is probed optimistically.
    const third = harness({
      capabilities,
      config: { model: 'deepseek-reasoner' },
      replies: [rejectedReply(400), messageReply(JSON.stringify(envelope))],
    })
    await third.runner.run(request())
    expect(third.http.callCount).toBe(2)
    expect(third.http.bodyAt(0).tools).toBeDefined()

    // So is a different provider.
    const fourth = harness({
      capabilities,
      config: { provider: 'openai', model: 'deepseek-chat' },
      replies: [rejectedReply(400), messageReply(JSON.stringify(envelope))],
    })
    await fourth.runner.run(request())
    expect(fourth.http.callCount).toBe(2)
    expect(fourth.http.bodyAt(0).tools).toBeDefined()
    expect(capabilities.size).toBe(3)
  })

  it('maps messages, images and tool results onto the wire format', async () => {
    const { runner, http } = harness({ replies: [messageReply('好。')] })
    await runner.run(request({
      tools: [],
      messages: [
        { role: 'system', content: '你是主持' },
        { role: 'user', content: '看这张', imageBase64: 'AAAA' },
        { role: 'assistant', content: '让我看看' },
        { role: 'tool', content: '{"quality":"good"}', toolCallId: 'call_9' },
      ],
    }))
    expect(http.callCount).toBe(1)
    expect(http.bodyAt(0).messages).toEqual([
      { role: 'system', content: '你是主持' },
      {
        role: 'user',
        content: [
          { type: 'text', text: '看这张' },
          { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AAAA' } },
        ],
      },
      { role: 'assistant', content: '让我看看' },
      { role: 'tool', tool_call_id: 'call_9', content: '{"quality":"good"}' },
    ])
  })

  it('streams the line for a plain call without tools', async () => {
    const { runner, http } = harness({
      replies: [{ sse: [chunk({ content: '他' }), chunk({ content: '靠近' })] }],
    })
    const deltas: string[] = []
    const result = await runner.run(request({ tools: [], onTextDelta: delta => deltas.push(delta) }))
    expect(deltas).toEqual(['他', '靠近'])
    expect(result.text).toBe('他靠近')
    expect(result.toolCalls).toEqual([])
    expect(result.finishReason).toBe('stop')
    const body = http.bodyAt(0)
    expect(body.tools).toBeUndefined()
    expect(body.response_format).toBeUndefined()
    // No fallback instruction for a plain call.
    expect((body.messages as unknown[]).length).toBe(2)
  })

  it('falls back to tolerant text parsing when json_schema is rejected', async () => {
    const prose = '他停顿了一下。\n```json\n{"pacing":"build","beats":[{"id":"b1","intentId":"probe-touch","regions":["chest"],"strength":"med"}]}\n```'
    const { runner, http } = harness({
      replies: [rejectedReply(400, 'no tools'), rejectedReply(422, 'response_format unsupported'), messageReply(prose)],
    })
    const calls: ToolCall[] = []
    const result = await runner.run(request({ onToolCall: call => calls.push(call) }))

    expect(http.callCount).toBe(3)
    const textBody = http.bodyAt(2)
    expect(textBody.tools).toBeUndefined()
    expect(textBody.response_format).toBeUndefined()
    expect(calls).toHaveLength(1)
    expect(calls[0]?.name).toBe('apply_plan')
    expect(calls[0]?.arguments).toEqual(PLAN)
    expect(result.text).toBe('他停顿了一下。')
    expect(result.finishReason).toBe('tool-calls')
    expect(runner.capabilities()).toEqual({ tools: false, jsonSchema: false })
  })

  it('returns a narrative-only result when the fallback text has no json', async () => {
    const { runner } = harness({
      replies: [rejectedReply(400), rejectedReply(422), messageReply('他只是看着你，没有动。')],
    })
    const deltas: string[] = []
    const result = await runner.run(request({ onTextDelta: delta => deltas.push(delta) }))
    expect(result.toolCalls).toEqual([])
    expect(result.text).toBe('他只是看着你，没有动。')
    expect(result.finishReason).toBe('stop')
    expect(deltas).toEqual(['他只是看着你，没有动。'])
  })

  it('maps 429 to a retryable rate-limit error without downgrading capabilities', async () => {
    const { runner, http } = harness({ replies: [rejectedReply(429, 'slow down')] })
    const error = await failure(runner.run(request()))
    expect(error).toBeInstanceOf(ModelError)
    expect((error as ModelError).code).toBe('rate-limit')
    expect((error as ModelError).status).toBe(429)
    expect((error as ModelError).retryable).toBe(true)
    expect(error.message).toContain('deepseek/deepseek-chat')
    expect(http.callCount).toBe(1)
    expect(runner.capabilities().tools).toBe(true)
  })

  it('maps 401 to a non-retryable auth error', async () => {
    const { runner } = harness({ replies: [rejectedReply(401, 'invalid api key')] })
    const error = await failure(runner.run(request()))
    expect((error as ModelError).code).toBe('auth')
    expect((error as ModelError).retryable).toBe(false)
    expect(error.message).toContain('EMBODIED_LLM_API_KEY')
  })

  it('maps a 5xx to a retryable server error', async () => {
    const { runner } = harness({ replies: [rejectedReply(503, 'upstream down')] })
    const error = await failure(runner.run(request()))
    expect((error as ModelError).code).toBe('server')
    expect((error as ModelError).retryable).toBe(true)
    expect((error as ModelError).status).toBe(503)
  })

  it('reports a readable error when the provider sends an error object', async () => {
    const { runner } = harness({ replies: [{ json: { error: { message: 'model is overloaded', code: 'overloaded' } } }] })
    const error = await failure(runner.run(request()))
    expect(error).toBeInstanceOf(ModelError)
    expect((error as ModelError).code).toBe('invalid-response')
    expect(error.message).toContain('model is overloaded')
  })

  it('reports a config error when no api key is available', async () => {
    const http = new RecordingFetch([{ json: {} }])
    const runner = new OpenAICompatibleRunner({
      config: modelConfig(),
      fetch: http.fetch,
      clock: new FakeClock(),
      env: {},
    })
    const error = await failure(runner.run(request()))
    expect((error as ModelError).code).toBe('config')
    expect(error.message).toContain('EMBODIED_LLM_API_KEY')
    expect(http.callCount).toBe(0)
  })

  it('reads the api key from the injected environment variable', async () => {
    const { runner, http } = harness({
      replies: [messageReply('好。')],
      config: { apiKeyEnv: 'MY_LLM_KEY' },
      env: { MY_LLM_KEY: 'env-secret' },
      apiKey: '',
    })
    await runner.run(request({ tools: [] }))
    expect(http.requests[0]?.headers?.authorization).toBe('Bearer env-secret')
  })

  it('requires a baseUrl for a provider without an OpenAI-compatible default', () => {
    expect(() => new OpenAICompatibleRunner({
      config: modelConfig({ provider: 'anthropic', model: 'claude-x' }),
      fetch: new RecordingFetch([{ json: {} }]).fetch,
      clock: new FakeClock(),
      apiKey: 'k',
    })).toThrowError(ModelError)
  })

  it('builds the chat completions url from the configured base url', async () => {
    const custom = harness({ replies: [messageReply('好。')], config: { baseUrl: 'https://proxy.test/v1/' } })
    await custom.runner.run(request({ tools: [] }))
    expect(custom.http.requests[0]?.url).toBe('https://proxy.test/v1/chat/completions')

    const full = harness({ replies: [messageReply('好。')], config: { baseUrl: 'https://proxy.test/v1/chat/completions' } })
    await full.runner.run(request({ tools: [] }))
    expect(full.http.requests[0]?.url).toBe('https://proxy.test/v1/chat/completions')
  })

  it('merges extra headers after the built-ins', async () => {
    const http = new RecordingFetch([messageReply('好。')])
    const runner = new OpenAICompatibleRunner({
      config: modelConfig(),
      fetch: http.fetch,
      clock: new FakeClock(),
      apiKey: 'k',
      headers: { 'x-title': 'embodied-roleplay' },
    })
    await runner.run(request({ tools: [] }))
    expect(http.requests[0]?.headers).toMatchObject({
      'content-type': 'application/json',
      authorization: 'Bearer k',
      'x-title': 'embodied-roleplay',
    })
  })

  it('honors a pre-aborted signal without calling the provider', async () => {
    const { runner, http } = harness({ replies: [messageReply('好。')] })
    const controller = new AbortController()
    controller.abort()
    const error = await failure(runner.run(request({ signal: controller.signal })))
    expect((error as ModelError).code).toBe('aborted')
    expect(http.callCount).toBe(0)
  })
})

describe('sse tail handling (R7)', () => {
  it('does not treat a trailing [DONE] sentinel as a completion chunk', async () => {
    const { runner } = harness({
      replies: [{
        chunks: [
          `data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: 'assistant', content: '他靠近。' } }] })}\n\n`,
          // EOF right after the sentinel: no trailing blank line, so the tail
          // path (not the blank-line dispatch) sees `data: [DONE]`.
          'data: [DONE]',
        ],
      }],
    })
    const result = await runner.run(request({ tools: [] }))
    expect(result.text).toBe('他靠近。')
    expect(result.toolCalls).toEqual([])
    expect(result.finishReason).toBe('stop')
  })
})
