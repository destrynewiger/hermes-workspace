import type { CampaignRecord, FleetSnapshot, JobRecord } from './types'

export function campaignPicture(campaign: CampaignRecord): string {
  const remaining = Math.max(0, campaign.targetCount - campaign.rsvps)
  return `${campaign.title}: ${campaign.rsvps}/${campaign.targetCount} RSVPs, ${campaign.contacted} contacted, ${campaign.accepted} accepted.`
    + (remaining > 0 ? ` Gap ${remaining}.` : ' Target met.')
    + (campaign.gaps.length ? ` Needs: ${campaign.gaps.join('; ')}.` : '')
}

export function ensureCampaign(snapshot: FleetSnapshot, input: {
  id: string
  objectiveId: string
  title: string
  targetCount: number
  geography?: string | null
}): CampaignRecord {
  const existing = snapshot.campaigns.find((item) => item.id === input.id)
  if (existing) return existing
  const campaign: CampaignRecord = {
    id: input.id,
    objectiveId: input.objectiveId,
    title: input.title,
    targetCount: input.targetCount,
    contacted: 0,
    accepted: 0,
    rsvps: 0,
    attended: 0,
    geography: input.geography ?? null,
    state: 'active',
    gaps: [],
    updatedAt: Date.now(),
  }
  snapshot.campaigns.push(campaign)
  return campaign
}

export function applyCampaignProgress(campaign: CampaignRecord, patch: Partial<Pick<CampaignRecord, 'contacted' | 'accepted' | 'rsvps' | 'attended'>>): CampaignRecord {
  if (typeof patch.contacted === 'number') {
    campaign.contacted = Math.min(campaign.targetCount * 3, Math.max(campaign.contacted, patch.contacted))
  }
  if (typeof patch.accepted === 'number') campaign.accepted = Math.max(campaign.accepted, patch.accepted)
  if (typeof patch.rsvps === 'number') campaign.rsvps = Math.max(campaign.rsvps, patch.rsvps)
  if (typeof patch.attended === 'number') campaign.attended = Math.max(campaign.attended, patch.attended)
  campaign.gaps = computeGaps(campaign)
  campaign.state = campaign.rsvps >= campaign.targetCount ? 'completed' : 'active'
  campaign.updatedAt = Date.now()
  return campaign
}

export function computeGaps(campaign: CampaignRecord): string[] {
  const gaps: string[] = []
  const remaining = campaign.targetCount - campaign.rsvps
  if (remaining <= 0) return []
  if (campaign.contacted < campaign.targetCount) {
    gaps.push(`Contact ${campaign.targetCount - campaign.contacted} more qualified targets`)
  }
  if (campaign.accepted < Math.ceil(campaign.targetCount * 0.4)) {
    gaps.push('Increase accept rate or expand Tier 1 list')
  }
  if (campaign.rsvps < campaign.targetCount) {
    gaps.push(`Convert ${remaining} more RSVPs`)
  }
  return gaps
}

export function gapJobs(campaign: CampaignRecord, workflowId: string): Array<{
  kind: string
  title: string
  priority: 'P1' | 'P2'
  requiredCapabilities: string[]
  requiredIdentityId: string | null
  idempotencyKey: string
  entityKey: string | null
  payload: Record<string, unknown>
}> {
  if (campaign.rsvps >= campaign.targetCount) return []
  const jobs = []
  if (campaign.contacted < campaign.targetCount) {
    jobs.push({
      kind: 'account.research',
      title: `Fill Toronto gap: research ${campaign.targetCount - campaign.contacted} more targets`,
      priority: 'P1' as const,
      requiredCapabilities: ['research'],
      requiredIdentityId: null,
      idempotencyKey: `${campaign.id}:gap-research:${campaign.contacted}`,
      entityKey: campaign.id,
      payload: { campaignId: campaign.id, gap: true },
    })
  }
  if (campaign.contacted > campaign.accepted) {
    jobs.push({
      kind: 'linkedin.draft',
      title: 'Draft outreach for remaining dinner targets',
      priority: 'P1' as const,
      requiredCapabilities: ['linkedin.draft'],
      requiredIdentityId: 'katherine-byteport',
      idempotencyKey: `${campaign.id}:gap-draft:${campaign.accepted}`,
      entityKey: campaign.id,
      payload: { campaignId: campaign.id, gap: true },
    })
  }
  return jobs.map((job) => ({ ...job, workflowId }))
}

export function campaignFromObjective(objectiveId: string, title: string, intent: string): {
  id: string
  objectiveId: string
  title: string
  targetCount: number
  geography: string | null
} | null {
  if (!/dinner|event|rsvp|luma/i.test(intent) && !/dinner|event/i.test(title)) return null
  const countMatch = intent.match(/(\d+)\s+(qualified|vp|leaders|people|guests|rsvp)/i)
    ?? title.match(/(\d+)/)
  const geoMatch = intent.match(/\b(toronto|nyc|new york|sf|san francisco|london)\b/i)
  return {
    id: objectiveId.replace(/^obj_/, 'camp_'),
    objectiveId,
    title,
    targetCount: countMatch ? Number(countMatch[1]) : 20,
    geography: geoMatch ? geoMatch[1] : null,
  }
}

export function bumpFromJob(campaign: CampaignRecord, job: JobRecord): void {
  if (job.kind === 'linkedin.send' || job.kind === 'email.send' || job.kind === 'linkedin.draft' || job.kind === 'email.draft') {
    applyCampaignProgress(campaign, { contacted: campaign.contacted + 1 })
  }
  if (job.kind === 'linkedin.send' || job.kind === 'email.send') {
    const accepted = typeof job.result?.accepted === 'boolean' && job.result.accepted
    if (accepted) applyCampaignProgress(campaign, { accepted: campaign.accepted + 1 })
  }
}
