import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { deflateRawSync } from 'node:zlib'
import {
  FakeClock,
  M2_MODEL_TOOLS,
  probeDirectorJson,
  probePromptBlock,
  type AuditRecord,
  type ProbeRecord,
} from '@embodied/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHostRuntime, type HostRuntime } from '../src/main/bootstrap.ts'
import { DashboardServer, type DashboardDeps } from '../src/main/dashboard.ts'
import type { CameraHost } from '../src/main/sensors/camera-host.ts'

let root: string
let runtime: HostRuntime | undefined

beforeEach(async () => {
  await mkdir(join(process.cwd(), '.test-tmp'), { recursive: true })
  root = await mkdtemp(join(process.cwd(), '.test-tmp', 'dash-'))
})

afterEach(async () => {
  await runtime?.shutdown()
  runtime = undefined
  await rm(root, { recursive: true, force: true })
})

async function auditRecords(): Promise<AuditRecord[]> {
  const { readFile } = await import('node:fs/promises')
  const raw = await readFile(join(root, 'audit', 'device.jsonl'), 'utf8')
  return raw.trimEnd().split('\n').map(line => JSON.parse(line) as AuditRecord)
}

function base(runtime: HostRuntime): string {
  const address = runtime.dashboardAddress!
  return `http://${address.host}:${address.port}`
}

async function start(): Promise<HostRuntime> {
  const clock = new FakeClock()
  const errors: unknown[] = []
  runtime = await createHostRuntime({
    dataDir: root,
    clock,
    withPanicServer: false,
    withButtplug: false,
    onError: error => { errors.push(error) },
  })
  return runtime
}

function headers(token: string, json = false): Record<string, string> {
  return {
    'x-control-token': token,
    ...(json ? { 'Content-Type': 'application/json' } : {}),
  }
}

