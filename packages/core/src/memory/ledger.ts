/**
 * Cross-session ledger (B2-T8): one append-only line per finished session.
 *
 * `M2-实施计划.md` §4.7.2 and `跨会话记忆与游戏性后果-设计草案.md` §1 define the
 * contract:
 *
 * - `memory/ledger.jsonl` is append-only, **one line per session**, and stores
 *   facts only — no chat text, no audio/video, no raw reaction-probe numbers.
 *   The line is built from {@link LedgerEntry}'s ten fields, so a caller
 *   cannot smuggle prose into the file;
 * - an `open` marker (`memory/open.json`) exists while a session runs. A clean
 *   `close` appends the line and clears it; if the marker is still there on
 *   the next start, the previous session crashed and {@link SessionLedger.recover}
 *   appends exactly one `unexpected_exit` line instead. The unfinished turn is
 *   never replayed — its effects may already have been dispatched;
 * - `endReason` is the only enum (six values). `aborted`/`recovered` are UI
 *   labels and are never written;
 * - a content pack opts in through `history.read`; {@link matchMetaReactions}
 *   then turns the ledger into an opening brief (`tone` / `firstIntent`). A
 *   pack that does not read produces exactly the neutral opening, which is the
 *   E-2 acceptance row.
 *
 * ## Reading an append-only store
 *
 * The `AppendOnlyStore` port is write-only by design. `read()` therefore takes
 * an optional {@link LedgerTextReader}: the host passes a closure over the
 * ledger file, unit tests pass the in-memory lines. Without a reader the class
 * can still report entries appended by the current instance, which keeps the
 * required behaviour testable but is not enough to remember earlier processes;
 * the host wiring (owned by Lead, `bootstrap.ts`) must pass the reader.
 *
 * @module
 */

import type { Clock } from '../ports/clock.ts'
import type { AppendOnlyStore, DocumentStore } from '../ports/storage.ts'
import type { PackManifest } from '../scenario/loader.ts'

/** The only end-reason vocabulary (§1 / S11); six values, nothing else. */
export const SESSION_END_REASONS = [
  'completed',
  'left_early',
  'paused',
  'panic',
  'stop',
  'unexpected_exit',
] as const

/** Why a session ended; `aborted`/`recovered` are UI labels, not ledger values. */
export type SessionEndReason = (typeof SESSION_END_REASONS)[number]

const END_REASON_SET: ReadonlySet<string> = new Set(SESSION_END_REASONS)

/** One ledger line. Facts only — extending this shape needs a spec change. */
export interface LedgerEntry {
  readonly sessionId: string
  readonly pack: string
  /** ISO timestamp of the session start. */
  readonly startedAt: string
  /** ISO timestamp of the session end (or the last snapshot time on crash). */
  readonly endedAt: string
  readonly endReason: SessionEndReason
  readonly plannedMin: number | null
  readonly actualMin: number
  readonly phaseReached: string
  readonly aftercare: boolean
  /** Highest percent actually dispatched this session; never a cap. */
  readonly maxCapUsed: number
}

/** What a matching `metaReactions` rule hands to the opening turn. */
export interface OpeningBrief {
  readonly tone?: string
  readonly firstIntent?: string
}

/** Read side of the append-only ledger; `AppendOnlyStore` has no read method. */
export type LedgerTextReader = () => Promise<string | undefined>

/** Last settled snapshot facts, used to date a crash (B2-T7's archive). */
export interface LedgerSnapshotFact {
  /** Epoch milliseconds of the last settled snapshot. */
  readonly at: number
  /** Phase id at that snapshot. */
  readonly phase: string
}

/** Optional seam back into {@link SessionState} for crash accounting. */
export type LedgerSnapshotSource = () => Promise<LedgerSnapshotFact | undefined>

/** Constructor seam. `reader`/`snapshot` are additive (see the module note). */
export interface SessionLedgerOptions {
  readonly store: AppendOnlyStore
  readonly documents: DocumentStore
  readonly clock: Clock
  readonly reader?: LedgerTextReader
  readonly snapshot?: LedgerSnapshotSource
}

/** Key of the in-progress marker inside the memory document namespace. */
export const OPEN_MARKER_KEY = 'open'

/** Key of the append-only cut marker written by {@link SessionLedger.clear}. */
export const CLEARED_MARKER_KEY = 'cleared'

const MARKER_VERSION = 1

/** `open.json` payload (never a ledger line). */
interface OpenMarker {
  readonly version: number
  readonly sessionId: string
  readonly pack: string
  readonly startedAt: string
  readonly plannedMin: number | null
}

