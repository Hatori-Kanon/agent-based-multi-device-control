/**
 * Zero-dependency runner for OpenAI-compatible chat completions.
 *
 * This is the usable gateway before (and independent of) the optional Vercel AI
 * SDK adapter (B1-T3), which has to produce the same `ModelTurnResult` shape.
 * It implements the §4.9 contract:
 *
 * - one request per turn: tool calls become the plan, text becomes the line;
 * - streamed `tool_calls` fragments are accumulated into complete arguments;
 * - capability discovery is cached per provider+model, and a rejected mode
 *   falls back `tool_calls → response_format: json_schema → tolerant JSON text`;
 * - HTTP failures become readable {@link ModelError}s.
 *
 * Nothing here knows about a platform: fetch and clock are injected, and the
 * API key is resolved by the host. Known providers get a default base URL; any
 * other provider (Anthropic Messages, local gateways) must supply `baseUrl`.
 *
 * @module
 */

import type { Clock } from '../../ports/clock.ts'
import type { FetchLike } from '../../ports/http.ts'
import { apiKeyEnvOf, ModelError } from '../model.ts'
import type {
  LlmMessage,
  ModelConfig,
  ModelRunner,
  ModelTurnRequest,
  ModelTurnResult,
  ToolCall,
  ToolDefinition,
} from '../model.ts'
import { ChatCompletionAccumulator, streamChatCompletion } from '../transport.ts'

/**
 * Default chat-completions roots for providers that speak the OpenAI wire
 * format. Anthropic is deliberately absent: it has no OpenAI-compatible default
 * endpoint, so a proxy base URL must be configured explicitly.
 */
export const PROVIDER_CHAT_BASE_URLS: Readonly<Record<string, string>> = {
  deepseek: 'https://api.deepseek.com/v1',
  openai: 'https://api.openai.com/v1',
  google: 'https://generativelanguage.googleapis.com/v1beta/openai',
}

/** What a provider+model has been observed to support. */
export interface ModelCapabilities {
  readonly tools: boolean
  readonly jsonSchema: boolean
}

/** The optimistic starting point: a fresh provider is assumed capable. */
const ASSUMED_CAPABILITIES: ModelCapabilities = { tools: true, jsonSchema: true }

/**
 * Per-provider+model capability memory.
 *
 * Capability discovery costs no extra request: the first real turn is the
 * probe, and an endpoint that rejects tools/structured output downgrades the
 * entry so later turns skip the dead mode (§4.9). Sharing one cache between
 * runners lets a host reuse the discovery for the same provider+model.
 */
export class CapabilityCache {
  private readonly entries = new Map<string, ModelCapabilities>()

  /** Known capabilities, or the optimistic default when nothing was learned. */
  get(provider: string, model: string): ModelCapabilities {
    return this.entries.get(cacheKey(provider, model)) ?? ASSUMED_CAPABILITIES
  }

  /** Known capabilities, or `undefined` when the pair was never probed. */
  peek(provider: string, model: string): ModelCapabilities | undefined {
    return this.entries.get(cacheKey(provider, model))
  }

  /** Overwrite the entry for one pair. */
  set(provider: string, model: string, capabilities: ModelCapabilities): void {
    this.entries.set(cacheKey(provider, model), { ...capabilities })
  }

  /** Record that a provider rejected one wire mode. */
  markUnsupported(provider: string, model: string, capability: 'tools' | 'jsonSchema'): void {
    const current = this.get(provider, model)
    this.entries.set(
      cacheKey(provider, model),
      capability === 'tools' ? { ...current, tools: false } : { ...current, jsonSchema: false },
    )
  }

  /** Number of learned entries; useful for leak assertions in tests. */
  get size(): number {
    return this.entries.size
  }

  clear(): void {
    this.entries.clear()
  }
}

