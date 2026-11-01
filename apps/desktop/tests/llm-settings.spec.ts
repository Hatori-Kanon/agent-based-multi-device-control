import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { FakeClock, resolveModel } from '@embodied/core'
import type { FetchLike, LlmConfig, ModelTurnRequest } from '@embodied/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHostRuntime, type HostRuntime } from '../src/main/bootstrap.ts'
import {
  DEFAULT_LLM_CONFIG,
  LLM_SETTINGS_VERSION,
  loadLlmConfig,
  loadLlmSettings,
  saveLlmConfig,
} from '../src/main/llm.ts'

let root: string
let runtime: HostRuntime | undefined

beforeEach(async () => {
  await mkdir(join(process.cwd(), '.test-tmp'), { recursive: true })
  root = await mkdtemp(join(process.cwd(), '.test-tmp', 'llm-'))
})

afterEach(async () => {
  await runtime?.shutdown()
  runtime = undefined
  await rm(root, { recursive: true, force: true })
})

interface RecordedLlmRequest {
  readonly url: string
  readonly headers: Record<string, string>
  readonly body: Record<string, unknown> | undefined
}

/**
 * A `FetchLike` that records the request and answers with one non-streaming
 * chat completion. Tests never touch the network (plan §4.9).
 */
function recordingFetch(): { fetch: FetchLike; requests: RecordedLlmRequest[] } {
  const requests: RecordedLlmRequest[] = []
  const fetch: FetchLike = (url, init) => {
    const wide = init as unknown as { headers?: Record<string, string>; body?: string }
    let body: Record<string, unknown> | undefined
    try {
      body = wide.body === undefined ? undefined : JSON.parse(wide.body) as Record<string, unknown>
    } catch {
      body = undefined
    }
    requests.push({ url, headers: wide.headers ?? {}, body })
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve({
        choices: [{ index: 0, message: { role: 'assistant', content: '好。' }, finish_reason: 'stop' }],
      }),
    })
  }
  return { fetch, requests }
}

function turnRequest(): ModelTurnRequest {
  return {
    messages: [
      { role: 'system', content: '你是主持' },
      { role: 'user', content: '我往后缩了一下' },
    ],
    tools: [],
    timeoutMs: 5_000,
    signal: new AbortController().signal,
  }
}

/** Start a runtime with the test defaults; the caller may override anything. */
async function start(overrides: Partial<Parameters<typeof createHostRuntime>[0]> = {}): Promise<HostRuntime> {
  const host = await createHostRuntime({
    dataDir: root,
    clock: new FakeClock(),
    withPanicServer: false,
    withButtplug: false,
    ...overrides,
  })
  runtime = host
  return host
}

async function writeLlmFile(value: unknown): Promise<void> {
  await mkdir(join(root, 'state'), { recursive: true })
  await writeFile(join(root, 'state', 'llm.json'), JSON.stringify(value, null, 2), 'utf8')
}