describe('DashboardServer', () => {
  it('publishes its token and address', async () => {
    const host = await start()
    expect(host.dashboardToken.length).toBeGreaterThanOrEqual(16)
    expect(host.dashboardAddress?.port).toBeGreaterThan(0)

    const raw = await host.documents.read('dashboard')
    expect(raw).toBeDefined()
    const persisted = JSON.parse(raw!) as { token: string; host: string; port: number }
    expect(persisted.token).toBe(host.dashboardToken)
    expect(persisted.host).toBe('127.0.0.1')
  })

  it('serves the console page itself', async () => {
    const host = await start()
    const response = await fetch(`${base(host)}/`, { headers: headers(host.dashboardToken) })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/html')
    expect(await response.text()).toContain('Embodied 控制台')
  })

  it('serves the static UI without a token so app.js actually runs', async () => {
    // A <script src> tag cannot send headers, and the page URL carries the
    // token only for its own navigation. Requiring it here returned 401 JSON,
    // whose MIME type makes Chromium refuse to execute app.js — the whole
    // console went silent. This is the regression test for that.
    const host = await start()
    const page = await fetch(`${base(host)}/`)
    expect(page.status).toBe(200)
    expect(page.headers.get('content-type')).toContain('text/html')
    const html = await page.text()
    expect(html).toContain('Embodied 控制台')

    const script = await fetch(`${base(host)}/app.js`)
    expect(script.status).toBe(200)
    expect(script.headers.get('content-type')).toContain('javascript')
    expect(await script.text()).toContain('api/snapshot')

    // The UI talks to the API over fetch(). With `default-src 'none'` and no
    // connect-src, connect-src falls back to 'none' and every fetch is blocked
    // by the browser — the console shows "Failed to fetch" and nothing loads.
    expect(html).toMatch(/connect-src 'self'/)
  })

  it('answers nothing without the token', async () => {
    const host = await start()
    const anonymous = await fetch(`${base(host)}/api/snapshot`)
    expect(anonymous.status).toBe(401)

    const wrong = await fetch(`${base(host)}/api/snapshot`, {
      headers: { 'x-control-token': 'x'.repeat(host.dashboardToken.length) },
    })
    expect(wrong.status).toBe(401)
  })

  it('returns the live snapshot over the API', async () => {
    const host = await start()
    const response = await fetch(`${base(host)}/api/snapshot`, { headers: headers(host.dashboardToken) })
    expect(response.status).toBe(200)
    const body = await response.json() as { locked: boolean; devices: Array<{ id: string; lifecycle: string }> }
    expect(body.locked).toBe(false)
    expect(body.devices.map(device => device.id)).toEqual(['mock-pulse', 'mock-hold'])
    // Nothing auto-connects; the 连接 button drives the link.
    expect(body.devices.every(device => device.lifecycle === 'disconnected')).toBe(true)
  })

  it('exposes the background log buffer over the API', async () => {
    const host = await start()
    const response = await fetch(`${base(host)}/api/logs`, { headers: headers(host.dashboardToken) })
    expect(response.status).toBe(200)
    const body = await response.json() as { lines: string[] }
    expect(Array.isArray(body.lines)).toBe(true)
  })

  it('adds and removes manifest devices over the API', async () => {
    const host = await start()
    const token = host.dashboardToken

    let response = await fetch(`${base(host)}/api/devices`, { headers: headers(token) })
    expect(response.status).toBe(200)
    let body: { devices: Array<{ key: string }>; snapshot?: { devices: Array<{ id: string }> } } = await response.json()
    expect(body.devices).toEqual([])

    response = await fetch(`${base(host)}/api/devices`, {
      method: 'POST',
      headers: headers(token, true),
      body: JSON.stringify({ protocol: 'mock' }),
    })
    expect(response.status).toBe(200)
    body = await response.json()
    const devices = body.devices
    expect(devices.map(device => device.key)).toContain('mock')
    expect(body.snapshot!.devices.some(device => device.id === 'mock')).toBe(true)

    response = await fetch(`${base(host)}/api/devices/remove`, {
      method: 'POST',
      headers: headers(token, true),
      body: JSON.stringify({ key: 'mock' }),
    })
    expect(response.status).toBe(200)
    body = await response.json()
    expect(body.snapshot!.devices.some(device => device.id === 'mock')).toBe(false)
    expect(body.devices).toEqual([])
  })

  it('rejects an unknown add protocol with 400', async () => {
    const host = await start()
    const response = await fetch(`${base(host)}/api/devices`, {
      method: 'POST',
      headers: headers(host.dashboardToken, true),
      body: JSON.stringify({ protocol: 'telepath' }),
    })
    expect(response.status).toBe(400)
  })

  it('runs a pattern, stops a channel, and changes a cap', async () => {
    const host = await start()
    const token = host.dashboardToken
    const connect = await fetch(`${base(host)}/api/connect`, {
      method: 'POST',
      headers: headers(token, true),
      body: JSON.stringify({ deviceId: 'mock-pulse' }),
    })
    expect(connect.status).toBe(200)

    const pattern = await fetch(`${base(host)}/api/pattern`, {
      method: 'POST',
      headers: headers(token, true),
      body: JSON.stringify({
        deviceId: 'mock-pulse', channelId: 'a',
        preset: 'steady', minPercent: 12, maxPercent: 12, periodMs: 1_000, jitter: 0, durationSec: 30,
      }),
    })
    expect(pattern.status).toBe(200)

    const cap = await fetch(`${base(host)}/api/cap`, {
      method: 'POST',
      headers: headers(token, true),
      body: JSON.stringify({ deviceId: 'mock-pulse', channelId: 'a', patch: { maxPercent: 55 } }),
    })
    expect(cap.status).toBe(200)
    const afterCap = await cap.json() as { devices: Array<{ id: string; channels: Array<{ id: string; maxPercent: number }> }> }
    expect(afterCap.devices.find(device => device.id === 'mock-pulse')?.channels.find(channel => channel.id === 'a')?.maxPercent).toBe(55)

    const stop = await fetch(`${base(host)}/api/stop`, {
      method: 'POST',
      headers: headers(token, true),
      body: JSON.stringify({ deviceId: 'mock-pulse', channelId: 'a' }),
    })
    expect(stop.status).toBe(200)
    const afterStop = await stop.json() as { devices: Array<{ id: string; channels: Array<{ id: string; percent: number }> }> }
    expect(afterStop.devices.find(device => device.id === 'mock-pulse')?.channels.find(channel => channel.id === 'a')?.percent).toBe(0)

    const records = await auditRecords()
    expect(records.some(record => record.action === 'run_pattern' && record.result === 'ok')).toBe(true)
    expect(records.some(record => record.action === 'policy_change' && record.actor === 'human')).toBe(true)
  })

  it('panics, locks, and unlocks', async () => {
    const host = await start()
    const token = host.dashboardToken
    await fetch(`${base(host)}/api/connect`, {
      method: 'POST',
      headers: headers(token, true),
      body: JSON.stringify({ deviceId: 'mock-pulse' }),
    })

    const panic = await fetch(`${base(host)}/api/panic`, {
      method: 'POST',
      headers: headers(token, true),
      body: JSON.stringify({ source: 'web-ui-test' }),
    })
    expect(panic.status).toBe(200)
    const locked = await panic.json() as { locked: boolean; devices: Array<{ channels: Array<{ percent: number }> }> }
    expect(locked.locked).toBe(true)
    expect(locked.devices.flatMap(device => device.channels).every(channel => channel.percent === 0)).toBe(true)

    // Model-style writes are refused through the console too.
    const refused = await fetch(`${base(host)}/api/pattern`, {
      method: 'POST',
      headers: headers(token, true),
      body: JSON.stringify({
        deviceId: 'mock-pulse', channelId: 'a',
        preset: 'steady', minPercent: 20, maxPercent: 20, periodMs: 1_000, jitter: 0, durationSec: 10,
      }),
    })
    expect(refused.status).toBe(500)

    const unlock = await fetch(`${base(host)}/api/unlock`, {
      method: 'POST',
      headers: headers(token, true),
      body: JSON.stringify({ note: 'test unlock' }),
    })
    expect(unlock.status).toBe(200)
    expect(((await unlock.json()) as { locked: boolean }).locked).toBe(false)
  })

  it('imports, lists, and promotes a waveform', async () => {
    const host = await start()
    const token = host.dashboardToken

    const imported = await fetch(`${base(host)}/api/waveforms/import`, {
      method: 'POST',
      headers: headers(token, true),
      body: JSON.stringify({ name: '测试波形', frames: '0A0A0A0A00000000 0A0A0A0A64646464' }),
    })
    expect(imported.status).toBe(200)
    const body = await imported.json() as { imported: { id: string }; waveforms: Array<{ id: string; scope: string }> }
    expect(body.waveforms.find(entry => entry.id === body.imported.id)?.scope).toBe('session')

    const promoted = await fetch(`${base(host)}/api/waveforms/promote`, {
      method: 'POST',
      headers: headers(token, true),
      body: JSON.stringify({ id: body.imported.id }),
    })
    expect(promoted.status).toBe(200)
    const after = await promoted.json() as { waveforms: Array<{ id: string; scope: string }> }
    expect(after.waveforms.find(entry => entry.id === body.imported.id)?.scope).toBe('library')
  })

  it('rejects an unknown endpoint with a clean 404', async () => {
    const host = await start()
    const response = await fetch(`${base(host)}/api/does-not-exist`, { headers: headers(host.dashboardToken) })
    expect(response.status).toBe(404)
  })
})

