/**
 * Electron half of the camera bridge.
 *
 * Deliberately thin, like the BLE side: the cadence, quality classification and
 * JPEG freshness logic live in `camera-host.ts` behind a testable interface.
 * What remains here is Electron-specific and cannot be exercised without a
 * display and a real camera.
 *
 * The hidden window runs `renderer/camera.html`, which loads a small esbuild
 * bundle. That bundle imports the shared `@embodied/core` feature extractor, so
 * the renderer and the unit tests analyse 32x24 grey frames with the same code
 * (plan §4.1). The main process drives capture through `executeJavaScript`
 * (the same pattern as `createBleWorker`); feature samples and JPEGs come back
 * as the documented `{type:'features',sample}` / `{type:'jpeg',bytes}`
 * payloads, and unexpected stream ends arrive over the preload bridge.
 */

import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BrowserWindow, ipcMain, type WebContents } from 'electron'
import { systemClock } from '@embodied/core'
import { log } from '../log.ts'
import {
  BridgedCameraHost,
  type CameraBridge,
  type CameraDeviceInfo,
  type CameraFeaturesMessage,
  type CameraHost,
  type CameraJpegMessage,
} from './camera-host.ts'

const here = dirname(fileURLToPath(import.meta.url))

/** JSON literal safe to inline into an evaluated expression. */
function literal(value: unknown): string {
  return JSON.stringify(value ?? null)
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
}

class ElectronCameraBridge implements CameraBridge {
  private readonly endedListeners = new Set<(reason: string) => void>()

  constructor(private readonly contents: WebContents) {}

  private call<T>(expression: string): Promise<T> {
    if (this.contents.isDestroyed()) return Promise.reject(new Error('the camera worker window is gone'))
    return this.contents.executeJavaScript(expression, true) as Promise<T>
  }

  listDevices(): Promise<readonly CameraDeviceInfo[]> {
    return this.call<readonly CameraDeviceInfo[]>('window.__camera.listDevices()')
  }

  async start(deviceId: string): Promise<void> {
    await this.call<boolean>(`window.__camera.start(${literal(deviceId)})`)
  }

  sample(): Promise<CameraFeaturesMessage | null> {
    return this.call<CameraFeaturesMessage | null>('window.__camera.sample()')
  }

  snapshot(): Promise<CameraJpegMessage> {
    return this.call<CameraJpegMessage>('window.__camera.snapshot()')
  }

  async stop(): Promise<void> {
    if (this.contents.isDestroyed()) return
    await this.call<boolean>('window.__camera.stop()')
  }

  onEnded(listener: (reason: string) => void): () => void {
    this.endedListeners.add(listener)
    return () => {
      this.endedListeners.delete(listener)
    }
  }

  /** Called when the worker page reports that its stream ended on its own. */
  emitEnded(reason: string): void {
    for (const listener of [...this.endedListeners]) listener(reason)
  }
}

export interface CameraWorker {
  readonly host: CameraHost
  /** Stop capture, detach IPC, and destroy the hidden window. */
  close(): Promise<void>
}

/**
 * Create the hidden camera worker window and return its host.
 *
 * A camera-less machine is a supported state: `listDevices()` returns an empty
 * list and the wiring registers an `unavailable` source. Construction itself
 * only fails when Electron cannot create the window at all.
 */
export async function createCameraWorker(options: {
  readonly sourceId?: string
  readonly label?: string
  readonly onError?: (error: unknown) => void
} = {}): Promise<CameraWorker> {
  const window = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: join(here, 'preload-camera.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Hidden windows are throttled by default; a throttled renderer stops
      // producing video frames, which would look like a dead camera.
      backgroundThrottling: false,
    },
  })

  const contents = window.webContents
  const bridge = new ElectronCameraBridge(contents)
  const host = new BridgedCameraHost({
    clock: systemClock,
    bridge,
    ...(options.sourceId === undefined ? {} : { sourceId: options.sourceId }),
    ...(options.label === undefined ? {} : { label: options.label }),
    ...(options.onError === undefined ? {} : { onError: options.onError }),
  })

  const routeEnded = (event: Electron.IpcMainEvent, payload: { reason?: string }): void => {
    if (event.sender !== contents) return
    const reason = typeof payload?.reason === 'string' && payload.reason.length > 0
      ? payload.reason
      : 'camera capture ended'
    log(`[camera] ${reason}`)
    bridge.emitEnded(reason)
  }
  const routeDiag = (event: Electron.IpcMainEvent, message: string): void => {
    if (event.sender !== contents) return
    log(`[camera] ${message}`)
  }
  ipcMain.on('camera:ended', routeEnded)
  ipcMain.on('camera:diag', routeDiag)

  // `here` is dist/, so the renderer sources sit one level up. The page loads
  // `dist/camera-renderer.js`, the bundle produced by the build script.
  await window.loadFile(join(here, '..', 'src', 'renderer', 'camera.html'))

  return {
    host,
    async close(): Promise<void> {
      ipcMain.off('camera:ended', routeEnded)
      ipcMain.off('camera:diag', routeDiag)
      try {
        await host.stop()
      } finally {
        host.dispose()
        if (!window.isDestroyed()) window.destroy()
      }
    },
  }
}
