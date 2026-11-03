/**
 * Electron entry point.
 *
 * Everything that can be tested without a browser lives in `bootstrap.ts`;
 * this file adds only what Electron uniquely provides — a window, a global
 * hotkey that reaches the emergency stop without passing through the agent,
 * and lifecycle hooks that guarantee output is cut before the process exits.
 */

import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { app, BrowserWindow, globalShortcut, ipcMain, session } from 'electron'
import type { ChannelPolicy } from '@embodied/core'
import { createBleWorker, type BleWorker } from './ble/electron-bridge.ts'
import { createHostRuntime, type HostRuntime } from './bootstrap.ts'
import { readAuditTail } from './node-storage.ts'
import { createCameraWorker, type CameraWorker } from './sensors/camera-window.ts'

/** Global emergency stop. Chosen to be reachable one-handed and unlikely to clash. */
const PANIC_ACCELERATOR = 'Control+Alt+X'

/**
 * Opens the play page (B2-T12) in its own window.
 *
 * The play page is the same HTTP page the console serves (`/play`); it is not
 * another Electron entry point. The shortcut mirrors the console's open path:
 * a normal BrowserWindow loading the dashboard URL with the token in the query.
 */
const PLAY_ACCELERATOR = 'Control+Alt+P'

/**
 * Bump whenever the main-process bundle changes meaningfully. The launcher
 * prints it at startup so a stale dist/main.mjs is never mistaken for current
 * code — which already cost one debugging round.
 */
const BUILD_TOKEN = 'embodied-build-d19e3'

const here = dirname(fileURLToPath(import.meta.url))

let runtime: HostRuntime | undefined
let bleWorker: BleWorker | undefined
let cameraWorker: CameraWorker | undefined
let window: BrowserWindow | undefined
let quitting = false

function dataDir(): string {
  return process.env.EMBODIED_DATA_DIR ?? join(app.getPath('userData'), 'embodied')
}

function reportError(error: unknown): void {
  console.error('[embodied]', error)
  window?.webContents.send('host:error', error instanceof Error ? error.message : String(error))
}

function registerIpc(): void {
  ipcMain.handle('host:snapshot', () => runtime?.snapshot() ?? null)

  ipcMain.handle('host:info', () => ({
    panicAddress: runtime?.panicAddress ?? null,
    accelerator: PANIC_ACCELERATOR,
    dataDir: dataDir(),
    intiface: runtime?.intiface ?? null,
  }))

  ipcMain.handle('host:panic', async () => {
    await runtime?.panic('ui-button')
    return runtime?.snapshot() ?? null
  })

  ipcMain.handle('host:unlock', async () => {
    await runtime?.registry.unlock('human', 'cleared from the desktop app')
    return runtime?.snapshot() ?? null
  })

  ipcMain.handle('host:set-cap', async (_event, deviceId: string, channelId: string, patch: Partial<ChannelPolicy>) => {
    await runtime?.registry.setPolicyByHuman(deviceId, channelId, patch)
    return runtime?.snapshot() ?? null
  })

  // M0 has no agent yet; this lets an operator confirm the runtime end to end.
  ipcMain.handle('host:demo', async (_event, deviceId: string, channelId: string) => {
    await runtime?.registry.runPattern('human', {
      deviceId,
      channelId,
      envelope: { preset: 'wave', minPercent: 5, maxPercent: 20, periodMs: 2_000, jitter: 10 },
      durationSec: 15,
    })
    return runtime?.snapshot() ?? null
  })

  ipcMain.handle('host:stop', async (_event, deviceId?: string, channelId?: string) => {
    await runtime?.registry.stop('human', deviceId, channelId)
    return runtime?.snapshot() ?? null
  })

  ipcMain.handle('host:waveforms', () => runtime?.waveforms.list() ?? [])

  ipcMain.handle('host:set-waveform', async (_event, deviceId: string, channelId: string, waveformId?: string) => {
    await runtime?.registry.setWaveform('human', deviceId, channelId, waveformId)
    return runtime?.snapshot() ?? null
  })

  /** Paste-import of a shared waveform: one hex frame per line. */
  ipcMain.handle('host:import-waveform', async (_event, name: string, framesText: string) => {
    const frames = framesText.split(/[\s,]+/u).filter(frame => frame.length > 0)
    const imported = runtime?.waveforms.importFrames(name, frames)
    return imported === undefined ? null : { id: imported.id, name: imported.name, frames: imported.frames.length }
  })

  ipcMain.handle('host:promote-waveform', async (_event, id: string) => {
    runtime?.waveforms.promoteByHuman(id)
    await runtime?.saveWaveforms()
    return runtime?.waveforms.list() ?? []
  })

  ipcMain.handle('host:audit', () => readAuditTail(join(dataDir(), 'audit', 'device.jsonl'), 120))

  ipcMain.handle('host:scan', async (_event, deviceId: string, durationMs = 5_000) => {
    const controller = new AbortController()
    await runtime?.registry.scan('human', deviceId, durationMs, controller.signal)
    return runtime?.snapshot() ?? null
  })

  // Retry after a failed or dropped link without restarting the app. Goes
  // through the same path as the console so the chosen unit is persisted and
  // concurrent scans stay serialised.
  ipcMain.handle('host:connect', async (_event, deviceId: string) => {
    await runtime?.connectDevice(deviceId)
    return runtime?.snapshot() ?? null
  })
}

