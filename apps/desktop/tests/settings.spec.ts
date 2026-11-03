import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { FakeClock, type FetchLike } from '@embodied/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHostRuntime, type HostRuntime } from '../src/main/bootstrap.ts'
import type { AudioHost } from '../src/main/sensors/audio-host.ts'
import type { CameraHost } from '../src/main/sensors/camera-host.ts'

let root: string
let runtime: HostRuntime | undefined

beforeEach(async () => {
  await mkdir(join(process.cwd(), '.test-tmp'), { recursive: true })
  root = await mkdtemp(join(process.cwd(), '.test-tmp', 'settings-'))
})

afterEach(async () => {
  await runtime?.shutdown()
  runtime = undefined
  await rm(root, { recursive: true, force: true })
})

// ── Helpers ────────────────────────────────────────────────────────────────

/** Start a runtime on the shared temp dir; the caller may override anything. */
async function start(
  overrides: Partial<Parameters<typeof createHostRuntime>[0]> = {},
): Promise<HostRuntime> {
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

function clientOf(host: HostRuntime): {
  get(path: string): Promise<Response>
  post(path: string, body: unknown): Promise<Response>
  json<T>(response: Response): Promise<T>
} {
  const address = host.dashboardAddress
  if (address === undefined) throw new Error('the runtime must expose the dashboard for this test')
  const base = `http://${address.host}:${address.port}`
  const headers = { 'x-control-token': host.dashboardToken, 'Content-Type': 'application/json' }
  return {
    get: async path => await fetch(`${base}${path}`, { headers: { 'x-control-token': host.dashboardToken } }),
    post: async (path, body) => await fetch(`${base}${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    }),
    json: async <T>(response: Response): Promise<T> => await response.json() as T,
  }
}

interface FakeCamera {
  readonly host: CameraHost
  readonly starts: string[]
  stops(): number
}

/** Camera host that records start/stop and can fail one chosen device. */
function fakeCameraHost(
  options: { readonly failDeviceId?: string; readonly failStop?: boolean; readonly failList?: boolean } = {},
): FakeCamera {
  const starts: string[] = []
  let stops = 0
  const host: CameraHost = {
    sourceId: 'usb-cam-1',
    label: 'USB 摄像头',
    listDevices: async () => {
      if (options.failList === true) throw new Error('enumerateDevices failed: NotFoundError')
      return [
        { deviceId: 'cam-1', label: 'USB Camera' },
        { deviceId: 'cam-2', label: '第二摄像头' },
      ]
    },
    start: async deviceId => {
      if (deviceId === options.failDeviceId) {
        throw new Error('getUserMedia failed: NotAllowedError: Permission denied')
      }
      starts.push(deviceId)
    },
    stop: async () => {
      stops += 1
      if (options.failStop === true) throw new Error('bridge stop failed')
    },
    latestJpeg: async () => undefined,
    onFeatures: () => () => {},
  }
  return { host, starts, stops: () => stops }
}

interface FakeAudio {
  readonly host: AudioHost
  readonly starts: string[]
  stops(): number
}

function fakeAudioHost(): FakeAudio {
  const starts: string[] = []
  let stops = 0
  const host: AudioHost = {
    sourceId: 'mic-1',
    label: '麦克风',
    listDevices: async () => [{ deviceId: 'mic-1', label: 'USB 麦克风' }],
    start: async deviceId => { starts.push(deviceId) },
    stop: async () => { stops += 1 },
    onFeatures: () => () => {},
  }
  return { host, starts, stops: () => stops }
}

interface SettingsBody {
  llm: {
    provider: string
    model: string
    baseUrl: string | null
    apiKeySource: 'env' | 'file' | 'none'
    apiKeyEnv: string
    hasApiKey: boolean
    split: boolean
    warning: string | null
  }
  sensors: {
    camera: {
      supported: boolean
      enabled: boolean
      deviceId: string | null
      devices: { deviceId: string; label: string }[]
      status: string
      error?: string
    }
    microphone: {
      supported: boolean
      enabled: boolean
      deviceId: string | null
      devices: { deviceId: string; label: string }[]
      status: string
      error?: string
    }
  }
}

async function readJsonFile(path: string): Promise<Record<string, any> | undefined> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as Record<string, any>
  } catch {
    return undefined
  }
}

const TEST_LLM = {
  default: { provider: 'fixture', model: 'fixture-model', baseUrl: 'http://fixture.invalid/v1' },
  director: null,
  writer: null,
} as const

// ── Suite ──────────────────────────────────────────────────────────────────

describe('settings API', () => {
  it('reports key-free model defaults and live capture status', async () => {
    const camera = fakeCameraHost()
    const audio = fakeAudioHost()
    const host = await start({ cameraHost: camera.host, audioHost: audio.host, llmEnv: {} })
    const client = clientOf(host)

    // Boot applied the documented defaults: camera on (first device), mic off.
    expect(camera.starts).toEqual(['cam-1'])
    expect(audio.starts).toEqual([])

    const response = await client.get('/api/settings')
    expect(response.status).toBe(200)
    const body = await client.json<SettingsBody>(response)
    expect(body.llm).toEqual({
      provider: 'deepseek',
      model: 'deepseek-chat',
      baseUrl: null,
      apiKeySource: 'none',
      apiKeyEnv: 'EMBODIED_LLM_API_KEY',
      hasApiKey: false,
      split: false,
      warning: null,
    })
    expect(body.sensors.camera).toMatchObject({
      supported: true,
      enabled: true,
      // The first device was auto-opened, so that is the device in use.
      deviceId: 'cam-1',
      status: 'running',
    })
    expect(body.sensors.camera.devices.map(device => device.deviceId)).toEqual(['cam-1', 'cam-2'])
    expect(body.sensors.microphone).toMatchObject({
      supported: true,
      enabled: false,
      deviceId: null,
      status: 'stopped',
    })
    expect(body.sensors.microphone.devices.map(device => device.deviceId)).toEqual(['mic-1'])

    // Every data route needs the control token, settings included.
    expect((await fetch(`http://${host.dashboardAddress!.host}:${host.dashboardAddress!.port}/api/settings`)).status)
      .toBe(401)
  })

  it('never returns a key and prefers the environment over the file', async () => {
    const host = await start({ llmEnv: { EMBODIED_LLM_API_KEY: 'env-secret-key' } })
    const client = clientOf(host)

    let body = await client.json<SettingsBody>(await client.get('/api/settings'))
    expect(body.llm).toMatchObject({ apiKeySource: 'env', hasApiKey: true })
    expect(JSON.stringify(body)).not.toContain('env-secret-key')

    // Saving a file key does not displace the environment key.
    const saved = await client.post('/api/settings/llm', { apiKey: 'file-secret-key' })
    expect(saved.status).toBe(200)
    body = await client.json<SettingsBody>(saved)
    expect(body.llm).toMatchObject({ apiKeySource: 'env', hasApiKey: true })
    expect(JSON.stringify(body)).not.toContain('file-secret-key')
    expect(JSON.stringify(body)).not.toContain('env-secret-key')

    const file = await readJsonFile(join(root, 'state', 'llm.json'))
    expect(file?.apiKey).toBe('file-secret-key')
  })

  it('persists a model change and keeps/clears the stored key as documented', async () => {
    const host = await start({ llmEnv: {} })
    const client = clientOf(host)

    const saved = await client.post('/api/settings/llm', {
      provider: 'openai',
      model: 'gpt-4o-mini',
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'sk-test-secret',
    })
    expect(saved.status).toBe(200)
    const body = await client.json<SettingsBody>(saved)
    expect(body.llm).toEqual({
      provider: 'openai',
      model: 'gpt-4o-mini',
      baseUrl: 'https://api.example.com/v1',
      apiKeySource: 'file',
      apiKeyEnv: 'EMBODIED_LLM_API_KEY',
      hasApiKey: true,
      split: false,
      warning: null,
    })
    expect(JSON.stringify(body)).not.toContain('sk-test-secret')
    const first = await readJsonFile(join(root, 'state', 'llm.json'))
    expect(first?.default).toMatchObject({
      provider: 'openai',
      model: 'gpt-4o-mini',
      baseUrl: 'https://api.example.com/v1',
    })
    expect(first?.apiKey).toBe('sk-test-secret')

    // An omitted apiKey keeps the stored one.
    const changed = await client.post('/api/settings/llm', { model: 'gpt-4o' })
    expect(changed.status).toBe(200)
    expect((await client.json<SettingsBody>(changed)).llm.model).toBe('gpt-4o')
    expect((await readJsonFile(join(root, 'state', 'llm.json')))?.apiKey).toBe('sk-test-secret')

    // An empty apiKey clears it.
    const cleared = await client.post('/api/settings/llm', { apiKey: '' })
    expect(cleared.status).toBe(200)
    expect(await client.json<SettingsBody>(cleared)).toMatchObject({
      llm: { apiKeySource: 'none', hasApiKey: false, model: 'gpt-4o' },
    })
    expect((await readJsonFile(join(root, 'state', 'llm.json')))?.apiKey).toBeUndefined()

    // The change is reflected by the runtime itself (the next turn's runner).
    expect(host.llm.default).toMatchObject({ provider: 'openai', model: 'gpt-4o' })
    expect(host.llmSummary()).toMatchObject({ apiKeySource: 'none', hasApiKey: false })
  })

  it('rejects invalid model settings with 400 and writes nothing', async () => {
    const host = await start({ llmEnv: {} })
    const client = clientOf(host)

    const cases: Record<string, unknown>[] = [
      { provider: '' },
      { provider: 'x'.repeat(201) },
      { model: 'x'.repeat(201) },
      { baseUrl: 'ftp://example.com' },
      { baseUrl: 'not a url' },
      { apiKey: 'k'.repeat(4_097) },
      { provider: 42 },
    ]
    for (const payload of cases) {
      const response = await client.post('/api/settings/llm', payload)
      expect(response.status).toBe(400)
      const body = await client.json<{ ok: boolean; error: string }>(response)
      expect(body.ok).toBe(false)
      expect(typeof body.error).toBe('string')
    }
    expect(await readJsonFile(join(root, 'state', 'llm.json'))).toBeUndefined()
  })

  it('refuses model writes when the host runs an in-memory config', async () => {
    const host = await start({ llmConfig: TEST_LLM, llmEnv: {} })
    const response = await clientOf(host).post('/api/settings/llm', { model: 'other-model' })
    expect(response.status).toBe(409)
    const body = await clientOf(host).json<{ ok: boolean; error: string; code: string }>(response)
    expect(body.code).toBe('FIXED_LLM_CONFIG')
    expect(body.error).toContain('in-memory')
  })

  it('starts and stops capture from sensor preferences and persists them', async () => {
    const camera = fakeCameraHost()
    const audio = fakeAudioHost()
    const host = await start({ cameraHost: camera.host, audioHost: audio.host })
    const client = clientOf(host)

    // Turn the camera off: capture stops and the preference is persisted.
    const off = await client.post('/api/settings/sensors', { camera: { enabled: false } })
    expect(off.status).toBe(200)
    expect((await client.json<SettingsBody>(off)).sensors.camera).toMatchObject({
      enabled: false,
      status: 'stopped',
    })
    expect(camera.stops()).toBe(1)

    // Turn the microphone on with an explicit device.
    const micOn = await client.post('/api/settings/sensors', {
      microphone: { enabled: true, deviceId: 'mic-1' },
    })
    expect(micOn.status).toBe(200)
    expect((await client.json<SettingsBody>(micOn)).sensors.microphone).toMatchObject({
      enabled: true,
      deviceId: 'mic-1',
      status: 'running',
    })
    expect(audio.starts).toEqual(['mic-1'])

    const file = await readJsonFile(join(root, 'state', 'settings.json'))
    expect(file).toMatchObject({
      version: 1,
      sensors: {
        camera: { enabled: false, deviceId: null },
        microphone: { enabled: true, deviceId: 'mic-1' },
      },
    })

    // A restart applies the saved preferences: camera stays off, mic starts.
    await host.shutdown()
    runtime = undefined
    const camera2 = fakeCameraHost()
    const audio2 = fakeAudioHost()
    const restarted = await start({ cameraHost: camera2.host, audioHost: audio2.host })
    expect(camera2.starts).toEqual([])
    expect(audio2.starts).toEqual(['mic-1'])
    const body = await clientOf(restarted).json<SettingsBody>(await clientOf(restarted).get('/api/settings'))
    expect(body.sensors.camera).toMatchObject({ enabled: false, status: 'stopped' })
    expect(body.sensors.microphone).toMatchObject({ enabled: true, deviceId: 'mic-1', status: 'running' })
  })

  it('rejects an unknown capture device with 400', async () => {
    const camera = fakeCameraHost()
    const host = await start({ cameraHost: camera.host })
    const response = await clientOf(host).post('/api/settings/sensors', {
      camera: { deviceId: 'ghost-cam' },
    })
    expect(response.status).toBe(400)
    const body = await clientOf(host).json<{ ok: boolean; error: string; code: string }>(response)
    expect(body.code).toBe('INVALID_SENSOR')
    expect(body.error).toContain('ghost-cam')

    const settings = await clientOf(host).json<SettingsBody>(await clientOf(host).get('/api/settings'))
    // The camera is still running its original device; the bad patch changed nothing.
    expect(settings.sensors.camera.deviceId).toBe('cam-1')
    // The failed patch did not start anything new.
    expect(camera.starts).toEqual(['cam-1'])
  })

  it('reports a failed capture start as status error instead of 500', async () => {
    const camera = fakeCameraHost({ failDeviceId: 'cam-2' })
    const host = await start({ cameraHost: camera.host })
    const client = clientOf(host)

    const response = await client.post('/api/settings/sensors', {
      camera: { deviceId: 'cam-2' },
    })
    // A refused getUserMedia is a state the page must show, not a host fault.
    expect(response.status).toBe(200)
    const body = await client.json<SettingsBody>(response)
    expect(body.sensors.camera).toMatchObject({
      supported: true,
      enabled: true,
      deviceId: 'cam-2',
      status: 'error',
    })
    expect(body.sensors.camera.error).toContain('Permission denied')
    // The preference is still saved, so the next boot retries it.
    const file = await readJsonFile(join(root, 'state', 'settings.json'))
    expect(file?.sensors.camera).toMatchObject({ enabled: true, deviceId: 'cam-2' })
  })

  it('reports both sensors as unsupported when the host has no capture workers', async () => {
    const host = await start({ llmEnv: {} })
    const body = await clientOf(host).json<SettingsBody>(await clientOf(host).get('/api/settings'))
    expect(body.sensors.camera).toEqual({
      supported: false,
      enabled: false,
      deviceId: null,
      devices: [],
      status: 'unavailable',
    })
    expect(body.sensors.microphone).toEqual({
      supported: false,
      enabled: false,
      deviceId: null,
      devices: [],
      status: 'unavailable',
    })
  })

  it('serves the settings page script and the /settings deep link', async () => {
    const host = await start({})
    const client = clientOf(host)
    const script = await client.get('/settings.js')
    expect(script.status).toBe(200)
    expect(script.headers.get('content-type')).toContain('javascript')
    expect(await script.text()).toContain('/api/settings')
    const page = await client.get('/settings')
    expect(page.status).toBe(200)
    expect(page.headers.get('content-type')).toContain('text/html')
  })

  it('applies a saved model config to the next turn without a host restart', async () => {
    await installDemoPack(root)
    const gateway = new FixtureGateway([{ text: '好。', plan: simplePlan() }])
    const host = await start({ llmFetch: gateway.fetch, llmEnv: {} })
    const client = clientOf(host)
    await host.registry.connect('mock-pulse', new AbortController().signal)

    const saved = await client.post('/api/settings/llm', {
      provider: 'fixture',
      model: 'fixture-model-next',
      baseUrl: 'https://fixture.invalid/v1',
      apiKey: 'sk-fixture',
    })
    expect(saved.status).toBe(200)

    // Start a session *after* the save: its first turn must use the new model,
    // which proves the session's runner provider reads the swapped runner.
    const started = await client.post('/api/session/start', { packId: 'demo', plannedMinutes: 20 })
    expect(started.status).toBe(200)
    expect(gateway.calls).toHaveLength(1)
    expect(gateway.calls[0]?.url).toContain('fixture.invalid')
    expect(gateway.calls[0]?.body.model).toBe('fixture-model-next')
  })

  it('refuses a model config the gateway cannot construct and writes nothing', async () => {
    const host = await start({ llmEnv: {} })
    const client = clientOf(host)
    const before = await client.json<SettingsBody>(await client.get('/api/settings'))

    // No default endpoint for this provider and no baseUrl: the runner throws
    // on construction, so persisting it would make every later boot fail.
    const response = await client.post('/api/settings/llm', { provider: 'acme' })
    expect(response.status).toBe(400)
    const body = await client.json<{ ok: boolean; error: string; code: string }>(response)
    expect(body.ok).toBe(false)
    expect(body.code).toBe('INVALID_LLM')
    expect(body.error).toContain('baseUrl')
    // The rejection happened before the write: no file, no host change.
    expect(await readJsonFile(join(root, 'state', 'llm.json'))).toBeUndefined()
    const after = await client.json<SettingsBody>(await client.get('/api/settings'))
    expect(after.llm).toEqual(before.llm)
    expect(host.llm.default).toMatchObject({ provider: 'deepseek', model: 'deepseek-chat' })
  })

  it('boots on the built-in default when state/llm.json names an unrunnable model', async () => {
    await mkdir(join(root, 'state'), { recursive: true })
    await writeFile(join(root, 'state', 'llm.json'), JSON.stringify({
      version: 1,
      default: { provider: 'acme', model: 'no-endpoint' },
      director: null,
      writer: null,
    }))
    // A hand-edited file must never make the console unbootable.
    const host = await start({ llmEnv: {} })
    expect(host.llm.default).toMatchObject({ provider: 'deepseek', model: 'deepseek-chat' })
    const body = await clientOf(host).json<SettingsBody>(await clientOf(host).get('/api/settings'))
    expect(body.llm).toMatchObject({ provider: 'deepseek', model: 'deepseek-chat', apiKeySource: 'none' })
    // The operator's file is left alone so they can see and fix what they wrote.
    expect((await readJsonFile(join(root, 'state', 'llm.json')))?.default).toMatchObject({
      provider: 'acme',
      model: 'no-endpoint',
    })
    // A valid save recovers the model without a restart.
    const saved = await clientOf(host).post('/api/settings/llm', { provider: 'deepseek', model: 'deepseek-chat' })
    expect(saved.status).toBe(200)
    expect((await readJsonFile(join(root, 'state', 'llm.json')))?.default).toMatchObject({
      provider: 'deepseek',
      model: 'deepseek-chat',
    })
  })

  it('keeps the file key when an environment key shadows it and apiKey is omitted', async () => {
    const host = await start({ llmEnv: { EMBODIED_LLM_API_KEY: 'env-secret' } })
    const client = clientOf(host)
    expect((await client.post('/api/settings/llm', { apiKey: 'file-secret' })).status).toBe(200)
    // A save that does not mention the key must not delete the file copy just
    // because the resolved key currently comes from the environment.
    expect((await client.post('/api/settings/llm', { model: 'deepseek-chat' })).status).toBe(200)
    expect((await readJsonFile(join(root, 'state', 'llm.json')))?.apiKey).toBe('file-secret')
    const body = await client.json<SettingsBody>(await client.get('/api/settings'))
    expect(body.llm).toMatchObject({ apiKeySource: 'env', hasApiKey: true })
  })

  it('serialises concurrent settings writes instead of dropping one side', async () => {
    const camera = fakeCameraHost()
    const audio = fakeAudioHost()
    const host = await start({ cameraHost: camera.host, audioHost: audio.host })
    const client = clientOf(host)
    const [cameraOff, micOn] = await Promise.all([
      client.post('/api/settings/sensors', { camera: { enabled: false } }),
      client.post('/api/settings/sensors', { microphone: { enabled: true } }),
    ])
    expect(cameraOff.status).toBe(200)
    expect(micOn.status).toBe(200)
    const file = await readJsonFile(join(root, 'state', 'settings.json'))
    expect(file?.sensors.camera.enabled).toBe(false)
    expect(file?.sensors.microphone.enabled).toBe(true)
    const body = await client.json<SettingsBody>(await client.get('/api/settings'))
    expect(body.sensors.camera).toMatchObject({ enabled: false, status: 'stopped' })
    expect(body.sensors.microphone).toMatchObject({ enabled: true, status: 'running' })
  })

  it('stops capture on shutdown', async () => {
    const camera = fakeCameraHost()
    const audio = fakeAudioHost()
    const host = await start({ cameraHost: camera.host, audioHost: audio.host })
    const client = clientOf(host)
    expect((await client.post('/api/settings/sensors', { microphone: { enabled: true } })).status).toBe(200)
    expect(camera.stops()).toBe(0)
    expect(audio.stops()).toBe(0)
    await host.shutdown()
    runtime = undefined
    // Both capture streams must be released by the graceful quit path.
    expect(camera.stops()).toBe(1)
    expect(audio.stops()).toBe(1)
  })

  it('refuses cleartext remote endpoints and accepts loopback http', async () => {
    const host = await start({ llmEnv: {} })
    const client = clientOf(host)

    // Remote http would send the bearer key in clear text.
    expect((await client.post('/api/settings/llm', { baseUrl: 'http://example.com/v1' })).status).toBe(400)
    // Userinfo would put a password in a URL that is echoed and audited.
    expect((await client.post('/api/settings/llm', {
      baseUrl: 'https://user:pass@example.com/v1',
    })).status).toBe(400)
    // A local model server may stay on http.
    const local = await client.post('/api/settings/llm', {
      provider: 'ollama',
      model: 'llama3',
      baseUrl: 'http://127.0.0.1:11434/v1',
    })
    expect(local.status).toBe(200)
    expect((await client.json<SettingsBody>(local)).llm).toMatchObject({
      provider: 'ollama',
      model: 'llama3',
      baseUrl: 'http://127.0.0.1:11434/v1',
    })
  })

  it('reports a failed capture stop as an error state instead of "stopped"', async () => {
    const camera = fakeCameraHost({ failStop: true })
    const host = await start({ cameraHost: camera.host })
    const client = clientOf(host)

    const off = await client.post('/api/settings/sensors', { camera: { enabled: false } })
    expect(off.status).toBe(200)
    const body = await client.json<SettingsBody>(off)
    expect(body.sensors.camera).toMatchObject({ supported: true, enabled: false, status: 'error' })
    expect(body.sensors.camera.error).toContain('stop failed')
    expect(camera.stops()).toBe(1)
  })

  it('reports a capture-enumeration failure instead of an empty device list', async () => {
    const camera = fakeCameraHost({ failList: true })
    const host = await start({ cameraHost: camera.host })
    const body = await clientOf(host).json<SettingsBody>(await clientOf(host).get('/api/settings'))
    expect(body.sensors.camera.supported).toBe(true)
    expect(body.sensors.camera.status).toBe('error')
    expect(body.sensors.camera.error).toContain('enumerateDevices')
    // Boot could not start capture either; the source must not claim to run.
    expect(camera.starts).toEqual([])
  })

  it('sanitises an invalid director so the settings page can repair the file', async () => {
    await mkdir(join(root, 'state'), { recursive: true })
    await writeFile(join(root, 'state', 'llm.json'), JSON.stringify({
      version: 1,
      default: { provider: 'deepseek', model: 'deepseek-chat' },
      // The single-call lane resolves the director first; this role is
      // unrunnable (unknown provider, no baseUrl) and used to brick saves.
      director: { provider: 'acme', model: 'no-endpoint' },
      writer: null,
    }))
    const host = await start({ llmEnv: {} })
    const client = clientOf(host)
    const before = await client.json<SettingsBody>(await client.get('/api/settings'))
    expect(before.llm.warning).toContain('director')
    expect(before.llm.split).toBe(false)

    // Saving the default model now succeeds and drops the invalid role from the
    // file, so the page can repair a hand-edited configuration.
    const saved = await client.post('/api/settings/llm', { model: 'deepseek-reasoner' })
    expect(saved.status).toBe(200)
    const file = await readJsonFile(join(root, 'state', 'llm.json'))
    expect(file?.default.model).toBe('deepseek-reasoner')
    expect(file?.director).toBeNull()
    const after = await client.json<SettingsBody>(await client.get('/api/settings'))
    expect(after.llm.warning).toBeNull()
    expect(after.llm.split).toBe(false)
  })

  it('keeps a valid director/writer configuration and says so', async () => {
    await mkdir(join(root, 'state'), { recursive: true })
    await writeFile(join(root, 'state', 'llm.json'), JSON.stringify({
      version: 1,
      default: { provider: 'deepseek', model: 'deepseek-chat' },
      director: { provider: 'deepseek', model: 'deepseek-reasoner' },
      writer: null,
    }))
    const host = await start({ llmEnv: {} })
    const client = clientOf(host)
    const before = await client.json<SettingsBody>(await client.get('/api/settings'))
    expect(before.llm.split).toBe(true)
    expect(before.llm.warning).toContain('director')

    expect((await client.post('/api/settings/llm', { model: 'deepseek-chat' })).status).toBe(200)
    const file = await readJsonFile(join(root, 'state', 'llm.json'))
    expect(file?.director).toMatchObject({ provider: 'deepseek', model: 'deepseek-reasoner' })
  })

  it('drops simulated devices left in an upgraded device manifest', async () => {
    await mkdir(join(root, 'state'), { recursive: true })
    await writeFile(join(root, 'state', 'devices.json'), JSON.stringify({
      version: 3,
      devices: [
        { key: 'mock', protocol: 'mock' },
        { key: 'coyote', protocol: 'coyote' },
      ],
    }))
    const host = await start({ llmEnv: {} })
    // No manifest entry may resurrect fake hardware; the file is rewritten.
    expect(host.listDevices().map(device => device.key)).not.toContain('mock')
    const file = await readJsonFile(join(root, 'state', 'devices.json'))
    expect((file?.devices as Array<{ key: string }>).map(entry => entry.key)).not.toContain('mock')
    expect(host.listDevices().map(device => device.key)).toContain('coyote')
  })

  it('applies a model change to the next turn of a running session', async () => {
    await installDemoPack(root)
    const gateway = new FixtureGateway([
      { text: '第一回合。', plan: simplePlan() },
      // Every scripted turn carries `apply_plan`: a prose-only reply now gets
      // one corrective retry (the model must always plan), and that retry is a
      // second HTTP call to the gateway. This test asserts the *runner swap*
      // via `gateway.calls` length, so both turns must be single-call.
      { text: '第二回合。', plan: simplePlan() },
    ])
    const host = await start({ llmFetch: gateway.fetch, llmEnv: {} })
    const client = clientOf(host)
    await host.registry.connect('mock-pulse', new AbortController().signal)
    // A constructible model + key must exist before the first turn (otherwise
    // the opening turn fails before reaching the network boundary).
    expect((await client.post('/api/settings/llm', {
      provider: 'fixture',
      model: 'fixture-model-first',
      baseUrl: 'https://first.invalid/v1',
      apiKey: 'sk-fixture',
    })).status).toBe(200)
    expect((await client.post('/api/session/start', { packId: 'demo', plannedMinutes: 20 })).status).toBe(200)
    expect(gateway.calls).toHaveLength(1)
    expect(gateway.calls[0]?.url).toContain('first.invalid')

    // Save a different endpoint while the session is still open.
    const saved = await client.post('/api/settings/llm', {
      provider: 'fixture',
      model: 'fixture-model-swapped',
      baseUrl: 'https://swapped.invalid/v1',
    })
    expect(saved.status).toBe(200)
    expect((await client.post('/api/session/message', { text: '继续' })).status).toBe(200)

    // The second turn resolved the swapped runner without a host restart.
    expect(gateway.calls).toHaveLength(2)
    expect(gateway.calls[1]?.url).toContain('swapped.invalid')
    expect(gateway.calls[1]?.body.model).toBe('fixture-model-swapped')
  })
})

