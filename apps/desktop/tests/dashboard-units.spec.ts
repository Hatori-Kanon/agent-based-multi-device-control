import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { COYOTE_BLE_NAME, FakeClock, hzBandToCode, MockBleTransport } from '@embodied/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHostRuntime, type HostRuntime } from '../src/main/bootstrap.ts'

let root: string
let runtime: HostRuntime | undefined

beforeEach(async () => {
  await mkdir(join(process.cwd(), '.test-tmp'), { recursive: true })
  root = await mkdtemp(join(process.cwd(), '.test-tmp', 'units-'))
})

afterEach(async () => {
  await runtime?.shutdown()
  runtime = undefined
  await rm(root, { recursive: true, force: true })
})

function base(host: HostRuntime): string {
  const address = host.dashboardAddress!
  return `http://${address.host}:${address.port}`
}

/**
 * A host with a Coyote registered through the fake BLE transport.
 *
 * The well-known manifest units (`coyote`, `xhtkj`, `zkrxb`) are registered
 * disconnected, plus the two mock devices the test runtime seeds by default.
 * That mix is exactly what the decoration needs: one Coyote, one other
 * protocol, and one device the operator manifest does not know.
 */
async function start(): Promise<HostRuntime> {
  const clock = new FakeClock()
  const transport = new MockBleTransport({ clock, name: COYOTE_BLE_NAME })
  runtime = await createHostRuntime({
    dataDir: root,
    clock,
    withPanicServer: false,
    withButtplug: false,
    bleTransport: transport,
  })
  return runtime
}

function headers(token: string, json = false): Record<string, string> {
  return {
    'x-control-token': token,
    ...(json ? { 'Content-Type': 'application/json' } : {}),
  }
}

interface ChannelSnapshot {
  readonly id: string
  readonly minFreq: number
  readonly maxFreq: number
  readonly minPercent: number
  readonly maxPercent: number
  readonly intensityUnit?: string
  readonly intensityMax?: number
  readonly minFreqHz?: number
  readonly maxFreqHz?: number
}

interface DeviceSnapshot {
  readonly id: string
  readonly protocol?: string
  readonly channels: readonly ChannelSnapshot[]
}

interface SnapshotBody {
  readonly devices: readonly DeviceSnapshot[]
}

interface WaveformEntry {
  readonly id: string
  readonly minFreq: number
  readonly maxFreq: number
  readonly minFreqHz?: number
  readonly maxFreqHz?: number
}

async function snapshot(host: HostRuntime): Promise<SnapshotBody> {
  const response = await fetch(`${base(host)}/api/snapshot`, { headers: headers(host.dashboardToken) })
  expect(response.status).toBe(200)
  return await response.json() as SnapshotBody
}

function channel(snapshot: SnapshotBody, deviceId: string, channelId: string): ChannelSnapshot | undefined {
  return snapshot.devices.find(device => device.id === deviceId)?.channels.find(entry => entry.id === channelId)
}

/** POST /api/cap with the console's schema. */
async function cap(
  host: HostRuntime,
  patch: Record<string, unknown>,
  deviceId = 'coyote',
  channelId = 'a',
): Promise<Response> {
  return await fetch(`${base(host)}/api/cap`, {
    method: 'POST',
    headers: headers(host.dashboardToken, true),
    body: JSON.stringify({ deviceId, channelId, patch }),
  })
}

