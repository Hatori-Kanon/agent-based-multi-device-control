/**
 * HTTP surface for the console's 设置 view.
 *
 * Kept in this module instead of `dashboard.ts` so the router stays a router:
 * `dashboard.ts` only needs to recognise the three paths and hand them over.
 * The handlers follow the same shape as the dashboard routes (token checked by
 * the caller, JSON bodies capped, a caller-fixable condition is a `400` with
 * `{ok:false,error}`), but they own their validation because every field here
 * is either a public model choice or a capture-device preference — never a
 * safety bound.
 *
 * Routes:
 *
 *     GET  /api/settings          → key-free model view + camera/mic status
 *     POST /api/settings/llm      → validate, persist, rebuild the model runner
 *     POST /api/settings/sensors  → validate, start/stop capture, persist prefs
 *
 * The API key never appears in a response. `POST /api/settings/llm` accepts a
 * new key (or `''` to clear it) but only ever reports `hasApiKey`/`apiKeySource`.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  isSettingsError,
  type LlmSettingsPatch,
  type SensorPreferencePatch,
  type SensorPreferencesPatch,
  type SettingsDeps,
} from './host-settings.ts'

/** Same JSON cap as the dashboard's other routes. */
const MAX_BODY_BYTES = 256 * 1024

/** Longest accepted provider/model name and API key, in characters. */
const MAX_MODEL_TEXT = 200
const MAX_API_KEY_TEXT = 4096

/** Paths this module owns (used by `dashboard.ts` to dispatch). */
export const SETTINGS_PATHS: readonly string[] = ['/api/settings', '/api/settings/llm', '/api/settings/sensors']

/** Whether `pathname` belongs to the settings API. */
export function isSettingsPath(pathname: string): boolean {
  return SETTINGS_PATHS.includes(pathname)
}

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload)
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  })
  response.end(body)
}

function sendError(response: ServerResponse, status: number, message: string, code?: string): void {
  sendJson(response, status, code === undefined ? { ok: false, error: message } : { ok: false, error: message, code })
}

/** Read the JSON body, capped at {@link MAX_BODY_BYTES}. */
async function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let total = 0
    request.on('data', (chunk: Buffer) => {
      total += chunk.length
      if (total > MAX_BODY_BYTES) {
        reject(new Error('body too large'))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => { resolve(Buffer.concat(chunks).toString('utf8')) })
    request.on('error', reject)
  })
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const raw = await readBody(request)
  if (raw.trim().length === 0) return {}
  const parsed: unknown = JSON.parse(raw)
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('expected a JSON object')
  }
  return parsed as Record<string, unknown>
}

/** Trimmed text; `undefined` when the field is absent or blank. */
function asText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

/** Validate one model field and return its trimmed value. */
function parseModelField(value: unknown, name: string): string {
  const text = asText(value)
  if (text === undefined) throw new Error(`${name} must be a non-empty string`)
  if (text.length > MAX_MODEL_TEXT) throw new Error(`${name} must be at most ${MAX_MODEL_TEXT} characters`)
  return text
}

/** `baseUrl`: absent/`null`/`''` means "provider default"; otherwise http(s). */
function parseBaseUrl(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null
  const text = asText(value)
  if (text === undefined) return null
  let url: URL
  try {
    url = new URL(text)
  } catch {
    throw new Error('baseUrl must be an http(s) URL')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('baseUrl must be an http(s) URL')
  }
  return text
}

/** Parse `POST /api/settings/llm`. Omitted fields keep their stored value. */
function parseLlmPatch(body: Record<string, unknown>): LlmSettingsPatch {
  const patch: {
    provider?: string
    model?: string
    baseUrl?: string | null
    apiKey?: string
  } = {}
  if (body.provider !== undefined) patch.provider = parseModelField(body.provider, 'provider')
  if (body.model !== undefined) patch.model = parseModelField(body.model, 'model')
  if (body.baseUrl !== undefined) patch.baseUrl = parseBaseUrl(body.baseUrl)
  if (body.apiKey !== undefined) {
    if (typeof body.apiKey !== 'string') throw new Error('apiKey must be a string')
    const apiKey = body.apiKey.trim()
    if (apiKey.length > MAX_API_KEY_TEXT) {
      throw new Error(`apiKey must be at most ${MAX_API_KEY_TEXT} characters`)
    }
    patch.apiKey = apiKey
  }
  return patch
}

