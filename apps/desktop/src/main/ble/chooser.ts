/**
 * Pure chooser policy for the Electron `select-bluetooth-device` handler.
 *
 * Two Coyote units advertise the **same name**, so "first candidate that
 * matches" connects both cards to whichever box answered first. This module
 * decides which advertised candidate a request should be answered with:
 *
 * 1. a card bound to a platform device id only ever gets that unit, and never
 *    silently substitutes another one;
 * 2. an unbound card skips units already connected to other cards, so adding a
 *    second unit picks the *other* box instead of double-driving the first;
 * 3. among the remaining candidates the name score decides (the OS often
 *    reports an empty `deviceName`, and a lone candidate is accepted anyway —
 *    the existing behaviour that keeps a scan with a blank name working).
 *
 * Kept free of Electron imports so it can be unit-tested in plain Node.
 */

import type { BleFilter } from '@embodied/core'

/** One advertisement reported by Electron's chooser. */
export interface BleCandidate {
  readonly deviceId: string
  readonly name: string
}

export type ChoiceKind = 'pinned' | 'auto'
export type ChoiceMiss = 'pinned-not-found' | 'pinned-already-connected' | 'pinned-reserved' | 'none-available'

export interface Choice {
  readonly kind: ChoiceKind | 'none'
  readonly deviceId?: string
  readonly reason?: ChoiceMiss
}

/** How well one advertisement matches the filter's name. */
export function scoreFor(filter: BleFilter, candidate: BleCandidate): number {
  if (filter.name !== undefined) return candidate.name === filter.name ? 3 : 0
  if (filter.namePrefix !== undefined) return candidate.name.startsWith(filter.namePrefix) ? 3 : 0
  // A service-only filter matches any advertisement the OS produced.
  return 1
}

/**
 * Decide which candidate a selection answers with.
 *
 * `connectedIds` are platform ids already controlled by another card in this
 * process. `filter.excludeDeviceIds` adds ids *persisted* on other cards (no
 * live link after a restart), so an unbound card cannot grab a paired box.
 * A pinned id that is already connected / reserved is a miss: driving the same
 * box from two cards is exactly the failure this policy prevents.
 */
export function chooseCandidate(
  filter: BleFilter,
  candidates: readonly BleCandidate[],
  connectedIds: ReadonlySet<string> = new Set(),
): Choice {
  const reserved = new Set<string>(connectedIds)
  for (const id of filter.excludeDeviceIds ?? []) reserved.add(id)

  const pinned = filter.deviceId
  if (pinned !== undefined) {
    const found = candidates.some(candidate => candidate.deviceId === pinned)
    if (!found) return { kind: 'none', reason: 'pinned-not-found' }
    if (connectedIds.has(pinned)) return { kind: 'none', reason: 'pinned-already-connected' }
    if (reserved.has(pinned)) return { kind: 'none', reason: 'pinned-reserved' }
    return { kind: 'pinned', deviceId: pinned }
  }

  const available = candidates.filter(candidate => !reserved.has(candidate.deviceId))
  let best: BleCandidate | undefined
  let bestScore = 0
  for (const candidate of available) {
    const score = scoreFor(filter, candidate)
    if (score > bestScore) {
      best = candidate
      bestScore = score
    }
  }
  if (best !== undefined) return { kind: 'auto', deviceId: best.deviceId }
  if (available.length === 1) {
    // The OS reported a blank or differently formatted name but only one unit
    // is free: it IS the target (the previous single-candidate fallback).
    return { kind: 'auto', deviceId: available[0]!.deviceId }
  }
  return { kind: 'none', reason: 'none-available' }
}