/** `cleared.json` payload: how many raw lines existed when the human cleared. */
interface ClearedMarker {
  readonly version: number
  readonly lines: number
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

async function readJson(documents: DocumentStore, key: string): Promise<unknown | undefined> {
  const raw = await documents.read(key)
  if (raw === undefined || raw.trim() === '') return undefined
  try {
    return JSON.parse(raw) as unknown
  } catch {
    return undefined
  }
}

function parseOpenMarker(value: unknown): OpenMarker | undefined {
  if (!isPlainObject(value)) return undefined
  if (typeof value['sessionId'] !== 'string' || typeof value['pack'] !== 'string') return undefined
  if (typeof value['startedAt'] !== 'string') return undefined
  const plannedMin = value['plannedMin']
  if (plannedMin !== null && !isFiniteNumber(plannedMin)) return undefined
  return {
    version: MARKER_VERSION,
    sessionId: value['sessionId'],
    pack: value['pack'],
    startedAt: value['startedAt'],
    plannedMin,
  }
}

function parseClearedMarker(value: unknown): ClearedMarker | undefined {
  if (!isPlainObject(value)) return undefined
  const lines = value['lines']
  if (!Number.isSafeInteger(lines) || (lines as number) < 0) return undefined
  return { version: MARKER_VERSION, lines: lines as number }
}

function parseLedgerEntry(value: unknown): LedgerEntry | undefined {
  if (!isPlainObject(value)) return undefined
  const endReason = value['endReason']
  if (typeof endReason !== 'string' || !END_REASON_SET.has(endReason)) return undefined
  const plannedMin = value['plannedMin']
  if (plannedMin !== null && !isFiniteNumber(plannedMin)) return undefined
  if (!isFiniteNumber(value['actualMin']) || !isFiniteNumber(value['maxCapUsed'])) return undefined
  if (typeof value['aftercare'] !== 'boolean') return undefined
  const startedAt = value['startedAt']
  const endedAt = value['endedAt']
  if (typeof startedAt !== 'string' || typeof endedAt !== 'string') return undefined
  if (!Number.isFinite(Date.parse(startedAt)) || !Number.isFinite(Date.parse(endedAt))) return undefined
  if (typeof value['sessionId'] !== 'string' || typeof value['pack'] !== 'string') return undefined
  if (typeof value['phaseReached'] !== 'string') return undefined
  return {
    sessionId: value['sessionId'],
    pack: value['pack'],
    startedAt,
    endedAt,
    endReason: endReason as SessionEndReason,
    plannedMin,
    actualMin: value['actualMin'],
    phaseReached: value['phaseReached'],
    aftercare: value['aftercare'],
    maxCapUsed: value['maxCapUsed'],
  }
}

/** One ledger line, field order fixed so the file is diff- and replay-friendly. */
function serializeEntry(entry: LedgerEntry): string {
  if (entry.sessionId.trim() === '' || entry.pack.trim() === '') {
    throw new TypeError('ledger entry needs a sessionId and a pack id')
  }
  if (typeof entry.endReason !== 'string' || !END_REASON_SET.has(entry.endReason)) {
    throw new TypeError(`unknown endReason "${String(entry.endReason)}"`)
  }
  if (!Number.isFinite(Date.parse(entry.startedAt)) || !Number.isFinite(Date.parse(entry.endedAt))) {
    throw new TypeError('ledger timestamps must be ISO date strings')
  }
  const plannedMin = entry.plannedMin
  if (plannedMin !== null && !isFiniteNumber(plannedMin)) throw new TypeError('plannedMin must be a number or null')
  if (!isFiniteNumber(entry.actualMin) || entry.actualMin < 0) throw new TypeError('actualMin must be a non-negative number')
  if (!isFiniteNumber(entry.maxCapUsed) || entry.maxCapUsed < 0) throw new TypeError('maxCapUsed must be non-negative')
  if (typeof entry.aftercare !== 'boolean') throw new TypeError('aftercare must be a boolean')
  if (typeof entry.phaseReached !== 'string') throw new TypeError('phaseReached must be a string')
  const line: LedgerEntry = {
    sessionId: entry.sessionId,
    pack: entry.pack,
    startedAt: entry.startedAt,
    endedAt: entry.endedAt,
    endReason: entry.endReason,
    plannedMin,
    actualMin: entry.actualMin,
    phaseReached: entry.phaseReached,
    aftercare: entry.aftercare,
    maxCapUsed: entry.maxCapUsed,
  }
  return JSON.stringify(line)
}

/**
 * Cross-session memory for one host.
 *
 * The ledger is deliberately independent from the audit log: a separate
 * `AppendOnlyStore`, a separate directory (`memory/`), and no rewrite/delete
 * API. `clear()` appends a cut marker instead of touching old lines, because
 * the port cannot truncate — and because an append-only file is the one
 * property the audit trail and the ledger share (§4.10).
 */
export class SessionLedger {
  private readonly store: AppendOnlyStore
  private readonly documents: DocumentStore
  private readonly clock: Clock
  private readonly reader: LedgerTextReader | undefined
  private readonly snapshotSource: LedgerSnapshotSource | undefined
  /** Fallback for `read()` when the host passed no {@link LedgerTextReader}. */
  private readonly appended: string[] = []
  /** Sessions this instance already settled, so a duplicated `end` is a no-op. */
  private readonly settled = new Set<string>()

