/**
 * MonsterParty relay backend — 安可尼 / 谜姬 / 醉清风.
 *
 * These brands share one WebSocket relay, so one implementation covers all
 * three. A share link carries a session token; anyone holding it joins the
 * relay as the controlling side.
 *
 * **This device has no hardware dead-man switch.** One `op:3` sets a level and
 * the toy holds it; the `op:8` heartbeat keeps the *relay* alive, not the
 * output. It therefore sits in the same category as a Buttplug toy: if the host
 * process dies, output continues. The Coyote's frame stream is the exception,
 * not the rule.
 *
 * Two operational facts worth knowing:
 *
 * - The share token is single-use in practice and expires on disconnect, so a
 *   mid-session drop needs a fresh link pasted by the operator.
 * - The transport must not send protocol-level pings. The reference
 *   implementation traced mysterious two-minute disconnects to a client ping;
 *   only the `op:8` application heartbeat may be used.
 *
 * Protocol cross-verified against `_reference/chemtrails/README.md` and
 * `_reference/dsh-toy/src/monsterparty.ts`.
 */

import { SafetyError } from '../../devices/errors.ts'
import type { Channel, DeviceBackend } from '../../devices/types.ts'
import type { Clock, Timer } from '../../ports/clock.ts'
import type { FetchLike } from '../../ports/http.ts'
import type { TextSocket, TextSocketTransport } from '../../ports/websocket.ts'

export const MONSTERPARTY_API_URL = 'https://api.monsterparty.cc/main/v1/remote'
export const MONSTERPARTY_ORIGIN = 'https://www.monsterparty.cn'

/** Opcode the relay expects for a join. */
const OP_JOIN = 2
/** Opcode that carries motor levels. */
const OP_LEVELS = 3
/** Application heartbeat. Never replace this with a protocol ping. */
const OP_HEARTBEAT = 8
/** Relay assigns our sender fd. */
const OP_SENDER = 6
/** Toy connection state plus its product id. */
const OP_DEVICE = 15

/** Fixed client id used by the reference implementations. */
const JOIN_ID = 8_899_001

/** The relay always expects ten slots. */
const VIB_SLOTS = 10

const VIBRATION_CHANNEL: Channel = { id: 'vibration', kind: 'level', label: '震动马达' }
const SUCTION_CHANNEL: Channel = { id: 'suction', kind: 'level', label: '吸力泵' }

export interface MonsterPartyBackendOptions {
  readonly id?: string
  readonly name?: string
  readonly clock: Clock
  readonly sockets: TextSocketTransport
  /**
   * Token from the share-link path.
   *
   * Comes from operator configuration only. It must never appear in a tool
   * argument, a tool result, or an error message that a model can read.
   */
  readonly sessionToken: string
  readonly apiUrl?: string
  readonly origin?: string
  readonly userAgent?: string
  readonly connectionTimeoutMs?: number
  readonly readyTimeoutMs?: number
  readonly heartbeatIntervalMs?: number
  readonly fetch?: FetchLike
  readonly onError?: (error: unknown) => void
}

interface SessionInfo {
  readonly socketUrl: string
  readonly sessionId: string | number
  readonly userId: string | number
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseSession(value: unknown): SessionInfo {
  if (!isObject(value) || !isObject(value.data)) {
    throw new SafetyError('NOT_CONNECTED', 'MonsterParty session response had no data object')
  }
  const socketUrl = value.data.socket_url
  const sessionId = value.data.id
  const userId = value.data.user_id
  if (typeof socketUrl !== 'string' || socketUrl.length === 0) {
    throw new SafetyError('NOT_CONNECTED', 'MonsterParty session response had no socket_url')
  }
  if (
    (typeof sessionId !== 'string' && typeof sessionId !== 'number')
    || (typeof userId !== 'string' && typeof userId !== 'number')
  ) {
    throw new SafetyError('NOT_CONNECTED', 'MonsterParty session response had an invalid id or user_id')
  }
  return { socketUrl, sessionId, userId }
}

function clampPercent(percent: number): number {
  if (!Number.isFinite(percent) || percent <= 0) return 0
  return Math.min(100, Math.round(percent))
}

export class MonsterPartyBackend implements DeviceBackend {
  readonly id: string

  private socket: TextSocket | undefined
  private offMessage: (() => void) | undefined
  private offClose: (() => void) | undefined
  private heartbeat: Timer | undefined
  private senderFd: string | number | undefined
  private productId = ''
  private keyType: 'suck' | 'vib' = 'vib'
  private dualMotor = false
  private ready = false
  private vibration = 0
  private suction = 0
  private readonly linkLostListeners = new Set<() => void>()

  constructor(private readonly options: MonsterPartyBackendOptions) {
    this.id = options.id ?? 'monsterparty'
    if (options.sessionToken.trim().length === 0) {
      throw new SafetyError('NOT_CONNECTED', 'a MonsterParty share token is required; paste a fresh link in the app')
    }
  }

