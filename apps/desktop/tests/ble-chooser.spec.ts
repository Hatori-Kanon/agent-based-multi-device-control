import { describe, expect, it } from 'vitest'
import type { BleFilter } from '@embodied/core'
import { chooseCandidate, scoreFor, type BleCandidate } from '../src/main/ble/chooser.ts'

const SERVICE = '0000180c-0000-1000-8000-00805f9b34fb'

function filter(overrides: Partial<BleFilter> = {}): BleFilter {
  return { name: 'CoyoteV3', services: [SERVICE], ...overrides }
}

function candidate(deviceId: string, name = 'CoyoteV3'): BleCandidate {
  return { deviceId, name }
}

describe('BLE chooser policy (two same-named units)', () => {
  it('answers with the bound platform id even when another unit advertises first', () => {
    const choice = chooseCandidate(
      filter({ deviceId: 'unit-b' }),
      [candidate('unit-a'), candidate('unit-b')],
      new Set(),
    )
    expect(choice).toEqual({ kind: 'pinned', deviceId: 'unit-b' })
  })

  it('refuses to substitute another unit when the bound one is not advertising', () => {
    const choice = chooseCandidate(filter({ deviceId: 'unit-b' }), [candidate('unit-a')], new Set())
    expect(choice).toEqual({ kind: 'none', reason: 'pinned-not-found' })
  })

  it('refuses a bound unit that another card already controls', () => {
    const choice = chooseCandidate(
      filter({ deviceId: 'unit-a' }),
      [candidate('unit-a'), candidate('unit-b')],
      new Set(['unit-a']),
    )
    expect(choice).toEqual({ kind: 'none', reason: 'pinned-already-connected' })
  })

  it('picks the other unit on an unbound second card instead of double-driving the first', () => {
    // First card is connected to unit-a; the second card must get unit-b.
    const choice = chooseCandidate(filter(), [candidate('unit-a'), candidate('unit-b')], new Set(['unit-a']))
    expect(choice).toEqual({ kind: 'auto', deviceId: 'unit-b' })
  })

  it('skips units reserved by another card even when no link is live (after a restart)', () => {
    // No live connection yet, but unit-a is persisted on another card.
    const reserved = filter({ excludeDeviceIds: ['unit-a'] })
    const choice = chooseCandidate(reserved, [candidate('unit-a'), candidate('unit-b')], new Set())
    expect(choice).toEqual({ kind: 'auto', deviceId: 'unit-b' })
  })

  it('refuses a pinned unit that is reserved by another card', () => {
    const choice = chooseCandidate(
      filter({ deviceId: 'unit-a', excludeDeviceIds: ['unit-a'] }),
      [candidate('unit-a'), candidate('unit-b')],
      new Set(),
    )
    expect(choice).toEqual({ kind: 'none', reason: 'pinned-reserved' })
  })

  it('refuses a pinned unit missing from the scan even when another card is live', () => {
    const choice = chooseCandidate(filter({ deviceId: 'unit-b' }), [candidate('unit-a')], new Set(['unit-a']))
    expect(choice).toEqual({ kind: 'none', reason: 'pinned-not-found' })
  })

  it('lets a pin win even when its advertised name does not match the filter', () => {
    const choice = chooseCandidate(filter({ deviceId: 'unit-b' }), [candidate('unit-b', 'Renamed')], new Set())
    expect(choice).toEqual({ kind: 'pinned', deviceId: 'unit-b' })
  })

  it('does not fall back to a connected single candidate', () => {
    const choice = chooseCandidate(filter(), [candidate('unit-a', 'Other')], new Set(['unit-a']))
    expect(choice).toEqual({ kind: 'none', reason: 'none-available' })
  })

  it('keeps insertion order for tied unbound candidates', () => {
    const choice = chooseCandidate(filter(), [candidate('unit-b'), candidate('unit-a')], new Set())
    expect(choice).toEqual({ kind: 'auto', deviceId: 'unit-b' })
  })

  it('accepts a lone candidate whose OS name is blank or formatted differently', () => {
    const choice = chooseCandidate(filter(), [candidate('unit-a', '')], new Set())
    expect(choice).toEqual({ kind: 'auto', deviceId: 'unit-a' })
  })

  it('does not guess when several candidates mismatch and none is bound', () => {
    const choice = chooseCandidate(filter(), [candidate('unit-a', 'Other'), candidate('unit-b', '')], new Set())
    expect(choice).toEqual({ kind: 'none', reason: 'none-available' })
  })

  it('fails cleanly when nothing advertised', () => {
    expect(chooseCandidate(filter(), [], new Set())).toEqual({ kind: 'none', reason: 'none-available' })
  })

  it('scores name / prefix / service-only filters', () => {
    expect(scoreFor(filter({ name: 'CoyoteV3' }), candidate('a', 'CoyoteV3'))).toBe(3)
    expect(scoreFor(filter({ name: 'CoyoteV3' }), candidate('a', 'Other'))).toBe(0)
    expect(scoreFor(filter({ namePrefix: 'Coyote' }), candidate('a', 'CoyoteV3'))).toBe(3)
    expect(scoreFor(filter({ namePrefix: 'Coyote' }), candidate('a', 'Nope'))).toBe(0)
    expect(scoreFor({ services: [SERVICE] }, candidate('a', ''))).toBe(1)
  })
})