/** Parse one sensor patch; `undefined` when the sensor was not mentioned. */
function parseSensorPatch(value: unknown, name: string): SensorPreferencePatch | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${name} must be an object`)
  }
  const raw = value as Record<string, unknown>
  const patch: { enabled?: boolean; deviceId?: string | null } = {}
  if (raw.enabled !== undefined) {
    if (typeof raw.enabled !== 'boolean') throw new Error(`${name}.enabled must be true or false`)
    patch.enabled = raw.enabled
  }
  if (raw.deviceId !== undefined) {
    if (raw.deviceId !== null && typeof raw.deviceId !== 'string') {
      throw new Error(`${name}.deviceId must be a string or null`)
    }
    if (typeof raw.deviceId === 'string' && raw.deviceId.trim() === '') {
      throw new Error(`${name}.deviceId must not be empty`)
    }
    patch.deviceId = raw.deviceId === null ? null : (raw.deviceId as string).trim()
  }
  return patch
}

/** Parse `POST /api/settings/sensors`. */
function parseSensorPatchBody(body: Record<string, unknown>): SensorPreferencesPatch {
  const patch: { camera?: SensorPreferencePatch; microphone?: SensorPreferencePatch } = {}
  const camera = parseSensorPatch(body.camera, 'camera')
  const microphone = parseSensorPatch(body.microphone, 'microphone')
  if (camera !== undefined) patch.camera = camera
  if (microphone !== undefined) patch.microphone = microphone
  return patch
}

/**
 * Dispatch one settings request.
 *
 * The caller (`dashboard.ts`) has already checked the token and decided that
 * `pathname` is one of {@link SETTINGS_PATHS}; this function always answers or
 * throws (the dashboard turns an unexpected throw into `500`).
 */
export async function handleSettingsRequest(
  request: IncomingMessage,
  response: ServerResponse,
  deps: SettingsDeps,
): Promise<void> {
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`)
  const pathname = url.pathname

  if (request.method === 'GET' && pathname === '/api/settings') {
    try {
      sendJson(response, 200, await deps.snapshot())
    } catch (error) {
      if (isSettingsError(error)) {
        sendError(response, 400, error.message, error.code)
        return
      }
      throw error
    }
    return
  }

  if (request.method === 'POST' && pathname === '/api/settings/llm') {
    let body: Record<string, unknown>
    try {
      body = await readJsonBody(request)
    } catch (error) {
      sendError(response, 400, `invalid JSON body: ${error instanceof Error ? error.message : 'unreadable'}`)
      return
    }
    let patch: LlmSettingsPatch
    try {
      patch = parseLlmPatch(body)
    } catch (error) {
      sendError(response, 400, error instanceof Error ? error.message : 'invalid model settings')
      return
    }
    try {
      sendJson(response, 200, await deps.saveLlm(patch))
    } catch (error) {
      if (isSettingsError(error)) {
        sendError(response, error.code === 'FIXED_LLM_CONFIG' ? 409 : 400, error.message, error.code)
        return
      }
      throw error
    }
    return
  }

  if (request.method === 'POST' && pathname === '/api/settings/sensors') {
    let body: Record<string, unknown>
    try {
      body = await readJsonBody(request)
    } catch (error) {
      sendError(response, 400, `invalid JSON body: ${error instanceof Error ? error.message : 'unreadable'}`)
      return
    }
    let patch: SensorPreferencesPatch
    try {
      patch = parseSensorPatchBody(body)
    } catch (error) {
      sendError(response, 400, error instanceof Error ? error.message : 'invalid sensor settings')
      return
    }
    if (patch.camera === undefined && patch.microphone === undefined) {
      sendError(response, 400, 'camera or microphone settings are required')
      return
    }
    try {
      sendJson(response, 200, await deps.saveSensors(patch))
    } catch (error) {
      if (isSettingsError(error)) {
        sendError(response, 400, error.message, error.code)
        return
      }
      throw error
    }
    return
  }

  sendError(response, 405, `method not allowed on ${pathname}`)
}