// ── Session fixtures (mirrors m2-e2e.spec: real runtime, fixture fetch) ─────

interface RecordedCall {
  readonly url: string
  readonly body: Record<string, unknown>
}

interface ScriptedTurn {
  readonly text: string
  readonly plan?: Record<string, unknown>
}

/** Offline model boundary: scripted completions, recorded requests, no socket. */
class FixtureGateway {
  readonly calls: RecordedCall[] = []
  private readonly turns: ScriptedTurn[]

  constructor(turns: readonly ScriptedTurn[]) {
    this.turns = [...turns]
  }

  readonly fetch: FetchLike = async (url, init) => {
    const raw = (init as { readonly body?: string } | undefined)?.body
    const body = raw === undefined ? {} : JSON.parse(raw) as Record<string, unknown>
    this.calls.push({ url, body })
    const turn = this.turns.shift()
    if (turn === undefined) throw new Error('the fixture gateway ran out of scripted turns')
    const toolCalls = turn.plan === undefined
      ? undefined
      : [{ id: 'call_1', type: 'function', function: { name: 'apply_plan', arguments: JSON.stringify(turn.plan) } }]
    return {
      ok: true,
      status: 200,
      json: async (): Promise<unknown> => ({
        id: 'chatcmpl-fixture',
        object: 'chat.completion',
        choices: [{
          index: 0,
          message: { role: 'assistant', content: turn.text, ...(toolCalls === undefined ? {} : { tool_calls: toolCalls }) },
          finish_reason: 'stop',
        }],
      }),
    }
  }
}

/** A plan the fixture pack's scenario can resolve against the mock devices. */
function simplePlan(): Record<string, unknown> {
  return {
    pacing: 'probe',
    beats: [{
      id: 'b1',
      intentId: 'probe-touch',
      regions: ['whole-body'],
      strength: 'low',
      targets: [{ deviceId: 'mock-pulse', channelId: 'a' }],
    }],
  }
}

/** Copy the freeform fixture pack into `<dataDir>/content/packs/demo/1.0.0/`. */
async function installDemoPack(dataDir: string): Promise<void> {
  const source = fileURLToPath(new URL('./fixtures/m2/pack-freeform/', import.meta.url))
  const target = join(dataDir, 'content', 'packs', 'demo', '1.0.0')
  await mkdir(target, { recursive: true })
  for (const name of ['pack.json', 'persona.md', 'setting.md']) {
    await writeFile(join(target, name), await readFile(join(source, name), 'utf8'))
  }
}
