/**
 * Buttplug / Intiface backend.
 *
 * Ported from `_reference/dsh-toy/src/buttplug.ts` (BSD-3-Clause); see NOTICE.
 *
 * Unlike every other backend here this one fronts a **hub**, not a toy: one
 * Intiface server serves any number of devices, which appear and disappear
 * while connected. So its channel set is dynamic, it implements `scan`, and it
 * reports channel changes for the registry to adopt.
 *
 * **No hardware dead-man switch.** One command sets a level and the toy holds
 * it; if the host dies, output continues. Same category as the 谜姬 and relay
 * backends. Only the Coyote's frame stream self-limits.
 *
 * The transport is the shared text-socket port, so nothing here is Node-specific
 * and the same code runs under React Native in M4b.
 */

import { SafetyError } from '../../devices/errors.ts'
import type { Channel, DeviceBackend } from '../../devices/types.ts'
import type { Clock, Timer } from '../../ports/clock.ts'
import type { TextSocket, TextSocketTransport } from '../../ports/websocket.ts'
import {
  channelIdFor,
  encodeMessage,
  outputCommandBody,
  parseChannelId,
  parseDevice,
  parseDeviceList,
  parseFrames,
  scalarCommandBody,
  serverInfoRequest,
  stopAllBody,
  type ButtplugDevice,
  type ButtplugFeature,
  type ButtplugProtocolVersion,
} from './protocol.ts'

/** Intiface Engine's default WebSocket endpoint. */
export const INTIFACE_DEFAULT_URL = 'ws://127.0.0.1:12345'

export interface ButtplugBackendOptions {
  readonly id?: string
  readonly name?: string
  readonly clock: Clock
  readonly sockets: TextSocketTransport
  readonly url?: string
  /** Negotiated protocol major version. Defaults to 4. */
  readonly version?: ButtplugProtocolVersion
  readonly clientName?: string
  readonly connectionTimeoutMs?: number
  readonly requestTimeoutMs?: number
  /** Discovery window run automatically on connect. 0 skips it. */
  readonly scanOnConnectMs?: number
  readonly onError?: (error: unknown) => void
}

interface Pending {
  readonly timer: Timer
  resolve(frame: { type: string; body: Readonly<Record<string, unknown>> }): void
  reject(error: Error): void
}

export class ButtplugBackend implements DeviceBackend {
  readonly id: string

  private socket: TextSocket | undefined
  private offMessage: (() => void) | undefined
  private offClose: (() => void) | undefined
  private pingTimer: Timer | undefined
  private nextId = 0
  private serverName = ''
  private ready = false
  /**
   * Guards against a doubled report: closing the socket after a protocol
   * violation raises `onClose`, which would otherwise announce the same loss
   * twice.
   */
  private linkLostFired = false
  private readonly pending = new Map<number, Pending>()
  private readonly devices = new Map<number, ButtplugDevice>()
  private readonly linkLostListeners = new Set<() => void>()
  private readonly channelsChangedListeners = new Set<() => void>()

  constructor(private readonly options: ButtplugBackendOptions) {
    this.id = options.id ?? 'buttplug'
  }

  get name(): string {
    if (this.options.name !== undefined) return this.options.name
    return this.serverName.length > 0 ? `Intiface (${this.serverName})` : 'Intiface / Buttplug'
  }

  private get version(): ButtplugProtocolVersion {
    return this.options.version ?? 4
  }

  /** One channel per scalar feature of every currently known device. */
  get channels(): readonly Channel[] {
    const channels: Channel[] = []
    for (const device of [...this.devices.values()].sort((left, right) => left.index - right.index)) {
      for (const feature of device.features) {
        // A v4 feature advertising a non-zero minimum has a real dead zone.
        const floor = feature.range[0] > 0 && feature.range[1] > 0
          ? Math.round((feature.range[0] / feature.range[1]) * 100)
          : 0
        channels.push({
          id: channelIdFor(feature),
          kind: 'level',
          label: `${device.displayName ?? device.name} · ${feature.description}`,
          ...(floor > 0 ? { outputFloorPercent: floor } : {}),
        })
      }
    }
    return channels
  }

  /** Devices currently reported by the server, for diagnostics. */
  get knownDevices(): readonly ButtplugDevice[] {
    return [...this.devices.values()]
  }

