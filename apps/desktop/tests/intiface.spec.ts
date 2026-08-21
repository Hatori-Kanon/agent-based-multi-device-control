import { createServer, type Server } from 'node:net'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import {
  INTIFACE_DEFAULT_PORT,
  IntifaceProcess,
  intifaceArguments,
  isPortOpen,
  waitForPort,
} from '../src/main/intiface.ts'

const servers: Server[] = []

async function listen(): Promise<number> {
  const server = createServer()
  servers.push(server)
  await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve) })
  return (server.address() as AddressInfo).port
}

/** A port nobody is listening on, obtained by closing one we just held. */
async function closedPort(): Promise<number> {
  const server = createServer()
  await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve) })
  const port = (server.address() as AddressInfo).port
  await new Promise<void>(resolve => { server.close(() => resolve()) })
  return port
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => { server.close(() => resolve()) })))
})

describe('intifaceArguments', () => {
  it('enables every transport the engine can serve', () => {
    expect(intifaceArguments(INTIFACE_DEFAULT_PORT)).toEqual([
      '--websocket-port',
      '12345',
      '--use-bluetooth-le',
      '--use-serial',
      '--use-hid',
    ])
  })
})

describe('isPortOpen', () => {
  it('detects a listening port', async () => {
    await expect(isPortOpen('127.0.0.1', await listen())).resolves.toBe(true)
  })

  it('reports a closed port without throwing', async () => {
    await expect(isPortOpen('127.0.0.1', await closedPort(), 300)).resolves.toBe(false)
  })
})

describe('waitForPort', () => {
  it('resolves once a server appears mid-wait', async () => {
    const port = await closedPort()
    const waiting = waitForPort('127.0.0.1', port, 3_000, 50)

    const server = createServer()
    servers.push(server)
    setTimeout(() => { server.listen(port, '127.0.0.1') }, 150)

    await expect(waiting).resolves.toBe(true)
  })

  it('gives up when the budget runs out', async () => {
    await expect(waitForPort('127.0.0.1', await closedPort(), 250, 50)).resolves.toBe(false)
  })
})

describe('IntifaceProcess', () => {
  it('leaves an engine it did not start alone', async () => {
    const port = await listen()
    const process = new IntifaceProcess({ port, executable: 'definitely-not-installed-engine' })

    // The whole point: an operator's own Intiface Central must not be touched.
    await expect(process.ensure()).resolves.toBe('already-running')
    expect(process.owned).toBe(false)
    // And stopping is a no-op rather than a kill.
    await expect(process.stop()).resolves.toBeUndefined()
    await expect(isPortOpen('127.0.0.1', port)).resolves.toBe(true)
  })

  it('reports unavailable instead of throwing when no engine is installed', async () => {
    const errors: unknown[] = []
    const process = new IntifaceProcess({
      port: await closedPort(),
      executable: 'definitely-not-installed-engine',
      onError: error => { errors.push(error) },
    })

    // A deployment with no Buttplug hardware is an ordinary case, not a fault.
    await expect(process.ensure()).resolves.toBe('unavailable')
    expect(process.owned).toBe(false)
    expect(errors.length).toBeGreaterThan(0)
  })

  it('exposes the endpoint the backend should dial', () => {
    const process = new IntifaceProcess({ port: 4_242 })
    expect(process.url).toBe('ws://127.0.0.1:4242')
  })
})
