/**
 * Electron half of the BLE bridge.
 *
 * Deliberately thin: the bookkeeping this could get wrong lives in `bridge.ts`
 * behind a testable interface. What remains is Electron-specific and cannot be
 * exercised without a display and real hardware.
 *
 * The subtlety here is the device chooser. `requestDevice` demands user
 * activation (`executeJavaScript(code, true)` supplies it) and, in Electron,
 * never resolves until the `select-bluetooth-device` handler calls back. That
 * event fires repeatedly as discovery finds more candidates, and a callback
 * with an empty string **cancels** — which is why answering the first batch
 * immediately can kill a request before the target has been discovered.
 *
 * So the chooser answer is delayed: the worker's `connect(filter)` call blocks
 * inside requestDevice, this handler collects candidates for a grace window,
 * then answers with the best match (or a lone candidate even when its name is
 * empty — Windows often leaves advertised names blank), and only cancels if
 * nothing appeared. The whole choose+connect runs inside ONE worker call, so
 * the approved BluetoothDevice never has to survive an executeJavaScript
 * boundary — that split was the source of lost-state races.
 */

import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BrowserWindow, ipcMain, type WebContents } from 'electron'
import type { BleCharacteristicRef, BleFilter } from '@embodied/core'
import { BridgedBleTransport, type BleBridge } from './bridge.ts'
import { log } from '../log.ts'

const here = dirname(fileURLToPath(import.meta.url))

/**
 * How long to collect candidates before deciding. Long enough for a cold scan
 * to find a toy, short enough that an operator is not staring at a spinner.
 */
const CHOOSER_GRACE_MS = 3_000

/** JSON literal safe to inline into an evaluated expression. */
function literal(value: unknown): string {
  return JSON.stringify(value ?? null)
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
}

type NotifyListener = (event: { handle: string; ref: BleCharacteristicRef; hex: string }) => void
type DisconnectListener = (event: { handle: string }) => void

interface Candidate {
  readonly deviceId: string
  readonly name: string
}

/** Score a candidate against what the filter was looking for. */
function scoreFor(filter: BleFilter, candidate: Candidate): number {
  const name = candidate.name
  if (filter.name !== undefined) return name === filter.name ? 3 : 0
  if (filter.namePrefix !== undefined) return name.startsWith(filter.namePrefix) ? 3 : 0
  return 1
}

interface PendingSelection {
  readonly filter: BleFilter
  readonly devices: Map<string, Candidate>
  /** The chooser's callback; requestDevice stays pending until it fires. */
  selectCallback: (deviceId: string) => void
  /** True once a chooser event delivered a callback for this selection. */
  callbackStored: boolean
  timer: ReturnType<typeof setTimeout>
  answered: boolean
}

/** Best candidate for a filter, or undefined when nothing matches. */
function pickBest(filter: BleFilter, candidates: readonly Candidate[]): Candidate | undefined {
  let best: Candidate | undefined
  let bestScore = 0
  for (const candidate of candidates) {
    const score = scoreFor(filter, candidate)
    if (score > bestScore) {
      best = candidate
      bestScore = score
    }
  }
  return best
}

class ElectronBleBridge implements BleBridge {
  // `selectDevice` is intentionally absent: the chooser runs inside the same
  // worker call that connects. The transport sees a chooser-less bridge and
  // goes straight to `request()`.
  private readonly notifyListeners = new Set<NotifyListener>()
  private readonly disconnectListeners = new Set<DisconnectListener>()
  /** Active selection, read by the chooser handler in `createBleWorker`. */
  pending: PendingSelection | undefined
  /** Candidates seen by the most recent selection; feeds failure guidance. */
  private selectionCandidates = 0
  /** Raw platform error from the most recent selection, or undefined. */
  private selectionError: string | undefined
  /**
   * Execution trace of the most recent selection. Surfaced inside the final
   * error message because terminal stdout is not reliable in every launch
   * path (some of it is buffered and only flushes at exit). The error text is
   * delivered through stderr, which is always visible.
   */
  private selectionTrace: string[] = []

  constructor(private readonly contents: WebContents) {}

  get lastSelectionSize(): number {
    return this.selectionCandidates
  }

  get lastSelectionError(): string | undefined {
    return this.selectionError
  }

  get lastSelectionTrace(): readonly string[] {
    return this.selectionTrace
  }

  private call<T>(expression: string): Promise<T> {
    if (this.contents.isDestroyed()) return Promise.reject(new Error('the BLE worker window is gone'))
    // The second argument marks this as user-activated, without which
    // navigator.bluetooth.requestDevice refuses to run.
    return this.contents.executeJavaScript(expression, true) as Promise<T>
  }

  /**
   * Select, connect, and return the peripheral — one worker call. The chooser
   * handler answers on the grace timer (see `addCandidates`); the worker then
   * proceeds straight to `gatt.connect()` with the device it already holds.
   */
  async request(filter: BleFilter, _deviceId?: string): Promise<{ handle: string; name?: string }> {
    this.selectionTrace = ['called', 'executor', 'choose-call']
    this.selectionCandidates = 0
    this.selectionError = undefined
    return new Promise<{ handle: string; name?: string }>((resolve, reject) => {
      const pending: PendingSelection = {
        filter,
        devices: new Map(),
        selectCallback: () => {},
        callbackStored: false,
        timer: setTimeout(() => { this.answer(undefined) }, CHOOSER_GRACE_MS),
        answered: false,
      }
      this.pending = pending
      void this.call<{ handle: string; name?: string }>(`window.__ble.connect(${literal(filter)})`).then(raw => {
        this.selectionTrace.push(`connect-settled:${raw?.handle ?? 'none'}`)
        // The chooser answer (if any) has already happened or will happen via
        // the grace timer; the connection itself is the payload here.
        resolve(raw)
      }).catch((error: unknown) => {
        // The platform refused the request outright — usually the Bluetooth
        // adapter being off/unavailable. Never let that reason vanish: it is
        // exactly what the console must show when nothing can be found.
        this.selectionError = error instanceof Error ? error.message : String(error)
        this.selectionTrace.push(`connect-rejected:${this.selectionError}`)
        reject(error instanceof Error ? error : new Error(String(error)))
      })
    })
  }