  async connect(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    this.devices.clear()
    this.serverName = ''
    this.nextId = 0
    this.linkLostFired = false

    const socket = await this.options.sockets.open({
      url: this.options.url ?? INTIFACE_DEFAULT_URL,
      timeoutMs: this.options.connectionTimeoutMs ?? 10_000,
    }, signal)
    this.socket = socket
    this.offMessage = socket.onMessage(text => { this.receive(text) })
    this.offClose = socket.onClose(() => { this.handleLinkLost() })
    this.ready = true

    try {
      const info = await this.request('RequestServerInfo', serverInfoRequest(this.options.clientName ?? 'embodied-roleplay', this.version))
      if (info.type !== 'ServerInfo') {
        throw new SafetyError('NOT_CONNECTED', `expected ServerInfo from the Buttplug server, received ${info.type}`)
      }
      const serverName = info.body.ServerName
      this.serverName = typeof serverName === 'string' ? serverName : 'Intiface'
      const maxPing = info.body.MaxPingTime
      if (typeof maxPing === 'number' && Number.isFinite(maxPing) && maxPing > 0) this.startPings(maxPing)

      await this.refreshDevices()
      const scanMs = this.options.scanOnConnectMs ?? 0
      if (scanMs > 0) await this.scan(scanMs, signal)
    } catch (error) {
      await this.teardown()
      throw error
    }
  }

  /** Bounded discovery, then refresh the device list. */
  async scan(durationMs: number, signal: AbortSignal): Promise<void> {
    this.assertReady()
    await this.request('StartScanning', {})
    try {
      await this.delay(durationMs, signal)
    } finally {
      if (this.socket?.open === true) {
        try {
          await this.request('StopScanning', {})
        } catch (error) {
          this.options.onError?.(error)
        }
      }
    }
    await this.refreshDevices()
  }

  async applyLevel(channelId: string, percent: number): Promise<void> {
    this.assertReady()
    const feature = this.featureFor(channelId)
    if (this.version === 3) {
      await this.request('ScalarCmd', scalarCommandBody(feature.deviceIndex, [{ feature, percent }]))
      return
    }
    await this.request('OutputCmd', outputCommandBody(feature, percent))
  }

  async stopAll(): Promise<void> {
    if (!this.ready || this.socket?.open !== true) return
    const { type, body } = stopAllBody(this.version)
    await this.request(type, body)
  }

  onLinkLost(listener: () => void): () => void {
    this.linkLostListeners.add(listener)
    return () => { this.linkLostListeners.delete(listener) }
  }