/** Options for {@link OpenAICompatibleRunner}. */
export interface OpenAICompatibleOptions {
  readonly config: ModelConfig
  /** The only network boundary; the host passes `globalThis.fetch`. */
  readonly fetch: FetchLike
  /** Timeout guard; injected so tests never wait on a real timer. */
  readonly clock: Clock
  /** Resolved API key; usually read from `config.apiKeyEnv` by the host. */
  readonly apiKey?: string
  /** Environment lookup used when `apiKey` is omitted (host passes `process.env`). */
  readonly env?: Readonly<Record<string, string | undefined>>
  /** Shared capability memory; defaults to a cache owned by this runner. */
  readonly capabilities?: CapabilityCache
  /** Extra headers merged after the built-ins (proxies, attribution). */
  readonly headers?: Readonly<Record<string, string>>
}

/** Which wire shape a single attempt uses. */
type WireMode = 'tools' | 'json-schema' | 'text' | 'plain'

/** Statuses that mean "this endpoint does not support this request shape". */
const CAPABILITY_REJECTION_STATUSES: ReadonlySet<number> = new Set([400, 404, 405, 415, 422, 501])

/**
 * `ModelRunner` over an OpenAI-compatible `/chat/completions` endpoint.
 *
 * ```ts
 * const runner = new OpenAICompatibleRunner({ config, fetch: globalThis.fetch, clock: systemClock, env: process.env })
 * const result = await runner.run({ messages, tools, timeoutMs: 60_000, signal, onToolCall })
 * ```
 */
export class OpenAICompatibleRunner implements ModelRunner {
  private readonly config: ModelConfig
  private readonly fetch: FetchLike
  private readonly clock: Clock
  private readonly cache: CapabilityCache
  private readonly chatUrl: string
  private readonly headers: Readonly<Record<string, string>>
  private readonly apiKey: string | undefined

  constructor(options: OpenAICompatibleOptions) {
    this.config = options.config
    this.fetch = options.fetch
    this.clock = options.clock
    this.cache = options.capabilities ?? new CapabilityCache()
    if (this.config.provider.trim() === '') {
      throw new ModelError('the model config has an empty provider', { code: 'config' })
    }
    if (this.config.model.trim() === '') {
      throw new ModelError(`the ${this.config.provider} model config has an empty model id`, { code: 'config' })
    }
    this.chatUrl = chatCompletionsUrl(this.config)
    const apiKey = options.apiKey !== undefined && options.apiKey.trim() !== ''
      ? options.apiKey.trim()
      : lookupEnv(options.env, apiKeyEnvOf(this.config))
    this.apiKey = apiKey
    this.headers = {
      'content-type': 'application/json',
      accept: 'text/event-stream',
      ...(apiKey === undefined ? {} : { authorization: `Bearer ${apiKey}` }),
      ...(options.headers ?? {}),
    }
  }

  /** Known capabilities for this runner's provider+model (cached, §4.9). */
  capabilities(): ModelCapabilities {
    return this.cache.get(this.config.provider, this.config.model)
  }

  async run(request: ModelTurnRequest): Promise<ModelTurnResult> {
    if (request.signal.aborted) {
      throw new ModelError('the model request was aborted before it started', { code: 'aborted' })
    }
    try {
      return await this.runWithFallback(request)
    } catch (error) {
      throw this.mapError(error)
    }
  }

  /**
   * Try the modes the endpoint is believed to support, in §4.9's order.
   *
   * A rejected mode downgrades the capability cache and falls through; every
   * other failure (auth, rate limit, timeout, network, bad response) is thrown
   * immediately, because re-asking in another shape would not help.
   */
  private async runWithFallback(request: ModelTurnRequest): Promise<ModelTurnResult> {
    // A writer-style call has no tools to fall back from: it is plain text.
    if (request.tools.length === 0) return await this.attempt('plain', request)

    let lastRejection: ModelError | undefined
    const modes: readonly WireMode[] = ['tools', 'json-schema', 'text']
    for (const mode of modes) {
      if (mode === 'tools' && !this.capabilities().tools) continue
      if (mode === 'json-schema' && !this.capabilities().jsonSchema) continue
      try {
        return await this.attempt(mode, request)
      } catch (error) {
        if (!isCapabilityRejection(error)) throw error
        if (mode === 'text') throw error
        if (mode === 'tools') this.cache.markUnsupported(this.config.provider, this.config.model, 'tools')
        else this.cache.markUnsupported(this.config.provider, this.config.model, 'jsonSchema')
        lastRejection = error
      }
    }
    throw lastRejection ?? new ModelError('the endpoint supports no usable response mode', { code: 'invalid-request' })
  }

