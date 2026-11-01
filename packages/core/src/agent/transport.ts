/**
 * Wire transport for OpenAI-style chat completions: JSON POST, SSE decoding,
 * streaming tool-call accumulation, and abort/timeout handling.
 *
 * The only IO entry point is the injected `FetchLike` from `ports/http.ts`
 * (§4.9). `globalThis.fetch` is structurally assignable to it, so the host
 * passes it unchanged; tests pass `stubFetch` or a recording stub, and never
 * touch the network.
 *
 * Two response shapes are accepted, because not every fixture (or edge proxy)
 * exposes a byte stream:
 *
 * 1. `body` as an async iterable of bytes/strings — a real SSE stream;
 * 2. `text()` or `json()` — the whole response at once, decoded as a single
 *    aggregate completion chunk (this is what `stubFetch` provides).
 *
 * A response that carries no `data:` fields at all is also treated as one
 * aggregate JSON chunk, so a proxy that ignores `stream: true` still works.
 *
 * @module
 */

import type { Clock } from '../ports/clock.ts'
import type { FetchLike, HttpResponseLike } from '../ports/http.ts'
import { ModelError } from './model.ts'
import type { ModelFinishReason, ModelTurnResult, ModelUsage, ToolCall, ToolDefinition } from './model.ts'

/**
 * Request members a chat POST needs on top of the GET-shaped `HttpRequestInit`.
 *
 * `FetchLike` is the declared network boundary, so the transport widens its
 * request/response *types* locally (a structural superset: anything satisfying
 * `FetchLike` is still accepted) while pointing out that only a real fetch
 * implementation can stream.
 */
interface ChatRequestInit {
  readonly method: 'POST'
  readonly headers: Readonly<Record<string, string>>
  readonly body: string
  readonly signal: AbortSignal
}

/** Runtime response shape; every member beyond `HttpResponseLike` is optional. */
interface ChatResponseLike extends HttpResponseLike {
  readonly body?: AsyncIterable<Uint8Array | string> | null
  readonly text?: () => Promise<string>
}

/** A `FetchLike` seen through the wider chat-completions lens. */
type ChatFetch = (url: string, init: ChatRequestInit) => Promise<ChatResponseLike>

/** Options for {@link streamChatCompletion}. */
export interface ChatStreamOptions {
  readonly fetch: FetchLike
  readonly clock: Clock
  readonly url: string
  readonly headers: Readonly<Record<string, string>>
  /** JSON request body; serialised by the transport. */
  readonly body: unknown
  /** Caller cancellation; forwarded to the request signal. */
  readonly signal: AbortSignal
  /** Total budget for connect + stream; `<= 0` disables the guard. */
  readonly timeoutMs: number
}

/**
 * Stream the decoded `data:` payloads of one chat completion.
 *
 * Each yielded string is the raw JSON payload of one chunk (or the whole
 * completion, for non-streaming responses). Transport-level failures surface as
 * {@link ModelError}:
 *
 * - `timeout` — the injected clock's budget elapsed;
 * - `aborted` — the caller's signal fired;
 * - `network` — the fetch itself rejected;
 * - `http` — non-2xx, with `status` and a truncated body in `detail`;
 * - `invalid-response` — the body could not be read.
 *
 * The returned async generator owns the request lifecycle: cancelling it (by
 * breaking out of `for await`) aborts the underlying request.
 */
export async function* streamChatCompletion(options: ChatStreamOptions): AsyncGenerator<string> {
  const { fetch, clock, url, signal, timeoutMs } = options
  if (signal.aborted) throw abortedError()

  const controller = new AbortController()
  let timedOut = false
  const timer = timeoutMs > 0
    ? clock.timeout(timeoutMs, () => {
        timedOut = true
        controller.abort()
      })
    : undefined
  // Reading the caller's flag rather than the abort reason keeps the code
  // independent of how (or whether) a host fills `AbortSignal.reason`.
  const forwardAbort = (): void => {
    controller.abort()
  }
  signal.addEventListener('abort', forwardAbort, { once: true })

  // A rejection that wins the race against a stalled fetch or a stalled stream.
  const abortRejection = new Promise<never>((_resolve, reject) => {
    controller.signal.addEventListener(
      'abort',
      () => {
        reject(timedOut ? timeoutError(timeoutMs) : abortedError())
      },
      { once: true },
    )
  })
  // The generator can finish before the abort fires; keep that rejection
  // observed so it never surfaces as an unhandled rejection.
  void abortRejection.catch(() => {})

  try {
    const response = await Promise.race([
      (fetch as unknown as ChatFetch)(url, {
        method: 'POST',
        headers: { ...options.headers },
        body: JSON.stringify(options.body),
        signal: controller.signal,
      }),
      abortRejection,
    ])
    if (!response.ok) {
      // An error body is small, but a broken proxy can stall it: keep the same
      // abort/timeout race as the happy path.
      const detail = await Promise.race([readResponseText(response), abortRejection])
      throw new ModelError(`chat completion request failed with HTTP ${response.status}`, {
        code: 'http',
        status: response.status,
        ...(detail === '' ? {} : { detail: snippet(detail) }),
      })
    }
    for await (const payload of decodeSseChunks(responseChunks(response), abortRejection)) {
      yield payload
    }
  } catch (error) {
    if (error instanceof ModelError) throw error
    if (timedOut) throw timeoutError(timeoutMs)
    if (controller.signal.aborted) throw abortedError()
    throw new ModelError(`chat completion request failed: ${describe(error)}`, { code: 'network', cause: error })
  } finally {
    timer?.cancel()
    signal.removeEventListener('abort', forwardAbort)
    // Tear the request down even when the consumer stopped early.
    if (!controller.signal.aborted) controller.abort()
  }
}