const DEBUG_TOKEN = 'debug-console-token'

/** One settled probe with numbers the default console must never render. */
const DEBUG_PROBE: ProbeRecord = {
  probeId: 'p-0007',
  turnId: 3,
  beatId: 'b-2',
  intentId: 'probe-touch',
  trigger: 'passive',
  actionAt: 12_000,
  targets: [{ deviceId: 'mock-pulse', channelId: 'a' }],
  baseline: undefined,
  window: undefined,
  delta: { motion: 0.31, audioPct: 18 },
  verdict: 'responded',
}

/**
 * The smallest dependency set the debug routes need (A2-T7).
 *
 * Everything the debug paths do not touch throws, so a later refactor that
 * makes `GET /api/debug` reach for, say, `listWaveforms` fails loudly instead
 * of silently widening the console's read surface.
 */
function debugDeps(records: readonly ProbeRecord[]): DashboardDeps {
  const unused = (): never => { throw new Error('not used by the debug routes') }
  return {
    snapshot: () => ({ locked: false, devices: [] }),
    session: {
      start: async () => unused(),
      message: async () => unused(),
      end: async () => unused(),
      snapshot: () => ({ phase: 'scene', lastLine: '……', choices: [] }),
    },
    listPacks: async () => unused(),
    importPack: async () => unused(),
    activatePack: async () => unused(),
    panic: async () => unused(),
    unlock: async () => unused(),
    setCap: async () => unused(),
    demo: async () => unused(),
    pattern: async () => unused(),
    stop: async () => unused(),
    connect: async () => unused(),
    scan: async () => unused(),
    listDevices: () => unused(),
    addDevice: async () => unused(),
    removeDevice: async () => unused(),
    rawWrite: async () => unused(),
    listWaveforms: () => unused(),
    importWaveform: async () => unused(),
    promoteWaveform: async () => unused(),
    setWaveform: async () => unused(),
    auditTail: async () => unused(),
    recentErrors: () => unused(),
    recentLogs: () => unused(),
    sensorsStatus: () => [],
    sensorFrame: async () => unused(),
    pushFeatures: () => unused(),
    probes: () => records,
  }
}

