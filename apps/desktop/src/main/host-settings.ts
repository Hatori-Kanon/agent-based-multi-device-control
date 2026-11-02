/**
 * Host settings that belong to the human operator, not to a session.
 *
 * Two kinds of state live behind this module:
 *
 * - **Persisted sensor preferences** in `<dataDir>/state/settings.json`
 *   (through the host's `DocumentStore`, so the write is atomic and `0600`):
 *   whether the camera and the microphone should capture, and which device each
 *   should open. The file is hand-editable input, so it is parsed field by
 *   field and a corrupt value degrades to the documented default instead of
 *   blocking the host from starting.
 * - **The settings payload** shown by the console's 设置 view: a key-free LLM
 *   projection plus the live capture status of both sensors. Capture state
 *   (`running` / `stopped` / `unavailable` / `error`) is derived at read time
 *   and never persisted — a "running" flag left from the previous process would
 *   be a lie.
 *
 * Defaults are a product decision:
 *
 * - **Camera on.** That preserves the pre-settings behaviour: the console
 *   auto-starts the first video input so the model has eyes without an extra
 *   gesture. A missing/failed camera is still a supported state.
 * - **Microphone off.** Perception is one-way and the harness holds the
 *   privacy default: the mic starts *only* after a human explicitly turns it
 *   on. A fresh install therefore never captures room audio.
 *
 * The API key is deliberately absent from every type here. {@link
 * SettingsLlmPayload} carries provenance (`apiKeySource`) and a boolean; the
 * secret itself only ever reaches `llm.ts` → the runner's auth header.
 */

import { apiKeyEnvOf } from '@embodied/core'
import type { DocumentStore, LlmConfig } from '@embodied/core'
import type { ApiKeySource, LlmSummary } from './settings.ts'

/** DocumentStore key == `<dataDir>/state/settings.json`. */
export const HOST_SETTINGS_KEY = 'settings'

/** Settings file version; bumped only for a breaking layout change. */
export const HOST_SETTINGS_VERSION = 1

/** A capture device the worker page can open. */
export interface SensorDeviceInfo {
  readonly deviceId: string
  /** Empty until the platform reveals labels (after the first permission grant). */
  readonly label: string
}

/** One sensor's persisted human preference. */
export interface SensorPreference {
  readonly enabled: boolean
  /**
   * Preferred device id, or `null` for "the platform default".
   *
   * A stored id that is no longer present is not an error: the host falls back
   * to the first available device, exactly like a freshly installed camera.
   */
  readonly deviceId: string | null
}

/** Persisted preferences for both capture sources. */
export interface SensorPreferences {
  readonly camera: SensorPreference
  readonly microphone: SensorPreference
}

/**
 * The privacy-preserving default: camera on (as before settings existed),
 * microphone off until a human asks for it.
 */
export const DEFAULT_SENSOR_PREFERENCES: SensorPreferences = {
  camera: { enabled: true, deviceId: null },
  microphone: { enabled: false, deviceId: null },
}

/** One partial update for a sensor as it arrives from HTTP. */
export interface SensorPreferencePatch {
  readonly enabled?: boolean
  readonly deviceId?: string | null
}

/** Partial sensor preferences from `POST /api/settings/sensors`. */
export interface SensorPreferencesPatch {
  readonly camera?: SensorPreferencePatch
  readonly microphone?: SensorPreferencePatch
}

/** What one capture host is doing right now; never persisted. */
export type SensorCaptureStatus = 'running' | 'stopped' | 'unavailable' | 'error'

/** Live state of one capture source, as the settings payload reports it. */
export interface SensorCaptureState {
  /** False when the host has no capture host at all (headless/dev-server). */
  readonly supported: boolean
  /** The human preference currently in force. */
  readonly enabled: boolean
  /** Device capture is using (or would use); `null` when none is known. */
  readonly deviceId: string | null
  readonly devices: readonly SensorDeviceInfo[]
  readonly status: SensorCaptureStatus
  /** Short, human-readable reason; present only for `error`/`unavailable`. */
  readonly error?: string
}

/** Key-free model configuration plus where its credential came from. */
export interface SettingsLlmPayload {
  readonly provider: string
  readonly model: string
  readonly baseUrl: string | null
  readonly apiKeySource: ApiKeySource
  /** Environment variable the host consults first (`EMBODIED_LLM_API_KEY`). */
  readonly apiKeyEnv: string
  readonly hasApiKey: boolean
}

/** `GET /api/settings` and the two `POST` routes' success payload. */
export interface SettingsPayload {
  readonly llm: SettingsLlmPayload
  readonly sensors: {
    readonly camera: SensorCaptureState
    readonly microphone: SensorCaptureState
  }
}

/** Partial model-settings update from `POST /api/settings/llm`. */
export interface LlmSettingsPatch {
  readonly provider?: string
  readonly model?: string
  readonly baseUrl?: string | null
  /**
   * Omitted = keep the stored key, `''` = clear it, anything else = replace it.
   * Never echoed back in a payload.
   */
  readonly apiKey?: string
}

/**
 * The seam the HTTP settings routes are driven through.
 *
 * `bootstrap.ts` implements it against the live capture hosts; tests may
 * implement it with fixtures. Everything is async because both capture hosts
 * and the disk are.
 */
export interface SettingsDeps {
  snapshot(): Promise<SettingsPayload>
  saveLlm(patch: LlmSettingsPatch): Promise<SettingsPayload>
  saveSensors(patch: SensorPreferencesPatch): Promise<SettingsPayload>
}

