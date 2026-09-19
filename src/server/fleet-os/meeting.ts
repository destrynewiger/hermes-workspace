import { commitmentsFromMeetingNotes } from './commitment-sync'

export type MeetingBrief = {
  meetingKey: string
  attendees: Array<{ name: string; company?: string; attioId?: string | null }>
  why: string
  relationship: string
  recentSignals: string[]
  promises: string[]
  questions: string[]
  desiredOutcome: string
}

export type TranscriptExtraction = {
  meetingKey: string
  summary: string
  technicalRequirements: string[]
  objections: string[]
  signals: string[]
  commitments: Array<{ owner: string; text: string; dueAt?: string | null }>
  nextSteps: string[]
  attioUpdates: Array<{ entityKey: string; note: string }>
}

export function buildMeetingBrief(input: {
  meetingKey: string
  title?: string
  attendees?: Array<{ name: string; company?: string; attioId?: string | null }>
  relationshipHistory?: string
  signals?: string[]
  promises?: string[]
}): MeetingBrief {
  const attendees = input.attendees?.length
    ? input.attendees
    : [{ name: 'External guest', company: 'Unknown' }]
  const company = attendees[0]?.company ?? 'the account'
  return {
    meetingKey: input.meetingKey,
    attendees,
    why: input.title?.trim() || `External meeting with ${company}`,
    relationship: input.relationshipHistory?.trim() || 'Limited prior Attio history; treat as discovery.',
    recentSignals: input.signals?.length ? input.signals : ['No fresh signals attached'],
    promises: input.promises?.length ? input.promises : [],
    questions: [
      'Who owns the data-movement / infrastructure decision?',
      'What breaks today when teams move data between systems?',
      'Is there a timeline or event that makes this urgent?',
    ],
    desiredOutcome: 'Confirm owner, pain, and whether a next step is warranted.',
  }
}

export function extractTranscript(input: {
  meetingKey: string
  text?: string
  attendees?: string[]
}): TranscriptExtraction {
  const raw = input.text ?? ''
  const text = raw.toLowerCase()
  // Prefer structured next-step bullets when present; fall back to generic follow-up.
  let commitments = commitmentsFromMeetingNotes(raw)
  if (!commitments.length && /i('ll| will) send|follow up|follow-up|circle back|send over/.test(text)) {
    commitments = [{
      owner: 'alex',
      text: 'Send follow-up with next step from the meeting',
      dueAt: null,
    }]
  }
  if (/introduc/.test(text) && !commitments.some((item) => /introduc/i.test(item.text))) {
    commitments.push({ owner: 'alex', text: 'Make the promised introduction', dueAt: null })
  }
  return {
    meetingKey: input.meetingKey,
    summary: raw.trim().slice(0, 280) || 'Meeting completed. Material points captured for CRM and follow-up.',
    technicalRequirements: /warehouse|snowflake|redshift|s3|pipeline|etl|kafka|data transfer|dart/.test(text)
      ? ['Data platform / pipeline context mentioned']
      : [],
    objections: /budget|timing|not now|later/.test(text) ? ['Timing or budget caution surfaced'] : [],
    signals: /hiring|migrat|multi-cloud|warehouse|data transfer/.test(text) ? ['Buying or infrastructure signal in transcript'] : [],
    commitments,
    nextSteps: ['Draft follow-up', 'Update Attio', 'Track commitments'],
    attioUpdates: [{
      entityKey: `meeting:${input.meetingKey}`,
      note: 'Transcript processed; commitments and next steps recorded.',
    }],
  }
}
