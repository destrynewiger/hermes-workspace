import type { AttioAdapter, AttioCompany, AttioPerson } from './attio'
import { MemoryAttioAdapter } from './attio'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const ATTIO_BASE = process.env.ATTIO_API_BASE ?? 'https://api.attio.com/v2'

type AttioJson = Record<string, unknown>

function readEnvFileValue(filePath: string, key: string): string | null {
  if (!existsSync(filePath)) return null
  try {
    const text = readFileSync(filePath, 'utf8')
    const match = text.match(new RegExp(`^${key}=(.+)$`, 'm'))
    if (!match) return null
    return match[1].trim().replace(/^['"]|['"]$/g, '')
  } catch {
    return null
  }
}

/** Resolve Attio API key from env or common fleet/hermes secret files. */
export function resolveAttioApiKey(): string | null {
  const fromEnv = (process.env.ATTIO_API_KEY ?? process.env.FLEET_ATTIO_API_KEY)?.trim()
  if (fromEnv) return fromEnv
  const home = process.env.HOME ?? os.homedir()
  const candidates = [
    process.env.FLEET_ATTIO_ENV_FILE,
    process.env.FLEET_OS_HOME ? path.join(process.env.FLEET_OS_HOME, '.env') : null,
    path.join(home, '.hermes', '.env'),
    path.join(home, '.hermes', 'fleet-os', '.env'),
    path.join(home, 'Library', 'Application Support', 'hermes', '.env'),
    path.join(process.cwd(), '.env'),
  ].filter((item): item is string => Boolean(item))
  for (const file of candidates) {
    const value = readEnvFileValue(file, 'ATTIO_API_KEY') ?? readEnvFileValue(file, 'FLEET_ATTIO_API_KEY')
    if (value) return value
  }
  return null
}

function bearer(): string | null {
  return resolveAttioApiKey()
}

async function attioFetch(path: string, init?: RequestInit): Promise<AttioJson> {
  const token = bearer()
  if (!token) throw new Error('ATTIO_API_KEY is not configured')
  const response = await fetch(`${ATTIO_BASE}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      ...(init?.headers ?? {}),
    },
  })
  if (!response.ok) {
    throw new Error(`Attio HTTP ${response.status}: ${await response.text()}`)
  }
  return response.json() as Promise<AttioJson>
}

function personFromRecord(record: AttioJson): AttioPerson | null {
  const id = (record.id as { record_id?: string } | undefined)?.record_id
    ?? (typeof record.record_id === 'string' ? record.record_id : null)
  if (!id) return null
  const values = (record.values ?? {}) as Record<string, Array<{ value?: string; email_address?: string }>>
  const name = values.name?.[0]?.value
    ?? values.full_name?.[0]?.value
    ?? 'Unknown'
  const email = values.email_addresses?.[0]?.email_address ?? values.email_addresses?.[0]?.value
  const linkedinUrl = values.linkedin?.[0]?.value ?? values.linkedin_url?.[0]?.value
  return { attioId: id, name, email, linkedinUrl }
}

/** Live Attio REST adapter. Read/search first; writes only when explicitly upserting. */
export class HttpAttioAdapter implements AttioAdapter {
  async findPerson(query: { email?: string; linkedinUrl?: string; name?: string }): Promise<AttioPerson | null> {
    const q = query.email ?? query.linkedinUrl ?? query.name
    if (!q) return null
    const body = await attioFetch('/objects/people/records/query', {
      method: 'POST',
      body: JSON.stringify({ limit: 5, filter: query.email
        ? { email_addresses: { email_address: { $eq: query.email } } }
        : undefined }),
    }).catch(async () => attioFetch(`/objects/people/records?limit=5`))
    const data = Array.isArray(body.data) ? body.data as AttioJson[] : []
    for (const record of data) {
      const person = personFromRecord(record)
      if (!person) continue
      if (query.email && person.email?.toLowerCase() === query.email.toLowerCase()) return person
      if (query.linkedinUrl && person.linkedinUrl === query.linkedinUrl) return person
      if (query.name && person.name.toLowerCase() === query.name.toLowerCase()) return person
    }
    if (query.name) {
      const search = await attioFetch('/objects/people/records/search', {
        method: 'POST',
        body: JSON.stringify({ query: query.name, limit: 5 }),
      }).catch(() => ({ data: [] }))
      const hits = Array.isArray(search.data) ? search.data as AttioJson[] : []
      for (const record of hits) {
        const person = personFromRecord(record)
        if (person && person.name.toLowerCase() === query.name.toLowerCase()) return person
      }
    }
    return null
  }

  async findCompany(query: { domain?: string; name?: string }): Promise<AttioCompany | null> {
    const q = query.domain ?? query.name
    if (!q) return null
    const body = await attioFetch('/objects/companies/records/query', {
      method: 'POST',
      body: JSON.stringify({ limit: 5 }),
    }).catch(async () => attioFetch('/objects/companies/records?limit=5'))
    const data = Array.isArray(body.data) ? body.data as AttioJson[] : []
    for (const record of data) {
      const id = (record.id as { record_id?: string } | undefined)?.record_id
      if (!id) continue
      const values = (record.values ?? {}) as Record<string, Array<{ value?: string; domain?: string }>>
      const name = values.name?.[0]?.value ?? 'Unknown'
      const domain = values.domains?.[0]?.domain ?? values.domains?.[0]?.value
      if (query.domain && domain?.toLowerCase() === query.domain.toLowerCase()) {
        return { attioId: id, name, domain }
      }
      if (query.name && name.toLowerCase() === query.name.toLowerCase()) {
        return { attioId: id, name, domain }
      }
    }
    return null
  }

  async upsertPerson(person: Omit<AttioPerson, 'attioId'> & { attioId?: string }): Promise<AttioPerson> {
    const existing = await this.findPerson({
      email: person.email,
      linkedinUrl: person.linkedinUrl,
      name: person.name,
    })
    if (existing) return existing
    if (process.env.ATTIO_ALLOW_WRITES !== '1') {
      throw new Error('Attio writes disabled. Set ATTIO_ALLOW_WRITES=1 to create people from Fleet OS.')
    }
    const body = await attioFetch('/objects/people/records', {
      method: 'POST',
      body: JSON.stringify({
        data: {
          values: {
            name: [{ value: person.name }],
            ...(person.email ? { email_addresses: [{ email_address: person.email }] } : {}),
          },
        },
      }),
    })
    const record = (body.data ?? body) as AttioJson
    return personFromRecord(record) ?? {
      attioId: String((record.id as { record_id?: string })?.record_id ?? 'unknown'),
      name: person.name,
      email: person.email,
      linkedinUrl: person.linkedinUrl,
    }
  }

  async listPeople(limit = 100): Promise<AttioPerson[]> {
    const body = await attioFetch(`/objects/people/records?limit=${Math.min(limit, 100)}`)
    const data = Array.isArray(body.data) ? body.data as AttioJson[] : []
    return data.map(personFromRecord).filter((person): person is AttioPerson => Boolean(person))
  }
}

export function createAttioAdapter(): AttioAdapter {
  if (bearer()) return new HttpAttioAdapter()
  return new MemoryAttioAdapter()
}

export function attioMode(): 'http' | 'memory' {
  return bearer() ? 'http' : 'memory'
}