  constructor(options: SessionLedgerOptions) {
    this.store = options.store
    this.documents = options.documents
    this.clock = options.clock
    this.reader = options.reader
    this.snapshotSource = options.snapshot
  }

  /**
   * Write the in-progress marker; no ledger line is written yet.
   *
   * If a marker for a **different** session is still there, it is settled as
   * `unexpected_exit` first. `recover()` does the same explicitly at startup;
   * this guard means a host that forgets the call cannot silently lose a line.
   */
  async open(sessionId: string, input: { readonly pack: string; readonly plannedMin: number | null }): Promise<void> {
    if (sessionId.trim() === '') throw new TypeError('sessionId must not be empty')
    if (input.pack.trim() === '') throw new TypeError('pack id must not be empty')
    const existing = await this.readOpenMarker()
    if (existing !== undefined && existing.sessionId !== sessionId) await this.recover()
    this.settled.delete(sessionId)
    const marker: OpenMarker = {
      version: MARKER_VERSION,
      sessionId,
      pack: input.pack,
      startedAt: new Date(this.clock.now()).toISOString(),
      plannedMin: input.plannedMin,
    }
    await this.documents.write(OPEN_MARKER_KEY, JSON.stringify(marker))
  }

  /**
   * Append one ledger line, then clear the matching open marker.
   *
   * Idempotent per session **within one process**: if `end` and a shutdown
   * path both close, the second call observes no marker and would otherwise
   * append a duplicate line ("one session, one line").
   */
  async close(entry: LedgerEntry): Promise<void> {
    const line = serializeEntry(entry)
    if (this.settled.has(entry.sessionId)) return
    await this.store.append(line)
    this.appended.push(line)
    this.settled.add(entry.sessionId)
    const marker = await this.readOpenMarker()
    if (marker === undefined || marker.sessionId === entry.sessionId) {
      await this.documents.write(OPEN_MARKER_KEY, '')
    }
  }

  /**
   * Startup crash check: a leftover marker becomes exactly one
   * `unexpected_exit` line, then the marker is cleared.
   *
   * `endedAt` prefers the last settled snapshot's time (B2-T7) and falls back
   * to the clock. `actualMin` is derived from the marker start. Nothing about
   * the unfinished turn is replayed.
   */
  async recover(): Promise<readonly LedgerEntry[]> {
    const marker = await this.readOpenMarker()
    if (marker === undefined) return []
    const snapshot = await this.readSnapshotFact()
    const startedAtMs = Date.parse(marker.startedAt)
    const endedAtMs = snapshot?.at ?? this.clock.now()
    const safeStartedAtMs = Number.isFinite(startedAtMs) ? startedAtMs : endedAtMs
    const entry: LedgerEntry = {
      sessionId: marker.sessionId,
      pack: marker.pack,
      startedAt: marker.startedAt,
      endedAt: new Date(endedAtMs).toISOString(),
      endReason: 'unexpected_exit',
      plannedMin: marker.plannedMin,
      actualMin: Math.max(0, Math.floor((endedAtMs - safeStartedAtMs) / 60_000)),
      phaseReached: snapshot?.phase ?? 'unknown',
      aftercare: false,
      maxCapUsed: 0,
    }
    const line = serializeEntry(entry)
    await this.store.append(line)
    this.appended.push(line)
    this.settled.add(entry.sessionId)
    await this.documents.write(OPEN_MARKER_KEY, '')
    return [entry]
  }

