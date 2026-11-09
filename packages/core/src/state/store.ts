/**
 * Session archive (B2-T7): one snapshot per settled turn, plus merge patches.
 *
 * `M2-实施计划.md` §4.7.1 is the contract:
 *
 * - the host writes {@link SessionState} through {@link SessionStore} on every
 *   settle (`TurnEngineHooks.onSettle`); the store is the only writer, the
 *   engine's phase machine stays the only authority for `currentPhase`;
 * - `state_patch` (the model tool) is an RFC 7386 merge patch restricted to
 *   `scene/player/npcs/flags/learned`, depth ≤ 4 and ≤ 16 KB serialised. A
 *   patch can never touch session identity, the phase, the turn counter or the
 *   timestamps, so the model cannot promote itself into a new phase or a new
 *   session;
 * - crash recovery reads the **last** snapshot, relabels a still-`active` one
 *   as `recovered`, and never replays the unfinished turn: a turn that was in
 *   flight may already have dispatched to hardware, and re-running it would
 *   double-drive the devices.
 *
 * ## Storage layout
 *
 * The module is platform-free: it only sees the {@link DocumentStore} port.
 * Keys are stable and POSIX-ish so a host can implement them as files:
 *
 *     session-<sessionId>   the snapshot itself (JSON)
 *     session-last          { version: 1, sessionId } pointer to the last write
 *     session-index         { version: 1, sessions: [...] } ids for `clear()`
 *
 * `DocumentStore` has no delete method, so `clear()` blanks the documents it
 * knows about (empty string = absent) instead of unlinking them. A host that
 * needs the bytes gone must remove the directory itself; that is an operator
 * action, not an engine one.
 *
 * ## Status vocabulary
 *
 * `active` is the only status a running session writes. `paused` is reserved
 * for B2-T11, `ended` is written by the host's end/panic path, and
 * `recovered` is written **only** by {@link SessionStore.recover} — a UI label
 * that is never persisted into the ledger (the ledger records
 * `unexpected_exit`, see `memory/ledger.ts`).
 *
 * @module
 */

import type { Clock } from '../ports/clock.ts'
import type { DocumentStore } from '../ports/storage.ts'

/** Top-level keys a `state_patch` may touch (§4.7.1). */
export const STATE_PATCH_FIELDS = ['scene', 'player', 'npcs', 'flags', 'learned'] as const

/** One of the five model-writable state blocks. */
export type StatePatchField = (typeof STATE_PATCH_FIELDS)[number]

/** Serialised patch/state ceiling from §4.7.1. */
export const MAX_STATE_PATCH_BYTES = 16 * 1024

/** Nesting ceiling from §4.7.1 (a primitive has no depth). */
export const MAX_STATE_PATCH_DEPTH = 4

/**
 * One persisted session snapshot.
 *
 * The first block is engine-owned and never writable through `patch`; the
 * optional blocks are the model/writer-owned narrative memory.
 */
export interface SessionState {
  readonly sessionId: string
  readonly packId: string
  readonly scenarioId?: string
  readonly currentPhase: string
  readonly turn: number
  readonly startedAt: string
  readonly elapsedMin: number
  readonly scene?: Readonly<Record<string, unknown>>
  readonly player?: Readonly<Record<string, unknown>>
  readonly npcs?: Readonly<Record<string, unknown>>
  readonly flags: Readonly<Record<string, unknown>>
  readonly learned: readonly string[]
  readonly lastLine?: string
  /** Intent ids of the last two settled turns (`§4.7.1`, recentBeats). */
  readonly recentBeats: readonly string[]
  readonly status: 'active' | 'paused' | 'recovered' | 'ended'
}

/** One rejected path inside a merge patch. */
export interface RejectedPatchPath {
  readonly path: string
  readonly reason: string
}

/** What {@link SessionStore.patch} applied and what it refused. */
export interface PatchResult {
  readonly state: SessionState
  readonly applied: readonly string[]
  readonly rejected: readonly RejectedPatchPath[]
}

/** Constructor seam: storage plus the time source (never `Date.now` directly). */
export interface SessionStoreOptions {
  readonly documents: DocumentStore
  readonly clock: Clock
}

/** Input of {@link SessionStore.open}; `startedAt` is epoch milliseconds. */
export interface OpenSessionInput {
  readonly sessionId: string
  readonly packId: string
  readonly scenarioId?: string
  readonly phase: string
  readonly startedAt?: number
}

/** Typed failure for programmer errors (a corrupt document degrades to `undefined`). */
export class StateStoreError extends Error {
  readonly code: 'NO_STATE' | 'INVALID_STATE'

  constructor(code: StateStoreError['code'], message: string) {
    super(message)
    this.name = 'StateStoreError'
    this.code = code
  }
}

