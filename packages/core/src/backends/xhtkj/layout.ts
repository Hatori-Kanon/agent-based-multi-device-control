/**
 * Shared control-layout adoption for the 谜姬/安可尼 BLE family.
 *
 * Both the classic 谜姬 backend (03 12 F3 command packets) and the ANKNI
 * stream backend (AA 08 04 frames) connect to the same service set and adopt
 * their control layout by the same INITIALIZE handshake — the clone layout
 * (0xdddd) has no notify path and splits acked setup from fire-and-forget
 * live traffic, so the handshake order does the discovery.
 */

import { SafetyError } from '../../devices/errors.ts'
import type { BleCharacteristicRef, BlePeripheral } from '../../ports/ble.ts'
import {
  INITIALIZE_PACKET,
  XHTKJ_ALT_SERVICE,
  XHTKJ_ALT_STREAM_CHARACTERISTIC,
  XHTKJ_ALT_WRITE_CHARACTERISTIC,
  XHTKJ_DEVICE_SERVICE,
  XHTKJ_NOTIFY_CHARACTERISTIC,
  XHTKJ_WRITE_CHARACTERISTIC,
} from './protocol.ts'

/** One known control-service layout of the 谜姬 family. */
export interface XhtkjLayout {
  /** Acked setup channel: initialise and other confirmed commands. */
  readonly write: BleCharacteristicRef
  /** Live policy channel: strength, clear, and stop traffic. */
  readonly live: BleCharacteristicRef
  /** Live traffic is fire-and-forget (stream toys) rather than acked. */
  readonly liveWithoutResponse: boolean
  readonly notify: BleCharacteristicRef | undefined
}

/** Classic 谜姬 layout (0xff10/ff11/ff12): one channel for everything. */
export const CLASSIC_LAYOUT: XhtkjLayout = {
  write: { service: XHTKJ_DEVICE_SERVICE, characteristic: XHTKJ_WRITE_CHARACTERISTIC },
  live: { service: XHTKJ_DEVICE_SERVICE, characteristic: XHTKJ_WRITE_CHARACTERISTIC },
  liveWithoutResponse: false,
  notify: { service: XHTKJ_DEVICE_SERVICE, characteristic: XHTKJ_NOTIFY_CHARACTERISTIC },
}

/**
 * ANKNI clone layout (0xdddd): ddd1 = fire-and-forget stream, ddd2 = acked
 * commands, ddd3 = read, no notify. Confirmed on a real ANKNI ZKRXB unit.
 */
export const ALT_LAYOUT: XhtkjLayout = {
  write: { service: XHTKJ_ALT_SERVICE, characteristic: XHTKJ_ALT_WRITE_CHARACTERISTIC },
  live: { service: XHTKJ_ALT_SERVICE, characteristic: XHTKJ_ALT_STREAM_CHARACTERISTIC },
  liveWithoutResponse: true,
  notify: undefined,
}

/** Tried in order; the first one that accepts the INITIALIZE write wins. */
const XHTKJ_LAYOUTS: readonly XhtkjLayout[] = [CLASSIC_LAYOUT, ALT_LAYOUT]

/** Layout adopted by the handshake, plus the notify subscription of that layout. */
export interface AdoptedLayout {
  readonly layout: XhtkjLayout
  readonly notifyOff: (() => void) | undefined
}

/**
 * Discover the control layout by handshake: clones (ANKNI ZKRXB...) serve
 * 0xdddd instead of 0xff10 and expose no notify characteristic, so the classic
 * layout must fail over cleanly. Probe failures are expected here (a clone has
 * no 0xff10 at all) and stay out of the error panel; only a notify failure on
 * the ADOPTED layout is worth reporting.
 */
export async function adoptControlLayout(
  peripheral: BlePeripheral,
  onNotification: (data: Uint8Array) => void,
  onError: (error: unknown) => void,
): Promise<AdoptedLayout> {
  let notifyOff: (() => void) | undefined
  let probeError: unknown
  let lastError: unknown
  for (const layout of XHTKJ_LAYOUTS) {
    notifyOff?.()
    notifyOff = undefined
    if (layout.notify !== undefined) {
      try {
        notifyOff = await peripheral.subscribe(layout.notify, onNotification)
        probeError = undefined
      } catch (error) {
        probeError = error
      }
    }
    try {
      await peripheral.write(layout.write, INITIALIZE_PACKET, false)
      if (layout.notify !== undefined && notifyOff === undefined && probeError !== undefined) {
        onError(probeError)
      }
      return { layout, notifyOff }
    } catch (error) {
      lastError = error
    }
  }
  throw new SafetyError(
    'NOT_CONNECTED',
    `initialize handshake failed on every known layout (classic 0xff10 and ANKNI 0xdddd): ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  )
}