  onChannelsChanged(listener: () => void): () => void {
    this.channelsChangedListeners.add(listener)
    return () => { this.channelsChangedListeners.delete(listener) }
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

  private featureFor(channelId: string): ButtplugFeature {
    const parsed = parseChannelId(channelId)
    if (parsed === undefined) {
      throw new SafetyError('UNKNOWN_CHANNEL', `${this.id} channel ids look like "0:1:vibrate"; received "${channelId}"`)
    }
    const feature = this.devices.get(parsed.deviceIndex)?.features
      .find(candidate => candidate.featureIndex === parsed.featureIndex && candidate.kind === parsed.kind)
    if (feature === undefined) {
      throw new SafetyError('UNKNOWN_CHANNEL', `${this.id} has no channel "${channelId}"; the device may have disconnected`)
    }
    return feature
  }

  private async refreshDevices(): Promise<void> {
    const reply = await this.request('RequestDeviceList', {})
    if (reply.type !== 'DeviceList') {
      throw new SafetyError('NOT_CONNECTED', `expected DeviceList from the Buttplug server, received ${reply.type}`)
    }
    // The DeviceList body is applied by the event path, which every DeviceList
    // goes through whether solicited or not.
  }

  private request(type: string, fields: Readonly<Record<string, unknown>>): Promise<{ type: string; body: Readonly<Record<string, unknown>> }> {
    const socket = this.assertReady()
    const id = ++this.nextId
    return new Promise((resolve, reject) => {
      const timeoutMs = this.options.requestTimeoutMs ?? 5_000
      const timer = this.options.clock.timeout(timeoutMs, () => {
        this.pending.delete(id)
        reject(new SafetyError('NOT_CONNECTED', `Buttplug ${type} timed out after ${timeoutMs}ms`))
      })
      this.pending.set(id, { timer, resolve, reject })
      void socket.send(encodeMessage(type, id, fields)).catch((error: unknown) => {
        const entry = this.pending.get(id)
        if (entry === undefined) return
        this.pending.delete(id)
        entry.timer.cancel()
        reject(error instanceof Error ? error : new Error(String(error)))
      })
    })
  }

  private receive(text: string): void {
    let frames
    try {
      frames = parseFrames(text)
    } catch (error) {
      this.options.onError?.(error)
      // A peer that is not speaking this protocol is not recoverable.
      void this.socket?.close(1002, 'invalid protocol frame').catch(() => {})
      this.handleLinkLost()
      return
    }

    for (const frame of frames) {
      try {
        this.applyEvent(frame)
      } catch (error) {
        this.options.onError?.(error)
        void this.socket?.close(1002, 'invalid protocol message').catch(() => {})
        this.handleLinkLost()
        return
      }

      const id = frame.body.Id
      if (typeof id !== 'number' || id === 0) continue
      const entry = this.pending.get(id)
      if (entry === undefined) continue
      this.pending.delete(id)
      entry.timer.cancel()
      if (frame.type === 'Error') {
        const message = frame.body.ErrorMessage
        entry.reject(new SafetyError('NOT_CONNECTED', typeof message === 'string' ? message : 'Buttplug request failed'))
      } else {
        entry.resolve(frame)
      }
    }
  }

  private applyEvent(frame: { type: string; body: Readonly<Record<string, unknown>> }): void {
    if (frame.type === 'DeviceList') {
      const parsed = parseDeviceList(frame.body, this.version)
      this.devices.clear()
      for (const device of parsed) this.devices.set(device.index, device)
      this.notifyChannelsChanged()
      return
    }
    // v4 folds add/remove into DeviceList; v3 announces them separately.
    if (this.version !== 3) return
    if (frame.type === 'DeviceAdded') {
      const device = parseDevice(frame.body, 3)
      if (device !== undefined) {
        this.devices.set(device.index, device)
        this.notifyChannelsChanged()
      }
      return
    }
    if (frame.type === 'DeviceRemoved') {
      const index = frame.body.DeviceIndex
      if (typeof index === 'number' && this.devices.delete(index)) this.notifyChannelsChanged()
    }
  }

  private notifyChannelsChanged(): void {
    for (const listener of [...this.channelsChangedListeners]) {
      try {
        listener()
      } catch (error) {
        this.options.onError?.(error)
      }
    }
  }

  private startPings(maxPingTime: number): void {
    this.stopPings()
    const interval = Math.max(100, Math.floor(maxPingTime / 2))
    this.pingTimer = this.options.clock.interval(interval, () => {
      if (this.socket?.open !== true) return
      void this.request('Ping', {}).catch((error: unknown) => {
        this.options.onError?.(error)
        this.handleLinkLost()
      })
    })
  }

  private stopPings(): void {
    this.pingTimer?.cancel()
    this.pingTimer = undefined
  }

  private delay(ms: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.reject(signal.reason ?? new Error('aborted'))
    return new Promise((resolve, reject) => {
      const timer = this.options.clock.timeout(ms, () => {
        signal.removeEventListener('abort', onAbort)
        resolve()
      })
      const onAbort = (): void => {
        timer.cancel()
        reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'))
      }
      signal.addEventListener('abort', onAbort, { once: true })
    })
  }

  private handleLinkLost(): void {
    if (this.linkLostFired) return
    if (!this.ready && this.socket === undefined) return
    this.linkLostFired = true
    this.stopPings()
    this.ready = false
    this.failPending(new SafetyError('NOT_CONNECTED', 'the Buttplug connection closed'))
    const had = this.devices.size > 0
    this.devices.clear()
    if (had) this.notifyChannelsChanged()
    for (const listener of [...this.linkLostListeners]) {
      try {
        listener()
      } catch (error) {
        this.options.onError?.(error)
      }
    }
  }

  private failPending(error: Error): void {
    for (const [id, entry] of [...this.pending]) {
      this.pending.delete(id)
      entry.timer.cancel()
      entry.reject(error)
    }
  }

  private async teardown(): Promise<void> {
    this.stopPings()
    this.ready = false
    this.failPending(new SafetyError('NOT_CONNECTED', 'the Buttplug connection is closing'))
    this.offMessage?.()
    this.offMessage = undefined
    this.offClose?.()
    this.offClose = undefined
    const socket = this.socket
    this.socket = undefined
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
      throw new SafetyError('NOT_CONNECTED', `${this.id} is not connected to Intiface; start the engine and reconnect`)
    }
    return socket
  }
}
