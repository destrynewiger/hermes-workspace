/**
 * Live Attio helpers for Fleet OS.
 * Prefer HttpAttioAdapter when ATTIO_API_KEY is present.
 * Otherwise seed from the durable MCP-refreshed snapshot (data/attio-live-snapshot.json)
 * so reconcile still binds to production Attio record IDs.
 */

import { reconcileTargets, type AttioAdapter, type ReconcileResult, type ReconcileTarget } from './attio'
import {
  companiesFromLiveHits,
  createBestAttioAdapter,
  peopleFromLiveHits,
  type LiveCompanyHit,
  type LivePersonHit,
} from './attio-bridge'
import { loadAttioLiveSnapshot } from './attio-cache'
import { loadAttioLiveProof } from './attio-remote'

/** Known Byteport workspace anchors verified via Attio MCP (read-only). */
export const BYTEPORT_LIVE_COMPANY: LiveCompanyHit = {
  recordId: '8fc484a3-8e27-4d9e-9223-ecfa3114a002',
  name: 'Byteport',
  domain: 'byteport.com',
}

/** Alex Newiger person record in Byteport Attio (verified via MCP search). */
export const BYTEPORT_LIVE_ALEX: LivePersonHit = {
  recordId: '6a89dc7a-81be-4f9b-bed2-724564ee3e97',
  name: 'Alex Newiger',
  email: 'alex@byteport.com',
  companyKey: 'company:byteport',
}

export type LiveAttioSeed = {
  people?: LivePersonHit[]
  companies?: LiveCompanyHit[]
}

export function createLiveAttioAdapter(seed?: LiveAttioSeed): {
  adapter: AttioAdapter
  mode: 'http' | 'memory' | 'seeded' | 'live-seeded'
  snapshotPath?: string
} {
  const snapshot = loadAttioLiveSnapshot()
  const proof = loadAttioLiveProof()
  const companies = seed?.companies?.length
    ? seed.companies
    : proof?.companies?.length
      ? proof.companies
      : snapshot?.companies?.length
        ? snapshot.companies
        : [BYTEPORT_LIVE_COMPANY]
  const people = seed?.people?.length
    ? seed.people
    : proof?.people?.length
      ? proof.people
      : snapshot?.people?.length
        ? snapshot.people
        : [BYTEPORT_LIVE_ALEX]
  const { adapter, mode } = createBestAttioAdapter({
    people: peopleFromLiveHits(people),
    companies: companiesFromLiveHits(companies),
  })
  return {
    adapter,
    mode: mode === 'seeded' || mode === 'memory' ? 'live-seeded' : mode,
    snapshotPath: snapshot || proof ? 'data/attio-live-snapshot.json' : undefined,
  }
}

/** Reconcile targets against live-seeded or HTTP Attio without inventing IDs. */
export async function reconcileAgainstLiveAttio(
  targets: ReconcileTarget[],
  seed?: LiveAttioSeed,
): Promise<ReconcileResult & { mode: string }> {
  const { adapter, mode } = createLiveAttioAdapter(seed)
  const result = await reconcileTargets(adapter, targets)
  return { ...result, mode }
}
