/**
 * Host settings: secret resolution and the key-free projection shown outside
 * the host.
 *
 * The API key exists in exactly two places — the environment and
 * `<dataDir>/state/llm.json` — and this module is the only code that reads it
 * into memory. From here the key goes straight into the model runner's
 * `Authorization` header; it is never part of a snapshot, an audit detail, a
 * prompt, or a console payload. `LlmConfig` has no key field by construction,
 * and {@link LlmSummary} is the shape everything else is allowed to display.
 */

import { DEFAULT_API_KEY_ENV, resolveModel } from '@embodied/core'
import type { LlmConfig, ModelConfig } from '@embodied/core'

/** Environment map used for secret lookup. Tests inject one instead of the process. */
export type SettingsEnv = Readonly<Record<string, string | undefined>>

/** Where an API key came from. A name only — never the key itself. */
export type ApiKeySource = 'env' | 'file' | 'none'

/** One resolved secret plus its provenance. */
export interface ResolvedApiKey {
  readonly apiKey: string | undefined
  readonly source: ApiKeySource
}

/** A non-empty, trimmed environment value. */
export function envValue(env: SettingsEnv, name: string): string | undefined {
  const raw = env[name]
  if (typeof raw !== 'string') return undefined
  const trimmed = raw.trim()
  return trimmed === '' ? undefined : trimmed
}

/**
 * Resolve the API key for a model config.
 *
 * The environment wins over the settings file: an operator can rotate the key
 * for one run without editing (or even having) a file. An empty value counts
 * as absent, so a blank field never becomes an `Authorization: Bearer ` header.
 */
export function resolveApiKey(env: SettingsEnv, config: ModelConfig, fileApiKey: string | undefined): ResolvedApiKey {
  const fromEnv = envValue(env, config.apiKeyEnv ?? DEFAULT_API_KEY_ENV)
  if (fromEnv !== undefined) return { apiKey: fromEnv, source: 'env' }
  const fromFile = typeof fileApiKey === 'string' ? fileApiKey.trim() : ''
  if (fromFile !== '') return { apiKey: fromFile, source: 'file' }
  return { apiKey: undefined, source: 'none' }
}

/** A model config as it may be displayed: no credential field exists on it. */
export interface LlmModelSummary {
  readonly provider: string
  readonly model: string
  readonly baseUrl?: string
}

/** Key-free LLM status for the console and host diagnostics (B1-T15). */
export interface LlmSummary {
  readonly default: LlmModelSummary
  readonly director: LlmModelSummary | null
  readonly writer: LlmModelSummary | null
  /**
   * Model the single-call MVP (D6) actually uses.
   *
   * With `director: null` it is the default model, which is exactly the
   * {@link resolveModel} fallback expressed as a payload.
   */
  readonly singleCall: LlmModelSummary
  readonly apiKeySource: ApiKeySource
  readonly hasApiKey: boolean
}

/** Project one model config for display; nothing secret is carried over. */
export function summarizeModel(config: ModelConfig): LlmModelSummary {
  return {
    provider: config.provider,
    model: config.model,
    ...(config.baseUrl === undefined ? {} : { baseUrl: config.baseUrl }),
  }
}

/**
 * Build the key-free status payload.
 *
 * `apiKeySource` is a provenance label, never a value; there is deliberately no
 * field on this type that could hold the key.
 */
export function summarizeLlm(config: LlmConfig, apiKeySource: ApiKeySource): LlmSummary {
  const singleCall = resolveModel(config, 'director')
  return {
    default: summarizeModel(config.default),
    director: config.director === null || config.director === undefined ? null : summarizeModel(config.director),
    writer: config.writer === null || config.writer === undefined ? null : summarizeModel(config.writer),
    singleCall: summarizeModel(singleCall),
    apiKeySource,
    hasApiKey: apiKeySource !== 'none',
  }
}
