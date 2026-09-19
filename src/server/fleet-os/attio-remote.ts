/**
 * Remote Attio adapter for production SoT when ATTIO_API_KEY is absent.
 * Cloud agents prove live records via Composio/MCP and persist a proof file;
 * workers fall back to the durable snapshot until the HTTP key is installed.
 */

import { writeFileSync, existsSync, readFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AttioAdapter, AttioCompany, AttioPerson } from './attio'
import { SeededAttioAdapter } from './attio-bridge'
import { peopleFromLiveHits, companiesFromLiveHits, type LiveCompanyHit, type LivePersonHit } from './attio-bridge'
import { upsertAttioLiveSnapshot } from './attio-cache'

export type AttioLiveProof = {
  verifiedAt: string
  source: 'composio' | 'attio-mcp' | 'attio-http'
  workspace: string
  people: LivePersonHit[]
  companies: LiveCompanyHit[]
}

function packageDataDir(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), 'data')
}

export function defaultAttioProofPath(): string {
  return process.env.FLEET_ATTIO_PROOF
    ?? path.join(packageDataDir(), 'attio-composio-proof.json')
}

export function loadAttioLiveProof(filePath = defaultAttioProofPath()): AttioLiveProof | null {
  if (!existsSync(filePath)) return null
  try {
    const raw = JSON.parse(readFileSync(filePath, 'utf8')) as AttioLiveProof
    if (!Array.isArray(raw.people) || !Array.isArray(raw.companies)) return null
    return raw
  } catch {
    return null
  }
}

export function saveAttioLiveProof(proof: AttioLiveProof, filePath = defaultAttioProofPath()): void {
  mkdirSync(path.dirname(filePath), { recursive: true })
  writeFileSync(filePath, JSON.stringify(proof, null, 2) + '\n', 'utf8')
  upsertAttioLiveSnapshot({
    people: proof.people,
    companies: proof.companies,
    source: proof.source,
    workspace: proof.workspace,
  })
}

export function attioProofIsFresh(
  proof: AttioLiveProof | null,
  maxAgeMs = 7 * 24 * 60 * 60 * 1000,
  at = Date.now(),
  /** Tolerate client clocks slightly ahead of the server when posting proofs. */
  skewMs = 5 * 60 * 1000,
): boolean {
  if (!proof) return false
  const age = at - Date.parse(proof.verifiedAt)
  return Number.isFinite(age) && age >= -skewMs && age <= maxAgeMs && proof.people.length > 0
}

/** Injectable remote finder used by agents with Composio/MCP access. */
export type AttioRemoteFinder = {
  findPerson(query: { email?: string; linkedinUrl?: string; name?: string }): Promise<AttioPerson | null>
  findCompany(query: { domain?: string; name?: string }): Promise<AttioCompany | null>
}

/**
 * Adapter that prefers a live remote finder, then falls back to seeded proof/snapshot.
 * Writes stay gated the same way as HttpAttioAdapter (ATTIO_ALLOW_WRITES).
 */
export class RemoteAttioAdapter implements AttioAdapter {
  private readonly fallback: AttioAdapter

  constructor(
    private readonly remote: AttioRemoteFinder | null,
    seed?: { people?: AttioPerson[]; companies?: AttioCompany[] },
  ) {
    this.fallback = new SeededAttioAdapter(seed)
  }

  async findPerson(query: { email?: string; linkedinUrl?: string; name?: string }): Promise<AttioPerson | null> {
    if (this.remote) {
      const hit = await this.remote.findPerson(query)
      if (hit) return hit
    }
    return this.fallback.findPerson(query)
  }

  async findCompany(query: { domain?: string; name?: string }): Promise<AttioCompany | null> {
    if (this.remote) {
      const hit = await this.remote.findCompany(query)
      if (hit) return hit
    }
    return this.fallback.findCompany(query)
  }

  async upsertPerson(person: Omit<AttioPerson, 'attioId'> & { attioId?: string }): Promise<AttioPerson> {
    if (process.env.ATTIO_ALLOW_WRITES !== '1') {
      const existing = await this.findPerson({
        email: person.email,
        linkedinUrl: person.linkedinUrl,
        name: person.name,
      })
      if (existing) return existing
      throw new Error('Attio writes disabled. Set ATTIO_ALLOW_WRITES=1 to create people from Fleet OS.')
    }
    return this.fallback.upsertPerson(person)
  }

  async listPeople(limit = 100): Promise<AttioPerson[]> {
    return this.fallback.listPeople(limit)
  }
}

export function createRemoteAttioAdapter(options?: {
  remote?: AttioRemoteFinder | null
  proof?: AttioLiveProof | null
}): { adapter: AttioAdapter; mode: 'remote' | 'proof-seeded' | 'empty' } {
  const proof = options?.proof ?? loadAttioLiveProof()
  const people = peopleFromLiveHits(proof?.people ?? [])
  const companies = companiesFromLiveHits(proof?.companies ?? [])
  const hasSeed = people.length > 0 || companies.length > 0
  const remote = options?.remote ?? null
  if (remote || hasSeed) {
    return {
      adapter: new RemoteAttioAdapter(remote, { people, companies }),
      mode: remote ? 'remote' : 'proof-seeded',
    }
  }
  return { adapter: new RemoteAttioAdapter(null), mode: 'empty' }
}

/** Parse Composio ATTIO_FIND_RECORD people/company payloads into live hits. */
export function liveHitsFromComposioFind(results: Array<{
  object?: string
  record_id?: string
  id?: { record_id?: string }
  values?: Record<string, Array<Record<string, unknown>>>
}>): { people: LivePersonHit[]; companies: LiveCompanyHit[] } {
  const people: LivePersonHit[] = []
  const companies: LiveCompanyHit[] = []
  for (const row of results) {
    const recordId = row.id?.record_id ?? row.record_id
    if (!recordId) continue
    const values = row.values ?? {}
    const emails = values.email_addresses ?? []
    const domains = values.domains ?? []
    const names = values.name ?? []
    if (emails.length || names.some((n) => 'full_name' in n || 'first_name' in n)) {
      const email = emails.map((e) => String(e.email_address ?? e.value ?? '')).find(Boolean)
      const name = names.map((n) => String(n.full_name ?? n.value ?? '')).find(Boolean) ?? email ?? recordId
      people.push({
        recordId,
        name,
        email,
        companyKey: 'company:byteport',
      })
      continue
    }
    if (domains.length || names.some((n) => typeof n.value === 'string')) {
      const domain = domains.map((d) => String(d.domain ?? d.value ?? '')).find(Boolean)
      const name = names.map((n) => String(n.value ?? n.full_name ?? '')).find(Boolean) ?? domain ?? recordId
      companies.push({ recordId, name, domain })
    }
  }
  return { people, companies }
}
