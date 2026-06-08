import { Database } from "bun:sqlite";
import type { CalEvent, ResolvedEvent } from "@cango/core";

export interface SourceStatus {
  id: string;
  lastSuccessAt: number | null;
  lastError: string | null;
  lastErrorAt: number | null;
}

interface EventRow {
  id: string;
  source_id: string;
  person_id: string;
  series_id: string | null;
  start_ms: number;
  end_ms: number;
  title: string;
  all_day: number;
  raw_json: string;
  fetched_at: number;
}

interface ResolvedRow {
  resolved_json: string;
}

export class Cache {
  private readonly db: Database;

  constructor(path: string) {
    this.db = new Database(path, { create: true });
    this.db.run("PRAGMA journal_mode = WAL");
    this.db.run("PRAGMA foreign_keys = ON");
    this.migrate();
  }

  private migrate(): void {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS sources (
        id TEXT PRIMARY KEY,
        last_success_at INTEGER,
        last_error TEXT,
        last_error_at INTEGER
      )
    `);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS events (
        id TEXT NOT NULL,
        source_id TEXT NOT NULL,
        person_id TEXT NOT NULL,
        series_id TEXT,
        start_ms INTEGER NOT NULL,
        end_ms INTEGER NOT NULL,
        title TEXT NOT NULL,
        all_day INTEGER NOT NULL DEFAULT 0,
        raw_json TEXT NOT NULL,
        fetched_at INTEGER NOT NULL,
        PRIMARY KEY (source_id, id)
      )
    `);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_events_window ON events (start_ms, end_ms)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_events_person ON events (person_id)`);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS resolved_cache (
        event_id TEXT NOT NULL,
        source_id TEXT NOT NULL,
        family_version TEXT NOT NULL,
        rules_version TEXT NOT NULL,
        resolved_json TEXT NOT NULL,
        PRIMARY KEY (source_id, event_id, family_version, rules_version)
      )
    `);
  }

  close(): void {
    this.db.close();
  }

  /** Replace all cached events for a source with a fresh fetch. */
  replaceSourceEvents(sourceId: string, events: CalEvent[], fetchedAt = Date.now()): void {
    const tx = this.db.transaction((rows: CalEvent[]) => {
      this.db.run("DELETE FROM events WHERE source_id = ?", [sourceId]);
      const insert = this.db.prepare(`
        INSERT INTO events
          (id, source_id, person_id, series_id, start_ms, end_ms, title, all_day, raw_json, fetched_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const e of rows) {
        insert.run(
          e.id,
          e.sourceId,
          e.personId,
          e.seriesId ?? null,
          e.start.getTime(),
          e.end.getTime(),
          e.title,
          e.allDay ? 1 : 0,
          JSON.stringify(serializeEvent(e)),
          fetchedAt,
        );
      }
      // Source events changed → invalidate this source's resolved cache.
      this.db.run("DELETE FROM resolved_cache WHERE source_id = ?", [sourceId]);
    });
    tx(events);
  }

  eventsInWindow(start: Date, end: Date, personIds?: string[]): CalEvent[] {
    const startMs = start.getTime();
    const endMs = end.getTime();
    let sql =
      "SELECT * FROM events WHERE start_ms < ? AND end_ms > ?";
    const params: (number | string)[] = [endMs, startMs];
    if (personIds && personIds.length > 0) {
      sql += ` AND person_id IN (${personIds.map(() => "?").join(",")})`;
      params.push(...personIds);
    }
    sql += " ORDER BY start_ms ASC";
    const rows = this.db.query(sql).all(...params) as EventRow[];
    return rows.map(rowToEvent);
  }

  recentSeries(
    sourceId: string,
    limit = 50,
  ): Array<{ seriesId: string; title: string; lastStartMs: number; count: number }> {
    const rows = this.db
      .query(
        `SELECT series_id AS seriesId, title,
                MAX(start_ms) AS lastStartMs, COUNT(*) AS count
         FROM events
         WHERE source_id = ? AND series_id IS NOT NULL
         GROUP BY series_id
         ORDER BY lastStartMs DESC
         LIMIT ?`,
      )
      .all(sourceId, limit) as Array<{
      seriesId: string;
      title: string;
      lastStartMs: number;
      count: number;
    }>;
    return rows;
  }

  getResolved(
    sourceId: string,
    eventId: string,
    familyVersion: string,
    rulesVersion: string,
  ): ResolvedEvent | null {
    const row = this.db
      .query(
        `SELECT resolved_json FROM resolved_cache
         WHERE source_id = ? AND event_id = ? AND family_version = ? AND rules_version = ?`,
      )
      .get(sourceId, eventId, familyVersion, rulesVersion) as ResolvedRow | null;
    if (!row) return null;
    return deserializeResolved(row.resolved_json);
  }

  putResolved(
    familyVersion: string,
    rulesVersion: string,
    resolved: ResolvedEvent,
  ): void {
    this.db.run(
      `INSERT OR REPLACE INTO resolved_cache
         (event_id, source_id, family_version, rules_version, resolved_json)
       VALUES (?, ?, ?, ?, ?)`,
      [
        resolved.id,
        resolved.sourceId,
        familyVersion,
        rulesVersion,
        JSON.stringify(serializeResolved(resolved)),
      ],
    );
  }

  clearResolvedCache(): void {
    this.db.run("DELETE FROM resolved_cache");
  }

  markSuccess(sourceId: string, at = Date.now()): void {
    this.db.run(
      `INSERT INTO sources (id, last_success_at, last_error, last_error_at)
       VALUES (?, ?, NULL, NULL)
       ON CONFLICT(id) DO UPDATE SET last_success_at = excluded.last_success_at,
                                     last_error = NULL, last_error_at = NULL`,
      [sourceId, at],
    );
  }

  markError(sourceId: string, error: string, at = Date.now()): void {
    this.db.run(
      `INSERT INTO sources (id, last_success_at, last_error, last_error_at)
       VALUES (?, NULL, ?, ?)
       ON CONFLICT(id) DO UPDATE SET last_error = excluded.last_error,
                                     last_error_at = excluded.last_error_at`,
      [sourceId, error, at],
    );
  }

  sourceStatuses(): SourceStatus[] {
    const rows = this.db
      .query(
        `SELECT id, last_success_at AS lastSuccessAt,
                last_error AS lastError, last_error_at AS lastErrorAt
         FROM sources ORDER BY id`,
      )
      .all() as SourceStatus[];
    return rows;
  }
}

interface SerializedEvent {
  id: string;
  sourceId: string;
  personId: string;
  seriesId?: string;
  title: string;
  start: string;
  end: string;
  allDay: boolean;
  rsvpStatus?: CalEvent["rsvpStatus"];
  organizerIsSelf?: boolean;
  attendeeCount?: number;
  recurring?: boolean;
}

function serializeEvent(e: CalEvent): SerializedEvent {
  return {
    id: e.id,
    sourceId: e.sourceId,
    personId: e.personId,
    ...(e.seriesId !== undefined ? { seriesId: e.seriesId } : {}),
    title: e.title,
    start: e.start.toISOString(),
    end: e.end.toISOString(),
    allDay: e.allDay,
    ...(e.rsvpStatus !== undefined ? { rsvpStatus: e.rsvpStatus } : {}),
    ...(e.organizerIsSelf !== undefined ? { organizerIsSelf: e.organizerIsSelf } : {}),
    ...(e.attendeeCount !== undefined ? { attendeeCount: e.attendeeCount } : {}),
    ...(e.recurring !== undefined ? { recurring: e.recurring } : {}),
  };
}

function deserializeEvent(s: SerializedEvent): CalEvent {
  return {
    id: s.id,
    sourceId: s.sourceId,
    personId: s.personId,
    ...(s.seriesId !== undefined ? { seriesId: s.seriesId } : {}),
    title: s.title,
    start: new Date(s.start),
    end: new Date(s.end),
    allDay: s.allDay,
    ...(s.rsvpStatus !== undefined ? { rsvpStatus: s.rsvpStatus } : {}),
    ...(s.organizerIsSelf !== undefined ? { organizerIsSelf: s.organizerIsSelf } : {}),
    ...(s.attendeeCount !== undefined ? { attendeeCount: s.attendeeCount } : {}),
    ...(s.recurring !== undefined ? { recurring: s.recurring } : {}),
  };
}

function serializeResolved(e: ResolvedEvent): SerializedEvent & {
  resolvedRole: ResolvedEvent["resolvedRole"];
  resolvedBy: ResolvedEvent["resolvedBy"];
  resolvedReason: string;
  ruleId?: string;
} {
  return {
    ...serializeEvent(e),
    resolvedRole: e.resolvedRole,
    resolvedBy: e.resolvedBy,
    resolvedReason: e.resolvedReason,
    ...(e.ruleId !== undefined ? { ruleId: e.ruleId } : {}),
  };
}

function deserializeResolved(json: string): ResolvedEvent {
  const s = JSON.parse(json) as ReturnType<typeof serializeResolved>;
  return {
    ...deserializeEvent(s),
    resolvedRole: s.resolvedRole,
    resolvedBy: s.resolvedBy,
    resolvedReason: s.resolvedReason,
    ...(s.ruleId !== undefined ? { ruleId: s.ruleId } : {}),
  };
}

function rowToEvent(row: EventRow): CalEvent {
  return deserializeEvent(JSON.parse(row.raw_json) as SerializedEvent);
}
