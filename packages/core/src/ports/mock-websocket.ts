/** In-memory {@link TextSocketTransport} for tests. */

import type { TextSocket, TextSocketCloseInfo, TextSocketOpenOptions, TextSocketTransport } from './websocket.ts'

export class MockTextSocket implements TextSocket {
  /** Every frame the code under test sent, in order. */
  readonly sent: string[] = []
  private readonly messageListeners = new Set<(text: string) => void>()
  private readonly closeListeners = new Set<(info: TextSocketCloseInfo) => void>()
  private live = true
  closeCount = 0

  /**
   * @param failSend - Return an error to reject a specific frame.
   * @param onSend - Called after a frame is recorded, so a test can play the
   *   peer and answer a request. Request/response protocols are unusable
   *   without this.
   */
  constructor(
    private readonly failSend?: (text: string) => Error | undefined,
    private readonly onSend?: (text: string, socket: MockTextSocket) => void,
  ) {}

  get open(): boolean {
    return this.live
  }

  /** Frames parsed as JSON, for readable assertions. */
  get sentJson(): Record<string, unknown>[] {
    return this.sent.map(frame => JSON.parse(frame) as Record<string, unknown>)
  }

  send(text: string): Promise<void> {
    if (!this.live) return Promise.reject(new Error('mock socket is closed'))
    const failure = this.failSend?.(text)
    if (failure !== undefined) return Promise.reject(failure)
    this.sent.push(text)
    this.onSend?.(text, this)
    return Promise.resolve()
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
    this.closeCount += 1
    this.simulateClose(code, reason)
    return Promise.resolve()
  }

  /** Deliver an inbound frame. */
  emit(payload: unknown): void {
    const text = typeof payload === 'string' ? payload : JSON.stringify(payload)
    for (const listener of [...this.messageListeners]) listener(text)
  }

  /** Drop the socket the way a relay timeout would. */
  simulateClose(code = 1006, reason = 'abnormal'): void {
    if (!this.live) return
    this.live = false
    for (const listener of [...this.closeListeners]) listener({ code, reason })
  }
}

export interface MockTextSocketTransportOptions {
  readonly failOpen?: Error
  readonly failSend?: (text: string) => Error | undefined
  /** Lets a test play the peer; see {@link MockTextSocket}. */
  readonly onSend?: (text: string, socket: MockTextSocket) => void
}

export class MockTextSocketTransport implements TextSocketTransport {
  /** Options seen by `open`, so a test can assert on url and headers. */
  readonly opens: TextSocketOpenOptions[] = []
  socket: MockTextSocket | undefined

  constructor(private readonly options: MockTextSocketTransportOptions = {}) {}

  open(options: TextSocketOpenOptions, signal: AbortSignal): Promise<MockTextSocket> {
    this.opens.push(options)
    if (signal.aborted) return Promise.reject(signal.reason ?? new Error('aborted'))
    if (this.options.failOpen !== undefined) return Promise.reject(this.options.failOpen)
    const socket = new MockTextSocket(this.options.failSend, this.options.onSend)
    this.socket = socket
    return Promise.resolve(socket)
  }
}
