/**
 * B2-T8 — ledger and cross-session opening-brief tests.
 *
 * The three acceptance `it` names from `M2-实施计划.md` §3.4 are kept verbatim.
 * The ledger is exercised through the real `AppendOnlyStore` port; the file
 * reader is simulated by joining the in-memory lines, which is exactly the
 * closure the host will install over `memory/ledger.jsonl`.
 */

import { describe, expect, it } from 'vitest'
import { FakeClock } from '../src/ports/fake-clock.ts'
import { MemoryAppendOnlyStore, MemoryDocumentStore } from '../src/ports/storage.ts'
import type { PackManifest } from '../src/scenario/loader.ts'
import {
  matchMetaReactions,
  OPEN_MARKER_KEY,
  SESSION_END_REASONS,
  SessionLedger,
  type LedgerEntry,
} from '../src/memory/ledger.ts'

const START = Date.parse('2026-11-01T12:00:00.000Z')

interface Harness {
  readonly clock: FakeClock
  readonly store: MemoryAppendOnlyStore
  readonly documents: MemoryDocumentStore
  readonly ledger: SessionLedger
  /** Raw lines as the host's file reader would return them. */
  readonly text: () => Promise<string | undefined>
}

function createLedger(input: {
  readonly clock: FakeClock
  readonly store: MemoryAppendOnlyStore
  readonly documents: MemoryDocumentStore
  readonly snapshot?: () => Promise<{ at: number; phase: string } | undefined>
}): SessionLedger {
  return new SessionLedger({
    clock: input.clock,
    store: input.store,
    documents: input.documents,
    reader: async () => input.store.lines.join('\n'),
    ...(input.snapshot === undefined ? {} : { snapshot: input.snapshot }),
  })
}

function harness(): Harness {
  const clock = new FakeClock(START)
  const store = new MemoryAppendOnlyStore()
  const documents = new MemoryDocumentStore()
  return {
    clock,
    store,
    documents,
    ledger: createLedger({ clock, store, documents }),
    text: async () => store.lines.join('\n'),
  }
}

/** A complete ledger line; individual fields are overridden per test. */
function entry(overrides: Partial<LedgerEntry> = {}): LedgerEntry {
  return {
    sessionId: 's-1',
    pack: 'demo',
    startedAt: new Date(START).toISOString(),
    endedAt: new Date(START + 18 * 60_000).toISOString(),
    endReason: 'left_early',
    plannedMin: 45,
    actualMin: 18,
    phaseReached: 'escalate',
    aftercare: false,
    maxCapUsed: 40,
    ...overrides,
  }
}

/** `pack.json` shape with optional history/metaReactions; no files involved. */
function manifest(overrides: Partial<PackManifest> = {}): PackManifest {
  return {
    id: 'demo',
    name: 'Demo Pack',
    version: '1.0.0',
    engine: '>=0.2 <1.0',
    mode: 'freeform',
    rating: 'all',
    ...overrides,
  }
}

/** The reaction pair from `内容包规范.md` §4.6. */
const REACTIONS: PackManifest['metaReactions'] = [
  { when: { endReason: ['left_early'] }, opening: { tone: 'cold', firstIntent: 'restrained-opening' } },
  { when: { endReason: ['unexpected_exit'] }, opening: { tone: 'worried', firstIntent: 'soothe' } },
  { when: { aftercare: false }, opening: { tone: 'disappointed' } },
]

