/**
 * Dispatch events: the line between "a command was accepted" and "a level was
 * written".
 *
 * The distinction is load-bearing. While an envelope runs, `EffectRunner`
 * samples it every 50 ms and each sample becomes a transport write; those
 * writes are parts of one action, not new actions. A reaction probe must latch
 * onto the moment a human- or model-issued command was accepted, so a registry
 * emits exactly one event per accepted command — `setLevel`, `runPattern`,
 * `setWaveform`, `stop`, `emergencyStop` — and nothing per tick.
 *
 * Events are observations, not a control path: they are informational, they do
 * not participate in safety decisions, and a listener that throws cannot
 * interrupt the dispatch chain.
 */

/** Which accepted command produced a dispatch event. */
export type DispatchEventKind = 'level' | 'pattern' | 'waveform' | 'stop'

/**
 * One accepted command, as observed by `DeviceRegistry.subscribe`.
 *
 * All fields describe what was asked for, after the command was validated and
 * clamped to the human's cap. They are informational only; the transport keeps
 * its own final clamp and nothing downstream may treat them as a safety
 * decision.
 *
 * A `stop` may target everything; in that case `deviceId` and `channelId` are
 * the same `'all'` sentinel the audit log uses for a broad stop.
 */
export interface DispatchEvent {
  readonly kind: DispatchEventKind
  readonly deviceId: string
  readonly channelId: string
  /** `Clock.now()` at the moment the command was accepted. */
  readonly at: number
  /** Target level of a `level`/`pattern` dispatch; never used for safety. */
  readonly percent?: number
  /** Waveform selected by a `waveform`/`pattern` dispatch; absent when cleared. */
  readonly waveformId?: string
  readonly durationSec?: number
}
