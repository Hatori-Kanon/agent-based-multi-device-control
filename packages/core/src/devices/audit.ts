/**
 * Append-only record of everything that reached, or was refused by, a device.
 *
 * The model has no tool that writes or reads this log. Two properties matter:
 * records are only ever appended, and {@link AuditLog.record} never throws —
 * a broken sink must not be able to prevent an emergency stop. Sink failures
 * are surfaced through the failure handler so the UI can warn instead.
 */

import type { Clock } from '../ports/clock.ts'
import type { AppendOnlyStore } from '../ports/storage.ts'

/** Who caused the recorded action. */
export type AuditActor = 'model' | 'human' | 'system'

/** How the action ended. */
export type AuditResult = 'ok' | 'rejected' | 'error'

export interface AuditRecord {
  /** ISO-8601 timestamp from the injected clock. */
  readonly ts: string
  readonly actor: AuditActor
  /** Stable verb, e.g. `set_level`, `panic`, `policy_change`. */
  readonly action: string
  readonly result: AuditResult
  /** Action-specific fields; must be JSON-serialisable. */
  readonly detail?: Readonly<Record<string, unknown>>
  /** Error code or explanation when `result` is not `ok`. */
  readonly reason?: string
}

/** Notified when the sink rejects a record. */
export type AuditFailureHandler = (error: unknown, record: AuditRecord) => void

export class AuditLog {
  /**
   * @param store - Append-only sink.
   * @param clock - Timestamp source.
   * @param onFailure - Receives sink failures; must not throw.
   */
  constructor(
    private readonly store: AppendOnlyStore,
    private readonly clock: Clock,
    private readonly onFailure: AuditFailureHandler,
  ) {}

  /** Append one record. Resolves even when the sink fails. */
  async record(entry: Omit<AuditRecord, 'ts'>): Promise<void> {
    const full: AuditRecord = { ts: new Date(this.clock.now()).toISOString(), ...entry }
    let line: string
    try {
      line = JSON.stringify(full)
    } catch (error) {
      // Detail was not serialisable. Keep the action, drop the payload.
      this.report(error, full)
      line = JSON.stringify({
        ts: full.ts,
        actor: full.actor,
        action: full.action,
        result: full.result,
        reason: 'detail was not serialisable',
      })
    }
    try {
      await this.store.append(line)
    } catch (error) {
      this.report(error, full)
    }
  }

  private report(error: unknown, record: AuditRecord): void {
    try {
      this.onFailure(error, record)
    } catch {
      // The diagnostic sink itself failed; there is no further recovery path
      // and losing the warning must not escalate into a device-control fault.
    }
  }
}
