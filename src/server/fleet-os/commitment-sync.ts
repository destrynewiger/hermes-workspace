/**
 * Sync meeting commitments into Attio notes/tasks so nothing from meetings is lost.
 * Agents with Attio MCP/HTTP create the real CRM objects; Fleet OS owns the job + evidence.
 */

import type { CommitmentRecord } from './types'

export type AttioCommitmentNote = {
  title: string
  content: string
  parent_object: 'people' | 'companies'
  parent_record_id: string
}

export type AttioCommitmentTask = {
  content: string
  deadline_at?: string
  is_completed: boolean
  linked_record_object: 'people' | 'companies'
  linked_record_id: string
  assignee_workspace_member_id?: string
}

export type CommitmentSyncPlan = {
  commitmentId: string
  meetingKey: string
  note: AttioCommitmentNote | null
  task: AttioCommitmentTask | null
}

/** Build Attio note+task payloads for an open commitment bound to a person/company record. */
export function planCommitmentAttioSync(input: {
  commitment: Pick<CommitmentRecord, 'id' | 'meetingKey' | 'owner' | 'text' | 'dueAt' | 'state'>
  attioRecordId: string
  parentObject?: 'people' | 'companies'
  meetingTitle?: string
  assigneeWorkspaceMemberId?: string
}): CommitmentSyncPlan {
  const parentObject = input.parentObject ?? 'people'
  const title = `Commitment · ${input.meetingTitle ?? input.commitment.meetingKey}`
  const content = [
    `Owner: ${input.commitment.owner}`,
    `Meeting: ${input.commitment.meetingKey}`,
    '',
    input.commitment.text,
    '',
    `_Fleet OS commitment ${input.commitment.id}_`,
  ].join('\n')
  if (input.commitment.state === 'cancelled') {
    return { commitmentId: input.commitment.id, meetingKey: input.commitment.meetingKey, note: null, task: null }
  }
  return {
    commitmentId: input.commitment.id,
    meetingKey: input.commitment.meetingKey,
    note: {
      title: title.slice(0, 500),
      content,
      parent_object: parentObject,
      parent_record_id: input.attioRecordId,
    },
    task: {
      content: `${input.commitment.text}`.slice(0, 2000),
      deadline_at: input.commitment.dueAt
        ? new Date(input.commitment.dueAt).toISOString()
        : undefined,
      is_completed: input.commitment.state === 'done',
      linked_record_object: parentObject,
      linked_record_id: input.attioRecordId,
      assignee_workspace_member_id: input.assigneeWorkspaceMemberId,
    },
  }
}

/** Record that an Attio task/note was created for a commitment (idempotent evidence). */
export function applyCommitmentAttioEvidence(
  commitment: CommitmentRecord,
  evidence: { attioTaskId?: string | null; attioNoteId?: string | null },
): CommitmentRecord {
  return {
    ...commitment,
    attioTaskId: evidence.attioTaskId ?? commitment.attioTaskId,
    state: evidence.attioTaskId && commitment.state === 'open' ? commitment.state : commitment.state,
  }
}

/** Extract richer commitments from Granola-style next-steps bullets. */
export function commitmentsFromMeetingNotes(text: string): Array<{ owner: string; text: string; dueAt?: string | null }> {
  const lines = text.split(/\n+/).map((line) => line.trim()).filter(Boolean)
  const found: Array<{ owner: string; text: string; dueAt?: string | null }> = []
  for (const line of lines) {
    const bullet = line.replace(/^[-*•]\s*/, '').replace(/^\*\*/, '').trim()
    const ownerMatch = bullet.match(/\((Alex|Jayram|Katherine|John|Will|Parth|Mounya)\)/i)
      ?? bullet.match(/\b(Alex|Jayram|Katherine|John)\b/i)
    if (/follow up|schedule|mention|explore|send|introduc|text |linkedin|onsite|interview/i.test(bullet)
      && bullet.length > 12
      && bullet.length < 240) {
      found.push({
        owner: (ownerMatch?.[1] ?? 'alex').toLowerCase(),
        text: bullet.replace(/\*\*/g, '').slice(0, 200),
        dueAt: null,
      })
    }
  }
  // Dedupe by text
  const seen = new Set<string>()
  return found.filter((item) => {
    const key = item.text.toLowerCase()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  }).slice(0, 8)
}
