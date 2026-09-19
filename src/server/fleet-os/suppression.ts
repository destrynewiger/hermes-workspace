/**
 * Suppression list for external sends.
 * Internal domains are always suppressed. Explicit rows cover recent touches,
 * opt-outs, and identity lanes that must not be contacted again.
 */

import type { JobRecord, SuppressionRecord } from './types'

export type { SuppressionRecord }

export type SuppressionChannel = 'email' | 'linkedin' | 'any'

const INTERNAL_DOMAINS = ['byteport.com', 'byteport.io', 'rootly.com']

const SEND_KINDS = new Set(['linkedin.send', 'email.send'])

export function isExternalSendKind(kind: string): boolean {
  return SEND_KINDS.has(kind)
}

function emailOf(value: string): string | null {
  const match = value.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)
  return match?.[0]?.toLowerCase() ?? null
}

function domainOf(email: string): string {
  return email.split('@')[1] ?? ''
}

export function candidateKeysForJob(job: Pick<JobRecord, 'kind' | 'entityKey' | 'payload'>): string[] {
  const keys = new Set<string>()
  const add = (value: unknown) => {
    if (typeof value !== 'string' || !value.trim()) return
    const raw = value.trim().toLowerCase()
    keys.add(raw)
    const email = emailOf(raw)
    if (email) {
      keys.add(email)
      keys.add(`domain:${domainOf(email)}`)
    }
  }
  add(job.entityKey)
  add(job.payload.email)
  add(job.payload.to)
  add(job.payload.recipient)
  add(job.payload.linkedinUrl)
  add(job.payload.prospect_key)
  if (job.entityKey?.startsWith('person:')) add(job.entityKey.slice('person:'.length))
  return [...keys]
}

export type SuppressionHit = {
  id: string
  reason: string
  key: string
}

export function findSendSuppression(
  records: SuppressionRecord[],
  job: Pick<JobRecord, 'kind' | 'entityKey' | 'payload'>,
  at = Date.now(),
): SuppressionHit | null {
  if (!isExternalSendKind(job.kind)) return null
  const keys = candidateKeysForJob(job)
  if (job.kind === 'email.send') {
    for (const key of keys) {
      const email = emailOf(key)
      if (!email) continue
      const domain = domainOf(email)
      if (INTERNAL_DOMAINS.includes(domain)) {
        return { id: `builtin:${domain}`, reason: `Internal domain ${domain} is suppressed for prospect sends.`, key: email }
      }
    }
  }
  for (const record of records) {
    if (record.expiresAt != null && record.expiresAt <= at) continue
    if (record.channel !== 'any' && record.channel !== (job.kind === 'linkedin.send' ? 'linkedin' : 'email')) {
      continue
    }
    const recordKey = record.key.toLowerCase()
    if (keys.includes(recordKey) || keys.some((key) => key.endsWith(recordKey))) {
      return { id: record.id, reason: record.reason, key: record.key }
    }
  }
  return null
}