  /** Bounded recent history, newest last, as `history` declares it. */
  async read(query?: { readonly windowHours?: number; readonly lastN?: number }): Promise<readonly LedgerEntry[]> {
    const cut = await this.clearedLineCount()
    const lines = (await this.rawLines()).slice(cut)
    let entries: LedgerEntry[] = []
    for (const line of lines) {
      try {
        const parsed = parseLedgerEntry(JSON.parse(line) as unknown)
        if (parsed !== undefined) entries.push(parsed)
      } catch {
        // A torn or hand-edited line is skipped; startup must never crash on it.
      }
    }
    const windowHours = query?.windowHours
    if (windowHours !== undefined && Number.isFinite(windowHours) && windowHours > 0) {
      const cutoff = this.clock.now() - windowHours * 3_600_000
      entries = entries.filter(entry => Date.parse(entry.endedAt) >= cutoff)
    }
    const lastN = query?.lastN
    if (lastN !== undefined && Number.isSafeInteger(lastN) && lastN >= 1) {
      entries = entries.slice(-lastN)
    }
    return entries
  }

  /**
   * Human "delete the ledger" action.
   *
   * The append-only store cannot be truncated, so this writes a cut marker
   * with the current raw line count: later reads skip those lines and old
   * bytes stay untouched. The audit record (`ledger_cleared`) belongs to the
   * caller — this module never writes the audit log.
   */
  async clear(): Promise<void> {
    const lines = await this.rawLines()
    const marker: ClearedMarker = { version: MARKER_VERSION, lines: lines.length }
    await this.documents.write(CLEARED_MARKER_KEY, JSON.stringify(marker))
  }

  /** Number of raw lines a previous `clear()` cut away. */
  private async clearedLineCount(): Promise<number> {
    const marker = parseClearedMarker(await readJson(this.documents, CLEARED_MARKER_KEY))
    return marker?.lines ?? 0
  }

  private async rawLines(): Promise<readonly string[]> {
    if (this.reader === undefined) return [...this.appended]
    const text = await this.reader()
    if (text === undefined) return []
    return text.split('\n').filter(line => line.trim() !== '')
  }

  private async readOpenMarker(): Promise<OpenMarker | undefined> {
    return parseOpenMarker(await readJson(this.documents, OPEN_MARKER_KEY))
  }

  private async readSnapshotFact(): Promise<LedgerSnapshotFact | undefined> {
    if (this.snapshotSource === undefined) return undefined
    try {
      return await this.snapshotSource()
    } catch {
      // Recovery must never be blocked by an unreadable archive.
      return undefined
    }
  }
}

/** True when a rule's `when` block matches one ledger entry. */
function matchesWhen(when: { readonly endReason?: readonly SessionEndReason[]; readonly aftercare?: boolean }, entry: LedgerEntry): boolean {
  if (when.endReason !== undefined && !when.endReason.includes(entry.endReason)) return false
  if (when.aftercare !== undefined && when.aftercare !== entry.aftercare) return false
  return true
}

/**
 * Turn the ledger into an opening brief, or `undefined` for a neutral opening.
 *
 * Matching follows §4.7.2 literally: a pack that does not set
 * `history.read = true` gets `undefined` **even if** entries and rules exist
 * (E-2); otherwise entries are filtered by the pack's `windowHours`/`lastN`,
 * walked newest-first, and the first matching `metaReactions` rule wins. The
 * result carries only `tone`/`firstIntent` — no numbers, no device facts.
 */
export function matchMetaReactions(
  pack: PackManifest,
  entries: readonly LedgerEntry[],
  now: number,
): OpeningBrief | undefined {
  const history = pack.history
  if (history === undefined || history.read !== true) return undefined
  let window = entries
  if (history.windowHours !== undefined && Number.isFinite(history.windowHours) && history.windowHours > 0) {
    const cutoff = now - history.windowHours * 3_600_000
    window = window.filter(entry => Date.parse(entry.endedAt) >= cutoff)
  }
  if (history.lastN !== undefined && Number.isSafeInteger(history.lastN) && history.lastN >= 1) {
    window = window.slice(-history.lastN)
  }
  const reactions = pack.metaReactions ?? []
  const newestFirst = [...window].reverse()
  for (const entry of newestFirst) {
    for (const reaction of reactions) {
      if (!matchesWhen(reaction.when, entry)) continue
      const opening = reaction.opening
      return {
        ...(opening.tone === undefined ? {} : { tone: opening.tone }),
        ...(opening.firstIntent === undefined ? {} : { firstIntent: opening.firstIntent }),
      }
    }
  }
  return undefined
}