  get name(): string {
    if (this.options.name !== undefined) return this.options.name
    return this.productId.length > 0 ? `MonsterParty ${this.productId}` : 'MonsterParty remote toy'
  }

  /**
   * Dual-motor toys are only revealed by the handshake, so this is a getter and
   * the registry re-reads it after connect.
   */
  get channels(): readonly Channel[] {
    return this.dualMotor ? [VIBRATION_CHANNEL, SUCTION_CHANNEL] : [VIBRATION_CHANNEL]
  }

  /** Product id reported by the relay, once known. */
  get reportedProductId(): string {
    return this.productId
  }

  async connect(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    this.resetState()

    const session = await this.resolveSession(signal)
    const socket = await this.options.sockets.open({
      url: session.socketUrl,
      headers: {
        // The relay rejects a connection without this.
        Origin: this.options.origin ?? MONSTERPARTY_ORIGIN,
        ...(this.options.userAgent === undefined ? {} : { 'User-Agent': this.options.userAgent }),
      },
      timeoutMs: this.options.connectionTimeoutMs ?? 10_000,
    }, signal)
    this.socket = socket

    try {
      await socket.send(JSON.stringify({
        op: OP_JOIN,
        id: JOIN_ID,
        gender: 'male',
        remoteID: session.sessionId,
        senderID: session.userId,
        avatar: '',
        nickname: this.id,
        lat: 0,
        lng: 0,
        area: '',
      }))
      await this.waitUntilReady(socket, signal)
    } catch (error) {
      await this.teardown()
      throw error
    }

    // Steady-state listeners take over once the handshake is done.
    this.offMessage = socket.onMessage(text => { this.receive(text) })
    this.offClose = socket.onClose(() => { this.handleLinkLost() })
    this.startHeartbeat(socket)
  }

  async applyLevel(channelId: string, percent: number): Promise<void> {
    this.assertReady()
    const value = clampPercent(percent)
    if (channelId === VIBRATION_CHANNEL.id) {
      this.vibration = value
    } else if (channelId === SUCTION_CHANNEL.id) {
      if (!this.dualMotor) {
        throw new SafetyError('UNKNOWN_CHANNEL', `${this.id} reported a single-motor toy (${this.productId}); it has no suction channel`)
      }
      this.suction = value
    } else {
      throw new SafetyError('UNKNOWN_CHANNEL', `${this.id} has no channel "${channelId}"`)
    }
    await this.sendLevels()
  }

  async stopAll(): Promise<void> {
    this.vibration = 0
    this.suction = 0
    if (!this.ready || this.socket?.open !== true) return
    await this.sendLevels()
  }

  onLinkLost(listener: () => void): () => void {
    this.linkLostListeners.add(listener)
    return () => { this.linkLostListeners.delete(listener) }
  }

  async close(): Promise<void> {
    if (this.ready && this.socket?.open === true) {
      try {
        await this.stopAll()
      } catch (error) {
        this.options.onError?.(error)
      }
    }
    await this.teardown()
  }

  private async resolveSession(signal: AbortSignal): Promise<SessionInfo> {
    const url = new URL(this.options.apiUrl ?? MONSTERPARTY_API_URL)
    url.searchParams.set('s', this.options.sessionToken)
    const doFetch = this.options.fetch ?? (globalThis.fetch as FetchLike | undefined)
    if (doFetch === undefined) {
      throw new SafetyError('NOT_CONNECTED', 'no fetch implementation is available for the MonsterParty session request')
    }

    let response
    try {
      response = await doFetch(url.toString(), {
        signal,
        ...(this.options.userAgent === undefined ? {} : { headers: { 'User-Agent': this.options.userAgent } }),
      })
    } catch (error) {
      // Never surface the error verbatim: its message may carry the request
      // URL, and the URL carries the share token.
      throw new SafetyError('NOT_CONNECTED', `MonsterParty session request failed: ${this.sanitize(error)}`)
    }
    if (!response.ok) {
      throw new SafetyError('NOT_CONNECTED', `MonsterParty session request failed with HTTP ${response.status}`)
    }
    const value: unknown = await response.json()
    if (isObject(value) && typeof value.errNo === 'number' && value.errNo !== 0) {
      throw new SafetyError(
        'NOT_CONNECTED',
        `MonsterParty rejected the share token (errNo ${value.errNo}); tokens are usually single-use, so generate a fresh link`,
      )
    }
    return parseSession(value)
  }

  /** Strip anything that could contain the share token. */
  private sanitize(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error)
    return message.split(this.options.sessionToken).join('<token>')
  }