/** Read a response body as text, for error details and non-streaming replies. */
export async function readResponseText(response: HttpResponseLike): Promise<string> {
  const parts: string[] = []
  for await (const chunk of responseChunks(response)) parts.push(chunk)
  return parts.join('')
}

/**
 * Yield a response body as decoded strings.
 *
 * Prefers a real byte stream, then `text()`, then `json()`. The `json()` path is
 * how a table-driven `stubFetch` fixture reaches the gateway without a stream.
 */
async function* responseChunks(response: HttpResponseLike): AsyncGenerator<string> {
  const wide = response as ChatResponseLike
  const body = wide.body
  if (body !== undefined && body !== null && typeof body[Symbol.asyncIterator] === 'function') {
    const decoder = new TextDecoder()
    for await (const chunk of body) {
      if (typeof chunk === 'string') yield chunk
      else if (chunk instanceof Uint8Array) yield decoder.decode(chunk, { stream: true })
      else yield String(chunk)
    }
    const tail = decoder.decode()
    if (tail !== '') yield tail
    return
  }
  if (typeof wide.text === 'function') {
    yield await wide.text()
    return
  }
  if (typeof response.json === 'function') {
    yield JSON.stringify(await response.json())
    return
  }
  throw new ModelError('the HTTP response carried no readable body', { code: 'invalid-response' })
}

/**
 * Decode an SSE payload stream.
 *
 * Handles `data:` continuation lines, `event:`/`id:`/`retry:` fields, comment
 * lines starting with `:`, CRLF, `[DONE]`, and chunk boundaries in the middle of
 * a line. A body with no SSE fields at all is emitted as one aggregate payload.
 */
async function* decodeSseChunks(
  chunks: AsyncIterable<string>,
  abortRejection: Promise<never>,
): AsyncGenerator<string> {
  let buffer = ''
  let dataLines: string[] = []
  let plain = ''
  let sawSseField = false
  let emitted = 0
  const iterator = chunks[Symbol.asyncIterator]()

  /** Fold one line into the decoder state; returns a payload when one completes. */
  const handleLine = (rawLine: string): string | undefined => {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
    if (line === '') {
      if (dataLines.length === 0) return undefined
      const payload = dataLines.join('\n')
      dataLines = []
      return payload
    }
    if (line.startsWith(':')) {
      sawSseField = true
      return undefined
    }
    const colon = line.indexOf(':')
    const field = colon < 0 ? line : line.slice(0, colon)
    const rawValue = colon < 0 ? '' : line.slice(colon + 1)
    const value = rawValue.startsWith(' ') ? rawValue.slice(1) : rawValue
    switch (field) {
      case 'data':
        sawSseField = true
        dataLines.push(value)
        return undefined
      case 'event':
      case 'id':
      case 'retry':
        sawSseField = true
        return undefined
      default:
        // Not an SSE field: remember it for the whole-body fallback below.
        plain += `${line}\n`
        return undefined
    }
  }

  try {
    for (;;) {
      const next = await Promise.race([iterator.next(), abortRejection])
      if (next.done === true) break
      buffer += next.value
      for (;;) {
        const newline = buffer.indexOf('\n')
        if (newline < 0) break
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        const payload = handleLine(line)
        if (payload === undefined || payload.trim() === '') continue
        emitted += 1
        if (isDoneSentinel(payload)) return
        yield payload
      }
    }
    if (buffer !== '') {
      const payload = handleLine(buffer)
      if (payload !== undefined && payload.trim() !== '') {
        emitted += 1
        if (isDoneSentinel(payload)) return
        yield payload
      }
    }
    if (dataLines.length > 0) {
      const payload = dataLines.join('\n')
      if (payload.trim() !== '') {
        emitted += 1
        yield payload
      }
    }
    if (emitted === 0 && !sawSseField) {
      const aggregate = plain.trim()
      if (aggregate !== '') yield aggregate
    }
  } finally {
    // Stop reading the body when the consumer stops early (e.g. after [DONE]).
    // Do not await the close: a stalled stream may never settle, and the request
    // is already being torn down by the caller's abort.
    try {
      const closing = iterator.return?.(undefined)
      if (closing !== undefined) void Promise.resolve(closing).catch(() => {})
    } catch {
      /* the request is already being torn down */
    }
  }
}

