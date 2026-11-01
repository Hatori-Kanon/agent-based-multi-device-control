/**
 * B2-T7 — session archive tests.
 *
 * The three acceptance `it` names from `M2-实施计划.md` §3.4 are kept verbatim.
 * Every assertion drives the real {@link SessionStore} over the in-memory
 * `DocumentStore` port; no host file system and no clock are mocked by hand.
 */

import { describe, expect, it } from 'vitest'
import { FakeClock } from '../src/ports/fake-clock.ts'
import { MemoryDocumentStore } from '../src/ports/storage.ts'
import {
  MAX_STATE_PATCH_BYTES,
  SessionStore,
  StateStoreError,
  type SessionState,
} from '../src/state/store.ts'

const STARTED_AT = Date.parse('2026-11-01T12:00:00.000Z')

interface Harness {
  readonly clock: FakeClock
  readonly documents: MemoryDocumentStore
  readonly store: SessionStore
}

function harness(): Harness {
  const clock = new FakeClock(STARTED_AT)
  const documents = new MemoryDocumentStore()
  return { clock, documents, store: new SessionStore({ documents, clock }) }
}

async function open(h: Harness, sessionId = 's-1', phase = 'scene'): Promise<SessionState> {
  return await h.store.open({ sessionId, packId: 'demo', phase })
}

describe('session store', () => {
  it('applies a merge patch and reports rejected paths', async () => {
    const h = harness()
    const opened = await open(h)
    await h.store.save({
      ...opened,
      scene: { room: '书房', mood: { light: 'warm' } },
      flags: { introduced: false },
    })

    const result = await h.store.patch('s-1', {
      scene: { mood: { light: 'dim' }, dust: null },
      flags: { introduced: true },
      learned: ['名字', '怕黑'],
      // Not writable: engine-owned and unknown keys are refused, not applied.
      turn: 99,
      currentPhase: 'climax',
      secret: 'nope',
      player: { name: '阿岚' },
    })

    // RFC 7386: objects merge, `null` deletes, arrays replace as a whole.
    expect(result.applied).toEqual(['scene', 'flags', 'learned', 'player'])
    expect(result.state.scene).toEqual({ room: '书房', mood: { light: 'dim' } })
    expect(result.state.flags).toEqual({ introduced: true })
    expect(result.state.learned).toEqual(['名字', '怕黑'])
    expect(result.state.player).toEqual({ name: '阿岚' })
    // The session identity is untouched by a refused patch.
    expect(result.state.currentPhase).toBe('scene')
    expect(result.state.turn).toBe(0)
    expect(result.state.sessionId).toBe('s-1')

    expect(result.rejected.map(entry => entry.path)).toEqual(['turn', 'currentPhase', 'secret'])
    expect(result.rejected.find(entry => entry.path === 'secret')?.reason).toContain('whitelist')

    const reloaded = await h.store.load('s-1')
    expect(reloaded).toEqual(result.state)
  })

  it('refuses a patch that tries to change the current phase', async () => {
    const h = harness()
    const opened = await open(h)
    await h.store.save({ ...opened, scene: { room: '书房' } })

    const result = await h.store.patch('s-1', {
      currentPhase: 'climax',
      scene: { room: '走廊' },
    })

    // The legal key still lands; the phase never does. Advancing the phase is
    // the phase machine's job, so a model cannot self-declare an ending.
    expect(result.state.currentPhase).toBe('scene')
    expect(result.state.scene).toEqual({ room: '走廊' })
    expect(result.rejected).toEqual([
      {
        path: 'currentPhase',
        reason: 'currentPhase is engine-owned and may only be advanced by the phase machine',
      },
    ])
    expect((await h.store.load('s-1'))?.currentPhase).toBe('scene')
  })

  it('recovers the last snapshot and marks it recovered', async () => {
    const h = harness()
    const first = await open(h, 'crashed')
    await h.store.save({
      ...first,
      turn: 4,
      elapsedMin: 18,
      lastLine: '他停在门口。',
      recentBeats: ['escalate-step', 'probe-touch'],
      status: 'active',
    })

    // Recovery reads the last snapshot and relabels it; it does not replay the
    // unfinished turn (there is no turn log and the counter stays at 4).
    const recovered = await h.store.recover()
    expect(recovered?.sessionId).toBe('crashed')
    expect(recovered?.status).toBe('recovered')
    expect(recovered?.turn).toBe(4)
    expect(recovered?.recentBeats).toEqual(['escalate-step', 'probe-touch'])
    expect((await h.store.load('crashed'))?.status).toBe('recovered')

    // Opening the next session performs the same crash check, so a host cannot
    // forget it. The new snapshot starts at turn 0 while the old one survives.
    const fresh = await h.store.open({ sessionId: 'next', packId: 'demo', phase: 'scene' })
    expect(fresh.turn).toBe(0)
    expect(fresh.status).toBe('active')
    expect(fresh.recentBeats).toEqual([])
    expect((await h.store.load('crashed'))?.status).toBe('recovered')
    expect((await h.store.load('next'))?.status).toBe('active')
  })

  it('leaves a cleanly ended snapshot ended instead of recovered', async () => {
    const h = harness()
    const opened = await open(h, 'done')
    await h.store.save({ ...opened, turn: 3, status: 'ended' })

    expect((await h.store.recover())?.status).toBe('ended')
    expect((await h.store.load('done'))?.status).toBe('ended')
  })

  it('refuses deep, oversized and prototype-polluting patch values', async () => {
    const h = harness()
    await open(h)

    const deep = await h.store.patch('s-1', { scene: { a: { b: { c: { d: 1 } } } } })
    expect(deep.applied).toEqual([])
    expect(deep.rejected[0]).toMatchObject({ path: 'scene.a.b.c.d' })
    expect(deep.rejected[0]?.reason).toContain('depth limit')

    const oversized = await h.store.patch('s-1', {
      scene: { blob: 'x'.repeat(MAX_STATE_PATCH_BYTES) },
    })
    expect(oversized.applied).toEqual([])
    expect(oversized.rejected).toEqual([{
      path: '',
      reason: `patch exceeds the ${MAX_STATE_PATCH_BYTES}-byte limit`,
    }])

    const polluted = await h.store.patch('s-1', {
      flags: JSON.parse('{"__proto__":{"polluted":true}}') as Record<string, unknown>,
    })
    expect(polluted.applied).toEqual([])
    expect(polluted.rejected[0]).toMatchObject({ path: 'flags.__proto__' })
    expect((await h.store.load('s-1'))?.flags).toEqual({})
  })

  it('reports a typed failure when patching a session that was never saved', async () => {
    const h = harness()
    await expect(h.store.patch('missing', { flags: { a: 1 } })).rejects.toBeInstanceOf(StateStoreError)
    await expect(h.store.patch('missing', { flags: { a: 1 } })).rejects.toMatchObject({ code: 'NO_STATE' })
  })

  it('blanks the archive on clear without touching any other document', async () => {
    const h = harness()
    await open(h, 'a')
    await h.store.open({ sessionId: 'b', packId: 'demo', phase: 'scene' })
    expect(await h.store.load('a')).toBeDefined()

    await h.store.clear()

    expect(await h.store.load('a')).toBeUndefined()
    expect(await h.store.load('b')).toBeUndefined()
    expect(await h.store.recover()).toBeUndefined()
  })
})
