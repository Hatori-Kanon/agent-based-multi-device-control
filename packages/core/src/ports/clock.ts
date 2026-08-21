/**
 * Injectable time source.
 *
 * Every deadline in this package goes through a `Clock` so that auto-stop
 * timing, effect ticking, and watchdog expiry are testable without real
 * delays. Production code uses {@link systemClock}; tests use `FakeClock`.
 */

/** A cancellable scheduled callback. */
export interface Timer {
  /** Cancel the callback. Safe to call more than once. */
  cancel(): void
}

export interface Clock {
  /** Current time in milliseconds. */
  now(): number
  /** Run `fn` once after `ms`. */
  timeout(ms: number, fn: () => void): Timer
  /** Run `fn` every `ms`. */
  interval(ms: number, fn: () => void): Timer
}

/** Real time, backed by the host timer functions. */
export const systemClock: Clock = {
  now: () => Date.now(),
  timeout(ms: number, fn: () => void): Timer {
    const handle = setTimeout(fn, ms)
    return { cancel: () => { clearTimeout(handle) } }
  },
  interval(ms: number, fn: () => void): Timer {
    const handle = setInterval(fn, ms)
    return { cancel: () => { clearInterval(handle) } }
  },
}
