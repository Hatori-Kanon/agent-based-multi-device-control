/**
 * Test doubles for the M2 model gateway.
 *
 * - {@link FakeModelRunner} is the runner every test injects instead of a real
 *   provider (§4.9: "测试永不联网"). It plays a programmable script of text
 *   deltas, tool calls, errors, stalls and timeouts, and records every request
 *   it received. B2 and the end-to-end acceptance reuse it, so its surface is
 *   deliberately small and stable.
 * - {@link RecordingFetch} is a `FetchLike` fed from a table of fixtures: JSON
 *   bodies, raw SSE chunks, whole text bodies, network errors and stalled
 *   streams. It records the request URL/headers/body and signal.
 *
 * Both are test-only: nothing under `src/` imports this file.
 *
 * @module
 */

import { ModelError } from '../../src/agent/model.ts'
import type {
  ModelRunner,
  ModelTurnRequest,
  ModelTurnResult,
  ToolCall,
  ModelUsage,
} from '../../src/agent/model.ts'
import type { FetchLike, HttpRequestInit, HttpResponseLike } from '../../src/ports/http.ts'

/** One event of a scripted turn. */
export type FakeTurnEvent =
  /** Emit a text delta through `onTextDelta`. */
  | { readonly type: 'text'; readonly delta: string }
  /** Report a completed tool call through `onToolCall`. */
  | { readonly type: 'tool-call'; readonly call: ToolCall }
  /** Reject the turn with a specific error. */
  | { readonly type: 'error'; readonly error: Error }
  /** Reject with `ModelError('timeout')`, as a real timeout would. */
  | { readonly type: 'timeout' }
  /** Hang until the request signal fires, then reject with `ModelError('aborted')`. */
  | { readonly type: 'stall' }

/** One scripted turn. */
export interface FakeTurn {
  readonly events?: readonly FakeTurnEvent[]
  readonly finishReason?: ModelTurnResult['finishReason']
  readonly usage?: ModelUsage
}

/** Convenience builder: a {@link ToolCall} with the usual id default. */
export function toolCall(name: string, args: unknown, id = 'call_1'): ToolCall {
  return { id, name, arguments: args }
}

/** Wait for `signal` to fire, then reject with an aborted {@link ModelError}. */
function waitForAbort(signal: AbortSignal): Promise<never> {
  return new Promise<never>((_resolve, reject) => {
    if (signal.aborted) {
      reject(abortedError())
      return
    }
    signal.addEventListener('abort', () => { reject(abortedError()) }, { once: true })
  })
}

function abortedError(): ModelError {
  return new ModelError('the model request was aborted', { code: 'aborted' })
}

/**
 * A scripted {@link ModelRunner}.
 *
 * ```ts
 * const runner = new FakeModelRunner([
 *   { events: [{ type: 'text', delta: '他轻轻' }, { type: 'tool-call', call: plan }, { type: 'text', delta: '靠近。' }] },
 *   { events: [{ type: 'error', error: new Error('boom') }] },
 * ])
 * ```
 *
 * Turns are served in order; when the queue is empty {@link fallbackTurn} (an
 * empty `stop` turn) is served. Every request is pushed onto {@link requests},
 * which doubles as a call counter.
 */
export class FakeModelRunner implements ModelRunner {
  /** Every request received, in call order. */
  readonly requests: ModelTurnRequest[] = []
  /** Turn served after the queue empties. */
  fallbackTurn: FakeTurn = { events: [] }
  private queue: FakeTurn[] = []

  /** @param turns - Scripted turns, or one turn. */
  constructor(turns: FakeTurn | readonly FakeTurn[] = []) {
    if (Array.isArray(turns)) {
      for (const turn of turns) this.queue.push(turn as FakeTurn)
    } else {
      this.queue.push(turns as FakeTurn)
    }
  }

  /** Number of `run` calls so far. */
  get callCount(): number {
    return this.requests.length
  }

  /** Append turns to the script. */
  push(...turns: readonly FakeTurn[]): this {
    for (const turn of turns) this.queue.push(turn)
    return this
  }

  /** Replace the queued turns (does not clear {@link requests}). */
  reset(...turns: readonly FakeTurn[]): this {
    this.queue = [...turns]
    return this
  }

  /** The last request received; throws when none was made. */
  get lastRequest(): ModelTurnRequest {
    const request = this.requests[this.requests.length - 1]
    if (request === undefined) throw new Error('FakeModelRunner never ran')
    return request
  }

  async run(request: ModelTurnRequest): Promise<ModelTurnResult> {
    this.requests.push(request)
    const turn = this.queue.shift() ?? this.fallbackTurn
    const textParts: string[] = []
    const calls: ToolCall[] = []
    for (const event of turn.events ?? []) {
      if (request.signal.aborted) throw abortedError()
      switch (event.type) {
        case 'text':
          textParts.push(event.delta)
          request.onTextDelta?.(event.delta)
          break
        case 'tool-call':
          calls.push(event.call)
          request.onToolCall?.(event.call)
          break
        case 'error':
          throw event.error
        case 'timeout':
          throw new ModelError('the model request timed out', { code: 'timeout' })
        case 'stall':
          await waitForAbort(request.signal)
          break
      }
      // Yield a microtask between events so a test can abort mid-turn.
      await Promise.resolve()
    }
    const text = textParts.join('')
    const finishReason = turn.finishReason ?? (calls.length > 0 ? 'tool-calls' : 'stop')
    return turn.usage === undefined
      ? { text, toolCalls: calls, finishReason }
      : { text, toolCalls: calls, finishReason, usage: turn.usage }
  }
}