function isDoneSentinel(payload: string): boolean {
  return payload.trim() === '[DONE]'
}

function abortedError(): ModelError {
  return new ModelError('the model request was aborted', { code: 'aborted' })
}

function timeoutError(timeoutMs: number): ModelError {
  return new ModelError(`the model request timed out after ${timeoutMs}ms`, { code: 'timeout' })
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Keep provider bodies short enough for a log line and an audit detail. */
function snippet(text: string, limit = 300): string {
  const trimmed = text.trim()
  return trimmed.length <= limit ? trimmed : `${trimmed.slice(0, limit)}…`
}

/** Options for {@link ChatCompletionAccumulator}. */
export interface ChatCompletionAccumulatorOptions {
  readonly tools?: readonly ToolDefinition[]
  readonly onTextDelta?: (delta: string) => void
  readonly onToolCall?: (call: ToolCall) => void
}

interface PendingToolCall {
  readonly index: number
  id: string
  name: string
  args: string
  emitted: boolean
}

/**
 * Fold decoded completion chunks into one {@link ModelTurnResult}.
 *
 * Handles the streaming delta shape (`choices[].delta`) and the non-streaming
 * aggregate shape (`choices[].message`) with the same code. A streamed tool call
 * is reported through `onToolCall` the instant its accumulated `arguments`
 * string parses as JSON, which is what lets the executor dispatch before the
 * text stream ends (§4.9). A call whose arguments never parse is still reported
 * at `finish()` with the raw string, so a tolerant planner can inspect it.
 */
export class ChatCompletionAccumulator {
  private readonly options: ChatCompletionAccumulatorOptions
  private readonly pending = new Map<number, PendingToolCall>()
  private readonly calls: ToolCall[] = []
  private readonly textParts: string[] = []
  private usage: ModelUsage | undefined
  private rawFinishReason: string | undefined
  private sawAnyChoice = false

  constructor(options: ChatCompletionAccumulatorOptions = {}) {
    this.options = options
  }

  /** Text accumulated so far. */
  get text(): string {
    return this.textParts.join('')
  }

  /** Completed tool calls, in the order they were reported. */
  get toolCalls(): readonly ToolCall[] {
    return this.calls
  }

  /** Whether any chunk carried a `choices` entry; `false` means the provider erred. */
  get sawChoice(): boolean {
    return this.sawAnyChoice
  }

  /**
   * Feed one chunk: a decoded JSON payload string or an already-parsed object.
   *
   * @throws ModelError `invalid-response` when the provider sent an error object
   *   or something that is not a completion chunk.
   */
  push(payload: string | unknown): void {
    const chunk = typeof payload === 'string' ? parseJson(payload) : payload
    if (!isRecord(chunk)) {
      throw new ModelError('the completion chunk was not a JSON object', { code: 'invalid-response' })
    }
    const providerError = chunk.error
    if (providerError !== undefined) {
      throw new ModelError(`the provider returned an error: ${describeProviderError(providerError)}`, {
        code: 'invalid-response',
        detail: snippet(describeProviderError(providerError)),
      })
    }
    const usageValue = chunk.usage
    if (isRecord(usageValue)) this.readUsage(usageValue)

    const choices = chunk.choices
    if (!Array.isArray(choices)) {
      // The final `stream_options.include_usage` chunk legally has only `usage`.
      if (isRecord(usageValue)) return
      throw new ModelError('the completion chunk had no choices array', { code: 'invalid-response' })
    }
    for (const choice of choices) {
      if (!isRecord(choice)) continue
      this.sawAnyChoice = true
      const delta = isRecord(choice.delta) ? choice.delta : isRecord(choice.message) ? choice.message : undefined
      if (delta !== undefined) this.readDelta(delta)
      const finish = choice.finish_reason
      if (typeof finish === 'string') this.rawFinishReason = finish
    }
    this.flushReady()
  }

  /** Flush any remaining tool call and return the finished turn result. */
  finish(): ModelTurnResult {
    for (const entry of this.pendingInOrder()) {
      if (entry.emitted || entry.name === '') continue
      this.emitCall(entry, parseArgumentsOrRaw(entry.args))
    }
    const toolCalls = [...this.calls]
    const text = this.text
    const finishReason = this.resolveFinishReason(toolCalls.length)
    return this.usage === undefined
      ? { text, toolCalls, finishReason }
      : { text, toolCalls, finishReason, usage: this.usage }
  }

  private readUsage(usage: Record<string, unknown>): void {
    const input = numberOrUndefined(usage.prompt_tokens ?? usage.input_tokens)
    const output = numberOrUndefined(usage.completion_tokens ?? usage.output_tokens)
    if (input === undefined || output === undefined) return
    this.usage = { inputTokens: input, outputTokens: output }
  }

  private readDelta(delta: Record<string, unknown>): void {
    const content = delta.content
    if (typeof content === 'string') {
      if (content !== '') this.appendText(content)
    } else if (Array.isArray(content)) {
      for (const part of content) {
        if (isRecord(part) && typeof part.text === 'string' && part.text !== '') this.appendText(part.text)
      }
    }
    const fragments = delta.tool_calls ?? delta.toolCalls
    if (!Array.isArray(fragments)) return
    for (let position = 0; position < fragments.length; position += 1) {
      const fragment = fragments[position]
      if (isRecord(fragment)) this.feedToolCall(fragment, position)
    }
  }

  private feedToolCall(fragment: Record<string, unknown>, position: number): void {
    const index = numberOrUndefined(fragment.index) ?? position
    let entry = this.pending.get(index)
    if (entry === undefined) {
      entry = { index, id: '', name: '', args: '', emitted: false }
      this.pending.set(index, entry)
    }
    if (typeof fragment.id === 'string' && fragment.id !== '' && entry.id === '') entry.id = fragment.id
    const fn = fragment.function
    if (!isRecord(fn)) return
    if (typeof fn.name === 'string' && fn.name !== '' && entry.name === '') entry.name = fn.name
    if (typeof fn.arguments === 'string') entry.args += fn.arguments
    else if (isRecord(fn.arguments)) entry.args = JSON.stringify(fn.arguments)
  }

  /** Report every pending call whose accumulated arguments already parse. */
  private flushReady(): void {
    for (const entry of this.pendingInOrder()) {
      if (entry.emitted || entry.name === '') continue
      const trimmed = entry.args.trim()
      if (trimmed === '') continue
      const parsed = tryParseJson(trimmed)
      if (parsed.ok) this.emitCall(entry, parsed.value)
    }
  }

  private pendingInOrder(): readonly PendingToolCall[] {
    return [...this.pending.values()].sort((a, b) => a.index - b.index)
  }

  private appendText(delta: string): void {
    this.textParts.push(delta)
    this.options.onTextDelta?.(delta)
  }

  private emitCall(entry: PendingToolCall, args: unknown): void {
    entry.emitted = true
    const call: ToolCall = {
      id: entry.id === '' ? `tool_${entry.index}` : entry.id,
      name: entry.name,
      arguments: args,
    }
    this.calls.push(call)
    this.options.onToolCall?.(call)
  }

  private resolveFinishReason(toolCallCount: number): ModelFinishReason {
    const raw = this.rawFinishReason
    switch (raw) {
      case 'length':
      case 'max_tokens':
        return 'length'
      case 'tool_calls':
      case 'tool-calls':
        return 'tool-calls'
      case 'timeout':
        return 'timeout'
      case 'content_filter':
      case 'error':
        return 'error'
      case undefined:
      case 'stop':
      case 'end_turn':
      case 'stop_sequence':
        return toolCallCount > 0 ? 'tool-calls' : 'stop'
      default:
        return toolCallCount > 0 ? 'tool-calls' : 'stop'
    }
  }
}

function parseArgumentsOrRaw(args: string): unknown {
  const trimmed = args.trim()
  if (trimmed === '') return {}
  const parsed = tryParseJson(trimmed)
  return parsed.ok ? parsed.value : args
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new ModelError('the completion chunk was not valid JSON', { code: 'invalid-response', detail: snippet(text) })
  }
}

function tryParseJson(text: string): { readonly ok: true; readonly value: unknown } | { readonly ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) as unknown }
  } catch {
    return { ok: false }
  }
}

function describeProviderError(value: unknown): string {
  if (isRecord(value)) {
    const message = value.message
    if (typeof message === 'string') return message
    const code = value.code ?? value.type
    if (typeof code === 'string') return code
  }
  return typeof value === 'string' ? value : JSON.stringify(value)
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
