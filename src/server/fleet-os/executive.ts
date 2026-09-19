import type { FleetControlPlane } from './control-plane'
import { parseExecutiveCommand, type ExecutiveCommand } from './commands'
import { enqueueBackgroundWork } from './background'
import type { AgentInterface } from './types'

export type CommandResult = {
  command: ExecutiveCommand
  picture: string
  objectiveId?: string
  details?: Record<string, unknown>
}

/**
 * One entrypoint for Hermes / GrokBot / Muse / Codex / Claude Code / Gemini Spark / Slack.
 * Parse → shared state → optional dispatch. Never invents a private campaign copy.
 */
export function executeExecutiveCommand(
  plane: FleetControlPlane,
  text: string,
  sourceInterface: AgentInterface | string = 'api',
): CommandResult {
  const command = parseExecutiveCommand(text, sourceInterface)

  if (command.kind === 'status') {
    const status = plane.status(command.query)
    const campaign = plane.campaignStatus(command.query)
    return {
      command,
      picture: status.picture,
      objectiveId: status.objective?.id,
      details: {
        approvals: status.approvals,
        campaign,
        jobs: status.jobs.map((job) => ({ kind: job.kind, state: job.state })),
      },
    }
  }

  if (command.kind === 'fleet' || command.kind === 'attention') {
    const snapshot = plane.snapshot()
    const blocked = snapshot.jobs.filter((job) => job.state === 'blocked' || job.state === 'verifying')
    const approvals = snapshot.approvals.filter((item) => item.status === 'pending')
    const active = snapshot.objectives.filter((item) => item.state === 'active')
    const promises = plane.promiseBoard()
    const picture = command.kind === 'fleet'
      ? plane.picture()
      : [
        promises.alexOwned.length
          ? `Alex still owns ${promises.alexOwned.length} promise(s): ${promises.alexOwned.slice(0, 4).map((item) => item.text).join('; ')}.`
          : 'No open promises owned by Alex.',
        approvals.length ? `${approvals.length} send/calendar decision(s) waiting.` : 'No send approvals waiting.',
        blocked.length ? `${blocked.length} blocked/verifying job(s).` : 'No blocked jobs.',
        active.length ? `${active.length} active objective(s).` : 'No active objectives.',
      ].join(' ')
    return {
      command,
      picture,
      details: {
        promises: promises.alexOwned.map((item) => ({ id: item.id, text: item.text, meetingKey: item.meetingKey })),
        approvals: approvals.map((item) => item.decision),
        blocked: blocked.map((job) => ({ id: job.id, kind: job.kind, nextAction: job.nextAction })),
        campaigns: snapshot.campaigns.filter((item) => item.state === 'active'),
      },
    }
  }

  if (command.kind === 'promises') {
    const board = plane.promiseBoard()
    return {
      command,
      picture: board.picture,
      details: {
        open: board.open.map((item) => ({
          id: item.id,
          owner: item.owner,
          text: item.text,
          meetingKey: item.meetingKey,
          attioTaskId: item.attioTaskId,
        })),
        missingAttio: board.missingAttio.map((item) => item.id),
      },
    }
  }

  if (command.kind === 'stuck') {
    const stuck = plane.stuckBoard()
    return { command, picture: stuck.picture, details: stuck }
  }

  if (command.kind === 'cost') {
    const costs = plane.costRollup()
    return { command, picture: costs.picture, details: costs }
  }

  if (command.kind === 'prepare') {
    const title = command.when === 'tomorrow' ? 'Prepare tomorrow meetings' : 'Prepare today meetings'
    const { objective, jobs } = plane.submitObjective({
      title,
      intent: text,
      sourceInterface,
      priority: 'P0',
    })
    plane.enqueueBackgroundJob({
      objectiveId: objective.id,
      workflowId: jobs[0]?.workflowId ?? plane.snapshot().workflows.find((item) => item.objectiveId === objective.id)!.id,
      kind: 'meeting.brief_tomorrow',
      title: `Meeting briefs for ${command.when}`,
      priority: 'P0',
      requiredCapabilities: ['meeting.brief'],
      idempotencyKey: `prepare:${command.when}:${new Date().toISOString().slice(0, 10)}`,
    })
    return {
      command,
      picture: plane.status(title).picture,
      objectiveId: objective.id,
    }
  }

  if (command.kind === 'background') {
    const result = enqueueBackgroundWork(plane)
    return {
      command,
      picture: plane.picture(),
      details: result,
    }
  }

  if (command.kind === 'objective') {
    const { objective, jobs } = plane.submitObjective({
      title: command.title,
      intent: command.intent,
      sourceInterface,
      priority: command.priority,
      campaignId: command.campaignId,
    })
    return {
      command,
      picture: plane.status(command.title).picture,
      objectiveId: objective.id,
      details: { jobCount: jobs.length, campaignId: objective.campaignId },
    }
  }

  return {
    command,
    picture: 'Could not map that to a fleet action. Try an objective or ask for status.',
    details: { raw: command.raw },
  }
}