async function startDebugServer(records: readonly ProbeRecord[]): Promise<{ server: DashboardServer; base: string }> {
  const server = new DashboardServer({ deps: debugDeps(records), token: DEBUG_TOKEN })
  const address = await server.start()
  return { server, base: `http://${address.host}:${address.port}` }
}

describe('debug mode (A2-T7)', () => {
  it('hides probe numbers and resolved commands unless debug mode is on', async () => {
    const { server, base: url } = await startDebugServer([DEBUG_PROBE])
    try {
      // The contract: `debugMode()` is process-local and off by default.
      expect(server.debugMode()).toBe(false)
      const off = await fetch(`${url}/api/debug`, { headers: headers(DEBUG_TOKEN) })
      expect(off.status).toBe(200)
      expect(await off.json()).toEqual({ enabled: false })

      // Off is a refusal, not an empty list: "[]" would be indistinguishable
      // from "no probe settled yet", and the error body must not leak a single
      // number, probe id or resolved target.
      const hidden = await fetch(`${url}/api/debug/probes`, { headers: headers(DEBUG_TOKEN) })
      expect(hidden.status).toBe(403)
      const hiddenText = await hidden.text()
      expect(hiddenText).not.toContain('p-0007')
      expect(hiddenText).not.toContain('0.31')
      expect(hiddenText).not.toContain('probe-touch')
      expect(hiddenText).not.toContain('mock-pulse')

      // A script cannot flip the switch without the control token.
      const anonymous = await fetch(`${url}/api/debug`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: true }),
      })
      expect(anonymous.status).toBe(401)

      const bad = await fetch(`${url}/api/debug`, {
        method: 'POST',
        headers: headers(DEBUG_TOKEN, true),
        body: JSON.stringify({ enabled: 'yes' }),
      })
      expect(bad.status).toBe(400)

      const on = await fetch(`${url}/api/debug`, {
        method: 'POST',
        headers: headers(DEBUG_TOKEN, true),
        body: JSON.stringify({ enabled: true }),
      })
      expect(on.status).toBe(200)
      expect(await on.json()).toEqual({ enabled: true })
      expect(server.debugMode()).toBe(true)

      const shown = await fetch(`${url}/api/debug/probes`, { headers: headers(DEBUG_TOKEN) })
      expect(shown.status).toBe(200)
      // The route is the documented structured surface, not a bespoke shape.
      expect(await shown.json()).toEqual(JSON.parse(JSON.stringify(probeDirectorJson([DEBUG_PROBE]))))

      // Turning the switch back off closes the tap immediately.
      const backOff = await fetch(`${url}/api/debug`, {
        method: 'POST',
        headers: headers(DEBUG_TOKEN, true),
        body: JSON.stringify({ enabled: false }),
      })
      expect(backOff.status).toBe(200)
      expect((await fetch(`${url}/api/debug/probes`, { headers: headers(DEBUG_TOKEN) })).status).toBe(403)

      // The console page ships the switch but the default view renders no
      // number at all; the script only asks for probes behind the switch.
      const html = await (await fetch(`${url}/`)).text()
      expect(html).toContain('id="debugToggle"')
      expect(html).toContain('id="debugPanel" style="display:none"')
      expect(html).toContain('id="debugProbes"')
      expect(html).toContain('id="sensors"')
      expect(html).not.toContain('0.31')
      expect(html).not.toContain('p-0007')
      const script = await (await fetch(`${url}/app.js`)).text()
      expect(script).toContain('/api/debug/probes')
      expect(script).toContain('debugEnabled')
      expect(script).toContain('解析')
    } finally {
      await server.stop()
    }
  })

  it('keeps debug mode out of the model context', async () => {
    const { server, base: url } = await startDebugServer([DEBUG_PROBE])
    try {
      // What the model may see is the digit-free narrative projection; the raw
      // delta is the debug/audit adapter surface, never a prompt input.
      const modelBlock = probePromptBlock([DEBUG_PROBE], { for: 'model' })
      expect(modelBlock).not.toMatch(/\p{Nd}/u)
      expect(modelBlock).not.toContain('0.31')

      const sessionBefore = await (await fetch(`${url}/api/session`, { headers: headers(DEBUG_TOKEN) })).text()
      const snapshotBefore = await (await fetch(`${url}/api/snapshot`, { headers: headers(DEBUG_TOKEN) })).text()
      expect(sessionBefore).not.toContain('0.31')
      expect(snapshotBefore).not.toContain('p-0007')

      await fetch(`${url}/api/debug`, {
        method: 'POST',
        headers: headers(DEBUG_TOKEN, true),
        body: JSON.stringify({ enabled: true }),
      })
      const probes = await (await fetch(`${url}/api/debug/probes`, { headers: headers(DEBUG_TOKEN) })).text()
      expect(probes).toContain('0.31')

      // Flipping the console switch changes no model-facing payload: the same
      // bytes before and after, and still no probe detail in either.
      expect(await (await fetch(`${url}/api/session`, { headers: headers(DEBUG_TOKEN) })).text()).toBe(sessionBefore)
      expect(await (await fetch(`${url}/api/snapshot`, { headers: headers(DEBUG_TOKEN) })).text()).toBe(snapshotBefore)
      expect(probePromptBlock([DEBUG_PROBE], { for: 'model' })).toBe(modelBlock)

      // The model's tool surface has no way to read or flip the switch.
      const toolNames = M2_MODEL_TOOLS.map(tool => tool.name)
      expect(toolNames.some(name => /debug|probe/iu.test(name))).toBe(false)
    } finally {
      await server.stop()
    }
  })

  it('answers an empty probe list without a recorder and leaves the audit untouched', async () => {
    const host = await start()
    const token = host.dashboardToken
    const auditBefore = await (await fetch(`${base(host)}/api/audit`, { headers: headers(token) })).text()

    const enable = await fetch(`${base(host)}/api/debug`, {
      method: 'POST',
      headers: headers(token, true),
      body: JSON.stringify({ enabled: true }),
    })
    expect(enable.status).toBe(200)

    const probes = await fetch(`${base(host)}/api/debug/probes`, { headers: headers(token) })
    expect(probes.status).toBe(200)
    expect(await probes.json()).toEqual([])

    // Toggling the switch is console state, not a session action: the audit
    // trail is byte-identical (A2-T7: 审计不因调试模式变化).
    const auditAfter = await (await fetch(`${base(host)}/api/audit`, { headers: headers(token) })).text()
    expect(auditAfter).toBe(auditBefore)
  })
})