const SNAPSHOT_PREFIX = 'session-'
const LAST_KEY = 'session-last'
const INDEX_KEY = 'session-index'
const INDEX_VERSION = 1

/** Keys the engine owns; listed only to give the model a precise refusal. */
const ENGINE_OWNED_FIELDS = new Set([
  'sessionId',
  'packId',
  'scenarioId',
  'currentPhase',
  'turn',
  'startedAt',
  'elapsedMin',
  'status',
  'lastLine',
  'recentBeats',
])

const PATCH_FIELD_SET: ReadonlySet<string> = new Set(STATE_PATCH_FIELDS)

/** JSON object (not null, not an array). */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isJsonPrimitive(value: unknown): boolean {
  if (value === null) return true
  const type = typeof value
  if (type === 'string' || type === 'boolean') return true
  return type === 'number' && Number.isFinite(value)
}

/** UTF-8 byte length without a platform encoder dependency. */
function utf8Bytes(text: string): number {
  let bytes = 0
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index)
    if (code < 0x80) bytes += 1
    else if (code < 0x800) bytes += 2
    else if (code >= 0xd800 && code <= 0xdbff) {
      // Surrogate pair: one 4-byte code point, skip the low surrogate.
      bytes += 4
      index += 1
    } else bytes += 3
  }
  return bytes
}

const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor'])

type Inspection = { readonly ok: true } | { readonly ok: false; readonly path: string; readonly reason: string }

/**
 * Recursively validate one patch value: JSON-safe, no prototype-polluting
 * keys, depth ≤ {@link MAX_STATE_PATCH_DEPTH}.
 */
function inspectValue(value: unknown, path: string, depth: number): Inspection {
  if (depth > MAX_STATE_PATCH_DEPTH) {
    return { ok: false, path, reason: `exceeds the nesting depth limit of ${MAX_STATE_PATCH_DEPTH}` }
  }
  if (isJsonPrimitive(value)) return { ok: true }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const result = inspectValue(value[index], `${path}[${index}]`, depth + 1)
      if (!result.ok) return result
    }
    return { ok: true }
  }
  if (!isPlainObject(value)) {
    return { ok: false, path, reason: 'is not a JSON value' }
  }
  for (const [key, child] of Object.entries(value)) {
    const childPath = path === '' ? key : `${path}.${key}`
    if (FORBIDDEN_KEYS.has(key)) {
      return { ok: false, path: childPath, reason: 'is a forbidden key' }
    }
    const result = inspectValue(child, childPath, depth + 1)
    if (!result.ok) return result
  }
  return { ok: true }
}

/**
 * RFC 7386 merge: objects merge recursively, `null` deletes a key, every other
 * value (including arrays) replaces the target wholesale.
 */
function mergeValue(target: unknown, patch: Record<string, unknown>): Record<string, unknown> {
  const base: Record<string, unknown> = isPlainObject(target) ? { ...target } : {}
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      delete base[key]
    } else if (isPlainObject(value)) {
      base[key] = mergeValue(base[key], value)
    } else {
      // Primitive or array: JSON merge patch replaces it as a whole.
      base[key] = Array.isArray(value) ? [...value] : value
    }
  }
  return base
}

/** Read a document as JSON, treating an empty string (cleared) as absent. */
async function readJson(documents: DocumentStore, key: string): Promise<unknown | undefined> {
  const raw = await documents.read(key)
  if (raw === undefined || raw.trim() === '') return undefined
  try {
    return JSON.parse(raw) as unknown
  } catch {
    return undefined
  }
}

/** Shape check for documents and ledger-adjacent state; corrupt ⇒ `undefined`. */
function parseState(value: unknown): SessionState | undefined {
  if (!isPlainObject(value)) return undefined
  const status = value['status']
  if (status !== 'active' && status !== 'paused' && status !== 'recovered' && status !== 'ended') {
    return undefined
  }
  if (typeof value['sessionId'] !== 'string' || typeof value['packId'] !== 'string') return undefined
  if (typeof value['currentPhase'] !== 'string') return undefined
  if (typeof value['turn'] !== 'number' || !Number.isFinite(value['turn'])) return undefined
  if (typeof value['startedAt'] !== 'string') return undefined
  if (typeof value['elapsedMin'] !== 'number' || !Number.isFinite(value['elapsedMin'])) return undefined
  if (!isPlainObject(value['flags'])) return undefined
  if (!Array.isArray(value['learned']) || !value['learned'].every(item => typeof item === 'string')) {
    return undefined
  }
  if (!Array.isArray(value['recentBeats']) || !value['recentBeats'].every(item => typeof item === 'string')) {
    return undefined
  }
  const scene = value['scene']
  const player = value['player']
  const npcs = value['npcs']
  const lastLine = value['lastLine']
  const scenarioId = value['scenarioId']
  return {
    sessionId: value['sessionId'],
    packId: value['packId'],
    ...(typeof scenarioId === 'string' ? { scenarioId } : {}),
    currentPhase: value['currentPhase'],
    turn: value['turn'],
    startedAt: value['startedAt'],
    elapsedMin: value['elapsedMin'],
    ...(isPlainObject(scene) ? { scene } : {}),
    ...(isPlainObject(player) ? { player } : {}),
    ...(isPlainObject(npcs) ? { npcs } : {}),
    flags: value['flags'],
    learned: [...value['learned']] as readonly string[],
    ...(typeof lastLine === 'string' ? { lastLine } : {}),
    recentBeats: [...value['recentBeats']] as readonly string[],
    status,
  }
}

