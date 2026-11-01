/**
 * Host LLM settings and model-runner assembly (B1-T15).
 *
 * Settings live in `<dataDir>/state/llm.json`; a missing or corrupt file falls
 * back to the built-in single-call default (DeepSeek `deepseek-chat`), so a
 * hand-edited file can never brick the console. The file layout mirrors core's
 * `LlmConfig` — `{version, default, director, writer}` — plus an optional
 * `apiKey` field for operators who cannot set an environment variable.
 *
 * Role models are `null` in M2: the single-call turn (D6) resolves through
 * `resolveModel(config, 'director')`, which falls back to `default`. Split mode
 * (B2+) only changes config values, not this assembly path.
 *
 * **The key never leaves this module except into the runner's auth header.**
 * It is resolved environment-first (see `settings.ts`), never serialised by
 * {@link saveLlmConfig} unless a caller explicitly passes one, and never
 * appears in `HostRuntime.llmSummary()`.
 */

import { join } from 'node:path'
import { OpenAICompatibleRunner, resolveModel } from '@embodied/core'
import type {
  CapabilityCache,
  Clock,
  FetchLike,
  LlmConfig,
  ModelConfig,
  ModelRunner,
} from '@embodied/core'
import { FileDocumentStore } from './node-storage.ts'
import { resolveApiKey, summarizeLlm } from './settings.ts'
import type { ApiKeySource, LlmSummary, SettingsEnv } from './settings.ts'

/** Built-in config: one DeepSeek chat model, no split-mode roles (D6). */
export const DEFAULT_LLM_CONFIG: LlmConfig = {
  default: { provider: 'deepseek', model: 'deepseek-chat' },
  director: null,
  writer: null,
}

/** Settings file version; bumped only for a breaking layout change. */
export const LLM_SETTINGS_VERSION = 1

/** DocumentStore key == `<dataDir>/state/llm.json`. */
export const LLM_SETTINGS_KEY = 'llm'

/**
 * Raw settings file shape.
 *
 * Everything is `unknown` because a settings file is hand-editable input: it is
 * validated field by field, and a bad model entry degrades to the default
 * instead of making the host refuse to start.
 */
export interface LlmSettingsFile {
  readonly version?: unknown
  readonly default?: unknown
  readonly director?: unknown
  readonly writer?: unknown
  readonly apiKey?: unknown
}

/** Resolved settings: public config plus the secret's value and provenance. */
export interface LlmSettings {
  readonly config: LlmConfig
  /** Resolved key; only the model runner should ever receive it. */
  readonly apiKey: string | undefined
  readonly apiKeySource: ApiKeySource
}

/** Trimmed non-empty string, or undefined. */
function asText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

/** Finite number, or undefined. */
function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** Validate one model config, completing optional fields only when present. */
function asModelConfig(value: unknown): ModelConfig | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const raw = value as Record<string, unknown>
  const provider = asText(raw.provider)
  const model = asText(raw.model)
  if (provider === undefined || model === undefined) return undefined
  const temperature = asNumber(raw.temperature)
  const maxTokens = asNumber(raw.maxTokens)
  const baseUrl = asText(raw.baseUrl)
  const apiKeyEnv = asText(raw.apiKeyEnv)
  return {
    provider,
    model,
    ...(temperature === undefined ? {} : { temperature }),
    ...(maxTokens === undefined ? {} : { maxTokens }),
    ...(baseUrl === undefined ? {} : { baseUrl }),
    ...(apiKeyEnv === undefined ? {} : { apiKeyEnv }),
  }
}

/** Parse the file body; missing/corrupt input yields the built-in default. */
function parseSettingsFile(raw: string | undefined): LlmSettingsFile | undefined {
  if (raw === undefined || raw.trim() === '') return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
  return parsed as LlmSettingsFile
}

/** The file's optional API key, without trusting its type. */
function apiKeyFromFile(file: LlmSettingsFile | undefined): string | undefined {
  return file === undefined ? undefined : asText(file.apiKey)
}

/**
 * Parse a settings document into an {@link LlmConfig} (no secrets).
 *
 * A corrupt file and a corrupt model entry both degrade to the default; a
 * `null`/invalid role stays `null`, which is the documented "use default"
 * spelling.
 */
export function parseLlmConfig(raw: string | undefined): LlmConfig {
  const file = parseSettingsFile(raw)
  if (file === undefined) return DEFAULT_LLM_CONFIG
  return {
    default: asModelConfig(file.default) ?? DEFAULT_LLM_CONFIG.default,
    director: asModelConfig(file.director) ?? null,
    writer: asModelConfig(file.writer) ?? null,
  }
}

/**
 * Parse a settings document into config + resolved secret.
 *
 * Resolution order is environment first, settings file second (see
 * {@link resolveApiKey}); the secret is never copied into the config object.
 */
export function parseLlmSettings(raw: string | undefined, env: SettingsEnv): LlmSettings {
  const config = parseLlmConfig(raw)
  const resolved = resolveApiKey(env, config.default, apiKeyFromFile(parseSettingsFile(raw)))
  return { config, apiKey: resolved.apiKey, apiKeySource: resolved.source }
}

/**
 * Resolve settings for an in-memory config override (tests, embedded hosts).
 *
 * No settings file is consulted: an explicit config is authoritative, and the
 * key still follows environment-first resolution.
 */