  /** The chooser handler reports each discovery batch. */
  addCandidates(candidates: readonly Candidate[], callback: (deviceId: string) => void): void {
    const pending = this.pending
    if (pending === undefined || pending.answered) {
      // Events can straggle in after the chooser settled. The request was
      // already answered; cancel nothing with them.
      log(`[ble] stray chooser event ignored (${candidates.length} candidate(s), no selection in flight)`)
      return
    }
    // The callback stays valid until the chooser settles, so remember it.
    pending.selectCallback = callback
    pending.callbackStored = true
    for (const candidate of candidates) pending.devices.set(candidate.deviceId, candidate)
    this.selectionCandidates = pending.devices.size
    log(`[ble] candidates received: ${candidates.length} (total ${this.selectionCandidates})`)
  }

  /** Settle the pending selection, once. `deviceId` is the candidate the
   * grace timer already decided on, or undefined to decide now. */
  private answer(deviceId: string | undefined): void {
    const pending = this.pending
    if (pending === undefined || pending.answered) return
    pending.answered = true
    this.pending = undefined
    clearTimeout(pending.timer)
    this.selectionTrace.push(`answered:${deviceId ?? 'none'} (${pending.devices.size} candidates)`)
    if (deviceId !== undefined) {
      pending.selectCallback(deviceId)
      return
    }
    // Nothing chosen yet: pick the best candidate seen so far, or cancel.
    let best: { id: string; score: number } | undefined
    for (const [id, candidate] of pending.devices) {
      const score = scoreFor(pending.filter, candidate)
      if (best === undefined || score > best.score) best = { id, score }
    }
    if (best === undefined) {
      // No candidates at all: cancel and let the transport retry.
      pending.selectCallback('')
      // If the chooser event never fired, the worker's requestDevice is still
      // pending and would block every later BLE request. Reloading the hidden
      // worker clears it; the page boots in milliseconds.
      if (!pending.callbackStored) this.contents.reload()
      return
    }
    if (best.score === 0) {
      // The name did not match, but `deviceName` reported by the OS is often
      // empty or formatted differently. If this filter produced exactly one
      // candidate, it IS the target — accept it rather than throwing away a
      // working scan over a string comparison.
      if (pending.devices.size === 1) {
        const only = [...pending.devices.values()][0]!
        this.selectionTrace.push(`single-candidate-accepted:${only.deviceId}`)
        pending.selectCallback(only.deviceId)
        return
      }
      pending.selectCallback('')
      return
    }
    pending.selectCallback(best.id)
  }

  async read(handle: string, ref: BleCharacteristicRef): Promise<string> {
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
      // Hidden windows are throttled by default; a throttled renderer stops
      // delivering Bluetooth scan events, which shows up as "no devices found
      // at all" on machines with a perfectly good adapter.
      backgroundThrottling: false,
    },
  })

  const contents = window.webContents
  const bridge = new ElectronBleBridge(contents)

  // Without this the first requestDevice never settles.
  contents.on('select-bluetooth-device', (event, devices, callback) => {
    event.preventDefault()
    // Collect candidates; the pending selection settles on its grace timer and
    // calls back then with the best one, or with '' to cancel. Answering here —
    // especially with '' on an empty early batch — cancels too early, which is
    // the exact failure this design exists to avoid.
    bridge.addCandidates(devices.map(device => ({
      deviceId: device.deviceId,
      name: device.deviceName,
    })), callback)
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
  const routeDiag = (event: Electron.IpcMainEvent, message: string): void => {
    if (event.sender !== contents) return
    log(`[ble] ${message}`)
  }

  ipcMain.on('ble:notify', routeNotify)
  ipcMain.on('ble:disconnected', routeDisconnected)
  ipcMain.on('ble:diag', routeDiag)

  // `here` is dist/, so the renderer sources sit one level up.
  await window.loadFile(join(here, '..', 'src', 'renderer', 'ble.html'))

  // Startup probe: proves whether Web Bluetooth exists at all in this worker
  // before anything tries to use it. One line tells us which half of the
  // problem we are on. (Top-level await is not allowed in an evaluated
  // expression, so the availability check stays in the page's own diag.)
  try {
    const probe = await contents.executeJavaScript(
      'JSON.stringify({ bluetooth: typeof navigator.bluetooth !== "undefined", ble: typeof window.__ble !== "undefined" })',
      true,
    )
    log(`[ble] worker probe: ${probe}`)
  } catch (error) {
    log(`[ble] worker probe failed: ${error instanceof Error ? error.message : String(error)}`)
  }

  const transport = new BridgedBleTransport(bridge)
  return {
    transport,
    async close(): Promise<void> {
      ipcMain.off('ble:notify', routeNotify)
      ipcMain.off('ble:disconnected', routeDisconnected)
      ipcMain.off('ble:diag', routeDiag)
      await transport.close()
      if (!window.isDestroyed()) window.destroy()
    },
  }
}
