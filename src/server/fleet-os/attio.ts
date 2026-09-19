import type { EntityRecord, FleetSnapshot } from './types'

export type AttioPerson = {
  attioId: string
  email?: string
  linkedinUrl?: string
  name: string
  companyKey?: string
}

export type AttioCompany = {
  attioId: string
  name: string
  domain?: string
}

export type AttioAdapter = {
  findPerson(query: { email?: string; linkedinUrl?: string; name?: string }): Promise<AttioPerson | null>
  findCompany(query: { domain?: string; name?: string }): Promise<AttioCompany | null>
  upsertPerson(person: Omit<AttioPerson, 'attioId'> & { attioId?: string }): Promise<AttioPerson>
  listPeople(limit?: number): Promise<AttioPerson[]>
}

/** File/memory Attio stand-in so reconcile works without live credentials. Replace with real Attio API later. */
export class MemoryAttioAdapter implements AttioAdapter {
  private people: AttioPerson[]
  private companies: AttioCompany[]
  private seq = 1

  constructor(seed?: { people?: AttioPerson[]; companies?: AttioCompany[] }) {
    this.people = [...(seed?.people ?? [])]
    this.companies = [...(seed?.companies ?? [])]
  }

  async findPerson(query: { email?: string; linkedinUrl?: string; name?: string }): Promise<AttioPerson | null> {
    return this.people.find((person) =>
      (query.email && person.email?.toLowerCase() === query.email.toLowerCase())
      || (query.linkedinUrl && person.linkedinUrl === query.linkedinUrl)
      || (query.name && person.name.toLowerCase() === query.name.toLowerCase()),
    ) ?? null
  }

  async findCompany(query: { domain?: string; name?: string }): Promise<AttioCompany | null> {
    return this.companies.find((company) =>
      (query.domain && company.domain?.toLowerCase() === query.domain.toLowerCase())
      || (query.name && company.name.toLowerCase() === query.name.toLowerCase()),
    ) ?? null
  }

  async upsertPerson(person: Omit<AttioPerson, 'attioId'> & { attioId?: string }): Promise<AttioPerson> {
    const existing = await this.findPerson({
      email: person.email,
      linkedinUrl: person.linkedinUrl,
      name: person.name,
    })
    if (existing) {
      Object.assign(existing, person)
      return existing
    }
    const created: AttioPerson = {
      ...person,
      attioId: person.attioId ?? `attio_person_${this.seq++}`,
    }
    this.people.push(created)
    return created
  }

  async listPeople(limit = 100): Promise<AttioPerson[]> {
    return this.people.slice(0, limit)
  }
}

export type ReconcileTarget = {
  key: string
  name: string
  email?: string
  linkedinUrl?: string
  company?: string
}

export type ReconcileResult = {
  crm: 'attio'
  newTargets: number
  existing: number
  entities: EntityRecord[]
  attioIds: string[]
  verified: boolean
  unmatched: ReconcileTarget[]
}

export async function reconcileTargets(
  adapter: AttioAdapter,
  targets: ReconcileTarget[],
  snapshotEntities: EntityRecord[] = [],
  options?: { createMissing?: boolean },
): Promise<ReconcileResult> {
  const entities: EntityRecord[] = []
  const attioIds: string[] = []
  const unmatched: ReconcileTarget[] = []
  let existing = 0
  let newTargets = 0
  // Never invent synthetic Attio IDs unless writes are explicitly allowed.
  const createMissing = options?.createMissing ?? (process.env.ATTIO_ALLOW_WRITES === '1')

  for (const target of targets) {
    const prior = snapshotEntities.find((entity) => entity.key === target.key)
    const found = await adapter.findPerson({
      email: target.email,
      linkedinUrl: target.linkedinUrl,
      name: target.name,
    })
    if (found || prior?.attioId) {
      existing += 1
      const attioId = found?.attioId ?? prior!.attioId!
      attioIds.push(attioId)
      entities.push({
        key: target.key,
        kind: 'person',
        attioId,
        displayName: target.name,
        aliases: [target.email, target.linkedinUrl].filter(Boolean) as string[],
      })
      continue
    }
    if (!createMissing) {
      unmatched.push(target)
      continue
    }
    const created = await adapter.upsertPerson({
      name: target.name,
      email: target.email,
      linkedinUrl: target.linkedinUrl,
      companyKey: target.company,
    })
    newTargets += 1
    attioIds.push(created.attioId)
    entities.push({
      key: target.key,
      kind: 'person',
      attioId: created.attioId,
      displayName: target.name,
      aliases: [target.email, target.linkedinUrl].filter(Boolean) as string[],
    })
  }

  return {
    crm: 'attio',
    newTargets,
    existing,
    entities,
    attioIds,
    unmatched,
    verified: unmatched.length === 0 && attioIds.length === targets.length && targets.length > 0,
  }
}

export function mergeEntities(snapshot: FleetSnapshot, entities: EntityRecord[]): void {
  for (const entity of entities) {
    const existing = snapshot.entities.find((item) => item.key === entity.key)
    if (existing) {
      existing.attioId = entity.attioId
      existing.displayName = entity.displayName
      existing.aliases = [...new Set([...existing.aliases, ...entity.aliases])]
    } else {
      snapshot.entities.push(entity)
    }
  }
}
