/**
 * Text WebSocket boundary.
 *
 * This port exists for one concrete reason: the MonsterParty relay requires an
 * `Origin` header, and the WHATWG WebSocket API cannot set request headers. So
 * the platform supplies the socket and `core` stays free of `ws` or any other
 * Node-only dependency.
 *
 * Only text frames are modelled. Every protocol reached through here is JSON.
 */

export interface TextSocketCloseInfo {
  readonly code: number
  readonly reason: string
}

export interface TextSocket {
  readonly open: boolean
  send(text: string): Promise<void>
  /** Subscribe to inbound frames. Returns a function that removes the listener. */
  onMessage(listener: (text: string) => void): () => void
  onClose(listener: (info: TextSocketCloseInfo) => void): () => void
  close(code?: number, reason?: string): Promise<void>
}

export interface TextSocketOpenOptions {
  readonly url: string
  /** Request headers; the reason this port is not the global WebSocket. */
  readonly headers?: Readonly<Record<string, string>>
  readonly timeoutMs: number
}

export interface TextSocketTransport {
  /** Open a socket, resolving once it is ready to carry frames. */
  open(options: TextSocketOpenOptions, signal: AbortSignal): Promise<TextSocket>
}
