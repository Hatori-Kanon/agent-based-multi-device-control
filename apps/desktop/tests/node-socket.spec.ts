import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WebSocketServer, type WebSocket as ServerSocket } from 'ws'
import { NodeTextSocketTransport } from '../src/main/node-socket.ts'

let server: WebSocketServer | undefined
let url = ''
/** Headers of the most recent upgrade request. */
let lastHeaders: Record<string, string | string[] | undefined> = {}
let connections: ServerSocket[] = []

beforeEach(async () => {
  connections = []
  lastHeaders = {}
  server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise<void>(resolve => { server!.once('listening', resolve) })
  const address = server.address() as AddressInfo
  url = `ws://127.0.0.1:${address.port}`
  server.on('connection', (socket, request) => {
    lastHeaders = request.headers
    connections.push(socket)
    socket.on('message', data => { socket.send(`echo:${data.toString()}`) })
  })
})

afterEach(async () => {
  for (const socket of connections) socket.terminate()
  const current = server
  server = undefined
  if (current !== undefined) await new Promise<void>(resolve => { current.close(() => resolve()) })
})

function signal(): AbortSignal {
  return new AbortController().signal
}

function nextMessage(socket: { onMessage: (listener: (text: string) => void) => () => void }): Promise<string> {
  return new Promise(resolve => {
    const off = socket.onMessage(text => {
      off()
      resolve(text)
    })
  })
}

describe('NodeTextSocketTransport', () => {
  it('sets the request headers the relay requires', async () => {
    const transport = new NodeTextSocketTransport()
    const socket = await transport.open({
      url,
      headers: { Origin: 'https://www.monsterparty.cn', 'User-Agent': 'embodied-test/1.0' },
      timeoutMs: 5_000,
    }, signal())

    // This is the whole reason the port exists: the global WebSocket API
    // cannot set either of these.
    expect(lastHeaders.origin).toBe('https://www.monsterparty.cn')
    expect(lastHeaders['user-agent']).toBe('embodied-test/1.0')
    await socket.close()
  })

  it('carries text frames in both directions', async () => {
    const transport = new NodeTextSocketTransport()
    const socket = await transport.open({ url, timeoutMs: 5_000 }, signal())
    expect(socket.open).toBe(true)

    const inbound = nextMessage(socket)
    await socket.send(JSON.stringify({ op: 8 }))
    expect(await inbound).toBe('echo:{"op":8}')

    await socket.close()
    expect(socket.open).toBe(false)
  })

  it('reports a close initiated by the relay', async () => {
    const transport = new NodeTextSocketTransport()
    const socket = await transport.open({ url, timeoutMs: 5_000 }, signal())
    const closed = new Promise<{ code: number }>(resolve => { socket.onClose(resolve) })

    connections[0]?.close(1001, 'going away')

    const info = await closed
    expect(info.code).toBe(1001)
    expect(socket.open).toBe(false)
  })

  it('rejects a send once the socket is closed', async () => {
    const transport = new NodeTextSocketTransport()
    const socket = await transport.open({ url, timeoutMs: 5_000 }, signal())
    await socket.close()
    await expect(socket.send('nope')).rejects.toThrow(/not open/)
  })

  it('is safe to close twice', async () => {
    const transport = new NodeTextSocketTransport()
    const socket = await transport.open({ url, timeoutMs: 5_000 }, signal())
    await socket.close()
    await expect(socket.close()).resolves.toBeUndefined()
  })

  it('gives up on an unreachable endpoint instead of hanging', async () => {
    const transport = new NodeTextSocketTransport()
    // Port 1 on loopback refuses immediately on every platform we target.
    await expect(transport.open({ url: 'ws://127.0.0.1:1', timeoutMs: 3_000 }, signal()))
      .rejects.toBeDefined()
  })

  it('honours an already-aborted signal', async () => {
    const transport = new NodeTextSocketTransport()
    const controller = new AbortController()
    controller.abort()
    await expect(transport.open({ url, timeoutMs: 5_000 }, controller.signal)).rejects.toBeDefined()
  })
})