/** Stable, machine-readable settings failure codes (HTTP layer maps to 400). */
export type SettingsErrorCode =
  /** A model field is empty, too long, or not an http(s) base URL. */
  | 'INVALID_LLM'
  /** A sensor patch has the wrong type or an unknown device id. */
  | 'INVALID_SENSOR'
  /** The host was started with an in-memory model config that cannot be saved. */
  | 'FIXED_LLM_CONFIG'

/** Caller-fixable settings failure; the routes answer `400` with its words. */
export class SettingsError extends Error {
  constructor(readonly code: SettingsErrorCode, message: string) {
    super(message)
    this.name = 'SettingsError'
  }
}

/** Narrow an unknown rejection to a {@link SettingsError}. */
export function isSettingsError(value: unknown): value is SettingsError {
  return value instanceof SettingsError
}

/** Trimmed text, or `undefined` when absent/blank/not a string. */
function asText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

/** Parse one persisted preference; a bad shape degrades to the default. */
function parsePreference(raw: unknown, fallback: SensorPreference): SensorPreference {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return fallback
  const record = raw as Record<string, unknown>
  const enabled = typeof record.enabled === 'boolean' ? record.enabled : fallback.enabled
  let deviceId = fallback.deviceId
  if (record.deviceId === null) deviceId = null
  else if (typeof record.deviceId === 'string') deviceId = asText(record.deviceId) ?? null
  return { enabled, deviceId }
}

/**
 * Parse the settings document.
 *
 * Missing or corrupt input yields the defaults; each sensor is parsed
 * independently so a hand-edit of one cannot silently flip the other.
 */
export function parseSensorPreferences(raw: string | undefined): SensorPreferences {
  if (raw === undefined || raw.trim() === '') return DEFAULT_SENSOR_PREFERENCES
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return DEFAULT_SENSOR_PREFERENCES
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return DEFAULT_SENSOR_PREFERENCES
  }
  const sensors = (parsed as Record<string, unknown>).sensors
  if (typeof sensors !== 'object' || sensors === null || Array.isArray(sensors)) {
    return DEFAULT_SENSOR_PREFERENCES
  }
  const record = sensors as Record<string, unknown>
  return {
    camera: parsePreference(record.camera, DEFAULT_SENSOR_PREFERENCES.camera),
    microphone: parsePreference(record.microphone, DEFAULT_SENSOR_PREFERENCES.microphone),
  }
}

/** Serialise preferences into the documented versioned file layout. */
export function sensorPreferencesJson(preferences: SensorPreferences): string {
  const file = {
    version: HOST_SETTINGS_VERSION,
    sensors: {
      camera: { enabled: preferences.camera.enabled, deviceId: preferences.camera.deviceId },
      microphone: { enabled: preferences.microphone.enabled, deviceId: preferences.microphone.deviceId },
    },
  }
  return `${JSON.stringify(file, null, 2)}\n`
}

/** Read `<dataDir>/state/settings.json`; a missing file means the defaults. */
export async function loadSensorPreferences(documents: DocumentStore): Promise<SensorPreferences> {
  return parseSensorPreferences(await documents.read(HOST_SETTINGS_KEY))
}

/** Persist sensor preferences atomically through the host's document store. */
export async function saveSensorPreferences(
  documents: DocumentStore,
  preferences: SensorPreferences,
): Promise<void> {
  await documents.write(HOST_SETTINGS_KEY, sensorPreferencesJson(preferences))
}

/**
 * Merge a partial update into the current preferences.
 *
 * Pure: validation (types, known device ids) happens before this call, so the
 * merge itself cannot fail. An absent field keeps the current value; an
 * explicit `deviceId: null` clears the preference without disabling capture.
 */
export function mergeSensorPreferences(
  current: SensorPreferences,
  patch: SensorPreferencesPatch,
): SensorPreferences {
  const mergeOne = (before: SensorPreference, update: SensorPreferencePatch | undefined): SensorPreference => {
    if (update === undefined) return before
    return {
      enabled: update.enabled === undefined ? before.enabled : update.enabled,
      deviceId: update.deviceId === undefined ? before.deviceId : update.deviceId,
    }
  }
  return {
    camera: mergeOne(current.camera, patch.camera),
    microphone: mergeOne(current.microphone, patch.microphone),
  }
}

/** Project the key-free LLM summary for the settings view. */
export function buildLlmSettingsPayload(summary: LlmSummary, config: LlmConfig): SettingsLlmPayload {
  return {
    provider: summary.default.provider,
    model: summary.default.model,
    baseUrl: summary.default.baseUrl ?? null,
    apiKeySource: summary.apiKeySource,
    apiKeyEnv: apiKeyEnvOf(config.default),
    hasApiKey: summary.hasApiKey,
  }
}

/** Assemble the full settings payload from already-resolved pieces. */
export function buildSettingsPayload(input: {
  readonly llm: SettingsLlmPayload
  readonly sensors: {
    readonly camera: SensorCaptureState
    readonly microphone: SensorCaptureState
  }
}): SettingsPayload {
  return { llm: input.llm, sensors: { camera: input.sensors.camera, microphone: input.sensors.microphone } }
}

/** A capture source the host does not have: the console renders this as 不可用. */
export function unsupportedSensorState(): SensorCaptureState {
  return { supported: false, enabled: false, deviceId: null, devices: [], status: 'unavailable' }
}
