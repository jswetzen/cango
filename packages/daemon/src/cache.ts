import { Database } from "bun:sqlite";
import type { CalEvent, Occupant, ResolvedEvent } from "@cango/core";

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
  /** JSON array of person ids matched from ATTENDEE props; "[]" when none. Kept
   * as a column (not just inside raw_json) so the person filter can widen to
   * events that occupy a requested person via ATTENDEE, not only ownership. */
  attendee_ids_json: string;
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
        attendee_ids_json TEXT NOT NULL DEFAULT '[]',
        raw_json TEXT NOT NULL,
        fetched_at INTEGER NOT NULL,
        PRIMARY KEY (source_id, id)
      )
    `);
    // Add attendee_ids_json to pre-existing event tables (the cache is
    // disposable, but ALTER avoids a forced full refetch on upgrade).
    if (!this.hasColumn("events", "attendee_ids_json")) {
      this.db.run(`ALTER TABLE events ADD COLUMN attendee_ids_json TEXT NOT NULL DEFAULT '[]'`);
    }
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

  private hasColumn(table: string, column: string): boolean {
    const cols = this.db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    return cols.some((c) => c.name === column);
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
          (id, source_id, person_id, series_id, start_ms, end_ms, title, all_day,
           attendee_ids_json, raw_json, fetched_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
          JSON.stringify(e.attendeeIds ?? []),
          JSON.stringify(serializeEvent(e)),
          fetchedAt,
        );
      }
      // Source events changed → invalidate this source's resolved cache.
      this.db.run("DELETE FROM resolved_cache WHERE source_id = ?", [sourceId]);
    });
    tx(events);
  }

  /**
   * Events overlapping [start,end). When `personIds` is given the query narrows
   * to events that *might* occupy one of those people — but occupancy is no
   * longer just `person_id`: an event can occupy people via ATTENDEE matches
   * (`attendee_ids_json`) or, more elusively, via a `fanout` rule whose targets
   * aren't stored on the row at all. So when `fanoutActive` is true the SQL
   * person filter is dropped entirely and the caller filters precisely on the
   * resolved `occupants` after `applyFanout`. Without fanout rules we can still
   * filter cheaply in SQL on ownership OR a stored attendee match.
   */
  eventsInWindow(
    start: Date,
    end: Date,
    personIds?: string[],
    fanoutActive = false,
  ): CalEvent[] {
    const startMs = start.getTime();
    const endMs = end.getTime();
    let sql = "SELECT * FROM events WHERE start_ms < ? AND end_ms > ?";
    const params: (number | string)[] = [endMs, startMs];
    if (personIds && personIds.length > 0 && !fanoutActive) {
      // Owner is the person, OR the person appears in the stored attendee ids.
      // The attendee match is a JSON-substring LIKE on the JSON-quoted id; the
      // quotes prevent one id being a prefix/substring of another. LIKE wildcards
      // (`%`/`_`) in an id would otherwise over-match, so escape them and declare
      // an ESCAPE char — ids are our own slugs but we don't rely on that.
      const placeholders = personIds.map(() => "?").join(",");
      const attendeeClauses = personIds
        .map(() => "attendee_ids_json LIKE ? ESCAPE '\\'")
        .join(" OR ");
      sql += ` AND (person_id IN (${placeholders}) OR ${attendeeClauses})`;
      params.push(...personIds);
      params.push(...personIds.map((id) => `%${escapeLike(JSON.stringify(id))}%`));
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
  attendeeIds?: string[];
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
    ...(e.attendeeIds !== undefined ? { attendeeIds: e.attendeeIds } : {}),
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
    ...(s.attendeeIds !== undefined ? { attendeeIds: s.attendeeIds } : {}),
    ...(s.recurring !== undefined ? { recurring: s.recurring } : {}),
  };
}

function serializeResolved(e: ResolvedEvent): SerializedEvent & {
  resolvedRole: ResolvedEvent["resolvedRole"];
  resolvedBy: ResolvedEvent["resolvedBy"];
  resolvedReason: string;
  ruleId?: string;
  occupants: Occupant[];
} {
  return {
    ...serializeEvent(e),
    resolvedRole: e.resolvedRole,
    resolvedBy: e.resolvedBy,
    resolvedReason: e.resolvedReason,
    occupants: e.occupants,
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
    // Back-compat: a cache row written before occupants existed resolves to the
    // owning person at the event's role.
    occupants: s.occupants ?? [{ personId: s.personId, role: s.resolvedRole }],
    ...(s.ruleId !== undefined ? { ruleId: s.ruleId } : {}),
  };
}

function rowToEvent(row: EventRow): CalEvent {
  const event = deserializeEvent(JSON.parse(row.raw_json) as SerializedEvent);
  // attendee_ids_json is the authoritative column (it's what the person filter
  // and migrations key off); fall back to whatever raw_json carried.
  const ids = parseIds(row.attendee_ids_json);
  if (ids.length > 0) event.attendeeIds = ids;
  return event;
}

/** Escape SQL LIKE metacharacters (`\`, `%`, `_`) for use with `ESCAPE '\'`. */
function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (m) => `\\${m}`);
}

function parseIds(json: string | null | undefined): string[] {
  if (!json) return [];
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}
