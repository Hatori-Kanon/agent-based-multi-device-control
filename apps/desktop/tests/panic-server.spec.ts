import { afterEach, describe, expect, it } from 'vitest'
import { PanicServer, type PanicServerOptions } from '../src/main/panic-server.ts'

const TOKEN = 'k'.repeat(32)

let running: PanicServer | undefined

afterEach(async () => {
  await running?.stop()
  running = undefined
})

async function start(overrides: Partial<PanicServerOptions> = {}) {
  const panics: string[] = []
  const options: PanicServerOptions = {
    token: TOKEN,
    port: 0,
    onPanic: source => { panics.push(source); return Promise.resolve() },
    onStatus: () => ({ locked: false }),
    ...overrides,
  }
  running = new PanicServer(options)
  const address = await running.start()
  return { panics, address, base: `http://${address.host}:${address.port}` }
}

describe('PanicServer', () => {
  it('refuses a short token at construction', () => {
    expect(() => new PanicServer({
      token: 'short',
      onPanic: () => Promise.resolve(),
      onStatus: () => ({}),
    })).toThrow(/at least 16/)
  })

  it('binds loopback by default', async () => {
    const { address } = await start()
    expect(address.host).toBe('127.0.0.1')
    expect(address.port).toBeGreaterThan(0)
  })

  it('answers nothing without a valid token', async () => {
    const { base, panics } = await start()

    const anonymous = await fetch(`${base}/panic`, { method: 'POST' })
    expect(anonymous.status).toBe(401)

    // Same length, wrong value.
    const wrong = await fetch(`${base}/panic`, {
      method: 'POST',
      headers: { authorization: `Bearer ${'x'.repeat(32)}` },
    })
    expect(wrong.status).toBe(401)

    // Different length.
    const short = await fetch(`${base}/panic`, {
      method: 'POST',
      headers: { 'x-panic-token': 'nope' },
    })
    expect(short.status).toBe(401)

    const status = await fetch(`${base}/status`)
    expect(status.status).toBe(401)

    expect(panics).toEqual([])
  })

  it('triggers a stop and reports the source', async () => {
    const { base, panics } = await start()
    const response = await fetch(`${base}/panic`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ source: 'phone' }),
    })
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ ok: true, stopped: true, source: 'phone' })
    expect(panics).toEqual(['phone'])
  })

  it('accepts a bodyless stop and an unparseable one', async () => {
    const { base, panics } = await start()
    await fetch(`${base}/panic`, { method: 'POST', headers: { 'x-panic-token': TOKEN } })
    await fetch(`${base}/panic`, { method: 'POST', headers: { 'x-panic-token': TOKEN }, body: 'not json' })
    expect(panics).toEqual(['remote', 'remote'])
  })

  it('serves status to an authenticated caller', async () => {
    const { base } = await start({ onStatus: () => ({ locked: true, devices: [] }) })
    const response = await fetch(`${base}/status`, { headers: { 'x-panic-token': TOKEN } })
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ ok: true, status: { locked: true } })
  })

  it('rejects an oversized body instead of buffering it', async () => {
    const { base, panics } = await start()
    const response = await fetch(`${base}/panic`, {
      method: 'POST',
      headers: { 'x-panic-token': TOKEN },
      body: 'z'.repeat(64 * 1024),
    }).catch(() => undefined)
    // The connection may be destroyed before a status is written; either way
    // no stop was recorded from a body that large.
    if (response !== undefined) expect([413, 500]).toContain(response.status)
    expect(panics).toEqual([])
  })

  it('404s an unknown route', async () => {
    const { base } = await start()
    const response = await fetch(`${base}/anything`, { headers: { 'x-panic-token': TOKEN } })
    expect(response.status).toBe(404)
  })

  it('stops listening after stop()', async () => {
    const { base } = await start()
    await running?.stop()
    running = undefined
    await expect(fetch(`${base}/status`, { headers: { 'x-panic-token': TOKEN } })).rejects.toThrow()
  })
})
