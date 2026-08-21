/**
 * Node implementation of the text socket port, backed by `ws`.
 *
 * `ws` is used rather than the global `WebSocket` for one reason: the
 * MonsterParty relay requires an `Origin` request header, and the WHATWG
 * WebSocket API cannot set headers.
 *
 * **No ping/pong is configured, deliberately.** The reference implementation
 * traced mysterious two-minute disconnects on this relay to a client-side
 * protocol ping. `ws` clients do not ping unless asked, so the rule here is
 * simply: never ask. Liveness is the application's `op:8` heartbeat.
 */

import WebSocket from 'ws'
import type {
  TextSocket,
  TextSocketCloseInfo,
  TextSocketOpenOptions,
  TextSocketTransport,
} from '@embodied/core'

function frameText(data: WebSocket.RawData): string {
  if (typeof data === 'string') return data
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8')
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8')
  return data.toString('utf8')
}

class NodeTextSocket implements TextSocket {
  private readonly messageListeners = new Set<(text: string) => void>()
  private readonly closeListeners = new Set<(info: TextSocketCloseInfo) => void>()
  private live = true

  constructor(private readonly socket: WebSocket) {
    socket.on('message', data => {
      const text = frameText(data)
      for (const listener of [...this.messageListeners]) listener(text)
    })
    socket.on('close', (code: number, reason: Buffer) => {
      this.live = false
      const info: TextSocketCloseInfo = { code, reason: reason.toString('utf8') }
      for (const listener of [...this.closeListeners]) listener(info)
    })
    // A socket error is always followed by close, which is where callers are
    // notified; swallowing it here only prevents an unhandled 'error' throw.
    socket.on('error', () => {})
  }

  get open(): boolean {
    return this.live && this.socket.readyState === WebSocket.OPEN
  }

  send(text: string): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.open) {
        reject(new Error('socket is not open'))
        return
      }
      this.socket.send(text, error => {
        if (error === undefined || error === null) resolve()
        else reject(error)
      })
    })
  }

  onMessage(listener: (text: string) => void): () => void {
    this.messageListeners.add(listener)
    return () => { this.messageListeners.delete(listener) }
  }

  onClose(listener: (info: TextSocketCloseInfo) => void): () => void {
    this.closeListeners.add(listener)
    return () => { this.closeListeners.delete(listener) }
  }

  close(code = 1000, reason = ''): Promise<void> {
    if (this.socket.readyState === WebSocket.CLOSED) {
      this.live = false
      return Promise.resolve()
    }
    return new Promise(resolve => {
      let settled = false
      const finish = (): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        this.live = false
        resolve()
      }
      // A relay that never answers the close handshake must not wedge shutdown.
      const timer = setTimeout(() => {
        this.socket.terminate()
        finish()
      }, 1_000)
      this.socket.once('close', finish)
      this.socket.close(code, reason)
    })
  }
}

export class NodeTextSocketTransport implements TextSocketTransport {
  /**
   * `async` on purpose: a method typed `Promise<...>` that throws synchronously
   * hands an uncaught exception to any caller that only attached a `.catch()`.
   * An already-aborted signal must surface as a rejection.
   */
  async open(options: TextSocketOpenOptions, signal: AbortSignal): Promise<TextSocket> {
    signal.throwIfAborted()
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(options.url, {
        ...(options.headers === undefined ? {} : { headers: { ...options.headers } }),
        perMessageDeflate: false,
      })

      let settled = false
      const finish = (error?: Error): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal.removeEventListener('abort', onAbort)
        socket.off('open', onOpen)
        socket.off('error', onError)
        if (error === undefined) {
          resolve(new NodeTextSocket(socket))
          return
        }
        socket.terminate()
        reject(error)
      }

      const onOpen = (): void => { finish() }
      const onError = (error: Error): void => { finish(error) }
      const onAbort = (): void => {
        finish(signal.reason instanceof Error ? signal.reason : new Error('aborted'))
      }
      const timer = setTimeout(() => {
        finish(new Error(`socket did not open within ${options.timeoutMs}ms`))
      }, options.timeoutMs)

      socket.once('open', onOpen)
      socket.once('error', onError)
      signal.addEventListener('abort', onAbort, { once: true })
    })
  }
}