/**
 * Same-origin page URL carrying the control token in the query.
 *
 * This is the console's existing convention: the page's own fetch() calls send
 * `x-control-token`, while a page navigation cannot carry headers at all. The
 * token therefore stays in the URL (never in the page, storage or a log line
 * beyond the startup log that already prints the console URL).
 */
function dashboardPageUrl(pathname: string): string | undefined {
  const address = runtime?.dashboardAddress
  const token = runtime?.dashboardToken
  if (address === undefined || token === undefined) return undefined
  return `http://${address.host}:${address.port}${pathname}?token=${encodeURIComponent(token)}`
}

async function createWindow(): Promise<void> {
  const url = dashboardPageUrl('/')
  if (url === undefined) {
    throw new Error('the control console did not start; cannot open the window')
  }
  window = new BrowserWindow({
    width: 1080,
    height: 800,
    title: 'Embodied 控制台',
    backgroundColor: '#0d0d12',
    webPreferences: {
      preload: join(here, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  window.on('closed', () => { window = undefined })
  // The console is an HTTP page served by the runtime; a phone on the LAN can
  // open the same address once the dashboard is bound beyond loopback.
  await window.loadURL(url)
}

/**
 * Bring the single window to the front and switch it to the play view (v3).
 *
 * The play view lives in the same page as the device view now, so the shortcut
 * must never open a second window: it focuses the existing one and clicks the
 * nav tab the page already owns.
 */
async function focusPlayView(): Promise<void> {
  if (window === undefined) return
  if (window.isMinimized()) window.restore()
  window.show()
  window.focus()
  try {
    await window.webContents.executeJavaScript(
      "document.querySelector('[data-view-target=\"play\"]')?.click(); true",
      true,
    )
  } catch {
    // The page may still be loading; the nav is available as soon as it is.
  }
}

/** Cut output before the process goes away, whatever the exit path. */
async function shutdown(): Promise<void> {
  const current = runtime
  const worker = bleWorker
  const camera = cameraWorker
  runtime = undefined
  bleWorker = undefined
  cameraWorker = undefined
  if (current !== undefined) {
    try {
      await current.shutdown()
    } catch (error) {
      console.error('[embodied] shutdown failed', error)
    }
  }
  if (camera !== undefined) {
    try {
      await camera.close()
    } catch (error) {
      console.error('[embodied] camera worker shutdown failed', error)
    }
  }
  if (worker !== undefined) {
    try {
      await worker.close()
    } catch (error) {
      console.error('[embodied] BLE worker shutdown failed', error)
    }
  }
}

app.on('before-quit', event => {
  if (quitting || (runtime === undefined && bleWorker === undefined && cameraWorker === undefined)) return
  quitting = true
  event.preventDefault()
  void shutdown().finally(() => { app.exit(0) })
})

app.on('will-quit', () => { globalShortcut.unregisterAll() })

app.on('window-all-closed', () => { app.quit() })

app.on('activate', () => { if (window === undefined) void createWindow() })

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void shutdown().finally(() => { app.exit(0) })
  })
}

void app.whenReady().then(async () => {
  console.log(`[embodied] build token: ${BUILD_TOKEN}`)
  // Web Bluetooth and camera capture both flow through Electron's session
  // permission system. Without granting `bluetooth` the hidden worker's
  // requestDevice is refused with zero candidates and no error details — the
  // console then reports "no Bluetooth devices were found at all" on machines
  // with a perfectly healthy adapter. Without `media` the hidden camera page's
  // getUserMedia is refused the same silent way.
  const allowedPermissions = new Set(['bluetooth', 'media'])
  session.defaultSession.setPermissionCheckHandler((_contents, permission) => {
    // Electron's TypeScript union does not list every runtime permission yet;
    // cast through string.
    return allowedPermissions.has(permission as string)
  })
  session.defaultSession.setPermissionRequestHandler((_contents, permission, callback) => {
    callback(allowedPermissions.has(permission as string))
  })

  // The BLE worker is optional: without it the runtime still serves the
  // console (empty device list), which is better than refusing to start on a
  // machine with no Bluetooth adapter.
  try {
    bleWorker = await createBleWorker(reportError)
  } catch (error) {
    reportError(error)
  }

  // Same for the camera/microphone worker: a machine without a camera (or with
  // the OS camera privacy switch off) still runs the console; the camera source
  // simply reports unavailable until one is attached. Microphone capture stays
  // off until a human enables it in the settings view.
  try {
    cameraWorker = await createCameraWorker({ onError: reportError })
  } catch (error) {
    reportError(error)
  }

  runtime = await createHostRuntime({
    dataDir: dataDir(),
    onError: reportError,
    // The console UI ships as plain files next to the app root. Pass the
    // absolute directory explicitly: the default relative resolution inside
    // dashboard.ts depends on whether the code runs from src/ or dist/.
    dashboardStaticDir: join(app.getAppPath(), 'src', 'ui'),
    ...(bleWorker === undefined ? {} : { bleTransport: bleWorker.transport }),
    ...(cameraWorker === undefined ? {} : { cameraHost: cameraWorker.host, audioHost: cameraWorker.audioHost }),
    // Operator configuration only; never reaches a tool argument or result.
    ...(process.env.EMBODIED_MONSTERPARTY_TOKEN === undefined
      ? {}
      : { monsterPartyToken: process.env.EMBODIED_MONSTERPARTY_TOKEN }),
    // A user-facing product never seeds fake hardware. The two mock devices
    // exist for fixtures and the demo launcher only (`EMBODIED_MOCK_DEVICES=1`).
    withMockDevices: process.env.EMBODIED_MOCK_DEVICES === '1',
    // Which BLE units exist is the manifest (state/devices.json), managed from
    // the console's 设备管理 (add/remove); no env tuning needed.
    // Without Buttplug hardware, skip the engine probe and spawn entirely.
    ...(process.env.EMBODIED_WITH_BUTTPLUG === undefined ? {} : {
      withButtplug: process.env.EMBODIED_WITH_BUTTPLUG === '1',
    }),
  })
  registerIpc()

  const registered = globalShortcut.register(PANIC_ACCELERATOR, () => {
    void runtime?.panic('global-hotkey').then(() => {
      window?.webContents.send('host:changed')
    }).catch(reportError)
  })
  if (!registered) {
    console.error(`[embodied] could not register ${PANIC_ACCELERATOR}; use the on-screen stop button`)
  }

  // Play view entry (B2-T12 / v3). Same window, different view — never a popup.
  const playRegistered = globalShortcut.register(PLAY_ACCELERATOR, () => {
    void focusPlayView().catch(reportError)
  })
  if (!playRegistered) {
    console.error(`[embodied] could not register ${PLAY_ACCELERATOR}; open the play URL printed below instead`)
  }

  await createWindow()

  const consoleUrl = dashboardPageUrl('/')
  if (consoleUrl !== undefined) {
    console.log(`[embodied] console: ${consoleUrl}`)
  }
  const playUrl = dashboardPageUrl('/play')
  if (playUrl !== undefined) {
    console.log(`[embodied] play: ${playUrl} (${PLAY_ACCELERATOR} switches the window to the play view)`)
  }
  if (runtime.panicAddress !== undefined) {
    console.log(`[embodied] out-of-band stop: POST http://${runtime.panicAddress.host}:${runtime.panicAddress.port}/panic`)
  }
}).catch((error: unknown) => {
  console.error('[embodied] startup failed', error)
  app.exit(1)
})
