/**
 * Discover available inference providers from the environment.
 * Prefer free/local; escalate only when a stronger tier is present.
 */

import type { ModelRecord, ModelTier } from './types'

function envFlag(name: string): boolean {
  const value = process.env[name]?.trim()
  return Boolean(value && value !== '0' && value.toLowerCase() !== 'false')
}

export function discoverModelPool(now = Date.now()): ModelRecord[] {
  const models: ModelRecord[] = [
    {
      id: 'deterministic-code',
      provider: 'code',
      tier: 'deterministic',
      available: true,
      costPerUnit: 0,
      latencyMs: 1,
      successRate: 1,
      capabilities: ['classify', 'dedupe', 'attio.lookup'],
    },
  ]

  if (envFlag('OLLAMA_HOST') || envFlag('OLLAMA_API_BASE') || process.env.FLEET_ENABLE_OLLAMA === '1') {
    models.push({
      id: 'ollama-local',
      provider: 'ollama',
      tier: 'local_free',
      available: true,
      costPerUnit: 0,
      latencyMs: 800,
      successRate: 0.9,
      capabilities: ['general', 'classify', 'extract', 'summarize'],
    })
  }

  if (process.env.OPENROUTER_API_KEY || process.env.FLEET_ENABLE_OPENROUTER === '1') {
    models.push({
      id: 'openrouter-free',
      provider: 'openrouter',
      tier: 'local_free',
      available: true,
      costPerUnit: 0,
      latencyMs: 1200,
      successRate: 0.88,
      capabilities: ['general', 'classify', 'extract'],
    })
    models.push({
      id: 'openrouter-cheap',
      provider: 'openrouter',
      tier: 'inexpensive_cloud',
      available: true,
      costPerUnit: 0.02,
      latencyMs: 900,
      successRate: 0.92,
      capabilities: ['general', 'write'],
    })
  }

  if (process.env.HERMES_NOUS_ENABLED === '1' || process.env.FLEET_ENABLE_HERMES_FREE === '1') {
    models.push({
      id: 'hermes-nous-free',
      provider: 'hermes',
      tier: 'local_free',
      available: true,
      costPerUnit: 0,
      latencyMs: 1500,
      successRate: 0.85,
      capabilities: ['general', 'classify'],
    })
  }

  if (process.env.OPENAI_API_KEY || process.env.FLEET_ENABLE_OPENAI === '1') {
    models.push({
      id: 'openai-frontier',
      provider: 'openai',
      tier: 'frontier',
      available: true,
      costPerUnit: 1,
      latencyMs: 1400,
      successRate: 0.97,
      capabilities: ['general', 'write', 'code'],
    })
  }

  if (process.env.ANTHROPIC_API_KEY || process.env.FLEET_ENABLE_ANTHROPIC === '1') {
    models.push({
      id: 'claude-frontier',
      provider: 'anthropic',
      tier: 'frontier',
      available: true,
      costPerUnit: 1,
      latencyMs: 1400,
      successRate: 0.98,
      capabilities: ['general', 'write', 'code', 'architecture'],
    })
  }

  if (process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY || process.env.FLEET_ENABLE_GEMINI === '1') {
    models.push({
      id: 'gemini-frontier',
      provider: 'google',
      tier: 'frontier',
      available: true,
      costPerUnit: 0.8,
      latencyMs: 1300,
      successRate: 0.96,
      capabilities: ['general', 'write', 'research'],
    })
  }

  // Always keep a free fallback so workflows never hard-fail for missing keys.
  if (!models.some((model) => model.tier === 'local_free')) {
    models.push({
      id: 'offline-free-stub',
      provider: 'local',
      tier: 'local_free',
      available: true,
      costPerUnit: 0,
      latencyMs: 50,
      successRate: 0.7,
      capabilities: ['general', 'classify'],
    })
  }

  void now
  return models
}

export function preferredTierForKind(kind: string): ModelTier[] {
  if (/attio|dedupe|cadence|lease|verify/.test(kind)) return ['deterministic']
  if (/classify|extract|enrich|triage|score/.test(kind)) return ['deterministic', 'local_free', 'inexpensive_cloud']
  if (/draft|outbound|brief|strategy|architect|debug/.test(kind)) {
    return ['inexpensive_cloud', 'frontier', 'local_free']
  }
  return ['local_free', 'inexpensive_cloud', 'frontier']
}
