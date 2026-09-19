import type { AttioAdapter, AttioPerson } from './attio'
import { MemoryAttioAdapter } from './attio'
import { createAttioAdapter, attioMode } from './attio-http'

export type LiveCompanyHit = {
  recordId: string
  name: string
  domain?: string
}

export type LivePersonHit = {
  recordId: string
  name: string
  email?: string
  linkedinUrl?: string
  companyKey?: string
}

/**
 * Bridge for live Attio reads. In cloud agents, MCP search can seed this adapter.
 * Workers with ATTIO_API_KEY use HttpAttioAdapter directly.
 */
export class SeededAttioAdapter extends MemoryAttioAdapter {
  constructor(seed?: { people?: AttioPerson[]; companies?: Array<{ attioId: string; name: string; domain?: string }> }) {
    super({
      people: seed?.people,
      companies: seed?.companies,
    })
  }
}

export function createBestAttioAdapter(seed?: {
  people?: AttioPerson[]
  companies?: Array<{ attioId: string; name: string; domain?: string }>
}): { adapter: AttioAdapter; mode: 'http' | 'memory' | 'seeded' } {
  if (attioMode() === 'http') return { adapter: createAttioAdapter(), mode: 'http' }
  if (seed?.people?.length || seed?.companies?.length) {
    return { adapter: new SeededAttioAdapter(seed), mode: 'seeded' }
  }
  return { adapter: createAttioAdapter(), mode: 'memory' }
}

/** Map Attio MCP / API company search hits into adapter seed records. */
export function companiesFromLiveHits(hits: LiveCompanyHit[]) {
  return hits.map((hit) => ({
    attioId: hit.recordId,
    name: hit.name,
    domain: hit.domain,
  }))
}

/** Map Attio MCP / API people search hits into adapter seed records. */
export function peopleFromLiveHits(hits: LivePersonHit[]) {
  return hits.map((hit) => ({
    attioId: hit.recordId,
    name: hit.name,
    email: hit.email,
    linkedinUrl: hit.linkedinUrl,
    companyKey: hit.companyKey,
  }))
}