/** A camera host that records whether capture was started. */
function fakeCameraHost(): { host: CameraHost; startCalls: () => number } {
  let startCalls = 0
  const host: CameraHost = {
    sourceId: 'usb-cam-1',
    label: 'USB 摄像头',
    listDevices: async () => [{ deviceId: 'cam-1', label: 'USB Camera' }],
    start: async () => { startCalls += 1 },
    stop: async () => {},
    latestJpeg: async () => undefined,
    onFeatures: () => () => {},
  }
  return { host, startCalls: () => startCalls }
}

describe('perception wiring', () => {
  it('wires a sensor registry without starting a camera when the camera flag is off', async () => {
    const clock = new FakeClock()
    const camera = fakeCameraHost()
    const host = await createHostRuntime({
      dataDir: root,
      clock,
      withPanicServer: false,
      withButtplug: false,
      cameraHost: camera.host,
      withCamera: false,
    })
    runtime = host

    // The source exists from boot, but capture never starts while the flag is off.
    expect(camera.startCalls()).toBe(0)
    expect(host.sensorsStatus()).toHaveLength(1)
    expect(host.sensorsStatus()[0]).toMatchObject({ id: 'usb-cam-1', kind: 'image', quality: 'unavailable' })

    const response = await fetch(`${base(host)}/api/sensors`, { headers: headers(host.dashboardToken) })
    expect(response.status).toBe(200)
    const body = await response.json() as { sources: Array<{ id: string; kind: string; quality: string }> }
    expect(body.sources).toHaveLength(1)
    expect(body.sources[0]).toMatchObject({ id: 'usb-cam-1', kind: 'image', quality: 'unavailable' })
  })

  it('starts the camera when the flag allows it', async () => {
    const clock = new FakeClock()
    const camera = fakeCameraHost()
    runtime = await createHostRuntime({
      dataDir: root,
      clock,
      withPanicServer: false,
      withButtplug: false,
      cameraHost: camera.host,
    })
    expect(camera.startCalls()).toBe(1)
  })

  it('answers 400 for a feature sample of an unregistered source instead of 500', async () => {
    const host = await start()
    const response = await fetch(`${base(host)}/api/sensors/features`, {
      method: 'POST',
      headers: headers(host.dashboardToken, true),
      body: JSON.stringify({ sourceId: 'ghost-cam', quality: 'ok', ts: 0, frameAgeMs: 0, lumaMean: 99 }),
    })
    expect(response.status).toBe(400)
    const body = await response.json() as { ok: boolean; error: string }
    expect(body.ok).toBe(false)
    expect(body.error).toContain('ghost-cam')
  })

  it('accepts a feature sample for a registered source and serves its JPEG frame', async () => {
    const clock = new FakeClock()
    const camera = fakeCameraHost()
    camera.host.latestJpeg = async () => ({ bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), ts: clock.now() })
    const host = await createHostRuntime({
      dataDir: root,
      clock,
      withPanicServer: false,
      withButtplug: false,
      cameraHost: camera.host,
      withCamera: false,
    })
    runtime = host

    const push = await fetch(`${base(host)}/api/sensors/features`, {
      method: 'POST',
      headers: headers(host.dashboardToken, true),
      body: JSON.stringify({
        sourceId: 'usb-cam-1',
        quality: 'ok',
        frameAgeMs: 5,
        motionEnergy: 0.2,
        lumaMean: 120,
      }),
    })
    expect(push.status).toBe(200)

    const listed = await fetch(`${base(host)}/api/sensors`, { headers: headers(host.dashboardToken) })
    const sensors = await listed.json() as { sources: Array<{ id: string; quality: string; lastTs?: number }> }
    expect(sensors.sources[0]).toMatchObject({ id: 'usb-cam-1', quality: 'ok' })
    // The injected clock stamps the sample, never the wall clock.
    expect(sensors.sources[0]?.lastTs).toBe(clock.now())

    const frame = await fetch(`${base(host)}/api/sensors/frame?sourceId=usb-cam-1`, {
      headers: headers(host.dashboardToken),
    })
    expect(frame.status).toBe(200)
    expect(frame.headers.get('content-type')).toBe('image/jpeg')
    expect([...new Uint8Array(await frame.arrayBuffer())]).toEqual([0xff, 0xd8, 0xff, 0xd9])
    expect(frame.headers.get('x-sensor-ts')).toBe(String(clock.now()))

    const missing = await fetch(`${base(host)}/api/sensors/frame?sourceId=nope`, {
      headers: headers(host.dashboardToken),
    })
    expect(missing.status).toBe(404)
  })
})