describe('session ledger', () => {
  it('records each of the six endReason values into one ledger line', async () => {
    const h = harness()
    for (const [index, reason] of SESSION_END_REASONS.entries()) {
      const sessionId = `s-${index}`
      await h.ledger.open(sessionId, { pack: 'demo', plannedMin: 30 })
      h.clock.advance(60_000)
      await h.ledger.close(entry({
        sessionId,
        endReason: reason,
        startedAt: new Date(h.clock.now() - 60_000).toISOString(),
        endedAt: new Date(h.clock.now()).toISOString(),
      }))
    }

    // One line per session, appended in order, nothing rewritten.
    expect(h.store.lines).toHaveLength(6)
    const raw = h.store.lines.map(line => JSON.parse(line) as Record<string, unknown>)
    expect(raw.map(line => line['endReason'])).toEqual([...SESSION_END_REASONS])
    expect(new Set(raw.map(line => line['sessionId'])).size).toBe(6)
    // Facts only, exactly the documented ten fields — no prose can sneak in.
    expect(Object.keys(raw[0]!).sort()).toEqual([
      'actualMin',
      'aftercare',
      'endReason',
      'endedAt',
      'maxCapUsed',
      'pack',
      'phaseReached',
      'plannedMin',
      'sessionId',
      'startedAt',
    ])

    const readBack = await h.ledger.read()
    expect(readBack).toHaveLength(6)
    expect(readBack.map(entry => entry.endReason)).toEqual([...SESSION_END_REASONS])
  })

  it('turns a stale open marker into unexpected_exit on the next start', async () => {
    const h = harness()
    await h.ledger.open('crashed', { pack: 'demo', plannedMin: 45 })
    h.clock.advance(18 * 60_000 + 32_000)
    const snapshotAt = h.clock.now()

    // A new process: a fresh instance sees only the persisted marker.
    const restarted = createLedger({
      clock: h.clock,
      store: h.store,
      documents: h.documents,
      snapshot: async () => ({ at: snapshotAt, phase: 'escalate' }),
    })
    const recovered = await restarted.recover()

    expect(recovered).toHaveLength(1)
    expect(recovered[0]).toMatchObject({
      sessionId: 'crashed',
      pack: 'demo',
      endReason: 'unexpected_exit',
      plannedMin: 45,
      actualMin: 18,
      phaseReached: 'escalate',
      aftercare: false,
      maxCapUsed: 0,
    })
    expect(Date.parse(recovered[0]!.endedAt)).toBe(snapshotAt)
    // The marker is cleared, so a second recovery writes nothing.
    expect(await restarted.recover()).toEqual([])
    expect(await restarted.read()).toHaveLength(1)
  })

  it('produces the same opening when the pack does not read the ledger', async () => {
    const entries = [entry({ endReason: 'left_early' })]
    const now = START + 60 * 60_000

    // Rules exist, entries exist — but without `history.read` the pack has no
    // access to them, so the opening is exactly the no-ledger opening.
    const noHistory = manifest({ metaReactions: REACTIONS })
    expect(matchMetaReactions(noHistory, entries, now)).toBeUndefined()
    const readOff = manifest({ history: { read: false }, metaReactions: REACTIONS })
    expect(matchMetaReactions(readOff, entries, now)).toBeUndefined()

    // The same entries do react once the pack opts in, which isolates the
    // opt-in rule from the matching rule.
    const reading = manifest({ history: { read: true }, metaReactions: REACTIONS })
    expect(matchMetaReactions(reading, entries, now)).toEqual({
      tone: 'cold',
      firstIntent: 'restrained-opening',
    })
  })

  it('matches the newest session inside the declared window and lastN', async () => {
    const now = START + 24 * 60 * 60_000
    const reading = manifest({
      history: { read: true, windowHours: 72, lastN: 2 },
      metaReactions: REACTIONS,
    })

    const fresh = [
      entry({ sessionId: 'old', endReason: 'left_early', endedAt: new Date(now - 100 * 3_600_000).toISOString() }),
      entry({ sessionId: 'recent', endReason: 'left_early', endedAt: new Date(now - 1 * 3_600_000).toISOString() }),
      entry({ sessionId: 'newest', endReason: 'unexpected_exit', endedAt: new Date(now - 60_000).toISOString() }),
    ]
    // Out-of-window entries are ignored; the newest of the window wins.
    expect(matchMetaReactions(reading, fresh, now)).toEqual({ tone: 'worried', firstIntent: 'soothe' })

    const lastOne = manifest({
      history: { read: true, windowHours: 72, lastN: 1 },
      metaReactions: REACTIONS,
    })
    expect(matchMetaReactions(lastOne, fresh, now)).toEqual({ tone: 'worried', firstIntent: 'soothe' })

    const onlyOlder = manifest({
      history: { read: true, windowHours: 72, lastN: 1 },
      metaReactions: [{ when: { endReason: ['left_early'] }, opening: { tone: 'cold' } }],
    })
    // `lastN: 1` keeps the newest entry (unexpected_exit), which this rule
    // does not match; the older left_early is outside the window.
    expect(matchMetaReactions(onlyOlder, fresh, now)).toBeUndefined()
  })

  it('clears the ledger without rewriting it and goes neutral again (E-5)', async () => {
    const h = harness()
    for (const sessionId of ['a', 'b']) {
      await h.ledger.open(sessionId, { pack: 'demo', plannedMin: 30 })
      await h.ledger.close(entry({ sessionId }))
    }
    expect(await h.ledger.read()).toHaveLength(2)
    const before = [...h.store.lines]

    await h.ledger.clear()

    expect(await h.ledger.read()).toEqual([])
    expect(h.store.lines).toEqual(before) // append-only: bytes untouched
    const reading = manifest({ history: { read: true }, metaReactions: REACTIONS })
    expect(matchMetaReactions(reading, await h.ledger.read(), START)).toBeUndefined()

    // New sessions still append and are readable after the cut.
    await h.ledger.open('c', { pack: 'demo', plannedMin: 30 })
    await h.ledger.close(entry({ sessionId: 'c' }))
    expect((await h.ledger.read()).map(line => line.sessionId)).toEqual(['c'])
  })

  it('never writes chat text, media paths or raw measurements into a line', async () => {
    const h = harness()
    await h.ledger.open('s-1', { pack: 'demo', plannedMin: 45 })
    // A caller cannot widen the line shape: extra properties are dropped.
    await h.ledger.close({
      ...entry(),
      transcript: '他说：别走。',
      rr: 1234,
      audioPath: 'C:/temp/turn.wav',
    } as LedgerEntry)

    const line = JSON.parse(h.store.lines[0]!) as Record<string, unknown>
    expect(Object.keys(line)).toHaveLength(10)
    expect(JSON.stringify(line)).not.toContain('别走')
    expect(JSON.stringify(line)).not.toContain('turn.wav')
    expect(line['rr']).toBeUndefined()
  })

  it('records a clean close once and leaves no marker behind', async () => {
    const h = harness()
    await h.ledger.open('s-1', { pack: 'demo', plannedMin: 45 })
    await h.ledger.close(entry())

    expect(await h.documents.read(OPEN_MARKER_KEY)).toBe('')
    expect(await h.ledger.recover()).toEqual([])
    expect(h.store.lines).toHaveLength(1)

    // A duplicated end must not append a second line for the same session.
    await h.ledger.close(entry())
    expect(h.store.lines).toHaveLength(1)
  })

  it('settles a stale marker before opening a different session', async () => {
    const h = harness()
    await h.ledger.open('previous', { pack: 'demo', plannedMin: 30 })
    h.clock.advance(5 * 60_000)
    await h.ledger.open('next', { pack: 'demo', plannedMin: 30 })

    const lines = await h.ledger.read()
    expect(lines.map(line => [line.sessionId, line.endReason])).toEqual([
      ['previous', 'unexpected_exit'],
    ])
  })
})