  private async attempt(mode: WireMode, request: ModelTurnRequest): Promise<ModelTurnResult> {
    if (this.apiKey === undefined) {
      throw new ModelError(
        `no API key for ${this.config.provider}/${this.config.model}; set ${apiKeyEnvOf(this.config)} or pass apiKey`,
        { code: 'config' },
      )
    }
    // Text is streamed to the caller only when the model is actually writing
    // prose; in the structured fallback modes the raw bytes are a JSON envelope,
    // so the (humanized) line is emitted once after it is parsed.
    const streamText = mode === 'tools' || mode === 'plain'
    const accumulator = new ChatCompletionAccumulator({
      tools: request.tools,
      ...(streamText && request.onTextDelta !== undefined ? { onTextDelta: request.onTextDelta } : {}),
      ...(request.onToolCall === undefined ? {} : { onToolCall: request.onToolCall }),
    })
    const body = this.buildBody(mode, request)
    for await (const payload of streamChatCompletion({
      fetch: this.fetch,
      clock: this.clock,
      url: this.chatUrl,
      headers: this.headers,
      body,
      signal: request.signal,
      timeoutMs: request.timeoutMs,
    })) {
      accumulator.push(payload)
    }
    if (!accumulator.sawChoice) {
      throw new ModelError('the provider returned no completion choices', { code: 'invalid-response' })
    }
    const result = accumulator.finish()
    return streamText ? result : this.fromStructuredText(result, request)
  }

  private buildBody(mode: WireMode, request: ModelTurnRequest): Record<string, unknown> {
    const messages: Record<string, unknown>[] = request.messages.map(toWireMessage)
    if (mode === 'json-schema' || mode === 'text') {
      messages.push({ role: 'system', content: fallbackInstruction(request.tools) })
    }
    const body: Record<string, unknown> = {
      model: this.config.model,
      messages,
      stream: true,
      stream_options: { include_usage: true },
    }
    if (this.config.temperature !== undefined) body.temperature = this.config.temperature
    if (this.config.maxTokens !== undefined) body.max_tokens = this.config.maxTokens
    if (mode === 'tools') {
      body.tools = request.tools.map(toWireTool)
      body.tool_choice = 'auto'
    }
    if (mode === 'json-schema') {
      body.response_format = {
        type: 'json_schema',
        json_schema: {
          name: 'm2_turn',
          strict: false,
          schema: turnEnvelopeSchema(request.tools),
        },
      }
    }
    return body
  }

  /**
   * Turn a plain-text reply into the same shape a tool call would produce.
   *
   * The fallback prompt asks for `{"tool": "...", "arguments": {...}, "line": "..."}`.
   * Tolerant variants are accepted: a bare plan object is treated as the first
   * tool's arguments, and prose around the JSON becomes the line when no `line`
   * field is present.
   */
  private fromStructuredText(result: ModelTurnResult, request: ModelTurnRequest): ModelTurnResult {
    if (result.toolCalls.length > 0) {
      if (result.text !== '') request.onTextDelta?.(result.text)
      return result
    }
    const parsed = extractJsonObject(result.text)
    if (!isRecord(parsed)) {
      if (result.text !== '') request.onTextDelta?.(result.text)
      return result
    }
    const toolNames = new Set(request.tools.map(tool => tool.name))
    const requested = typeof parsed.tool === 'string' ? parsed.tool : undefined
    const name = requested !== undefined && toolNames.has(requested) ? requested : request.tools[0]?.name
    const envelope = parsed.arguments ?? parsed.plan
    const remainder = omitKeys(parsed, ['tool', 'arguments', 'plan', 'line'])
    const args = envelope ?? (Object.keys(remainder).length > 0 ? remainder : undefined)
    const line = typeof parsed.line === 'string' ? parsed.line : textWithoutJson(result.text)
    const toolCalls: ToolCall[] = []
    if (name !== undefined && args !== undefined) {
      const call: ToolCall = { id: `fallback_${toolCalls.length + 1}`, name, arguments: args }
      request.onToolCall?.(call)
      toolCalls.push(call)
    }
    if (line !== '') request.onTextDelta?.(line)
    return {
      text: line,
      toolCalls,
      finishReason: toolCalls.length > 0
        ? 'tool-calls'
        : result.finishReason === 'length' ? 'length' : 'stop',
      ...(result.usage === undefined ? {} : { usage: result.usage }),
    }
  }