describe('phone stop page', () => {
  it('serves the phone page without a token but refuses its panic post without one', async () => {
    const host = await start()

    const page = await fetch(`${base(host)}/phone`)
    expect(page.status).toBe(200)
    expect(page.headers.get('content-type')).toContain('text/html')
    const html = await page.text()
    expect(html).toContain('panic-button')
    expect(html).toContain('/api/panic')
    expect(html).toContain('紧急停止')

    const anonymous = await fetch(`${base(host)}/api/panic`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: 'phone' }),
    })
    expect(anonymous.status).toBe(401)

    const allowed = await fetch(`${base(host)}/api/panic`, {
      method: 'POST',
      headers: headers(host.dashboardToken, true),
      body: JSON.stringify({ source: 'phone' }),
    })
    expect(allowed.status).toBe(200)
    expect(((await allowed.json()) as { locked: boolean }).locked).toBe(true)
  })

  it('renders the locked banner from the snapshot payload', async () => {
    const host = await start()
    const html = await (await fetch(`${base(host)}/phone`)).text()
    // The page carries the banner element and reads it from the snapshot API.
    expect(html).toContain('id="locked-banner"')
    expect(html).toContain('/api/snapshot')
    expect(html).toContain('locked')

    await fetch(`${base(host)}/api/panic`, {
      method: 'POST',
      headers: headers(host.dashboardToken, true),
      body: JSON.stringify({ source: 'phone' }),
    })
    const snapshot = await fetch(`${base(host)}/api/snapshot`, { headers: headers(host.dashboardToken) })
    expect(((await snapshot.json()) as { locked: boolean }).locked).toBe(true)
  })
})