export function settingsFromConfig(config: LlmConfig, env: SettingsEnv): LlmSettings {
  const resolved = resolveApiKey(env, config.default, undefined)
  return { config, apiKey: resolved.apiKey, apiKeySource: resolved.source }
}

/** Read `<dataDir>/state/llm.json`; missing entries fall back to the default. */
export async function loadLlmSettings(dataDir: string, env: SettingsEnv = process.env): Promise<LlmSettings> {
  const store = new FileDocumentStore(join(dataDir, 'state'))
  return parseLlmSettings(await store.read(LLM_SETTINGS_KEY), env)
}

/** Read just the public config (the API key is deliberately not returned). */
export async function loadLlmConfig(dataDir: string): Promise<LlmConfig> {
  return (await loadLlmSettings(dataDir)).config
}

/**
 * Persist LLM settings atomically (`FileDocumentStore`: temp file + rename,
 * mode `0o600` on POSIX).
 *
 * The API key is only written when the caller passes one explicitly — a key
 * resolved from the environment is never copied into the file.
 */
export async function saveLlmConfig(
  dataDir: string,
  config: LlmConfig,
  options: { readonly apiKey?: string } = {},
): Promise<void> {
  const file: Record<string, unknown> = {
    version: LLM_SETTINGS_VERSION,
    default: config.default,
    director: config.director ?? null,
    writer: config.writer ?? null,
  }
  const apiKey = options.apiKey?.trim()
  if (apiKey !== undefined && apiKey !== '') file.apiKey = apiKey
  const store = new FileDocumentStore(join(dataDir, 'state'))
  await store.write(LLM_SETTINGS_KEY, `${JSON.stringify(file, null, 2)}\n`)
}

/**
 * Model the single-call MVP actually uses.
 *
 * Director role resolved, `null` → default. When B2 splits director/writer
 * calls, this stays the definition of "the one request" and role runners are
 * built from `resolveModel(config, role)` instead.
 */
export function singleCallModel(config: LlmConfig): ModelConfig {
  return resolveModel(config, 'director')
}

export interface CreateModelRunnerOptions {
  /** Model the runner is bound to (one runner per model config). */
  readonly model: ModelConfig
  /** Key resolved by the host; omitted falls back to the runner's env lookup. */
  readonly apiKey?: string
  readonly fetch: FetchLike
  readonly clock: Clock
  readonly env?: SettingsEnv
  /** Shared capability memory so repeated probes are skipped (B1-T2). */
  readonly capabilities?: CapabilityCache
}

/**
 * Build the provider-neutral runner.
 *
 * Constructor work is pure configuration: no socket is opened and no request is
 * made, so a host can assemble this at boot on an offline machine. The first
 * network call happens when a turn actually runs.
 */
export function createModelRunner(options: CreateModelRunnerOptions): ModelRunner {
  return new OpenAICompatibleRunner({
    config: options.model,
    fetch: options.fetch,
    clock: options.clock,
    ...(options.apiKey === undefined ? {} : { apiKey: options.apiKey }),
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(options.capabilities === undefined ? {} : { capabilities: options.capabilities }),
  })
}

/**
 * The runner set a two-call turn needs (B2-T3).
 *
 * `runner` is always the `default` model. A role runner exists **only** when
 * that role names its own model, so a caller can hand the set to
 * `TurnPipeline` unchanged: `undefined` means "the pipeline falls back to
 * `runner`". Splitting is therefore a settings-file change
 * (`llm.director` / `llm.writer`), not an assembly change.
 */
export interface LlmRoleRunners {
  /** The `default` model; also the fallback for every role. */
  readonly runner: ModelRunner
  /** Present only when `llm.director` is a model config. */
  readonly directorRunner?: ModelRunner
  /** Present only when `llm.writer` is a model config. */
  readonly writerRunner?: ModelRunner
}

/** Options for {@link createRoleRunners}; `llm` replaces the single `model`. */
export interface CreateRoleRunnersOptions extends Omit<CreateModelRunnerOptions, 'model'> {
  readonly llm: LlmConfig
}

/**
 * Build the provider-neutral runners for the pipeline's two roles.
 *
 * Constructor work is pure configuration: no socket is opened and no request is
 * made. The capability cache, when supplied, is shared by every runner in the
 * set (the adapter keys it by provider + model, so sharing only avoids duplicate
 * probes).
 */
export function createRoleRunners(options: CreateRoleRunnersOptions): LlmRoleRunners {
  const director = options.llm.director
  const writer = options.llm.writer
  return {
    runner: createRunnerFor(options.llm.default, options),
    ...(director === null || director === undefined
      ? {}
      : { directorRunner: createRunnerFor(director, options) }),
    ...(writer === null || writer === undefined
      ? {}
      : { writerRunner: createRunnerFor(writer, options) }),
  }
}

function createRunnerFor(
  model: ModelConfig,
  options: Omit<CreateModelRunnerOptions, 'model'>,
): ModelRunner {
  return createModelRunner({
    model,
    fetch: options.fetch,
    clock: options.clock,
    ...(options.apiKey === undefined ? {} : { apiKey: options.apiKey }),
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(options.capabilities === undefined ? {} : { capabilities: options.capabilities }),
  })
}

/** Key-free status payload for the console/diagnostics (see `settings.ts`). */
export function llmSummaryOf(settings: LlmSettings): LlmSummary {
  return summarizeLlm(settings.config, settings.apiKeySource)
}
