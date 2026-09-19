/**
 * Normalize Amplemarket / Apollo / inbox activity into Fleet OS signal events.
 */

export type ExternalSignalHit = {
  source: 'amplemarket' | 'apollo' | 'inbox' | 'research' | 'sumble' | 'linkedin' | 'x' | 'common-room'
  company?: string
  person?: string
  email?: string
  detail: string
  strength?: number
  url?: string
}

export function externalHitsToFleetEvents(
  hits: ExternalSignalHit[],
): Array<{ type: string; source: string; payload: Record<string, unknown> }> {
  return hits.map((hit) => {
    const entityKey = hit.email
      ? `person:${hit.email.toLowerCase()}`
      : hit.person
        ? `person:${hit.person.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`
        : hit.company
          ? `company:${hit.company.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`
          : null
    return {
      type: 'signal.detected',
      source: hit.source,
      payload: {
        company: hit.company,
        person: hit.person,
        email: hit.email,
        signal: hit.detail,
        strength: hit.strength ?? 0.7,
        url: hit.url,
        entityKey,
      },
    }
  })
}

/** Map Amplemarket duo/lead-list style rows into signal hits. */
export function amplemarketLeadsToHits(leads: Array<{
  full_name?: string
  email?: string
  company_name?: string
  title?: string
  linkedin_url?: string
  reason?: string
  person?: { name?: string; email?: string }
  company?: { name?: string }
  signal?: { description?: string; title?: string; kind?: string }
}>): ExternalSignalHit[] {
  return leads.map((lead) => {
    const person = lead.person || {}
    const company = lead.company || {}
    const signal = lead.signal || {}
    return {
      source: 'amplemarket' as const,
      person: lead.full_name || person.name,
      email: lead.email || person.email,
      company: lead.company_name || company.name,
      detail: lead.reason
        ?? signal.description
        ?? signal.title
        ?? signal.kind
        ?? [lead.title, lead.company_name || company.name].filter(Boolean).join(' @ ')
        ?? 'Amplemarket Duo lead signal',
      strength: 0.75,
      url: lead.linkedin_url,
    }
  })
}

/** Map Common Room activity rows into signal hits without rebuilding Common Room. */
export function commonRoomHitsToHits(rows: Array<{
  name?: string
  email?: string
  company?: string
  activity?: string
  url?: string
}>): ExternalSignalHit[] {
  return rows.map((row) => ({
    source: 'common-room' as const,
    person: row.name,
    email: row.email,
    company: row.company,
    detail: row.activity ?? 'Common Room community signal',
    strength: 0.65,
    url: row.url,
  }))
}

/** Map Apollo contact/search rows into signal hits. */
export function apolloPeopleToHits(people: Array<{
  name?: string
  first_name?: string
  last_name?: string
  email?: string
  title?: string
  organization_name?: string
  linkedin_url?: string
}>): ExternalSignalHit[] {
  return people.map((person) => {
    const name = person.name
      ?? [person.first_name, person.last_name].filter(Boolean).join(' ')
    return {
      source: 'apollo' as const,
      person: name || undefined,
      email: person.email,
      company: person.organization_name,
      detail: [person.title, person.organization_name].filter(Boolean).join(' @ ') || 'Apollo people signal',
      strength: 0.7,
      url: person.linkedin_url,
    }
  })
}