describe('host LLM settings (B1-T15)', () => {
  it('resolves the api key from the environment without writing it to the audit log', async () => {
    const http = recordingFetch()
    const apiKey = 'sk-env-secret-0123456789'
    const host = await start({ llmEnv: { EMBODIED_LLM_API_KEY: apiKey }, llmFetch: http.fetch })

    // Assembling the runtime is offline: the first request only happens on a turn.
    expect(http.requests).toHaveLength(0)
    expect(host.llmSummary()).toMatchObject({ apiKeySource: 'env', hasApiKey: true })
    expect(JSON.stringify(host.llmSummary())).not.toContain(apiKey)

    await host.modelRunner.run(turnRequest())
    expect(http.requests).toHaveLength(1)
    expect(http.requests[0]?.headers.authorization).toBe(`Bearer ${apiKey}`)

    // An environment key is never persisted, even when the config is saved.
    await saveLlmConfig(join(root, 'saved'), host.llm)
    expect(await readFile(join(root, 'saved', 'state', 'llm.json'), 'utf8')).not.toContain(apiKey)

    // The audit log has real lines, and none of them carries the key.
    await host.registry.emergencyStop('llm-settings-test')
    const audit = await readFile(join(root, 'audit', 'device.jsonl'), 'utf8')
    expect(audit).toContain('"panic"')
    expect(audit).not.toContain(apiKey)
    expect(JSON.stringify(host.snapshot())).not.toContain(apiKey)
  })

  it('falls back to the default model when director is null', async () => {
    await writeLlmFile({
      version: LLM_SETTINGS_VERSION,
      default: { provider: 'deepseek', model: 'deepseek-chat' },
      director: null,
      writer: null,
    })
    const http = recordingFetch()
    // A key is only needed to actually run the turn; the model choice under
    // test is the fallback, so the key is a fixed test value.
    const host = await start({ llmEnv: { EMBODIED_LLM_API_KEY: 'sk-fallback-test' }, llmFetch: http.fetch })

    expect(host.llm.director).toBeNull()
    expect(host.llmSummary().director).toBeNull()
    expect(host.llmSummary().singleCall.model).toBe('deepseek-chat')
    expect(resolveModel(host.llm, 'director')).toBe(host.llm.default)

    await host.modelRunner.run(turnRequest())
    expect(http.requests[0]?.body?.model).toBe('deepseek-chat')
  })

  it('keeps an api key from the settings file out of the audit log and snapshots', async () => {
    const apiKey = 'sk-file-secret-abcdef'
    await writeLlmFile({
      version: LLM_SETTINGS_VERSION,
      default: { provider: 'deepseek', model: 'deepseek-chat' },
      director: null,
      writer: null,
      apiKey,
    })
    const http = recordingFetch()
    const host = await start({ llmEnv: {}, llmFetch: http.fetch })

    expect(host.llmSummary()).toMatchObject({ apiKeySource: 'file', hasApiKey: true })
    await host.modelRunner.run(turnRequest())
    expect(http.requests[0]?.headers.authorization).toBe(`Bearer ${apiKey}`)

    await host.registry.emergencyStop('llm-settings-test')
    const audit = await readFile(join(root, 'audit', 'device.jsonl'), 'utf8')
    expect(audit).toContain('"panic"')
    expect(audit).not.toContain(apiKey)
    expect(JSON.stringify(host.snapshot())).not.toContain(apiKey)
    expect(JSON.stringify(host.llmSummary())).not.toContain(apiKey)
    // The prompt-facing config is secret-free by construction.
    expect(JSON.stringify(host.llm)).not.toContain(apiKey)
  })

  it('loads the documented defaults when the settings file is missing', async () => {
    const config = await loadLlmConfig(join(root, 'no-settings-here'))
    expect(config).toEqual(DEFAULT_LLM_CONFIG)
    expect(config.default).toEqual({ provider: 'deepseek', model: 'deepseek-chat' })
    expect(config.director).toBeNull()
    expect(config.writer).toBeNull()
  })

  it('falls back to the defaults for a corrupt settings file', async () => {
    await mkdir(join(root, 'state'), { recursive: true })
    await writeFile(join(root, 'state', 'llm.json'), '{ not json', 'utf8')
    expect(await loadLlmConfig(root)).toEqual(DEFAULT_LLM_CONFIG)
  })

  it('persists an explicit api key owner-only and lets the environment win over it', async () => {
    const config: LlmConfig = {
      default: { provider: 'openai', model: 'gpt-4o-mini' },
      director: null,
      writer: null,
    }
    const savedKey = 'sk-saved-secret'
    await saveLlmConfig(join(root, 'saved'), config, { apiKey: savedKey })

    const path = join(root, 'saved', 'state', 'llm.json')
    const raw = await readFile(path, 'utf8')
    const file = JSON.parse(raw) as {
      version: number
      default: { provider: string; model: string }
      director: unknown
      writer: unknown
      apiKey?: string
    }
    expect(file.version).toBe(LLM_SETTINGS_VERSION)
    expect(file.default).toEqual({ provider: 'openai', model: 'gpt-4o-mini' })
    expect(file.director).toBeNull()
    expect(file.writer).toBeNull()
    expect(file.apiKey).toBe(savedKey)

    // POSIX honours the 0o600 mode; Windows has no per-file mode to assert.
    if (process.platform !== 'win32') {
      expect((await stat(path)).mode & 0o777).toBe(0o600)
    }

    const fromFile = await loadLlmSettings(join(root, 'saved'), {})
    expect(fromFile.apiKey).toBe(savedKey)
    expect(fromFile.apiKeySource).toBe('file')

    const fromEnv = await loadLlmSettings(join(root, 'saved'), { EMBODIED_LLM_API_KEY: 'sk-env-wins' })
    expect(fromEnv.apiKey).toBe('sk-env-wins')
    expect(fromEnv.apiKeySource).toBe('env')
  })

  it('parses role models from the settings file for split mode', async () => {
    await writeLlmFile({
      version: LLM_SETTINGS_VERSION,
      default: { provider: 'deepseek', model: 'deepseek-chat' },
      director: { provider: 'openai', model: 'gpt-4o' },
      writer: { provider: 'deepseek', model: 'deepseek-reasoner' },
    })
    const config = await loadLlmConfig(root)
    expect(config.director?.model).toBe('gpt-4o')
    expect(config.writer?.model).toBe('deepseek-reasoner')
    expect(resolveModel(config, 'writer')).toBe(config.writer)
  })
})
