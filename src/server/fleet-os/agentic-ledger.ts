/**
 * Fleet OS → agentic-os ledger appender.
 *
 * Uses the same SQLite WAL schema as agentic-os/server/lib/event-ledger.js so a
 * Mac Mini can point AGENTIC_LEDGER_PATH (or FLEET_LEDGER_PATH) at the shared
 * ledger file and import Fleet OS outbox events without a second SoT.
 *
 * Fleet-prefixed event types (fleet.*) are stored as plain events. They do not
 * project into work_items/worker_runs unless/until agentic-os grows fleet
 * projectors — state remains recoverable from the event stream.
 */

import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { AgenticLedgerEvent, AgenticOutboxEntry } from './agentic-bridge'
import { ledgerEventsFromOutbox } from './agentic-bridge'

export type LedgerAppendResult = {
  eventId: string
  streamId: string
  type: string
  inserted: boolean
  sequence?: number
  version?: number
}

export type LedgerSyncReport = {
  filename: string
  attempted: number
  inserted: number
  skipped: number
  failed: Array<{ eventId: string; error: string }>
  latestSequence: number
}

function openLedger(filename: string, clock = Date.now) {
  if (filename !== ':memory:') fs.mkdirSync(path.dirname(filename), { recursive: true })
  const database = new DatabaseSync(filename, { timeout: 5_000 })
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    CREATE TABLE IF NOT EXISTS migrations (
      version INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS streams (
      stream_id TEXT PRIMARY KEY,
      version INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS events (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT NOT NULL UNIQUE,
      stream_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      type TEXT NOT NULL,
      actor TEXT NOT NULL,
      occurred_at INTEGER NOT NULL,
      payload TEXT NOT NULL,
      UNIQUE (stream_id, version)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS work_items (
      id TEXT PRIMARY KEY,
      state TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      source_event_id TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS worker_runs (
      id TEXT PRIMARY KEY,
      state TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      source_event_id TEXT NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS events_type_work_item_idx
      ON events(type, json_extract(payload, '$.workItemId'));
    INSERT OR IGNORE INTO migrations (version, applied_at) VALUES (1, ${Number(clock())});
    INSERT OR IGNORE INTO migrations (version, applied_at) VALUES (2, ${Number(clock())});
    INSERT OR IGNORE INTO migrations (version, applied_at) VALUES (3, ${Number(clock())});
  `)

  const findEvent = database.prepare('SELECT * FROM events WHERE event_id = ?')
  const findStream = database.prepare('SELECT version FROM streams WHERE stream_id = ?')
  const insertEvent = database.prepare(`
    INSERT INTO events (event_id, stream_id, version, type, actor, occurred_at, payload)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `)
  const upsertStream = database.prepare(`
    INSERT INTO streams (stream_id, version) VALUES (?, ?)
    ON CONFLICT(stream_id) DO UPDATE SET version = excluded.version
  `)
  const findLatestSequence = database.prepare(
    'SELECT COALESCE(MAX(sequence), 0) AS sequence FROM events',
  )
  const listEvents = database.prepare(
    'SELECT * FROM events WHERE sequence > ? ORDER BY sequence LIMIT ?',
  )

  function append(event: AgenticLedgerEvent): LedgerAppendResult {
    const prior = findEvent.get(event.eventId) as { sequence?: number; version?: number } | undefined
    if (prior) {
      return {
        eventId: event.eventId,
        streamId: event.streamId,
        type: event.type,
        inserted: false,
        sequence: Number(prior.sequence ?? 0),
        version: Number(prior.version ?? 0),
      }
    }

    database.exec('BEGIN IMMEDIATE')
    try {
      const actualVersion = Number((findStream.get(event.streamId) as { version?: number } | undefined)?.version || 0)
      if (event.expectedVersion != null && actualVersion !== event.expectedVersion) {
        throw new Error(
          `stale stream ${event.streamId}: expected version ${event.expectedVersion}, found ${actualVersion}`,
        )
      }
      const version = actualVersion + 1
      const result = insertEvent.run(
        event.eventId,
        event.streamId,
        version,
        event.type,
        event.actor,
        Number(event.occurredAt),
        JSON.stringify(event.payload ?? {}),
      )
      upsertStream.run(event.streamId, version)
      database.exec('COMMIT')
      return {
        eventId: event.eventId,
        streamId: event.streamId,
        type: event.type,
        inserted: true,
        sequence: Number(result.lastInsertRowid),
        version,
      }
    } catch (error) {
      database.exec('ROLLBACK')
      throw error
    }
  }

  function latestSequence(): number {
    return Number((findLatestSequence.get() as { sequence?: number } | undefined)?.sequence || 0)
  }

  function events(afterSequence = 0, limit = 1_000) {
    return listEvents.all(Math.max(0, afterSequence), Math.min(1_000, Math.max(1, limit))) as Array<Record<string, unknown>>
  }

  function close() {
    database.close()
  }

  return { append, latestSequence, events, close, filename }
}

export type FleetLedger = ReturnType<typeof openLedger>

export function createFleetLedger(filename: string, clock = Date.now): FleetLedger {
  return openLedger(filename, clock)
}

export function defaultLedgerPath(): string {
  return process.env.FLEET_LEDGER_PATH
    ?? process.env.AGENTIC_LEDGER_PATH
    ?? path.join(
      process.env.FLEET_OS_HOME
        ?? process.env.HERMES_HOME
        ?? process.env.CLAUDE_HOME
        ?? path.join(process.env.HOME ?? '/tmp', '.hermes'),
      'fleet-os',
      'agentic-ledger.sqlite',
    )
}

/** Append outbox entries into the shared ledger. Idempotent by eventId. */
export function appendOutboxToLedger(
  outbox: AgenticOutboxEntry[],
  options?: { filename?: string; ledger?: FleetLedger },
): LedgerSyncReport {
  const filename = options?.filename ?? defaultLedgerPath()
  const owned = !options?.ledger
  const ledger = options?.ledger ?? createFleetLedger(filename)
  const events = ledgerEventsFromOutbox(outbox)
  let inserted = 0
  let skipped = 0
  const failed: Array<{ eventId: string; error: string }> = []

  for (const event of events) {
    try {
      const result = ledger.append({ ...event, expectedVersion: null })
      if (result.inserted) inserted += 1
      else skipped += 1
    } catch (error) {
      failed.push({
        eventId: event.eventId,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  const report: LedgerSyncReport = {
    filename: ledger.filename,
    attempted: events.length,
    inserted,
    skipped,
    failed,
    latestSequence: ledger.latestSequence(),
  }
  if (owned) ledger.close()
  return report
}

/** Re-append is a no-op for duplicate eventIds — proves crash-safe sync. */
export function verifyLedgerIdempotency(
  outbox: AgenticOutboxEntry[],
  filename: string,
): { first: LedgerSyncReport; second: LedgerSyncReport } {
  const first = appendOutboxToLedger(outbox, { filename })
  const second = appendOutboxToLedger(outbox, { filename })
  return { first, second }
}