// ── B2-T14: content-pack routes ────────────────────────────────────────────
// `core` 的 ZIP 读取器零依赖，fixture 也手写一个最小 store-only ZIP；
// 这里只生成 ASCII 文件名，避免把 CP437/UTF-8 的编码细节带进路由测试。

const PACK_CRC32_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256)
  for (let index = 0; index < 256; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) !== 0 ? (0xedb88320 ^ (value >>> 1)) : value >>> 1
    }
    table[index] = value >>> 0
  }
  return table
})()

function packCrc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of bytes) crc = ((crc >>> 8) ^ PACK_CRC32_TABLE[(crc ^ byte) & 0xff]!) >>> 0
  return (crc ^ 0xffffffff) >>> 0
}

function packUtf8(text: string): Uint8Array {
  return new TextEncoder().encode(text)
}

function packConcat(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0)
  const result = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    result.set(part, offset)
    offset += part.byteLength
  }
  return result
}

/** 最小 ZIP fixture；`deflate: true` 时走 method 8，验证宿主的 `inflateRaw` 注入。 */
function packZip(files: Readonly<Record<string, string>>, options: { readonly deflate?: boolean } = {}): Uint8Array {
  const localParts: Uint8Array[] = []
  const centralParts: Uint8Array[] = []
  let localOffset = 0
  for (const [name, value] of Object.entries(files)) {
    const nameBytes = packUtf8(name)
    const data = packUtf8(value)
    const crc = packCrc32(data)
    const method = options.deflate === true ? 8 : 0
    const compressed = method === 8 ? new Uint8Array(deflateRawSync(data)) : data

    const local = new Uint8Array(30 + nameBytes.byteLength + compressed.byteLength)
    const localView = new DataView(local.buffer)
    localView.setUint32(0, 0x04034b50, true)
    localView.setUint16(4, 20, true)
    localView.setUint16(6, 0, true)
    localView.setUint16(8, method, true)
    localView.setUint32(14, crc, true)
    localView.setUint32(18, compressed.byteLength, true)
    localView.setUint32(22, data.byteLength, true)
    localView.setUint16(26, nameBytes.byteLength, true)
    local.set(nameBytes, 30)
    local.set(compressed, 30 + nameBytes.byteLength)
    localParts.push(local)

    const central = new Uint8Array(46 + nameBytes.byteLength)
    const centralView = new DataView(central.buffer)
    centralView.setUint32(0, 0x02014b50, true)
    centralView.setUint16(4, 20, true)
    centralView.setUint16(6, 20, true)
    centralView.setUint16(8, 0, true)
    centralView.setUint16(10, method, true)
    centralView.setUint32(16, crc, true)
    centralView.setUint32(20, compressed.byteLength, true)
    centralView.setUint32(24, data.byteLength, true)
    centralView.setUint16(28, nameBytes.byteLength, true)
    centralView.setUint32(42, localOffset, true)
    central.set(nameBytes, 46)
    centralParts.push(central)

    localOffset += local.byteLength
  }
  const centralSize = centralParts.reduce((sum, part) => sum + part.byteLength, 0)
  const eocd = new Uint8Array(22)
  const eocdView = new DataView(eocd.buffer)
  eocdView.setUint32(0, 0x06054b50, true)
  eocdView.setUint16(8, Object.keys(files).length, true)
  eocdView.setUint16(10, Object.keys(files).length, true)
  eocdView.setUint32(12, centralSize, true)
  eocdView.setUint32(16, localOffset, true)
  return packConcat([...localParts, ...centralParts, eocd])
}