function snapshotKey(sessionId: string): string {
  return `${SNAPSHOT_PREFIX}${sessionId}`
}

/**
 * The per-turn session archive.
 *
 * One store instance is bound to one document namespace and one clock. Methods
 * serialise through the injected port only; ordering between concurrent calls
 * is the caller's responsibility (the host calls `save` from a single settle
 * hook per turn).
 */
export class SessionStore {
  private readonly documents: DocumentStore
  private readonly clock: Clock

  constructor(options: SessionStoreOptions) {
    this.documents = options.documents
    this.clock = options.clock
  }

  /**
   * Start a fresh snapshot and return it.
   *
   * A still-`active` snapshot left by an earlier process is relabelled
   * `recovered` first: `open` doubles as the crash-recovery entry point, so a
   * host cannot forget the recovery step. The unfinished turn is **not**
   * replayed — only its last settled snapshot is kept.
   */
  async open(input: OpenSessionInput): Promise<SessionState> {
    if (input.sessionId.trim() === '') {
      throw new StateStoreError('INVALID_STATE', 'sessionId must not be empty')
    }
    await this.recover()
    const startedAt = new Date(input.startedAt ?? this.clock.now()).toISOString()
    const state: SessionState = {
      sessionId: input.sessionId,
      packId: input.packId,
      ...(input.scenarioId === undefined ? {} : { scenarioId: input.scenarioId }),
      currentPhase: input.phase,
      turn: 0,
      startedAt,
      elapsedMin: 0,
      flags: {},
      learned: [],
      recentBeats: [],
      status: 'active',
    }
    // Index first: `clear()` discovers snapshots through it, so a crash in
    // between must not leave a snapshot the clear path cannot name.
    await this.addToIndex(input.sessionId)
    await this.save(state)
    return state
  }
  /** The snapshot for one session, or `undefined` when absent/corrupt/cleared. */
  async load(sessionId: string): Promise<SessionState | undefined> {
    return parseState(await readJson(this.documents, snapshotKey(sessionId)))
  }

  /** Persist one snapshot and move the "last" pointer onto it. */
  async save(state: SessionState): Promise<void> {
    const parsed = parseState(state)
    if (parsed === undefined) {
      throw new StateStoreError('INVALID_STATE', 'refusing to save an invalid session state')
    }
    await this.documents.write(snapshotKey(parsed.sessionId), JSON.stringify(parsed))
    await this.documents.write(LAST_KEY, JSON.stringify({ version: INDEX_VERSION, sessionId: parsed.sessionId }))
  }

  /**
   * Crash recovery: read the last snapshot and relabel a still-`active` one.
   *
   * Returns the snapshot as it now stands (unchanged when it was already
   * `paused`/`ended`/`recovered`). The host calls this at startup, before
   * opening a new session; it performs **no replay** of the unfinished turn.
   */
  async recover(): Promise<SessionState | undefined> {
    const pointer = await readJson(this.documents, LAST_KEY)
    if (!isPlainObject(pointer) || typeof pointer['sessionId'] !== 'string') return undefined
    const state = await this.load(pointer['sessionId'])
    if (state === undefined) return undefined
    if (state.status !== 'active') return state
    const recovered: SessionState = { ...state, status: 'recovered' }
    await this.save(recovered)
    return recovered
  }

