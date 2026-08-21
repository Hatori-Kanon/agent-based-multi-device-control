/**
 * Electron half of the BLE bridge.
 *
 * Deliberately thin: the bookkeeping this could get wrong lives in `bridge.ts`
 * behind a testable interface. What remains is Electron-specific and cannot be
 * exercised without a display and real hardware.
 *
 * Two Electron facts shape it:
 *
 * - `requestDevice` demands user activation, and `executeJavaScript(code, true)`
 *   is the sanctioned way to supply it. Every command therefore travels as an
 *   `executeJavaScript` call, which doubles as a promise-returning RPC.
 * - Without a `select-bluetooth-device` handler the request hangs forever,
 *   because Electron ships no device chooser of its own.
 */

import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BrowserWindow, ipcMain, type WebContents } from 'electron'
import type { BleCharacteristicRef, BleFilter } from '@embodied/core'
import { BridgedBleTransport, type BleBridge } from './bridge.ts'

const here = dirname(fileURLToPath(import.meta.url))

/** JSON literal safe to inline into an evaluated expression. */
function literal(value: unknown): string {
  return JSON.stringify(value ?? null)
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
}

type NotifyListener = (event: { handle: string; ref: BleCharacteristicRef; hex: string }) => void
type DisconnectListener = (event: { handle: string }) => void

class ElectronBleBridge implements BleBridge {
  private readonly notifyListeners = new Set<NotifyListener>()
  private readonly disconnectListeners = new Set<DisconnectListener>()

  constructor(private readonly contents: WebContents) {}

  private call<T>(expression: string): Promise<T> {
    if (this.contents.isDestroyed()) return Promise.reject(new Error('the BLE worker window is gone'))
    // The second argument marks this as user-activated, without which
    // navigator.bluetooth.requestDevice refuses to run.
    return this.contents.executeJavaScript(expression, true) as Promise<T>
  }

  request(filter: BleFilter): Promise<{ handle: string; name?: string }> {
    return this.call(`window.__ble.request(${literal(filter)})`)
  }

  read(handle: string, ref: BleCharacteristicRef): Promise<string> {
    return this.call(`window.__ble.read(${literal(handle)},${literal(ref.service)},${literal(ref.characteristic)})`)
  }

  async write(handle: string, ref: BleCharacteristicRef, hex: string, withoutResponse: boolean): Promise<void> {
    await this.call(
      `window.__ble.write(${literal(handle)},${literal(ref.service)},${literal(ref.characteristic)},${literal(hex)},${String(withoutResponse)})`,
    )
  }

  async subscribe(handle: string, ref: BleCharacteristicRef): Promise<void> {
    await this.call(`window.__ble.subscribe(${literal(handle)},${literal(ref.service)},${literal(ref.characteristic)})`)
  }

  async unsubscribe(handle: string, ref: BleCharacteristicRef): Promise<void> {
    await this.call(`window.__ble.unsubscribe(${literal(handle)},${literal(ref.service)},${literal(ref.characteristic)})`)
  }

  async disconnect(handle: string): Promise<void> {
    await this.call(`window.__ble.disconnect(${literal(handle)})`)
  }

  onNotify(listener: NotifyListener): () => void {
    this.notifyListeners.add(listener)
    return () => { this.notifyListeners.delete(listener) }
  }

  onDisconnected(listener: DisconnectListener): () => void {
    this.disconnectListeners.add(listener)
    return () => { this.disconnectListeners.delete(listener) }
  }

  emitNotify(event: { handle: string; service: string; characteristic: string; hex: string }): void {
    const payload = {
      handle: event.handle,
      ref: { service: event.service, characteristic: event.characteristic },
      hex: event.hex,
    }
    for (const listener of [...this.notifyListeners]) listener(payload)
  }

  emitDisconnected(handle: string): void {
    for (const listener of [...this.disconnectListeners]) listener({ handle })
  }
}

export interface BleWorker {
  readonly transport: BridgedBleTransport
  close(): Promise<void>
}

/**
 * Start the hidden worker window and return a transport bound to it.
 *
 * @param onError - Receives worker-side failures for operator display.
 */
export async function createBleWorker(onError: (error: unknown) => void = () => {}): Promise<BleWorker> {
  const window = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: join(here, 'preload-ble.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  const contents = window.webContents
  const bridge = new ElectronBleBridge(contents)

  // Without this the first requestDevice never settles.
  contents.on('select-bluetooth-device', (event, devices, callback) => {
    event.preventDefault()
    const first = devices[0]
    if (first === undefined) {
      // Keep waiting: Electron fires this again as discovery finds more.
      callback('')
      return
    }
    callback(first.deviceId)
  })

  const routeNotify = (event: Electron.IpcMainEvent, payload: { handle: string; service: string; characteristic: string; hex: string }): void => {
    if (event.sender !== contents) return
    try {
      bridge.emitNotify(payload)
    } catch (error) {
      onError(error)
    }
  }
  const routeDisconnected = (event: Electron.IpcMainEvent, payload: { handle: string }): void => {
    if (event.sender !== contents) return
    bridge.emitDisconnected(payload.handle)
  }

  ipcMain.on('ble:notify', routeNotify)
  ipcMain.on('ble:disconnected', routeDisconnected)

  // `here` is dist/, so the renderer sources sit one level up.
  await window.loadFile(join(here, '..', 'src', 'renderer', 'ble.html'))

  const transport = new BridgedBleTransport(bridge)
  return {
    transport,
    async close(): Promise<void> {
      ipcMain.off('ble:notify', routeNotify)
      ipcMain.off('ble:disconnected', routeDisconnected)
      await transport.close()
      if (!window.isDestroyed()) window.destroy()
    },
  }
}