/** One fixture response for {@link RecordingFetch}. */
export type FakeHttpReply =
  /** `json()` answers with this body; the default 200 status makes it a success. */
  | { readonly json: unknown; readonly status?: number }
  /** Whole-body `text()` response (an error body or a non-streaming payload). */
  | { readonly text: string; readonly status?: number }
  /** Streaming SSE reply: one `data: <json>` event per payload. */
  | { readonly sse: readonly unknown[]; readonly status?: number }
  /** Streaming SSE reply from raw chunks, so a test can split JSON mid-line. */
  | { readonly chunks: readonly string[]; readonly status?: number }
  /** Body that never yields, to exercise abort and timeout handling. */
  | { readonly stall: true; readonly status?: number }
  /** `fetch` rejects with this error (a network failure). */
  | { readonly error: Error }

/** One request seen by {@link RecordingFetch}. */
export interface RecordedRequest {
  readonly url: string
  readonly method: string | undefined
  readonly headers: Readonly<Record<string, string>> | undefined
  /** The JSON body exactly as sent. */
  readonly rawBody: string | undefined
  /** `rawBody` parsed, when it is JSON. */
  readonly body: unknown
  readonly signal: AbortSignal | undefined
}

/**
 * A `FetchLike` that answers from a fixture table and records what it received.
 *
 * ```ts
 * const http = new RecordingFetch([{ status: 400, json: { error: 'no tools' } }, { json: completion }])
 * const runner = new OpenAICompatibleRunner({ config, fetch: http.fetch, clock, apiKey: 'k' })
 * expect(http.bodyAt(1).tools).toBeUndefined()
 * ```
 */
export class RecordingFetch {
  /** Every request, in call order. */
  readonly requests: RecordedRequest[] = []
  /** The `FetchLike` handed to the code under test. */
  readonly fetch: FetchLike

  /**
   * @param replies - Fixtures served in order, or a handler that builds each
   *   response from the recorded request.
   */
  constructor(
    private readonly replies:
      | readonly FakeHttpReply[]
      | ((request: RecordedRequest, index: number) => FakeHttpReply),
  ) {
    this.fetch = (url, init) => this.respond(url, init)
  }

  /** Number of requests received. */
  get callCount(): number {
    return this.requests.length
  }

  /** Parsed JSON body of the `index`-th request. */
  bodyAt(index: number): Record<string, unknown> {
    const request = this.requests[index]
    if (request === undefined) throw new Error(`RecordingFetch saw no request at index ${index}`)
    if (typeof request.body !== 'object' || request.body === null) return {}
    return request.body as Record<string, unknown>
  }

  /** Raw body of the `index`-th request. */
  rawBodyAt(index: number): string | undefined {
    return this.requests[index]?.rawBody
  }

  private respond(url: string, init?: HttpRequestInit): Promise<HttpResponseLike> {
    const wide = init as (HttpRequestInit & { method?: string; body?: string }) | undefined
    const rawBody = wide?.body
    const request: RecordedRequest = {
      url,
      method: wide?.method,
      headers: wide?.headers,
      rawBody,
      body: rawBody === undefined ? undefined : tryParse(rawBody),
      signal: wide?.signal,
    }
    this.requests.push(request)
    const index = this.requests.length - 1
    const reply = typeof this.replies === 'function' ? this.replies(request, index) : this.replies[index]
    if (reply === undefined) {
      return Promise.reject(new Error(`RecordingFetch: no fixture reply for request ${index} (${url})`))
    }
    if ('error' in reply) return Promise.reject(reply.error)
    return Promise.resolve(toResponse(reply))
  }
}

function tryParse(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown
  } catch {
    return raw
  }
}

function toResponse(reply: FakeHttpReply): HttpResponseLike {
  if ('error' in reply) throw reply.error
  const status = reply.status ?? 200
  const ok = status >= 200 && status < 300
  if ('json' in reply) {
    const response: HttpResponseLike & { json: () => Promise<unknown> } = {
      ok,
      status,
      json: () => Promise.resolve(reply.json),
    }
    return response
  }
  if ('text' in reply) return textResponse(ok, status, reply.text)
  if ('stall' in reply) {
    return streamResponse(ok, status, { [Symbol.asyncIterator]: () => ({ next: () => new Promise<never>(() => {}) }) })
  }
  const chunks = 'sse' in reply
    ? reply.sse.map(payload => `data: ${JSON.stringify(payload)}\n\n`)
    : reply.chunks
  return streamResponse(ok, status, (async function* stream(): AsyncGenerator<string> {
    for (const chunk of chunks) yield chunk
  })())
}

function textResponse(ok: boolean, status: number, text: string): HttpResponseLike {
  const response = {
    ok,
    status,
    text: () => Promise.resolve(text),
    json: () => Promise.resolve(tryParse(text)),
  }
  return response as unknown as HttpResponseLike
}

function streamResponse(
  ok: boolean,
  status: number,
  body: AsyncIterable<string>,
): HttpResponseLike {
  const response = {
    ok,
    status,
    body,
    json: () => Promise.reject(new Error('this fixture streams SSE and has no JSON body')),
  }
  return response as unknown as HttpResponseLike
}