  /** Turn transport/HTTP failures into readable, branchable errors. */
  private mapError(error: unknown): ModelError {
    const prefix = `[${this.config.provider}/${this.config.model}] `
    if (!(error instanceof ModelError)) {
      return new ModelError(`${prefix}chat completion failed: ${describe(error)}`, { code: 'network', cause: error })
    }
    if (error.code !== 'http' || error.status === undefined) return error
    const status = error.status
    const detail = error.detail === undefined ? '' : `: ${error.detail}`
    const detailOption = error.detail === undefined ? {} : { detail: error.detail }
    if (status === 401 || status === 403) {
      return new ModelError(
        `${prefix}authentication failed (HTTP ${status}); check the API key in ${apiKeyEnvOf(this.config)}`,
        { code: 'auth', status, ...detailOption },
      )
    }
    if (status === 429) {
      return new ModelError(`${prefix}rate limited (HTTP 429); back off before retrying`, {
        code: 'rate-limit',
        status,
        retryable: true,
        ...detailOption,
      })
    }
    if (status >= 500) {
      return new ModelError(`${prefix}provider error (HTTP ${status})${detail}`, {
        code: 'server',
        status,
        retryable: true,
        ...detailOption,
      })
    }
    if (status === 404) {
      return new ModelError(`${prefix}endpoint not found (HTTP 404); check the configured baseUrl`, {
        code: 'invalid-request',
        status,
        ...detailOption,
      })
    }
    return new ModelError(`${prefix}request rejected (HTTP ${status})${detail}`, {
      code: 'invalid-request',
      status,
      ...detailOption,
    })
  }
}

/**
 * Tolerant "find a JSON object in this text" helper.
 *
 * Accepts a whole-JSON reply, a fenced ```json block, or the first balanced
 * object embedded in prose. Returns `undefined` when nothing parses. Exported
 * because the fallback chain's third level is specified as "纯文本 JSON + 容错解析"
 * and other M2 modules may reuse it.
 */
export function extractJsonObject(text: string): unknown {
  const trimmed = text.trim()
  if (trimmed === '') return undefined
  const direct = tryParseJson(trimmed)
  if (direct.ok) return direct.value
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)
  if (fenced !== null) {
    const inner = fenced[1]
    if (inner !== undefined) {
      const parsed = tryParseJson(inner.trim())
      if (parsed.ok) return parsed.value
    }
  }
  const range = findJsonRange(text)
  if (range === undefined) return undefined
  const parsed = tryParseJson(text.slice(range.start, range.end))
  return parsed.ok ? parsed.value : undefined
}

function chatCompletionsUrl(config: ModelConfig): string {
  const base = config.baseUrl ?? PROVIDER_CHAT_BASE_URLS[config.provider]
  if (base === undefined || base.trim() === '') {
    throw new ModelError(
      `provider "${config.provider}" has no OpenAI-compatible default endpoint; set baseUrl in the model config`,
      { code: 'config' },
    )
  }
  const trimmed = base.trim().replace(/\/+$/, '')
  return trimmed.endsWith('/chat/completions') ? trimmed : `${trimmed}/chat/completions`
}