  private waitUntilReady(socket: TextSocket, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false
      let senderFd: string | number | undefined
      let productId = ''

      const finish = (error?: Error): void => {
        if (settled) return
        settled = true
        timer.cancel()
        signal.removeEventListener('abort', onAbort)
        offMessage()
        offClose()
        if (error !== undefined) {
          reject(error)
          return
        }
        this.senderFd = senderFd
        this.productId = productId
        // The product id is the only capability signal the relay gives us.
        this.keyType = productId.toUpperCase().includes('SUCK') ? 'suck' : 'vib'
        this.dualMotor = productId.toUpperCase().includes('DS')
        this.ready = true
        resolve()
      }

      const offMessage = socket.onMessage(text => {
        const message = parseFrame(text)
        if (message === undefined) return
        if (typeof message.errNo === 'number' && message.errNo !== 0) {
          finish(new SafetyError('NOT_CONNECTED', `MonsterParty handshake failed (errNo ${message.errNo})`))
          return
        }
        if (message.op === OP_SENDER && isObject(message.sender)) {
          const fd = message.sender.fd
          if (typeof fd === 'number' || typeof fd === 'string') senderFd = fd
        }
        if (message.op === OP_DEVICE && message.conn === true) {
          productId = typeof message.pid === 'string' && message.pid.length > 0 ? message.pid : 'unknown'
        }
        if (senderFd !== undefined && productId.length > 0) finish()
      })

      const offClose = socket.onClose(() => {
        finish(new SafetyError('NOT_CONNECTED', 'MonsterParty relay closed before the toy became ready'))
      })

      const onAbort = (): void => {
        finish(signal.reason instanceof Error ? signal.reason : new SafetyError('NOT_CONNECTED', 'aborted'))
      }
      signal.addEventListener('abort', onAbort, { once: true })

      const readyTimeoutMs = this.options.readyTimeoutMs ?? 20_000
      const timer = this.options.clock.timeout(readyTimeoutMs, () => {
        finish(new SafetyError(
          'NOT_CONNECTED',
          `the MonsterParty toy was not ready after ${readyTimeoutMs}ms; check that it is powered on and use a fresh share link`,
        ))
      })
    })
  }

  private receive(text: string): void {
    const message = parseFrame(text)
    if (message === undefined) return
    // The relay reports the toy going offline while the socket stays up.
    if (message.op === OP_DEVICE && message.conn === false) this.handleLinkLost()
  }

  private async sendLevels(): Promise<void> {
    const socket = this.assertReady()
    const fd = this.senderFd
    if (fd === undefined) {
      throw new SafetyError('NOT_CONNECTED', 'the MonsterParty relay never assigned a sender fd')
    }
    // Slot 0 drives the suction pump and slots 1-4 the vibration motor on a
    // dual-motor toy; single-motor toys read every slot as vibration.
    const vib = this.dualMotor
      ? [this.suction, this.vibration, this.vibration, this.vibration, this.vibration, 0, 0, 0, 0, 0]
      : new Array<number>(VIB_SLOTS).fill(this.vibration)
    await socket.send(JSON.stringify({ op: OP_LEVELS, vib, fd, keyType: this.keyType }))
  }

  private startHeartbeat(socket: TextSocket): void {
    this.stopHeartbeat()
    const interval = this.options.heartbeatIntervalMs ?? 9_000
    this.heartbeat = this.options.clock.interval(interval, () => {
      if (socket.open !== true) return
      void socket.send(JSON.stringify({ op: OP_HEARTBEAT })).catch((error: unknown) => {
        this.options.onError?.(error)
        this.handleLinkLost()
      })
    })
  }

  private stopHeartbeat(): void {
    this.heartbeat?.cancel()
    this.heartbeat = undefined
  }

  private handleLinkLost(): void {
    if (!this.ready && this.socket === undefined) return
    this.stopHeartbeat()
    this.ready = false
    this.vibration = 0
    this.suction = 0
    for (const listener of [...this.linkLostListeners]) {
      try {
        listener()
      } catch (error) {
        this.options.onError?.(error)
      }
    }
  }

  private resetState(): void {
    this.senderFd = undefined
    this.productId = ''
    this.keyType = 'vib'
    this.dualMotor = false
    this.ready = false
    this.vibration = 0
    this.suction = 0
  }

  private async teardown(): Promise<void> {
    this.stopHeartbeat()
    this.offMessage?.()
    this.offMessage = undefined
    this.offClose?.()
    this.offClose = undefined
    const socket = this.socket
    this.socket = undefined
    this.ready = false
    if (socket?.open === true) {
      try {
        await socket.close(1000, 'closing')
      } catch (error) {
        this.options.onError?.(error)
      }
    }
  }

  private assertReady(): TextSocket {
    const socket = this.socket
    if (!this.ready || socket === undefined || !socket.open) {
      throw new SafetyError(
        'NOT_CONNECTED',
        `${this.id} is not connected; share tokens are usually single-use, so paste a fresh link and reconnect`,
      )
    }
    return socket
  }
}

function parseFrame(text: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(text)
    return isObject(value) ? value : undefined
  } catch {
    return undefined
  }
}
