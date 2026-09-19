import type { ModelRecord, ModelTier } from './types'

export type ModelTask = {
  kind: string
  complexity: ModelTier
  requiredCapabilities?: string[]
}

const TIER_ORDER: ModelTier[] = ['deterministic', 'local_free', 'inexpensive_cloud', 'frontier']

const DETERMINISTIC_KINDS = new Set([
  'dedupe',
  'queue.triage',
  'idempotency.check',
  'attio.lookup',
  'cadence.check',
  'lease.expire',
  'entity.match',
])

export function requestedTier(task: ModelTask): ModelTier {
  if (DETERMINISTIC_KINDS.has(task.kind)) return 'deterministic'
  return task.complexity
}

export function routeModel(
  task: ModelTask,
  models: ModelRecord[],
  options: { failedModelIds?: string[] } = {},
): { model: ModelRecord | null; mode: 'code' | 'llm'; reason: string } {
  const failed = new Set(options.failedModelIds ?? [])
  const minTier = requestedTier(task)
  if (minTier === 'deterministic' || DETERMINISTIC_KINDS.has(task.kind)) {
    return { model: null, mode: 'code', reason: 'Deterministic code can complete this task.' }
  }

  const minIndex = TIER_ORDER.indexOf(minTier)
  const candidates = models
    .filter((model) => model.available && !failed.has(model.id))
    .filter((model) => TIER_ORDER.indexOf(model.tier) >= minIndex)
    .filter((model) => {
      const needed = task.requiredCapabilities ?? []
      return needed.every((cap) => model.capabilities.includes(cap) || model.capabilities.includes('general'))
    })
    .sort((a, b) => {
      const tierDelta = TIER_ORDER.indexOf(a.tier) - TIER_ORDER.indexOf(b.tier)
      if (tierDelta !== 0) return tierDelta
      if (b.successRate !== a.successRate) return b.successRate - a.successRate
      if (a.costPerUnit !== b.costPerUnit) return a.costPerUnit - b.costPerUnit
      return a.latencyMs - b.latencyMs
    })

  if (!candidates.length) {
    const fallback = models
      .filter((model) => model.available && !failed.has(model.id))
      .sort((a, b) => TIER_ORDER.indexOf(a.tier) - TIER_ORDER.indexOf(b.tier))
    if (fallback[0]) {
      return { model: fallback[0], mode: 'llm', reason: 'No model matched the requested tier; using next available provider.' }
    }
    return { model: null, mode: 'llm', reason: 'No available model remaining after failover.' }
  }

  return {
    model: candidates[0],
    mode: 'llm',
    reason: `Selected ${candidates[0].id} at ${candidates[0].tier} for ${task.kind}.`,
  }
}

export function fallbackAfterFailure(
  task: ModelTask,
  models: ModelRecord[],
  failedModelId: string,
  previouslyFailed: string[] = [],
) {
  return routeModel(task, models, { failedModelIds: [...previouslyFailed, failedModelId] })
}
