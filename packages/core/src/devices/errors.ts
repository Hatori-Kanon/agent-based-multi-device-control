/** Failure vocabulary shared by the safety runtime. */

/**
 * Why an operation was refused.
 *
 * These codes are stable and appear in the audit trail; the accompanying
 * message is what a model or operator reads, so it must say what to do next.
 */
export type SafetyErrorCode =
  /** A human pressed emergency stop; only a human can clear it. */
  | 'LOCKED'
  /** Requested percentage exceeds the human-configured cap. */
  | 'POLICY_PERCENT'
  /** Requested duration exceeds the human-configured cap. */
  | 'POLICY_DURATION'
  /** Envelope bounds are inconsistent or out of range. */
  | 'POLICY_ENVELOPE'
  /** A waveform script, imported frame, or library operation is malformed. */
  | 'INVALID_WAVEFORM'
  /** No such waveform id. */
  | 'UNKNOWN_WAVEFORM'
  /** No such device is registered. */
  | 'UNKNOWN_DEVICE'
  /** The device has no such channel. */
  | 'UNKNOWN_CHANNEL'
  /** The channel exists but does not accept this kind of command. */
  | 'WRONG_CHANNEL_KIND'
  /** The backend is not connected yet. */
  | 'NOT_CONNECTED'
  /** The registry is shutting down and refuses new work. */
  | 'SHUTTING_DOWN'
  /** A human tried to set a cap outside the absolute bounds. */
  | 'INVALID_POLICY'

/** Refusal or failure raised by the safety runtime. */
export class SafetyError extends Error {
  /**
   * @param code - Stable machine-readable reason.
   * @param message - Actionable text for the model or operator.
   */
  constructor(readonly code: SafetyErrorCode, message: string) {
    super(message)
    this.name = 'SafetyError'
  }
}

/** Narrow an unknown rejection to a {@link SafetyError}. */
export function isSafetyError(value: unknown): value is SafetyError {
  return value instanceof SafetyError
}
