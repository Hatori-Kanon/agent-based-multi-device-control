/**
 * Background log ring buffer.
 *
 * Runtime diagnostics (BLE discovery, chooser decisions, worker dianostics)
 * belong in a buffer the console UI can open on demand — the terminal stays
 * readable, carrying only one-shot essentials like the build token and the
 * console URL. Nothing here prints to stdout.
 */

let lines: string[] = []

const CAPACITY = 400

/** Record one diagnostic line. */
export function log(line: string): void {
  lines.push(`${new Date().toISOString().slice(11, 23)} ${line}`)
  if (lines.length > CAPACITY) lines = lines.slice(lines.length - CAPACITY)
}

/** Snapshot of the buffer, newest last. */
export function recentLogs(): string[] {
  return [...lines]
}