describe('dashboard native units', () => {
  it('decorates the Coyote snapshot with protocol and native strength, keeping code fields', async () => {
    const host = await start()
    const live = await snapshot(host)

    const coyote = live.devices.find(device => device.id === 'coyote')
    expect(coyote?.protocol).toBe('coyote')
    const coyoteChannel = coyote?.channels.find(entry => entry.id === 'a')
    expect(coyoteChannel).toMatchObject({
      intensityUnit: 'strength',
      intensityMax: 200,
      // The protocol-unit fields stay untouched for compatibility.
      minFreq: 10,
      maxFreq: 240,
      // Full default band: 240 is 1 Hz, 10 is 100 Hz.
      minFreqHz: 1,
      maxFreqHz: 100,
    })

    // A non-Coyote BLE protocol is a percentage device.
    const xhtkj = live.devices.find(device => device.id === 'xhtkj')
    expect(xhtkj?.protocol).toBe('xhtkj')
    expect(xhtkj?.channels[0]).toMatchObject({ intensityUnit: 'percent', intensityMax: 100 })
    expect(xhtkj?.channels[0]?.minFreqHz).toBeTypeOf('number')

    // The mock pair is not in the operator manifest, so `protocol` is omitted
    // and the channel falls back to percentage units.
    const mock = live.devices.find(device => device.id === 'mock-pulse')
    expect(mock).toBeDefined()
    expect(mock?.protocol).toBeUndefined()
    expect(mock?.channels[0]).toMatchObject({ intensityUnit: 'percent', intensityMax: 100 })
  })

  it('converts a whole-Hz frequency patch into the protocol code pair', async () => {
    const host = await start()
    const response = await cap(host, { minFreqHz: 5, maxFreqHz: 50 })
    expect(response.status).toBe(200)

    const expected = hzBandToCode({ minHz: 5, maxHz: 50 })
    const after = await response.json() as SnapshotBody
    const live = channel(after, 'coyote', 'a')
    expect(live?.minFreq).toBe(expected.minCode)
    expect(live?.maxFreq).toBe(expected.maxCode)
    // Read back through the snapshot: 20 code = 50 Hz, 120 code = 5 Hz.
    expect(live).toMatchObject({ minFreqHz: 5, maxFreqHz: 50 })

    // The stored policy agrees on the next plain snapshot too.
    expect(channel(await snapshot(host), 'coyote', 'a')).toMatchObject({
      minFreq: expected.minCode,
      maxFreq: expected.maxCode,
      minFreqHz: 5,
      maxFreqHz: 50,
    })
  })

  it('resolves a one-sided Hz patch from the stored band before converting', async () => {
    const host = await start()

    // Default band is 1-100 Hz and only the fast end is narrowed to 5 Hz.
    const first = await cap(host, { minFreqHz: 5 })
    expect(first.status).toBe(200)
    const firstChannel = channel(await first.json() as SnapshotBody, 'coyote', 'a')
    expect(firstChannel).toMatchObject({ minFreqHz: 5, maxFreqHz: 100 })
    // The complete code pair was written, not just one endpoint.
    expect(firstChannel?.minFreq).toBe(hzBandToCode({ minHz: 5, maxHz: 100 }).minCode)
    expect(firstChannel?.maxFreq).toBe(hzBandToCode({ minHz: 5, maxHz: 100 }).maxCode)

    // Then the slow end is narrowed to 20 Hz against the stored 5 Hz floor.
    const second = await cap(host, { maxFreqHz: 20 })
    expect(second.status).toBe(200)
    const secondChannel = channel(await second.json() as SnapshotBody, 'coyote', 'a')
    expect(secondChannel).toMatchObject({ minFreqHz: 5, maxFreqHz: 20 })
    expect(secondChannel?.minFreq).toBe(hzBandToCode({ minHz: 5, maxHz: 20 }).minCode)
    expect(secondChannel?.maxFreq).toBe(hzBandToCode({ minHz: 5, maxHz: 20 }).maxCode)
  })

  it('leaves the untouched frequency endpoint on its exact code for a one-sided patch', async () => {
    const host = await start()
    // Establish a narrow high band: 91-100 Hz. The protocol can only say
    // "code 11 = 90.9 Hz" and "code 10 = 100 Hz", so the display rounds to
    // 91-100 while the raw codes are 10 (fast) .. 11 (slow).
    const set = await cap(host, { minFreqHz: 91, maxFreqHz: 100 })
    expect(set.status).toBe(200)
    const established = channel(await set.json() as SnapshotBody, 'coyote', 'a')
    expect(established).toMatchObject({ minFreq: 10, maxFreq: 11, minFreqHz: 91, maxFreqHz: 100 })

    // Move only the fast end. Re-quantising the untouched 91 Hz display value
    // would collapse the band and push the slow end down to 83 Hz; the raw
    // slow code must stay exactly where it was.
    const moved = await cap(host, { maxFreqHz: 95 })
    expect(moved.status).toBe(200)
    const after = channel(await moved.json() as SnapshotBody, 'coyote', 'a')
    expect(after?.minFreq).toBe(10)
    expect(after?.maxFreq).toBe(11)
    expect(after).toMatchObject({ minFreqHz: 91, maxFreqHz: 100 })

    // The same rule for the slow end: it may not drag the fast code with it.
    const slower = await cap(host, { minFreqHz: 95 })
    expect(slower.status).toBe(200)
    const slowerChannel = channel(await slower.json() as SnapshotBody, 'coyote', 'a')
    expect(slowerChannel?.minFreq).toBe(10)
    expect(slowerChannel?.maxFreq).toBe(11)
  })

  it('rejects a one-sided Hz patch that would cross the untouched endpoint', async () => {
    const host = await start()
    const established = await cap(host, { minFreqHz: 5, maxFreqHz: 50 })
    expect(established.status).toBe(200)
    const stored = hzBandToCode({ minHz: 5, maxHz: 50 })

    // `minFreqHz` is the slow end and `maxFreqHz` the fast end: crossing or
    // touching the other end must be a clean 400, not a clamped arbitrary band.
    for (const patch of [
      { minFreqHz: 60 },
      { minFreqHz: 50 },
      { maxFreqHz: 4 },
      { maxFreqHz: 5 },
    ]) {
      const response = await cap(host, patch)
      expect(response.status, JSON.stringify(patch)).toBe(400)
      expect((await response.json() as { code?: string }).code).toBe('INVALID_POLICY')
    }

    // Every rejected patch left the stored band exactly where it was.
    expect(channel(await snapshot(host), 'coyote', 'a')).toMatchObject({
      minFreq: stored.minCode,
      maxFreq: stored.maxCode,
      minFreqHz: 5,
      maxFreqHz: 50,
    })
  })

  it('accepts Hz fields together with percentage fields in one all-or-nothing patch', async () => {
    const host = await start()
    const response = await cap(host, { maxPercent: 55, minFreqHz: 5, maxFreqHz: 50 })
    expect(response.status).toBe(200)
    const after = await response.json() as SnapshotBody
    expect(channel(after, 'coyote', 'a')).toMatchObject({ maxPercent: 55, minFreqHz: 5, maxFreqHz: 50 })

    // A bad Hz field rejects the whole patch: the percentage must not move.
    const bad = await cap(host, { maxPercent: 80, minFreqHz: 0, maxFreqHz: 50 })
    expect(bad.status).toBe(400)
    const unchanged = channel(await snapshot(host), 'coyote', 'a')
    expect(unchanged?.maxPercent).toBe(55)
    expect(unchanged).toMatchObject({ minFreqHz: 5, maxFreqHz: 50 })
  })

  it('rejects malformed, mixed, or empty Hz patches', async () => {
    const host = await start()

    for (const patch of [
      { minFreqHz: 0 },
      { maxFreqHz: 101 },
      { minFreqHz: 20, maxFreqHz: 5 },
      { minFreqHz: 5, maxFreqHz: 5 },
      { minFreqHz: 5, minFreq: 20 },
      { minFreqHz: 5.5 },
    ]) {
      const response = await cap(host, patch)
      expect(response.status, JSON.stringify(patch)).toBe(400)
      // A bad cap patch is always a policy refusal, never a partial apply.
      expect((await response.json() as { code?: string }).code).toBe('INVALID_POLICY')
    }

    // Nothing above may have moved the stored band.
    expect(channel(await snapshot(host), 'coyote', 'a')).toMatchObject({
      minFreq: 10,
      maxFreq: 240,
      minFreqHz: 1,
      maxFreqHz: 100,
    })

    // A one-sided Hz patch for an unknown channel cannot resolve its other end.
    expect((await cap(host, { minFreqHz: 5 }, 'coyote', 'nope')).status).toBe(400)
  })

  it('keeps accepting legacy protocol-code frequency patches', async () => {
    const host = await start()
    const response = await cap(host, { minFreq: 20, maxFreq: 120 })
    expect(response.status).toBe(200)
    expect(channel(await response.json() as SnapshotBody, 'coyote', 'a')).toMatchObject({
      minFreq: 20,
      maxFreq: 120,
      // Display path still reads in Hz.
      minFreqHz: 5,
      maxFreqHz: 50,
    })
  })

  it('adds Hz display bands to every waveform payload', async () => {
    const host = await start()
    const list = await fetch(`${base(host)}/api/waveforms`, { headers: headers(host.dashboardToken) })
    expect(list.status).toBe(200)
    const waveforms = await list.json() as WaveformEntry[]
    expect(waveforms.length).toBeGreaterThan(0)
    for (const waveform of waveforms) {
      expect(waveform.minFreqHz, waveform.id).toBeTypeOf('number')
      expect(waveform.maxFreqHz, waveform.id).toBeTypeOf('number')
      if (typeof waveform.minFreqHz !== 'number' || typeof waveform.maxFreqHz !== 'number') {
        throw new Error(`waveform ${waveform.id} is missing its Hz display band`)
      }
      expect(Number.isInteger(waveform.minFreqHz)).toBe(true)
      expect(Number.isInteger(waveform.maxFreqHz)).toBe(true)
      expect(waveform.minFreqHz).toBeGreaterThanOrEqual(1)
      expect(waveform.maxFreqHz).toBeLessThanOrEqual(100)
      expect(waveform.minFreqHz).toBeLessThanOrEqual(waveform.maxFreqHz)
      // Protocol codes stay published next to the Hz display values.
      expect(waveform.minFreq).toBeGreaterThanOrEqual(10)
      expect(waveform.maxFreq).toBeLessThanOrEqual(240)
    }

    const imported = await fetch(`${base(host)}/api/waveforms/import`, {
      method: 'POST',
      headers: headers(host.dashboardToken, true),
      body: JSON.stringify({ name: 'Hz 波形', frames: '0A0A0A0A00000000 0A0A0A0A64646464' }),
    })
    expect(imported.status).toBe(200)
    const body = await imported.json() as { imported: { id: string }; waveforms: WaveformEntry[] }
    const entry = body.waveforms.find(waveform => waveform.id === body.imported.id)
    // Both frames carry code 10 in every slot, which is 100 Hz.
    expect(entry).toMatchObject({ minFreq: 10, maxFreq: 10, minFreqHz: 100, maxFreqHz: 100 })
  })

  it('serves the settings deep link from the single-window page', async () => {
    const host = await start()
    const response = await fetch(`${base(host)}/settings`)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/html')
  })

  it('no longer allows adding the simulated-device protocol', async () => {
    const host = await start()
    const response = await fetch(`${base(host)}/api/devices`, {
      method: 'POST',
      headers: headers(host.dashboardToken, true),
      body: JSON.stringify({ protocol: 'mock' }),
    })
    expect(response.status).toBe(400)
  })
})
