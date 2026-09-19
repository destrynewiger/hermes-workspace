/**
 * Identity map derived from the live Attio snapshot + Fleet OS identity registry.
 * Keeps sender routing aligned with real CRM people without inventing ids.
 */

import { loadAttioLiveSnapshot } from './attio-cache'
import type { IdentityRecord } from './types'
import { BYTEPORT_LIVE_ALEX } from './attio-live'
import { mergeIdentityRegistry } from './harness-identities'

export type TeammateIdentityLink = {
  teammate: string
  email?: string
  attioId?: string
  fleetIdentityId?: string
  principal: string
  roles: string[]
}

const FLEET_IDENTITY_SEEDS: IdentityRecord[] = mergeIdentityRegistry([
  { id: 'alex-byteport', teammate: 'alex', principal: 'byteport', channel: 'linkedin', machineId: 'sf-mini', sessionHost: 'alex-browser', sessionStatus: 'unknown', autonomyLevel: 2, sendMode: 'staged' },
  { id: 'alex-gmail', teammate: 'alex', principal: 'byteport', channel: 'gmail', machineId: 'oakland-mini', sessionHost: 'hermes-oakland', sessionStatus: 'alive', autonomyLevel: 2, sendMode: 'draft_only' },
  { id: 'alex-calendar', teammate: 'alex', principal: 'byteport', channel: 'calendar', machineId: 'oakland-mini', sessionHost: 'hermes-oakland', sessionStatus: 'alive', autonomyLevel: 2, sendMode: 'draft_only' },
  { id: 'katherine-byteport', teammate: 'katherine', principal: 'byteport', channel: 'linkedin', machineId: 'sf-mini', sessionHost: 'hermes', sessionStatus: 'alive', autonomyLevel: 2, sendMode: 'draft_only' },
  { id: 'john-gradient', teammate: 'john', principal: 'gradient', channel: 'linkedin', machineId: 'oakland-mini', sessionHost: 'hermes-oakland-john', sessionStatus: 'unknown', autonomyLevel: 3, sendMode: 'live' },
])

/** Map Attio people + fleet identities into a routing table. */
export function buildIdentityMap(identities: IdentityRecord[] = FLEET_IDENTITY_SEEDS): TeammateIdentityLink[] {
  const snapshot = loadAttioLiveSnapshot()
  const people = snapshot?.people ?? [BYTEPORT_LIVE_ALEX]
  const links: TeammateIdentityLink[] = []

  for (const person of people) {
    const email = person.email?.toLowerCase()
    const local = email?.split('@')[0]
    const fleet = identities.find((item) =>
      item.teammate === local
      || (local === 'alex' && item.id === 'alex-byteport')
      || (local === 'jayram' && item.teammate === 'jayram'),
    )
    links.push({
      teammate: local ?? person.name.split(' ')[0]?.toLowerCase() ?? person.recordId,
      email: person.email,
      attioId: person.recordId,
      fleetIdentityId: fleet?.id,
      principal: fleet?.principal ?? 'byteport',
      roles: person.name.toLowerCase().includes('founder') ? ['founder'] : ['teammate'],
    })
  }

  for (const identity of identities) {
    if (links.some((link) => link.fleetIdentityId === identity.id)) continue
    links.push({
      teammate: identity.teammate,
      fleetIdentityId: identity.id,
      principal: identity.principal,
      roles: identity.channel === 'linkedin' ? ['sender'] : ['worker'],
    })
  }

  return links
}

export function resolveSenderForPrincipal(principal: string, channel = 'linkedin'): TeammateIdentityLink | null {
  const identities = FLEET_IDENTITY_SEEDS.filter((item) => item.principal === principal && item.channel === channel)
  const links = buildIdentityMap(identities.length ? identities : FLEET_IDENTITY_SEEDS)
  return links.find((link) => link.principal === principal && link.fleetIdentityId) ?? null
}