function packZipOf(
  id: string,
  version: string,
  name: string,
  options: { readonly deflate?: boolean } = {},
): Uint8Array {
  return packZip({
    'pack.json': JSON.stringify({
      id,
      name,
      version,
      engine: '>=0.2 <1.0',
      mode: 'freeform',
      rating: 'all',
      boundaries: ['不做真实伤害'],
    }),
    'persona.md': `# ${name}\n\n## 导演摘要\n\n测试用角色，先观察再靠近。\n`,
  }, options)
}

/** `fetch()` 在运行时接受任意 ArrayBufferView；TS 6 的 DOM 类型只收 ArrayBuffer 视图。 */
function packUpload(bytes: Uint8Array): BodyInit {
  return bytes as unknown as BodyInit
}

interface PacksResponse {
  readonly packs: readonly {
    readonly id: string
    readonly activeVersion?: string
    readonly versions: readonly { readonly version: string; readonly active: boolean }[]
  }[]
}

interface ImportResponse extends PacksResponse {
  readonly pack: { readonly id: string; readonly version: string; readonly active: boolean }
}

describe('content pack API (B2-T14)', () => {
  it('imports a zip, lists both versions, and switches the active version', async () => {
    const host = await start()
    const token = host.dashboardToken
    const url = base(host)

    let response = await fetch(`${url}/api/packs`, { headers: headers(token) })
    expect(response.status).toBe(200)
    expect(((await response.json()) as PacksResponse).packs).toEqual([])

    response = await fetch(`${url}/api/packs/import`, {
      method: 'POST',
      headers: headers(token),
      body: packUpload(packZipOf('demo-pack', '1.0.0', '旧版')),
    })
    expect(response.status).toBe(200)
    let imported = await response.json() as ImportResponse
    expect(imported.pack).toEqual({ id: 'demo-pack', version: '1.0.0', active: true })
    expect(imported.packs[0]?.activeVersion).toBe('1.0.0')

    // 新版本安装后默认切到新版本；旧版仍保留，可随时切回（回滚）。
    response = await fetch(`${url}/api/packs/import`, {
      method: 'POST',
      headers: headers(token),
      body: packUpload(packZipOf('demo-pack', '1.1.0', '新版', { deflate: true })),
    })
    expect(response.status).toBe(200)
    imported = await response.json() as ImportResponse
    expect(imported.pack).toEqual({ id: 'demo-pack', version: '1.1.0', active: true })
    expect(imported.packs[0]?.versions.map(version => version.version)).toEqual(['1.0.0', '1.1.0'])
    expect(imported.packs[0]?.activeVersion).toBe('1.1.0')

    response = await fetch(`${url}/api/packs/activate`, {
      method: 'POST',
      headers: headers(token, true),
      body: JSON.stringify({ id: 'demo-pack', version: '1.0.0' }),
    })
    expect(response.status).toBe(200)
    const switched = await response.json() as PacksResponse
    expect(switched.packs[0]?.activeVersion).toBe('1.0.0')
    expect(switched.packs[0]?.versions.find(version => version.active)?.version).toBe('1.0.0')
  })

  it('answers 400 for a corrupt zip and 404 for an unknown pack or version', async () => {
    const host = await start()
    const token = host.dashboardToken
    const url = base(host)

    let response = await fetch(`${url}/api/packs/import`, {
      method: 'POST',
      headers: headers(token),
      body: packUpload(packUtf8('definitely not a zip archive')),
    })
    expect(response.status).toBe(400)
    const corrupt = await response.json() as { error: string; code?: string }
    expect(corrupt.error).toMatch(/zip/iu)
    expect(corrupt.code).toBe('not-a-zip')
    // 校验失败不改变已安装列表（导入是全有或全无）。
    expect(((await (await fetch(`${url}/api/packs`, { headers: headers(token) })).json()) as PacksResponse).packs)
      .toEqual([])

    response = await fetch(`${url}/api/packs/activate`, {
      method: 'POST',
      headers: headers(token, true),
      body: JSON.stringify({ id: 'ghost', version: '1.0.0' }),
    })
    expect(response.status).toBe(404)
    expect(((await response.json()) as { error: string }).error).toContain('ghost')

    response = await fetch(`${url}/api/packs/activate`, {
      method: 'POST',
      headers: headers(token, true),
      body: JSON.stringify({ id: 'ghost' }),
    })
    expect(response.status).toBe(400)
  })
})
