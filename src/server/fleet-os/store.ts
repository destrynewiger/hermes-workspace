import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { emptySnapshot, type FleetSnapshot } from './types'

export function fleetOsHome(): string {
  return process.env.FLEET_OS_HOME
    ?? path.join(process.env.HERMES_HOME ?? process.env.CLAUDE_HOME ?? path.join(os.homedir(), '.hermes'), 'fleet-os')
}

export function fleetOsStatePath(): string {
  return path.join(fleetOsHome(), 'state.json')
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function asArray<T>(value: unknown, fallback: T[]): T[] {
  return Array.isArray(value) ? value as T[] : fallback
}

export class FleetStore {
  readonly path: string

  constructor(filePath = fleetOsStatePath()) {
    this.path = filePath
  }

  load(): FleetSnapshot {
    mkdirSync(path.dirname(this.path), { recursive: true })
    if (!existsSync(this.path)) {
      this.save(emptySnapshot())
      return emptySnapshot()
    }
    try {
      const raw = readFileSync(this.path, 'utf-8').trim()
      if (!raw) return emptySnapshot()
      const parsed = JSON.parse(raw) as Partial<FleetSnapshot>
      const base = emptySnapshot()
      return {
        ...base,
        ...parsed,
        version: 1,
        machines: asArray(parsed.machines, base.machines),
        workers: asArray(parsed.workers, base.workers),
        identities: asArray(parsed.identities, base.identities),
        models: asArray(parsed.models, base.models),
        objectives: asArray(parsed.objectives, base.objectives),
        workflows: asArray(parsed.workflows, base.workflows),
        jobs: asArray(parsed.jobs, base.jobs),
        attempts: asArray(parsed.attempts, base.attempts),
        events: asArray(parsed.events, base.events),
        entities: asArray(parsed.entities, base.entities),
        approvals: asArray(parsed.approvals, base.approvals),
        costs: asArray(parsed.costs, base.costs),
        campaigns: asArray(parsed.campaigns, base.campaigns),
        commitments: asArray(parsed.commitments, base.commitments),
        suppressions: asArray(parsed.suppressions, base.suppressions),
      }
    } catch {
      return emptySnapshot()
    }
  }

  save(snapshot: FleetSnapshot): void {
    mkdirSync(path.dirname(this.path), { recursive: true })
    const tmp = `${this.path}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(snapshot, null, 2) + '\n', 'utf-8')
    renameSync(tmp, this.path)
  }

  mutate(fn: (snapshot: FleetSnapshot) => void): FleetSnapshot {
    const snapshot = clone(this.load())
    fn(snapshot)
    this.save(snapshot)
    return snapshot
  }
}
