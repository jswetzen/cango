import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import type { Rule, RuleEffect, RuleMatch, RuleRole } from "@cango/core";

const SCHEMA_VERSION = 1;

/** What a caller supplies to create a rule. */
export interface RuleInput {
  match: RuleMatch;
  role: RuleRole;
  effect?: RuleEffect;
  reason: string;
}

/** Partial patch for an in-place amend. */
export interface RulePatch {
  match?: RuleMatch;
  role?: RuleRole;
  effect?: RuleEffect;
  reason?: string;
}

/** A former attendance edge, as parsed from family.yaml, for one-time seeding. */
export interface SeedEdge {
  personId: string;
  seriesId: string;
  role: "ATTENDS" | "SOMETIMES_ATTENDS" | "NEVER_ATTENDS";
  // `| undefined` (not just `?`) so the parsed family.yaml attendance type,
  // whose reason is `string | undefined`, is assignable under
  // exactOptionalPropertyTypes.
  reason?: string | undefined;
}

interface RuleRow {
  id: string;
  match_json: string;
  role: string;
  effect: string;
  reason: string;
  created_at: number;
  updated_at: number;
  retracted_at: number | null;
}

/**
 * The durable, agent-owned rule store — a *separate* SQLite file from the
 * disposable event cache. Rules created/amended/retracted at runtime (via the
 * MCP tools → daemon RPCs) live here and survive restarts and redeploys. Soft
 * delete keeps a tombstone (`retracted_at`) so retraction is auditable and
 * undoable. The daemon is the only writer, so single-writer SQLite is enough.
 */
export class RuleStore {
  private readonly db: Database;

  constructor(path: string) {
    this.db = new Database(path, { create: true });
    this.db.run("PRAGMA journal_mode = WAL");
    this.migrate();
  }

  private migrate(): void {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS rules (
        id           TEXT PRIMARY KEY,
        match_json   TEXT NOT NULL,
        role         TEXT NOT NULL,
        effect       TEXT NOT NULL DEFAULT 'self',
        reason       TEXT NOT NULL,
        created_at   INTEGER NOT NULL,
        updated_at   INTEGER NOT NULL,
        retracted_at INTEGER
      )
    `);
    this.db.run(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)`);
    if (this.getMeta("schema_version") === null) {
      this.setMeta("schema_version", String(SCHEMA_VERSION));
    }
    // Future migrations: read schema_version, apply stepwise, bump it.
  }

  close(): void {
    this.db.close();
  }

  private getMeta(key: string): string | null {
    const row = this.db.query("SELECT value FROM meta WHERE key = ?").get(key) as
      | { value: string }
      | null;
    return row ? row.value : null;
  }

  private setMeta(key: string, value: string): void {
    this.db.run(
      `INSERT INTO meta (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      [key, value],
    );
  }

  /** Active (non-retracted) rules, as core `Rule` objects. */
  active(): Rule[] {
    const rows = this.db
      .query("SELECT * FROM rules WHERE retracted_at IS NULL ORDER BY created_at ASC")
      .all() as RuleRow[];
    return rows.map(rowToRule);
  }

  /** All rules, optionally including retracted tombstones (for inspection). */
  list(includeRetracted = false): Rule[] {
    const sql = includeRetracted
      ? "SELECT * FROM rules ORDER BY created_at ASC"
      : "SELECT * FROM rules WHERE retracted_at IS NULL ORDER BY created_at ASC";
    return (this.db.query(sql).all() as RuleRow[]).map(rowToRule);
  }

  get(id: string): Rule | null {
    const row = this.db.query("SELECT * FROM rules WHERE id = ?").get(id) as RuleRow | null;
    return row ? rowToRule(row) : null;
  }

  create(input: RuleInput, now = Date.now()): Rule {
    const id = randomUUID();
    this.db.run(
      `INSERT INTO rules (id, match_json, role, effect, reason, created_at, updated_at, retracted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
      [id, JSON.stringify(input.match), input.role, input.effect ?? "self", input.reason, now, now],
    );
    return this.get(id)!;
  }

  /** Amend in place — id is stable so anything referring to it survives. */
  amend(id: string, patch: RulePatch, now = Date.now()): Rule {
    const existing = this.db.query("SELECT * FROM rules WHERE id = ?").get(id) as RuleRow | null;
    if (!existing) throw new Error(`unknown rule: ${id}`);
    if (existing.retracted_at !== null) throw new Error(`cannot amend retracted rule: ${id}`);
    const match = patch.match !== undefined ? JSON.stringify(patch.match) : existing.match_json;
    const role = patch.role ?? existing.role;
    const effect = patch.effect ?? existing.effect;
    const reason = patch.reason ?? existing.reason;
    this.db.run(
      `UPDATE rules SET match_json = ?, role = ?, effect = ?, reason = ?, updated_at = ? WHERE id = ?`,
      [match, role, effect, reason, now, id],
    );
    return this.get(id)!;
  }

  /** Soft delete: stamp a tombstone so the rule stops applying but is auditable. */
  retract(id: string, now = Date.now()): Rule {
    const existing = this.get(id);
    if (!existing) throw new Error(`unknown rule: ${id}`);
    this.db.run("UPDATE rules SET retracted_at = ?, updated_at = ? WHERE id = ?", [now, now, id]);
    return this.get(id)!;
  }

  /**
   * Content hash of the active rules — used as the cache key version so the
   * daemon's resolved_cache invalidates whenever a rule changes.
   */
  version(): string {
    return createHash("sha1").update(JSON.stringify(this.active())).digest("hex").slice(0, 16);
  }

  /**
   * One-time migration of family.yaml attendance edges into the store. Guarded
   * by a `seeded` meta flag so it runs exactly once, even with zero edges.
   * Returns the number of rules created.
   */
  seedFromAttendance(edges: SeedEdge[], now = Date.now()): number {
    if (this.getMeta("seeded") === "1") return 0;
    let created = 0;
    for (const e of edges) {
      const role: RuleRole =
        e.role === "ATTENDS" ? "inherit" : e.role === "SOMETIMES_ATTENDS" ? "soft" : "info";
      this.create(
        {
          match: { personId: e.personId, seriesId: e.seriesId },
          role,
          reason: e.reason ?? `${e.role} ${e.seriesId}`,
        },
        now,
      );
      created += 1;
    }
    this.setMeta("seeded", "1");
    return created;
  }
}

function rowToRule(row: RuleRow): Rule {
  const rule: Rule = {
    id: row.id,
    match: JSON.parse(row.match_json) as RuleMatch,
    role: row.role as RuleRole,
    effect: row.effect as RuleEffect,
    reason: row.reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  if (row.retracted_at !== null) rule.retractedAt = row.retracted_at;
  return rule;
}