  /**
   * Apply one RFC 7386 merge patch to the stored snapshot.
   *
   * Only {@link STATE_PATCH_FIELDS} are writable. Every other top-level key is
   * refused (with a dedicated reason for `currentPhase`), so the phase, turn
   * counter and session identity stay engine-owned. The patch is applied
   * partially: legal keys land, illegal keys are reported in `rejected`.
   */
  async patch(sessionId: string, patch: unknown): Promise<PatchResult> {
    const state = await this.load(sessionId)
    if (state === undefined) {
      throw new StateStoreError('NO_STATE', `no session state for "${sessionId}"`)
    }
    const rejected: RejectedPatchPath[] = []
    const applied: string[] = []

    if (!isPlainObject(patch)) {
      return {
        state,
        applied,
        rejected: [{ path: '', reason: 'patch must be a JSON object' }],
      }
    }

    let serialized: string
    try {
      serialized = JSON.stringify(patch)
    } catch {
      return { state, applied, rejected: [{ path: '', reason: 'patch is not JSON-serialisable' }] }
    }
    if (utf8Bytes(serialized) > MAX_STATE_PATCH_BYTES) {
      return {
        state,
        applied,
        rejected: [{ path: '', reason: `patch exceeds the ${MAX_STATE_PATCH_BYTES}-byte limit` }],
      }
    }

    let scene = state.scene
    let player = state.player
    let npcs = state.npcs
    let flags: Record<string, unknown> = { ...state.flags }
    let learned: readonly string[] = state.learned

    for (const [key, value] of Object.entries(patch)) {
      if (!PATCH_FIELD_SET.has(key)) {
        rejected.push({
          path: key,
          reason: key === 'currentPhase'
            ? 'currentPhase is engine-owned and may only be advanced by the phase machine'
            : ENGINE_OWNED_FIELDS.has(key)
              ? 'field is engine-owned'
              : 'not in the state_patch whitelist',
        })
        continue
      }

      const inspected = inspectValue(value, key, 1)
      if (!inspected.ok) {
        rejected.push({ path: inspected.path, reason: inspected.reason })
        continue
      }

      if (key === 'learned') {
        if (value === null) {
          rejected.push({ path: key, reason: 'learned cannot be removed' })
          continue
        }
        if (!Array.isArray(value) || !value.every(item => typeof item === 'string')) {
          rejected.push({ path: key, reason: 'learned must be an array of strings' })
          continue
        }
        learned = [...value]
        applied.push(key)
        continue
      }

      if (key === 'flags') {
        if (value === null) {
          rejected.push({ path: key, reason: 'flags cannot be removed' })
          continue
        }
        if (!isPlainObject(value)) {
          rejected.push({ path: key, reason: 'flags must be a JSON object' })
          continue
        }
        flags = mergeValue(flags, value)
        applied.push(key)
        continue
      }

      if (value === null) {
        if (key === 'scene') scene = undefined
        else if (key === 'player') player = undefined
        else npcs = undefined
        applied.push(key)
        continue
      }
      if (!isPlainObject(value)) {
        rejected.push({ path: key, reason: `${key} must be a JSON object or null` })
        continue
      }
      const merged = mergeValue(key === 'scene' ? scene : key === 'player' ? player : npcs, value)
      if (key === 'scene') scene = merged
      else if (key === 'player') player = merged
      else npcs = merged
      applied.push(key)
    }

    if (applied.length === 0) return { state, applied, rejected }

    const next: SessionState = {
      ...state,
      ...(scene === undefined ? {} : { scene }),
      ...(player === undefined ? {} : { player }),
      ...(npcs === undefined ? {} : { npcs }),
      flags,
      learned,
    }
    const size = utf8Bytes(JSON.stringify(next))
    if (size > MAX_STATE_PATCH_BYTES) {
      return {
        state,
        applied: [],
        rejected: [{ path: '', reason: `resulting state exceeds the ${MAX_STATE_PATCH_BYTES}-byte limit` }],
      }
    }
    await this.save(next)
    return { state: next, applied, rejected }
  }

  /**
   * Blank every known snapshot (the `DocumentStore` port has no delete).
   *
   * This is a human/operator action; callers audit it as `ledger_cleared` only
   * for the ledger, never for the archive.
   */
  async clear(): Promise<void> {
    const index = await readJson(this.documents, INDEX_KEY)
    const sessions = isPlainObject(index) && Array.isArray(index['sessions'])
      ? index['sessions'].filter((item): item is string => typeof item === 'string')
      : []
    for (const sessionId of sessions) {
      await this.documents.write(snapshotKey(sessionId), '')
    }
    await this.documents.write(LAST_KEY, '')
    await this.documents.write(INDEX_KEY, '')
  }

  /** Track session ids so `clear()` can blank them without directory listing. */
  private async addToIndex(sessionId: string): Promise<void> {
    const index = await readJson(this.documents, INDEX_KEY)
    const sessions = isPlainObject(index) && Array.isArray(index['sessions'])
      ? index['sessions'].filter((item): item is string => typeof item === 'string')
      : []
    if (sessions.includes(sessionId)) return
    sessions.push(sessionId)
    await this.documents.write(INDEX_KEY, JSON.stringify({ version: INDEX_VERSION, sessions }))
  }
}
