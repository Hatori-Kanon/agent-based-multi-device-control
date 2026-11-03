import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { deflateRawSync } from 'node:zlib'
import {
  FakeClock,
  M2_MODEL_TOOLS,
  PackRegistryError,
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
    // The page is the single-window app: the play view is the default surface.
    expect(await response.text()).toContain('id="view-play"')
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
    expect(html).toContain('Embodied')
    expect(html).toContain('id="view-play"')

    const script = await fetch(`${base(host)}/app.js`)
    expect(script.status).toBe(200)
    expect(script.headers.get('content-type')).toContain('javascript')
    expect(await script.text()).toContain('api/snapshot')

    // The UI talks to the API over fetch(). With `default-src 'none'` and no
    // connect-src, connect-src falls back to 'none' and every fetch is blocked
    // by the browser — the console shows "Failed to fetch" and nothing loads.
    expect(html).toMatch(/connect-src 'self'/)

    // The shared design system rides the same static allowlist. If it 404s the
    // pages silently fall back to browser defaults — the pre-redesign "naked
    // HTML" look — so this pins both the file and the link that loads it.
    const style = await fetch(`${base(host)}/style.css`)
    expect(style.status).toBe(200)
    expect(style.headers.get('content-type')).toContain('text/css')
    expect(await style.text()).toContain('--gold')
    expect(html).toContain('href="/style.css"')
    // No off-host assets: the CSP forbids them, and a stray CDN link would
    // break the theme on a machine without internet access.
    expect(html).not.toMatch(/(?:src|href)="https?:/u)
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

    // The product console does not offer simulated hardware: the add route
    // refuses "mock" even though the runtime's test fixture can still create it.
    response = await fetch(`${base(host)}/api/devices`, {
      method: 'POST',
      headers: headers(token, true),
      body: JSON.stringify({ protocol: 'mock' }),
    })
    expect(response.status).toBe(400)

    // The remove route still has to work on whatever the manifest holds; the
    // runtime API is the fixture path for creating a device without BLE.
    const added = await host.addDevice('mock')
    expect(added.key).toBe('mock')
    response = await fetch(`${base(host)}/api/devices`, { headers: headers(token) })
    body = await response.json()
    expect(body.devices.map(device => device.key)).toContain('mock')
    const liveSnapshot = await (await fetch(`${base(host)}/api/snapshot`, {
      headers: headers(token),
    })).json() as { devices: Array<{ id: string }> }
    expect(liveSnapshot.devices.some(device => device.id === 'mock')).toBe(true)

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

  it('exposes per-channel ranges and drives direct level control', async () => {
    const host = await start()
    const token = host.dashboardToken
    const post = async (path: string, body: unknown): Promise<Response> => fetch(`${base(host)}${path}`, {
      method: 'POST',
      headers: headers(token, true),
      body: JSON.stringify(body),
    })
    await post('/api/connect', { deviceId: 'mock-pulse' })

    // The human narrows both axes: an interval and a frequency band.
    const cap = await post('/api/cap', {
      deviceId: 'mock-pulse',
      channelId: 'a',
      patch: { minPercent: 10, maxPercent: 55, minFreq: 40, maxFreq: 120 },
    })
    expect(cap.status).toBe(200)
    type Snapshot = {
      devices: Array<{
        id: string
        channels: Array<{
          id: string
          percent: number
          minPercent: number
          maxPercent: number
          minFreq: number
          maxFreq: number
          maxDurationSec: number
        }>
      }>
    }
    const afterCap = await cap.json() as Snapshot
    const channel = (snapshot: Snapshot): Snapshot['devices'][number]['channels'][number] | undefined =>
      snapshot.devices.find(device => device.id === 'mock-pulse')?.channels.find(entry => entry.id === 'a')
    expect(channel(afterCap)).toMatchObject({ minPercent: 10, maxPercent: 55, minFreq: 40, maxFreq: 120 })

    // Direct control is absolute and clamped into the human's interval: asking
    // for 5% (below the floor) lands on 10%.
    const low = await post('/api/level', { deviceId: 'mock-pulse', channelId: 'a', percent: 5, durationSec: 5 })
    expect(low.status).toBe(200)
    expect(channel(await low.json() as Snapshot)?.percent).toBe(10)

    // Above the ceiling is clamped down rather than refused.
    const high = await post('/api/level', { deviceId: 'mock-pulse', channelId: 'a', percent: 90, durationSec: 5 })
    expect(high.status).toBe(200)
    expect(channel(await high.json() as Snapshot)?.percent).toBe(55)

    // percent 0 is a stop.
    const stop = await post('/api/level', { deviceId: 'mock-pulse', channelId: 'a', percent: 0 })
    expect(stop.status).toBe(200)
    expect(channel(await stop.json() as Snapshot)?.percent).toBe(0)

    // Malformed payloads are refused, not coerced.
    expect((await post('/api/level', { deviceId: 'mock-pulse', channelId: 'a', percent: 'x' })).status).toBe(400)
    expect((await post('/api/cap', { deviceId: 'mock-pulse', channelId: 'a', patch: { minPercent: 80, maxPercent: 20 } })).status).toBe(400)

    const records = await auditRecords()
    expect(records.some(record => record.action === 'set_level' && record.actor === 'human')).toBe(true)
  })

  it('rejects malformed level and cap payloads instead of coercing them', async () => {
    const host = await start()
    const token = host.dashboardToken
    const post = async (path: string, body: unknown): Promise<Response> => fetch(`${base(host)}${path}`, {
      method: 'POST',
      headers: headers(token, true),
      body: JSON.stringify(body),
    })
    await post('/api/connect', { deviceId: 'mock-pulse' })

    // Direct control is an absolute 0–100 whole number; negative and fractional
    // values must not be silently clamped into a level (or a fake stop).
    expect((await post('/api/level', { deviceId: 'mock-pulse', channelId: 'a', percent: -5 })).status).toBe(400)
    expect((await post('/api/level', { deviceId: 'mock-pulse', channelId: 'a', percent: 12.5 })).status).toBe(400)
    expect((await post('/api/level', { deviceId: 'mock-pulse', channelId: 'a', percent: 101 })).status).toBe(400)

    // A cap patch is all-or-nothing: one bad field must not apply the rest.
    expect((await post('/api/cap', {
      deviceId: 'mock-pulse',
      channelId: 'a',
      patch: { maxPercent: 30, minFreq: 'nope' },
    })).status).toBe(400)
    // The removed pulse-width cap is a clean 400, not a silently ignored field.
    expect((await post('/api/cap', {
      deviceId: 'mock-pulse',
      channelId: 'a',
      patch: { maxWaveIntensity: 50 },
    })).status).toBe(400)

    // Nothing above may have changed the human's bounds.
    const snapshot = await (await fetch(`${base(host)}/api/snapshot`, { headers: headers(token) })).json() as {
      devices: Array<{ id: string; channels: Array<{ id: string; maxPercent: number; minFreq: number }> }>
    }
    const channel = snapshot.devices.find(device => device.id === 'mock-pulse')?.channels.find(entry => entry.id === 'a')
    expect(channel?.maxPercent).toBe(20)
    expect(channel?.minFreq).toBe(10)
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
    level: async () => unused(),
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

      // The user-facing console ships no debug switch at all. The probe route
      // stays reachable for tools and tests, but neither shipped script can
      // fetch or render a probe number, and the page markup has no panel.
      const html = await (await fetch(`${url}/`)).text()
      expect(html).not.toContain('id="debugToggle"')
      expect(html).not.toContain('id="debugPanel"')
      expect(html).not.toContain('id="debugProbes"')
      expect(html).not.toContain('id="sensors"')
      expect(html).not.toContain('0.31')
      expect(html).not.toContain('p-0007')
      const appScript = await (await fetch(`${url}/app.js`)).text()
      expect(appScript).not.toContain('/api/debug')
      const playScript = await (await fetch(`${url}/play.js`)).text()
      expect(playScript).not.toContain('/api/debug')
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
  options: {
    readonly deflate?: boolean
    readonly mode?: 'freeform' | 'scenario'
    /** Extra/replacement files (e.g. a `scenario.json`). */
    readonly files?: Readonly<Record<string, string>>
  } = {},
): Uint8Array {
  return packZip({
    'pack.json': JSON.stringify({
      id,
      name,
      version,
      engine: '>=0.2 <1.0',
      mode: options.mode ?? 'freeform',
      rating: 'all',
      boundaries: ['不做真实伤害'],
    }),
    'persona.md': `# ${name}\n\n## 导演摘要\n\n测试用角色，先观察再靠近。\n`,
    ...options.files,
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
  readonly pack: {
    readonly id: string
    readonly version: string
    readonly active: boolean
    /** 同 id@version 重导时宿主返回 true（覆盖安装，不是首次导入）。 */
    readonly replaced: boolean
  }
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
    expect(imported.pack).toEqual({ id: 'demo-pack', version: '1.0.0', active: true, replaced: false })
    expect(imported.packs[0]?.activeVersion).toBe('1.0.0')

    // 新版本安装后默认切到新版本；旧版仍保留，可随时切回（回滚）。
    response = await fetch(`${url}/api/packs/import`, {
      method: 'POST',
      headers: headers(token),
      body: packUpload(packZipOf('demo-pack', '1.1.0', '新版', { deflate: true })),
    })
    expect(response.status).toBe(200)
    imported = await response.json() as ImportResponse
    expect(imported.pack).toEqual({ id: 'demo-pack', version: '1.1.0', active: true, replaced: false })
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

  it('overwrites an installed id@version when the same zip is imported again', async () => {
    // The product rule: an import extracts into the project's own directory and
    // same-named files are overwritten — a duplicate pack is never "already
    // installed". End-to-end through the real host, FsPackStore and HTTP route.
    const host = await start()
    const token = host.dashboardToken
    const url = base(host)
    const packPath = join(root, 'content', 'packs', 'demo-pack', '1.0.0')

    // The literal user scenario: pick the very same zip file twice.
    const original = packZipOf('demo-pack', '1.0.0', '初版', {
      files: { 'notes/old.md': '旧附注' },
    })
    let response = await fetch(`${url}/api/packs/import`, {
      method: 'POST',
      headers: headers(token),
      body: packUpload(original),
    })
    expect(response.status).toBe(200)
    expect((await response.json() as ImportResponse).pack).toEqual({
      id: 'demo-pack',
      version: '1.0.0',
      active: true,
      replaced: false,
    })
    expect(await readFile(join(packPath, 'notes', 'old.md'), 'utf8')).toBe('旧附注')

    response = await fetch(`${url}/api/packs/import`, {
      method: 'POST',
      headers: headers(token),
      body: packUpload(original),
    })
    expect(response.status).toBe(200)
    const identical = await response.json() as ImportResponse
    expect(identical.pack).toEqual({ id: 'demo-pack', version: '1.0.0', active: true, replaced: true })
    expect(identical.packs[0]?.versions).toHaveLength(1)
    expect(identical.packs[0]?.activeVersion).toBe('1.0.0')

    // A changed archive for the same id@version overwrites the same-named files
    // and drops the file this archive no longer contains (stale cleanup).
    response = await fetch(`${url}/api/packs/import`, {
      method: 'POST',
      headers: headers(token),
      body: packUpload(packZipOf('demo-pack', '1.0.0', '修订版')),
    })
    expect(response.status).toBe(200)
    const overwritten = await response.json() as ImportResponse
    expect(overwritten.pack).toEqual({
      id: 'demo-pack',
      version: '1.0.0',
      active: true,
      replaced: true,
    })

    // The bytes on disk really changed, and the file only the first archive had
    // is gone.
    const manifest = JSON.parse(await readFile(join(packPath, 'pack.json'), 'utf8')) as { name: string }
    expect(manifest.name).toBe('修订版')
    expect(await readFile(join(packPath, 'persona.md'), 'utf8')).toContain('修订版')
    await expect(readFile(join(packPath, 'notes', 'old.md'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })

    // The list route agrees: one version, still active, refreshed metadata.
    const listed = await (await fetch(`${url}/api/packs`, { headers: headers(token) })).json() as PacksResponse
    expect(listed.packs[0]?.versions).toHaveLength(1)
    expect(listed.packs[0]?.versions[0]?.version).toBe('1.0.0')
    expect(listed.packs[0]?.activeVersion).toBe('1.0.0')
  })

  it('serves the declared body regions of one installed pack', async () => {
    const host = await start()
    const token = host.dashboardToken
    const url = base(host)
    const scenario = JSON.stringify({
      session: { plannedMinutes: 30, phaseWindows: [], aftercareMin: 0 },
      // `whole-body` deliberately omitted: the host must still offer it first,
      // because the resolver/world facts/apply_plan enum always accept it.
      regions: [
        { id: 'hands', label: '手' },
        { id: 'shoulders', label: '肩背' },
      ],
      phases: [{ id: 'scene', goal: '自由互动', next: [] }],
      feedbackIntents: [{ id: 'probe-touch', meaning: '短促试探', regions: ['hands'] }],
    })
    const response = await fetch(`${url}/api/packs/import`, {
      method: 'POST',
      headers: headers(token),
      body: packUpload(packZipOf('region-pack', '1.0.0', '部位包', {
        mode: 'scenario',
        files: { 'scenario.json': scenario },
      })),
    })
    expect(response.status).toBe(200)

    const regions = await fetch(`${url}/api/packs/regions?packId=region-pack`, {
      headers: headers(token),
    })
    expect(regions.status).toBe(200)
    expect(await regions.json()).toEqual({
      packId: 'region-pack',
      version: '1.0.0',
      regions: [
        { id: 'whole-body', label: '全身' },
        { id: 'hands', label: '手' },
        { id: 'shoulders', label: '肩背' },
      ],
    })

    // An explicit version pins the vocabulary to the version a running session
    // started with; an unknown version is the registry's 404, not a 400.
    const pinned = await fetch(`${url}/api/packs/regions?packId=region-pack&version=1.0.0`, {
      headers: headers(token),
    })
    expect(pinned.status).toBe(200)
    expect(((await pinned.json()) as { version: string }).version).toBe('1.0.0')
    const missingVersion = await fetch(`${url}/api/packs/regions?packId=region-pack&version=9.9.9`, {
      headers: headers(token),
    })
    expect(missingVersion.status).toBe(404)

    // A freeform pack has no scenario.json: the synthetic whole-body region is
    // exactly what the play view's picker must offer.
    await fetch(`${url}/api/packs/import`, {
      method: 'POST',
      headers: headers(token),
      body: packUpload(packZipOf('free-pack', '1.0.0', '自由包')),
    })
    const free = await fetch(`${url}/api/packs/regions?packId=free-pack`, {
      headers: headers(token),
    })
    expect(free.status).toBe(200)
    expect(await free.json()).toEqual({
      packId: 'free-pack',
      version: '1.0.0',
      regions: [{ id: 'whole-body', label: '全身' }],
    })

    // Unknown pack → the registry's not-found maps to 404; a missing query is
    // a caller error, and the route is behind the same token as everything else.
    const unknown = await fetch(`${url}/api/packs/regions?packId=ghost`, {
      headers: headers(token),
    })
    expect(unknown.status).toBe(404)
    expect(((await unknown.json()) as { error: string }).error).toContain('ghost')
    expect((await fetch(`${url}/api/packs/regions`, { headers: headers(token) })).status).toBe(400)
    expect((await fetch(`${url}/api/packs/regions?packId=region-pack`)).status).toBe(401)
  })

  it('answers 404 for the region vocabulary when the host has no pack registry', async () => {
    // The route is optional for console-only test doubles: a caller must see a
    // clean 404, not a crash from an undefined dependency.
    const deps = debugDeps([])
    const server = new DashboardServer({ deps, token: DEBUG_TOKEN })
    const address = await server.start()
    const url = `http://${address.host}:${address.port}`
    try {
      const response = await fetch(`${url}/api/packs/regions?packId=demo`, { headers: headers(DEBUG_TOKEN) })
      expect(response.status).toBe(404)
    } finally {
      await server.stop()
    }
  })

  it('answers 404 for the region vocabulary when a pack has no active version', async () => {
    // "Not installed" and "no active version" are the same player-facing state
    // (nothing to show); the generic pack-failure map would answer 400 here.
    const deps: DashboardDeps = {
      ...debugDeps([]),
      packRegions: async () => {
        throw new PackRegistryError('no-active-version', 'demo has no active version')
      },
    }
    const server = new DashboardServer({ deps, token: DEBUG_TOKEN })
    const address = await server.start()
    const url = `http://${address.host}:${address.port}`
    try {
      const response = await fetch(`${url}/api/packs/regions?packId=demo`, { headers: headers(DEBUG_TOKEN) })
      expect(response.status).toBe(404)
      expect(((await response.json()) as { code?: string }).code).toBe('no-active-version')
    } finally {
      await server.stop()
    }
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

describe('session controls (B2-T11)', () => {
  /** Minimal deps: only the session-control routes are exercised. */
  function controlDeps(calls: string[]): DashboardDeps {
    const unused = (): never => { throw new Error('not used by the session-control routes') }
    return {
      snapshot: () => ({ locked: false, devices: [] }),
      session: {
        start: async () => unused(),
        message: async () => unused(),
        end: async () => unused(),
        snapshot: () => ({ phase: 'scene' }),
        pause: async () => { calls.push('pause'); return { state: 'paused' } },
        resume: async () => { calls.push('resume'); return { state: 'idle' } },
        choose: async (choiceId: string) => { calls.push(`choice:${choiceId}`); return { chosen: choiceId } },
        transcript: () => [{ turnId: 1, at: 0, text: '（低笑）' }],
      },
      ledger: async (limit?: number) => [{ sessionId: 's-1', limit }],
      listPacks: async () => unused(),
      importPack: async () => unused(),
      activatePack: async () => unused(),
      panic: async () => unused(),
      unlock: async () => unused(),
      setCap: async () => unused(),
      level: async () => unused(),
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
    }
  }

  async function startControlServer(calls: string[]): Promise<{ server: DashboardServer; base: string }> {
    const server = new DashboardServer({ deps: controlDeps(calls), token: 'control-token-0123456789abcdef' })
    const address = await server.start()
    return { server, base: `http://${address.host}:${address.port}` }
  }

  it('drives pause, resume and a choice through the session routes', async () => {
    const calls: string[] = []
    const { server, base: url } = await startControlServer(calls)
    try {
      const headers = { 'x-control-token': 'control-token-0123456789abcdef', 'Content-Type': 'application/json' }
      const pause = await fetch(`${url}/api/session/pause`, { method: 'POST', headers })
      expect(pause.status).toBe(200)
      expect(await pause.json()).toEqual({ state: 'paused' })

      const resume = await fetch(`${url}/api/session/resume`, { method: 'POST', headers })
      expect(resume.status).toBe(200)

      const choice = await fetch(`${url}/api/session/choice`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ choiceId: 'c1' }),
      })
      expect(choice.status).toBe(200)
      expect(calls).toEqual(['pause', 'resume', 'choice:c1'])

      // A missing choice id is a caller error, not a turn.
      const missing = await fetch(`${url}/api/session/choice`, { method: 'POST', headers, body: JSON.stringify({}) })
      expect(missing.status).toBe(400)
    } finally {
      await server.stop()
    }
  })

  it('serves the transcript and the ledger behind the token', async () => {
    const calls: string[] = []
    const { server, base: url } = await startControlServer(calls)
    try {
      expect((await fetch(`${url}/api/session/pause`)).status).toBe(401)

      const transcript = await fetch(`${url}/api/session/transcript`, { headers: { 'x-control-token': 'control-token-0123456789abcdef' } })
      expect(transcript.status).toBe(200)
      expect((await transcript.json()) as { transcript: unknown[] }).toMatchObject({
        transcript: [{ turnId: 1, text: '（低笑）' }],
      })

      const ledger = await fetch(`${url}/api/ledger?limit=5`, { headers: { 'x-control-token': 'control-token-0123456789abcdef' } })
      expect(ledger.status).toBe(200)
      expect((await ledger.json()) as { entries: Array<{ limit?: number }> }).toMatchObject({ entries: [{ limit: 5 }] })

      const badLimit = await fetch(`${url}/api/ledger?limit=zero`, { headers: { 'x-control-token': 'control-token-0123456789abcdef' } })
      expect(badLimit.status).toBe(400)
    } finally {
      await server.stop()
    }
  })
})

describe('play page (B2-T12)', () => {
  const PLAY_TOKEN = 'play-token-0123456789abcdef'

  /** The snapshot `GET /api/session` serves: 0–3 options, no device numbers. */
  function playSnapshot(): Record<string, unknown> {
    return {
      state: 'idle',
      turnId: 3,
      phase: 'scene',
      elapsedMin: 6,
      remainingMin: 24,
      lastLine: '（她把灯调暗了一点）',
      choices: [
        { id: 'c1', label: '往后退一步', tag: 'resist' },
        { id: 'c2', label: '留在原地', tag: 'passive' },
        { id: 'c3', label: '开口求饶', tag: 'plead' },
      ],
      outcome: 'completed',
      checkpoint: 0.5,
      mustResolve: false,
      sessionId: 'session-play-1',
      packId: 'tentacle-pure',
      packVersion: '1.0.0',
    }
  }

  /** Minimal deps: only the session snapshot and the static files are read. */
  function playDeps(calls: string[]): DashboardDeps {
    const unused = (): never => { throw new Error('not used by the play-page routes') }
    return {
      snapshot: () => ({ locked: false, devices: [] }),
      session: {
        start: async () => playSnapshot(),
        message: async () => playSnapshot(),
        end: async () => playSnapshot(),
        snapshot: () => playSnapshot(),
        pause: async () => playSnapshot(),
        resume: async () => playSnapshot(),
        choose: async (choiceId: string) => {
          calls.push(`choice:${choiceId}`)
          return playSnapshot()
        },
        transcript: () => [{ turnId: 1, at: 1_000, text: '（她把灯调暗了一点）' }],
      },
      listPacks: async () => [],
      importPack: async () => unused(),
      activatePack: async () => unused(),
      panic: async () => unused(),
      unlock: async () => unused(),
      setCap: async () => unused(),
      level: async () => unused(),
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
    }
  }

  it('serves the single-window app and its scripts through the static whitelist', async () => {
    const host = await start()
    // v4: `/`, `/play`, `/device` and `/settings` are the same single-window
    // page; a page navigation cannot carry headers, so scripts and styles must
    // be readable without the token, exactly like the phone page.
    const page = await fetch(`${base(host)}/play`)
    expect(page.status).toBe(200)
    expect(page.headers.get('content-type')).toContain('text/html')
    const html = await page.text()
    // All three views live in the page; the play view is the default landing view.
    expect(html).toContain('id="view-play"')
    expect(html).toContain('id="view-device"')
    expect(html).toContain('id="view-settings"')
    expect(html).toContain('data-view-target="play"')
    expect(html).toContain('data-view-target="device"')
    expect(html).toContain('data-view-target="settings"')
    // The play view is what the page opens on: the other sections ship hidden
    // and the body starts in the play mode.
    expect(html).toContain('data-view="play"')
    expect(html).toMatch(/id="view-device"[^>]*hidden/u)
    expect(html).toMatch(/id="view-settings"[^>]*hidden/u)
    expect(html).toContain('/play.js')
    expect(html).toContain('/app.js')
    expect(html).toContain('/shell.js')
    expect(html).toContain('/settings.js')
    expect(html).toContain('href="/style.css"')
    // v11: 波形柱状图的几何计算是独立的 classic script，必须在 play.js 之前
    // 加载 —— play.js 直接读 window.EmbodiedChartMath，顺序反了图表整块不画。
    expect(html).toContain('/chart-math.js')
    expect(html.indexOf('/chart-math.js')).toBeGreaterThan(-1)
    expect(html.indexOf('/chart-math.js')).toBeLessThan(html.indexOf('/play.js'))
    expect(html).toMatch(/connect-src 'self'/)
    // Safety chrome is in the markup: a persistent stop button and the LOCKED
    // banner, plus the player-visible narrative surface.
    expect(html).toContain('id="panic"')
    expect(html).toContain('紧急停止')
    expect(html).toContain('id="lockBanner"')
    expect(html).toContain('id="choices"')
    // v3 dropped the global session ceiling X from the UI: the human bounds the
    // output per device/channel instead (软上限).
    expect(html).not.toContain('id="ceiling"')
    expect(html).toContain('软上限')
    // 部位与软上限 are one per-device/per-channel list, mounted in the lobby
    // and in the session rail; the old separate 连接与部位 / 软上限 cards
    // (and their `softCapsRail` mount) are gone.
    expect(html).toContain('id="softCapsLobby"')
    expect(html).toContain('id="devices"')
    expect(html).not.toContain('id="softCapsRail"')
    // v8: one scrollable conversation column; the old "now card" is gone.
    expect(html).toContain('id="lines"')
    expect(html).toContain('role="log"')
    expect(html).not.toContain('id="currentLine"')
    expect(html).not.toContain('id="nowCard"')
    // The lobby owns the one content-pack import entry point (zip upload).
    expect(html).toContain('id="packImport"')
    expect(html).toContain('id="packFile"')
    expect(html).toContain('id="packImportStatus"')
    // Autopilot is a human pacing control in both the lobby and the session rail.
    // v12: the wait is a window (shortest–longest), so each mount has two range
    // ids instead of the old single `auto*Interval` slider.
    for (const id of ['autoLobbyEnabled', 'autoLobbyMin', 'autoLobbyMax', 'autoLobbyValue',
      'autoRunEnabled', 'autoRunMin', 'autoRunMax', 'autoRunValue']) {
      expect(html).toContain(`id="${id}"`)
    }
    expect(html).not.toContain('autoLobbyInterval')
    expect(html).not.toContain('autoRunInterval')
    // Confirmations are rendered in-page (native <dialog>), never a browser popup.
    for (const id of ['confirmDialog', 'confirmText', 'confirmCancel', 'confirmOk']) {
      expect(html).toContain(`id="${id}"`)
    }
    // The product console shows no telemetry surface at all: no log/audit/debug
    // panels and no probe field name or probe number on the default page.
    expect(html).not.toContain('id="debugToggle"')
    expect(html).not.toContain('id="debugPanel"')
    expect(html).not.toContain('id="debugProbes"')
    expect(html).not.toContain('id="sensors"')
    expect(html).not.toMatch(/motionEnergy|motionPeak|staticRatio|centerMotionRatio|lumaMean|lumaStd|overexposedRatio|underexposedRatio|audioLevelPct|bpm/u)
    expect(html).not.toContain('0.31')
    expect(html).not.toContain('append-only')
    expect(html).not.toContain('遥测')
    // The settings view is markup only; its logic lives in /settings.js and
    // the ids are the contract between the two.
    for (const id of [
      'setProvider', 'setModel', 'setBaseUrl', 'setApiKey', 'setLlmSave', 'setLlmStatus',
      'setCamEnabled', 'setCamDevice', 'setCamRefresh', 'setCamStatus',
      'setMicEnabled', 'setMicDevice', 'setMicRefresh', 'setMicStatus',
    ]) {
      expect(html).toContain(`id="${id}"`)
    }

    const script = await fetch(`${base(host)}/play.js`)
    expect(script.status).toBe(200)
    expect(script.headers.get('content-type')).toContain('javascript')
    const js = await script.text()
    // The surfaces the play view drives besides the session snapshot.
    expect(js).toContain('/api/session/transcript')
    expect(js).toContain('/api/panic')
    expect(js).toContain('/api/cap')
    // The per-channel region field is a free-text input with the current pack's
    // recommended labels as a datalist; the old select/warning classes are gone.
    expect(js).toContain('/api/region')
    expect(js).toContain('/api/packs/regions')
    // The lobby imports zip packs through the same host route the installer uses.
    expect(js).toContain('/api/packs/import')
    // A duplicate import overwrites and the status line says so (the host sends
    // `replaced`); without it the unchanged version number looks like a no-op.
    expect(js).toContain('replaced')
    expect(js).toContain('已导入（覆盖）')
    // Autopilot is session-scoped; end uses the in-page confirmation helper.
    expect(js).toContain('/api/session/autopilot')
    // v12: start 与 /api/session/autopilot 的载荷都是等待区间；旧单值 id 必须
    // 没有悬空引用（页面/脚本都只剩新 id），旧宿主靠 intervalSec 中点兼容。
    expect(js).toContain('windowMinSec')
    expect(js).toContain('windowMaxSec')
    expect(js).not.toContain('autoLobbyInterval')
    expect(js).not.toContain('autoRunInterval')
    expect(js).toContain('embodiedConfirm')
    expect(js).toContain('is-latest')
    expect(js).toContain('line-effects')
    // v14: 效果小框显示「区间请求% → 实际输出%」（软上限映射一眼可见）；
    // 旧宿主没有 requestedPercent 时退回旧格式，rejected 记录不展示。
    expect(js).toContain('requestedPercent')
    expect(js).toContain('区间 ${requested}%')
    expect(js).toContain('实际 ${actual}%')
    expect(js).toContain('requested === actual')
    expect(js).toContain("effect.status === 'rejected'")
    // 去重 key 必须把 requestedPercent 和 percent 都算进去，否则
    // 「区间 40% → 实际 8%」与「区间 70% → 实际 8%」会被误合并成一条。
    expect(js).toContain('percentValues.requested')
    expect(js).toContain('percentValues.actual')
    expect(js).toContain("join('|')")
    expect(js).toContain('channel-live')
    expect(js).toContain('/api/waveforms/preview')
    // v13: 波形图下方有一行波形名小字（用户靠它判断波形有没有变）。
    // 名字来自 snapshot channel.waveform（id+name），由 updateChannelLive 每轮
    // 刷新；没有波形时固定「波形：未选择」。
    expect(js).toContain('live-wave-name')
    expect(js).toContain('波形：未选择')
    expect(js).toContain('波形：${waveformName}')
    expect(js).toContain('channel.waveform')
    expect(js).toContain('waveformLabel')
    // v11: 右轨柱状图只调用纯几何函数；柱高只跟波形自身 intensity 走，
    // 旧实现乘当前通道强度的 `view.level / 100` 必须消失（用户反馈「高度
    // 不要根据强度」）。
    expect(js).toContain('EmbodiedChartMath.computeBars')
    expect(js).not.toContain('view.level / 100')
    // 图表数学是独立的 classic script，走同一份静态白名单，否则 <script src>
    // 404、图表整块不画。
    const chartMath = await fetch(`${base(host)}/chart-math.js`)
    expect(chartMath.status).toBe(200)
    expect(chartMath.headers.get('content-type')).toContain('javascript')
    const chartMathJs = await chartMath.text()
    expect(chartMathJs).toContain('EmbodiedChartMath')
    expect(chartMathJs).toContain('computeBars')
    expect(js).not.toContain('window.confirm')
    expect(js).toContain('region-input')
    expect(js).toContain('datalist')
    expect(js).not.toContain('region-pick')
    expect(js).not.toContain('region-warn')
    // The global ceiling route and the debug/probe surface are gone from this view.
    expect(js).not.toContain('/api/session/ceiling')
    expect(js).not.toContain('/api/debug')
    expect(js).not.toContain('/api/sensors')
    // Token convention: query once, then the header — never persisted, and no
    // bare console.error when a poll fails.
    expect(js).not.toContain('localStorage')
    expect(js).not.toMatch(/\bconsole\./u)

    // The device view's script is the console logic; it owns direct control and
    // no longer exposes logs/audit/debug to the user.
    const consoleScript = await fetch(`${base(host)}/app.js`)
    expect(consoleScript.status).toBe(200)
    const consoleJs = await consoleScript.text()
    expect(consoleJs).toContain('/api/level')
    expect(consoleJs).toContain('/api/cap')
    expect(consoleJs).not.toContain('/api/logs')
    expect(consoleJs).not.toContain('/api/audit')
    expect(consoleJs).not.toContain('/api/debug')
    // Device removal asks through the same in-page dialog, never window.confirm.
    expect(consoleJs).toContain('embodiedConfirm')
    expect(consoleJs).not.toContain('window.confirm')

    // The settings view's script talks to the settings API and never persists
    // the token itself.
    const settingsScript = await fetch(`${base(host)}/settings.js`)
    expect(settingsScript.status).toBe(200)
    expect(settingsScript.headers.get('content-type')).toContain('javascript')
    const settingsJs = await settingsScript.text()
    expect(settingsJs).toContain('/api/settings')
    expect(settingsJs).not.toContain('localStorage')
    expect(settingsJs).not.toMatch(/\bconsole\./u)

    // The view switch is a tiny separate script so the page needs no inline JS.
    const shell = await fetch(`${base(host)}/shell.js`)
    expect(shell.status).toBe(200)
    expect(shell.headers.get('content-type')).toContain('javascript')
    const shellJs = await shell.text()
    // The switch must remember the view AND keep the URL in sync, otherwise a
    // refresh on `/play` would always fall back to the play view.
    expect(shellJs).toContain('sessionStorage')
    expect(shellJs).toContain('replaceState')
    expect(shellJs).toContain('viewchange')
    expect(shellJs).toContain('settings')
    // All confirmations go through the in-page <dialog> helper, not window.confirm.
    expect(shellJs).toContain('embodiedConfirm')
    expect(shellJs).toContain('showModal')
    expect(shellJs).not.toContain('window.confirm')

    // `/device` and `/settings` are deep links to the same page, and the
    // deleted play.html is not reachable any more.
    const devicePage = await fetch(`${base(host)}/device`)
    expect(devicePage.status).toBe(200)
    expect(await devicePage.text()).toContain('id="view-device"')
    const settingsPage = await fetch(`${base(host)}/settings`)
    expect(settingsPage.status).toBe(200)
    expect(await settingsPage.text()).toContain('id="view-settings"')
    expect((await fetch(`${base(host)}/play.html`)).status).toBe(404)

    // The allowlist is still a whitelist: unknown names are clean 404s.
    expect((await fetch(`${base(host)}/play.json`)).status).toBe(404)
    expect((await fetch(`${base(host)}/src/ui/index.html`)).status).toBe(404)
    // Browsers ask for the favicon on every navigation; answer 204 so the
    // console is not filled with 404 noise (the static allowlist is unchanged).
    expect((await fetch(`${base(host)}/favicon.ico`)).status).toBe(204)
  })

  it('renders choices from the session snapshot and posts the picked id', async () => {
    const calls: string[] = []
    const server = new DashboardServer({ deps: playDeps(calls), token: PLAY_TOKEN })
    const address = await server.start()
    const url = `http://${address.host}:${address.port}`
    try {
      // What the page renders from: 0–3 options, each with a player-visible label.
      const snapshot = await fetch(`${url}/api/session`, { headers: headers(PLAY_TOKEN) })
      expect(snapshot.status).toBe(200)
      const body = (await snapshot.json()) as { choices: Array<{ id: string; label: string }> }
      expect(body.choices.map(choice => choice.id)).toEqual(['c1', 'c2', 'c3'])
      expect(body.choices.every(choice => typeof choice.label === 'string')).toBe(true)

      // The script draws the buttons from that list (capped at three) and posts
      // the picked id — the assertion is on the data flow, since the suite has
      // no browser/DOM harness.
      const script = await (await fetch(`${url}/play.js`)).text()
      expect(script).toContain('current.choices')
      expect(script).toContain('choice.label')
      expect(script).toContain('.slice(0, 3)')
      expect(script).toContain('choiceId')
      expect(script).toContain('/api/session/choice')

      // Clicking an option posts exactly that id to the token-guarded route.
      const picked = await fetch(`${url}/api/session/choice`, {
        method: 'POST',
        headers: headers(PLAY_TOKEN, true),
        body: JSON.stringify({ choiceId: 'c2' }),
      })
      expect(picked.status).toBe(200)
      expect(calls).toEqual(['choice:c2'])

      // Anonymous clicks are refused like every other data endpoint.
      const anonymous = await fetch(`${url}/api/session/choice`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ choiceId: 'c1' }),
      })
      expect(anonymous.status).toBe(401)
    } finally {
      await server.stop()
    }
  })

  it('serves the single-window app from the in-memory bundle the dev server ships', async () => {
    // `start-dev.bat` runs `dev-server.ts`, which inlines the UI files into the
    // bundle and hands them over as `staticFiles`; this is that exact path.
    const { readFile } = await import('node:fs/promises')
    const names = ['index.html', 'chart-math.js', 'play.js', 'app.js', 'shell.js', 'settings.js'] as const
    const files = Object.fromEntries(await Promise.all(names.map(async name =>
      [name, await readFile(join(process.cwd(), 'src', 'ui', name), 'utf8')] as const,
    )))
    const calls: string[] = []
    const server = new DashboardServer({
      deps: playDeps(calls),
      token: PLAY_TOKEN,
      staticFiles: files,
    })
    const address = await server.start()
    const url = `http://${address.host}:${address.port}`
    try {
      // `/play` is a deep link into the same page, not a second document.
      const page = await fetch(`${url}/play`)
      expect(page.status).toBe(200)
      expect(await page.text()).toContain('/play.js')

      const script = await fetch(`${url}/play.js`)
      expect(script.status).toBe(200)
      expect(script.headers.get('content-type')).toContain('javascript')
      expect(await script.text()).toContain('/api/session/transcript')

      // 图表数学和 play.js 一起被内联进 bundle；缺了它柱状图只剩基线。
      const chartMath = await fetch(`${url}/chart-math.js`)
      expect(chartMath.status).toBe(200)
      expect(chartMath.headers.get('content-type')).toContain('javascript')
      expect(await chartMath.text()).toContain('computeBars')

      const shell = await fetch(`${url}/shell.js`)
      expect(shell.status).toBe(200)
      expect(shell.headers.get('content-type')).toContain('javascript')
    } finally {
      await server.stop()
    }
  })
})
