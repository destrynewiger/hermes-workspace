import type { AgentInterface, Priority } from './types'

export type ExecutiveCommand =
  | { kind: 'status'; query: string; sourceInterface: AgentInterface | string }
  | { kind: 'attention'; sourceInterface: AgentInterface | string }
  | { kind: 'fleet'; sourceInterface: AgentInterface | string }
  | { kind: 'prepare'; when: 'tomorrow' | 'today'; sourceInterface: AgentInterface | string }
  | {
    kind: 'objective'
    title: string
    intent: string
    priority?: Priority
    campaignId?: string | null
    sourceInterface: AgentInterface | string
  }
  | { kind: 'background'; sourceInterface: AgentInterface | string }
  | { kind: 'promises'; sourceInterface: AgentInterface | string }
  | { kind: 'stuck'; sourceInterface: AgentInterface | string }
  | { kind: 'cost'; sourceInterface: AgentInterface | string }
  | { kind: 'unknown'; raw: string; sourceInterface: AgentInterface | string }

/**
 * Turn Alex's natural-language command into a control-plane action.
 * Interfaces (Hermes, GrokBot, Muse, Codex, …) all parse through this.
 */
export function parseExecutiveCommand(
  text: string,
  sourceInterface: AgentInterface | string = 'api',
): ExecutiveCommand {
  const raw = text.trim()
  const lower = raw.toLowerCase()

  if (/what needs my attention|what should i (do|focus)|attention today/.test(lower)) {
    return { kind: 'attention', sourceInterface }
  }
  if (/why aren'?t we getting meetings|gtm motions are stuck|what is stuck|dead letter/.test(lower)) {
    return { kind: 'stuck', sourceInterface }
  }
  if (/inference cost|token spend|cost model|what did (inference|models) cost/.test(lower)) {
    return { kind: 'cost', sourceInterface }
  }
  if (/what is the fleet|what are the machines|fleet doing|workers online/.test(lower)) {
    return { kind: 'fleet', sourceInterface }
  }
  if (/prepare me for tomorrow|brief me for tomorrow|tomorrow'?s meetings/.test(lower)) {
    return { kind: 'prepare', when: 'tomorrow', sourceInterface }
  }
  if (/prepare me for today|today'?s meetings/.test(lower)) {
    return { kind: 'prepare', when: 'today', sourceInterface }
  }
  if (/where are we on|status of|progress on|how is|what happened/.test(lower)) {
    const query = raw
      .replace(/^(where are we on|status of|progress on|how(?:'s| is)|what happened(?: with| to)?)\s+/i, '')
      .replace(/\?+$/, '')
      .trim() || raw
    return { kind: 'status', query, sourceInterface }
  }
  if (/spare fleet|background work|use spare capacity|enrich incomplete/.test(lower)) {
    return { kind: 'background', sourceInterface }
  }
  if (/follow up on everything i promised|nothing from .* meetings should get lost|what did i promise|open commitments/.test(lower)) {
    return { kind: 'promises', sourceInterface }
  }
  if (/fill the .*dinner|get \d+.+(leader|guest|rsvp)|toronto dinner|nyc dinner/.test(lower)) {
    const titleMatch = raw.match(/\b((?:toronto|nyc|new york|sf|london)[^?.!]{0,40}dinner)/i)
    return {
      kind: 'objective',
      title: titleMatch?.[1] ?? 'Event dinner',
      intent: raw,
      priority: 'P1',
      campaignId: titleMatch ? titleMatch[1].toLowerCase().replace(/\s+/g, '-') : null,
      sourceInterface,
    }
  }
  if (/find people|start the appropriate motion|keep .* accounts warm|highest-leverage|make sure every external meeting/.test(lower)) {
    const title = raw.length > 60 ? `${raw.slice(0, 57)}...` : raw
    return {
      kind: 'objective',
      title,
      intent: raw,
      priority: inferCommandPriority(lower),
      sourceInterface,
    }
  }
  if (raw.length > 12) {
    return {
      kind: 'objective',
      title: raw.length > 60 ? `${raw.slice(0, 57)}...` : raw,
      intent: raw,
      priority: inferCommandPriority(lower),
      sourceInterface,
    }
  }
  return { kind: 'unknown', raw, sourceInterface }
}

function inferCommandPriority(lower: string): Priority {
  if (/today|tomorrow|promised|attention|failed|stuck/.test(lower)) return 'P0'
  if (/dinner|revenue|intro|warm|reply/.test(lower)) return 'P1'
  if (/campaign|prospect|outreach|research/.test(lower)) return 'P2'
  if (/signal|enrich|map/.test(lower)) return 'P3'
  return 'P4'
}
