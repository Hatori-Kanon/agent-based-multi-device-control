/**
 * Provider-neutral model gateway types.
 *
 * The gateway is the only part of core that talks to an LLM. Providers are
 * hidden behind {@link ModelRunner}, tool definitions are plain JSON Schema (no
 * SDK type is involved), and every byte of IO is injected: the wire lives in
 * `agent/transport.ts` and takes a `FetchLike` from `ports/http.ts`, while the
 * clock comes from `ports/clock.ts`. This file therefore imports nothing from
 * the platform and can be used from the desktop host, tests, or a future CLI.
 *
 * @module
 */

/** Which configured model a caller wants: the plan writer or the line writer. */
export type ModelRole = 'director' | 'writer'

/** Environment variable the host reads the API key from by default. */
export const DEFAULT_API_KEY_ENV = 'EMBODIED_LLM_API_KEY'

/**
 * One model endpoint.
 *
 * `provider` is intentionally open (`(string & {})`) so a proxy or a local
 * gateway can name itself; known providers get a default `baseUrl` in the
 * OpenAI-compatible adapter. `apiKeyEnv` is only a *name*: core never reads the
 * environment, the host resolves it and passes the value in (§4.9).
 */
export interface ModelConfig {
  readonly provider: 'deepseek' | 'openai' | 'anthropic' | 'google' | (string & {})
  readonly model: string
  readonly temperature?: number
  readonly maxTokens?: number
  readonly baseUrl?: string
  /** Environment variable that carries the API key; defaults to {@link DEFAULT_API_KEY_ENV}. */
  readonly apiKeyEnv?: string
}

/**
 * The host's LLM settings.
 *
 * `director`/`writer` are the M3+ split-mode roles. In M2 both are `null`, so
 * a turn is a single request to `default` (D6); `resolveModel` makes that
 * fallback explicit instead of scattering `??` through the engine.
 */
export interface LlmConfig {
  readonly default: ModelConfig
  /** `null` or omitted = use `default`. */
  readonly director?: ModelConfig | null
  /** `null` or omitted = use `default`. */
  readonly writer?: ModelConfig | null
}

/**
 * Pick the model for a role.
 *
 * A missing or `null` role model always falls back to `default`; the returned
 * object is the configured one (not a copy), so callers can compare identity.
 */
export function resolveModel(config: LlmConfig, role: ModelRole): ModelConfig {
  const override = role === 'director' ? config.director : config.writer
  return override ?? config.default
}

/** Environment variable name a config expects its API key in. */
export function apiKeyEnvOf(config: ModelConfig): string {
  return config.apiKeyEnv ?? DEFAULT_API_KEY_ENV
}

/** One message in the provider-neutral conversation. */
export interface LlmMessage {
  readonly role: 'system' | 'user' | 'assistant' | 'tool'
  readonly content: string
  /** Base64 snapshot returned by `look` (JPEG, no data-url prefix). */
  readonly imageBase64?: string
  /** Required on `tool` messages: the call this message answers. */
  readonly toolCallId?: string
}

/** One completed tool invocation. */
export interface ToolCall {
  readonly id: string
  readonly name: string
  /** Parsed JSON arguments; a tolerant wire layer may leave a raw string. */
  readonly arguments: unknown
}

/**
 * A tool the model may call.
 *
 * `parameters` is a provider-neutral JSON Schema object; adapters translate it
 * to whatever a provider expects. Nothing here is bound to an SDK type.
 */
export interface ToolDefinition {
  readonly name: string
  readonly description: string
  readonly parameters: Readonly<Record<string, unknown>>
}

/** Usage reported by the provider, when it reports any. */
export interface ModelUsage {
  readonly inputTokens: number
  readonly outputTokens: number
}

/** Why the model stopped. */
export type ModelFinishReason = 'stop' | 'tool-calls' | 'length' | 'timeout' | 'error'

/**
 * One turn request.
 *
 * `onToolCall` fires the moment a tool's arguments are complete — the executor
 * dispatches from it while the text stream is still running (§4.9). `timeoutMs`
 * is the total budget for connect + stream; the caller's `signal` cancels it.
 */
export interface ModelTurnRequest {
  readonly messages: readonly LlmMessage[]
  readonly tools: readonly ToolDefinition[]
  readonly timeoutMs: number
  readonly signal: AbortSignal
  readonly onTextDelta?: (delta: string) => void
  /** Fired as soon as the arguments of a tool call are complete. */
  readonly onToolCall?: (call: ToolCall) => void
}

/** One turn result. The text and the tool calls come from the same request. */
export interface ModelTurnResult {
  readonly text: string
  readonly toolCalls: readonly ToolCall[]
  readonly finishReason: ModelFinishReason
  readonly usage?: ModelUsage
}

/** Everything the agent loop needs from a model provider. */
export interface ModelRunner {
  run(request: ModelTurnRequest): Promise<ModelTurnResult>
}

/** Why a model call failed. Stable enough to branch on; the message is for humans. */
export type ModelErrorCode =
  /** Bad configuration (missing key, unknown provider, unusable base URL). */
  | 'config'
  /** The total budget ran out. */
  | 'timeout'
  /** The caller aborted the turn. */
  | 'aborted'
  /** The request never reached the provider (DNS, TLS, socket). */
  | 'network'
  /** The provider answered with a non-2xx status; `status` says which. */
  | 'http'
  /** The provider understood the request but refused its shape (4xx). */
  | 'invalid-request'
  /** The provider answered with something that is not a completion. */
  | 'invalid-response'
  /** 401/403: the key is missing, wrong, or lacks access. */
  | 'auth'
  /** 429: back off and retry later. */
  | 'rate-limit'
  /** 5xx: the provider is broken, not the request. */
  | 'server'

export interface ModelErrorOptions {
  readonly code: ModelErrorCode
  /** HTTP status when the failure came from a response. */
  readonly status?: number
  /** Override the default retryability of the code. */
  readonly retryable?: boolean
  /** Raw provider detail (truncated body); kept out of the headline message. */
  readonly detail?: string
  readonly cause?: unknown
}

/** Failure raised by a {@link ModelRunner}. */
export class ModelError extends Error {
  readonly code: ModelErrorCode
  readonly status: number | undefined
  readonly detail: string | undefined
  readonly retryable: boolean

  /**
   * @param message - Actionable text for the operator log and the audit trail.
   * @param options - Machine-readable reason plus optional HTTP context.
   */
  constructor(message: string, options: ModelErrorOptions) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'ModelError'
    this.code = options.code
    this.status = options.status
    this.detail = options.detail
    this.retryable = options.retryable ?? RETRYABLE_CODES.has(options.code)
  }
}

/** Codes that are worth one retry after a backoff (D12). */
const RETRYABLE_CODES: ReadonlySet<ModelErrorCode> = new Set<ModelErrorCode>([
  'timeout',
  'network',
  'rate-limit',
  'server',
])

/** Narrow an unknown rejection to a {@link ModelError}. */
export function isModelError(value: unknown): value is ModelError {
  return value instanceof ModelError
}
