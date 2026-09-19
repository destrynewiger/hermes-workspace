/**
 * Import LinkedIn outreach harness.yaml identities into the Fleet OS registry.
 * The harness remains the send-chain source of truth; Fleet OS uses it for routing.
 */

import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AutonomyLevel, IdentityRecord } from './types'

export type HarnessIdentityYaml = {
  id: string
  principal: string
  owner: string
  send_mode: IdentityRecord['sendMode']
  session: {
    host: string
    status: IdentityRecord['sessionStatus']
  }
}

const SESSION_HOST_MACHINE: Record<string, string | null> = {
  luey: null,
  'alex-browser': 'sf-mini',
  grokbot: 'backup-mini',
  hermes: 'sf-mini',
}

function autonomyForSendMode(mode: IdentityRecord['sendMode']): AutonomyLevel {
  if (mode === 'live') return 3
  if (mode === 'planned') return 1
  return 2
}

function defaultHarnessPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url))
  const candidates = [
    path.resolve(here, '../../.claude/skills/linkedin-outreach-harness/harness.yaml'),
    path.resolve(here, '../../../.claude/skills/linkedin-outreach-harness/harness.yaml'),
    path.resolve(process.cwd(), '.claude/skills/linkedin-outreach-harness/harness.yaml'),
  ]
  return candidates.find((item) => existsSync(item)) ?? candidates[0]
}

/** Parse the identities: list from harness.yaml without a YAML dependency. */
export function parseHarnessYamlIdentities(yaml: string): HarnessIdentityYaml[] {
  const identitiesStart = yaml.search(/^identities:\s*$/m)
  if (identitiesStart < 0) return []
  const rest = yaml.slice(identitiesStart)
  const nextTop = rest.search(/\n[a-z_]+:\s*$/m)
  const block = nextTop > 0 ? rest.slice(0, nextTop) : rest
  const chunks = block.split(/\n  - id:\s*/)
  const out: HarnessIdentityYaml[] = []
  for (const chunk of chunks.slice(1)) {
    const id = chunk.split(/\r?\n/)[0]?.trim()
    if (!id) continue
    const principal = chunk.match(/\n    principal:\s*(\S+)/)?.[1]
    const owner = chunk.match(/\n    owner:\s*(\S+)/)?.[1]
    const sendModeRaw = chunk.match(/\n    send_mode:\s*(\S+)/)?.[1] as IdentityRecord['sendMode'] | undefined
    const host = chunk.match(/\n      host:\s*(\S+)/)?.[1]
    const statusRaw = chunk.match(/\n      status:\s*(\S+)/)?.[1] as IdentityRecord['sessionStatus'] | undefined
    if (!principal || !owner || !sendModeRaw || !host) continue
    const send_mode: IdentityRecord['sendMode'] = ['live', 'draft_only', 'staged', 'planned'].includes(sendModeRaw)
      ? sendModeRaw
      : 'planned'
    const status: IdentityRecord['sessionStatus'] = ['alive', 'needs_login', 'locked', 'unknown', 'needs_attach'].includes(statusRaw ?? '')
      ? statusRaw!
      : 'unknown'
    out.push({
      id,
      principal,
      owner,
      send_mode,
      session: { host, status },
    })
  }
  return out
}

export function harnessIdentityToRecord(identity: HarnessIdentityYaml): IdentityRecord {
  return {
    id: identity.id,
    teammate: identity.owner,
    principal: identity.principal,
    channel: 'linkedin',
    machineId: SESSION_HOST_MACHINE[identity.session.host] ?? null,
    sessionHost: identity.session.host,
    sessionStatus: identity.session.status,
    autonomyLevel: autonomyForSendMode(identity.send_mode),
    sendMode: identity.send_mode,
  }
}

export function loadHarnessIdentities(filePath = defaultHarnessPath()): IdentityRecord[] {
  if (!existsSync(filePath)) return []
  return parseHarnessYamlIdentities(readFileSync(filePath, 'utf-8')).map(harnessIdentityToRecord)
}

/** Merge harness LinkedIn identities over hardcoded seeds (harness wins on id collision). */
export function mergeIdentityRegistry(seeds: IdentityRecord[], harness = loadHarnessIdentities()): IdentityRecord[] {
  const byId = new Map<string, IdentityRecord>()
  for (const item of seeds) byId.set(item.id, item)
  for (const item of harness) byId.set(item.id, item)
  return [...byId.values()]
}

export function grokbotHarnessIdentityIds(identities = loadHarnessIdentities()): string[] {
  return identities.filter((item) => item.sessionHost === 'grokbot').map((item) => item.id)
}
