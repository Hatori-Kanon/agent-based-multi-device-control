import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { FakeClock, type AuditRecord } from '@embodied/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHostRuntime, type HostRuntime } from '../src/main/bootstrap.ts'

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