function lookupEnv(env: Readonly<Record<string, string | undefined>> | undefined, name: string): string | undefined {
  const value = env?.[name]
  return value !== undefined && value.trim() !== '' ? value.trim() : undefined
}

function cacheKey(provider: string, model: string): string {
  return `${provider}\u0000${model}`
}

function isCapabilityRejection(error: unknown): error is ModelError {
  if (!(error instanceof ModelError)
    || error.code !== 'http'
    || error.status === undefined
    || !CAPABILITY_REJECTION_STATUSES.has(error.status)) return false
  // A thinking-mode conversation-state error (e.g. DeepSeek demanding the
  // previous assistant's `reasoning_content`) says nothing about whether the
  // endpoint supports tools. Treating it as a capability rejection permanently
  // disables tools for this process and silently degrades every later turn
  // into raw-JSON text fallback.
  const detail = error.detail ?? ''
  return !/reasoning_content|thinking mode/iu.test(detail)
}

/** Map one provider-neutral message onto the Chat Completions wire shape. */
function toWireMessage(message: LlmMessage): Record<string, unknown> {
  if (message.role === 'tool') {
    return {
      role: 'tool',
      tool_call_id: message.toolCallId ?? '',
      content: message.content,
    }
  }
  if (message.imageBase64 !== undefined && message.role === 'user') {
    return {
      role: 'user',
      content: [
        { type: 'text', text: message.content },
        { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${message.imageBase64}` } },
      ],
    }
  }
  return { role: message.role, content: message.content }
}

function toWireTool(tool: ToolDefinition): Record<string, unknown> {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }
}

/** The JSON schema offered at `response_format` level for the plan envelope. */
function turnEnvelopeSchema(tools: readonly ToolDefinition[]): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      tool: { type: 'string', enum: tools.map(tool => tool.name) },
      arguments: { type: 'object' },
      line: { type: 'string' },
    },
    required: ['arguments'],
  }
}

/** Instruction appended as a system message for the two fallback modes. */
function fallbackInstruction(tools: readonly ToolDefinition[]): string {
  const names = tools.map(tool => tool.name).join(' | ')
  const defaultName = tools[0]?.name ?? ''
  return `本端点不支持工具调用。只输出一个 JSON 对象，不要输出其它文字：`
    + `{"tool":"${names}","arguments":{...},"line":"给玩家看的台词"}。`
    + `tool 省略时默认使用 ${defaultName}。`
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

type ParseResult = { readonly ok: true; readonly value: unknown } | { readonly ok: false }

function tryParseJson(text: string): ParseResult {
  try {
    return { ok: true, value: JSON.parse(text) as unknown }
  } catch {
    return { ok: false }
  }
}

/** First balanced `{...}` substring that parses as JSON, in document order. */
function findJsonRange(text: string): { readonly start: number; readonly end: number } | undefined {
  for (let start = text.indexOf('{'); start >= 0; start = text.indexOf('{', start + 1)) {
    const end = balancedObjectEnd(text, start)
    if (end === undefined) continue
    if (tryParseJson(text.slice(start, end)).ok) return { start, end }
  }
  return undefined
}

function balancedObjectEnd(text: string, start: number): number | undefined {
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = start; index < text.length; index += 1) {
    const char = text[index]
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') {
      inString = true
    } else if (char === '{') {
      depth += 1
    } else if (char === '}') {
      depth -= 1
      if (depth === 0) return index + 1
    }
  }
  return undefined
}

/** Text with the extracted JSON (and any code fence) removed. */
function textWithoutJson(text: string): string {
  let stripped = text.replace(/```(?:json)?\s*[\s\S]*?```/gi, '')
  const range = findJsonRange(stripped)
  if (range !== undefined) stripped = `${stripped.slice(0, range.start)}${stripped.slice(range.end)}`
  return stripped.trim()
}

function omitKeys(source: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(source)) {
    if (!keys.includes(key)) result[key] = value
  }
  return result
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
