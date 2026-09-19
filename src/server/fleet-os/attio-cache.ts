/**
 * Durable live Attio snapshot cache.
 * Cloud agents refresh this from Attio MCP; workers load it when ATTIO_API_KEY
 * is absent so reconcile still binds to production record IDs.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { LiveCompanyHit, LivePersonHit } from './attio-bridge'

export type AttioLiveSnapshot = {
  fetchedAt: string
  source: string
  workspace?: string
  companies: LiveCompanyHit[]
  people: LivePersonHit[]
}

function packageDataDir(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), 'data')
}

export function defaultAttioSnapshotPath(): string {
  return process.env.FLEET_ATTIO_SNAPSHOT
    ?? path.join(packageDataDir(), 'attio-live-snapshot.json')
}

export function loadAttioLiveSnapshot(filePath = defaultAttioSnapshotPath()): AttioLiveSnapshot | null {
  if (!existsSync(filePath)) return null
  try {
    const raw = JSON.parse(readFileSync(filePath, 'utf8')) as AttioLiveSnapshot
    if (!Array.isArray(raw.companies) || !Array.isArray(raw.people)) return null
    return raw
  } catch {
    return null
  }
}

export function saveAttioLiveSnapshot(
  snapshot: AttioLiveSnapshot,
  filePath = defaultAttioSnapshotPath(),
): void {
  mkdirSync(path.dirname(filePath), { recursive: true })
  writeFileSync(filePath, JSON.stringify(snapshot, null, 2) + '\n', 'utf8')
}

/** Merge MCP / API hits into the on-disk snapshot (idempotent by recordId). */
export function upsertAttioLiveSnapshot(input: {
  companies?: LiveCompanyHit[]
  people?: LivePersonHit[]
  source?: string
  workspace?: string
  filePath?: string
}): AttioLiveSnapshot {
  const filePath = input.filePath ?? defaultAttioSnapshotPath()
  const prior = loadAttioLiveSnapshot(filePath) ?? {
    fetchedAt: new Date(0).toISOString(),
    source: 'empty',
    companies: [],
    people: [],
  }
  const companies = [...prior.companies]
  for (const company of input.companies ?? []) {
    const idx = companies.findIndex((item) => item.recordId === company.recordId)
    if (idx >= 0) companies[idx] = { ...companies[idx], ...company }
    else companies.push(company)
  }
  const people = [...prior.people]
  for (const person of input.people ?? []) {
    const idx = people.findIndex((item) => item.recordId === person.recordId)
    if (idx >= 0) people[idx] = { ...people[idx], ...person }
    else people.push(person)
  }
  const next: AttioLiveSnapshot = {
    fetchedAt: new Date().toISOString(),
    source: input.source ?? prior.source,
    workspace: input.workspace ?? prior.workspace,
    companies,
    people,
  }
  saveAttioLiveSnapshot(next, filePath)
  return next
}
