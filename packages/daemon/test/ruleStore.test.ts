import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RuleStore } from "../src/ruleStore.ts";

describe("RuleStore", () => {
  let store: RuleStore;

  beforeEach(() => {
    store = new RuleStore(":memory:");
  });
  afterEach(() => store.close());

  test("create returns a rule with a stable id and timestamps", () => {
    const r = store.create({
      match: { titleRegex: "(?i)standup" },
      role: "soft",
      reason: "standups optional",
    });
    expect(r.id).toBeTruthy();
    expect(r.effect).toBe("self");
    expect(r.createdAt).toBeGreaterThan(0);
    expect(store.active()).toHaveLength(1);
  });

  test("amend keeps the id stable and changes the version", () => {
    const r = store.create({ match: { titleRegex: "x" }, role: "soft", reason: "a" });
    const v1 = store.version();
    const amended = store.amend(r.id!, { role: "hard" });
    expect(amended.id).toBe(r.id!);
    expect(amended.role).toBe("hard");
    expect(store.version()).not.toBe(v1);
  });

  test("retract soft-deletes: drops from active() but stays in list(true)", () => {
    const r = store.create({ match: { titleRegex: "x" }, role: "soft", reason: "a" });
    store.retract(r.id!);
    expect(store.active()).toHaveLength(0);
    expect(store.list(true)).toHaveLength(1);
    expect(store.list(true)[0]!.retractedAt).toBeGreaterThan(0);
  });

  test("amending a retracted rule throws", () => {
    const r = store.create({ match: { titleRegex: "x" }, role: "soft", reason: "a" });
    store.retract(r.id!);
    expect(() => store.amend(r.id!, { role: "hard" })).toThrow(/retracted/);
  });

  test("version is content-addressed over active rules", () => {
    const empty = store.version();
    store.create({ match: { titleRegex: "x" }, role: "soft", reason: "a" });
    expect(store.version()).not.toBe(empty);
  });

  test("fanout rule round-trips occupants", () => {
    const r = store.create({
      match: { seriesId: "lager" },
      role: "soft",
      effect: "fanout",
      occupants: ["eli", "jona", "family"],
      reason: "family may attend",
    });
    expect(r.effect).toBe("fanout");
    expect(r.occupants).toEqual(["eli", "jona", "family"]);
    expect(store.active()[0]!.occupants).toEqual(["eli", "jona", "family"]);
  });

  test("amend can change and clear occupants", () => {
    const r = store.create({
      match: { seriesId: "s" },
      role: "soft",
      effect: "fanout",
      occupants: ["eli"],
      reason: "x",
    });
    expect(store.amend(r.id!, { occupants: ["jona", "sara"] }).occupants).toEqual([
      "jona",
      "sara",
    ]);
    // Empty array clears it (becomes undefined).
    expect(store.amend(r.id!, { occupants: [] }).occupants).toBeUndefined();
  });

  test("seedFromAttendance maps roles and runs exactly once", () => {
    const n = store.seedFromAttendance([
      { personId: "p-kid", seriesId: "u11", role: "ATTENDS", reason: "on the squad" },
      { personId: "p-kid", seriesId: "u9", role: "NEVER_ATTENDS" },
      { personId: "p-me", seriesId: "sync", role: "SOMETIMES_ATTENDS" },
    ]);
    expect(n).toBe(3);
    const byMatch = (sid: string) =>
      store.active().find((r) => r.match.seriesId === sid)!;
    expect(byMatch("u11").role).toBe("inherit");
    expect(byMatch("u9").role).toBe("info");
    expect(byMatch("sync").role).toBe("soft");

    // Second call is a no-op (seeded flag).
    const again = store.seedFromAttendance([
      { personId: "p-x", seriesId: "y", role: "ATTENDS" },
    ]);
    expect(again).toBe(0);
    expect(store.active()).toHaveLength(3);
  });

  test("a stored rule row with role 'conditional' reads back as 'info'", () => {
    const dir = mkdtempSync(join(tmpdir(), "cango-rules-cond-"));
    const path = join(dir, "state.db");
    try {
      // Create the schema via RuleStore, then plant a row with the removed role.
      const seeded = new RuleStore(path);
      seeded.close();

      const raw = new Database(path, { create: true });
      raw.run(
        `INSERT INTO rules (id, match_json, role, effect, occupants_json, reason, created_at, updated_at, retracted_at)
         VALUES ('cond', '{"seriesId":"s"}', 'conditional', 'self', NULL, 'legacy conditional', 1, 1, NULL)`,
      );
      raw.close();

      const store = new RuleStore(path);
      const rule = store.get("cond")!;
      expect(rule.role).toBe("info");
      expect(store.active()[0]!.role).toBe("info");
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("v1 → v2 migration adds occupants_json and keeps existing rules", () => {
    const dir = mkdtempSync(join(tmpdir(), "cango-rules-"));
    const path = join(dir, "state.db");
    try {
      // Hand-build a v1 schema (no occupants_json) with one rule.
      const raw = new Database(path, { create: true });
      raw.run(`
        CREATE TABLE rules (
          id TEXT PRIMARY KEY, match_json TEXT NOT NULL, role TEXT NOT NULL,
          effect TEXT NOT NULL DEFAULT 'self', reason TEXT NOT NULL,
          created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, retracted_at INTEGER
        )`);
      raw.run(`CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)`);
      raw.run(`INSERT INTO meta (key, value) VALUES ('schema_version', '1')`);
      raw.run(
        `INSERT INTO rules (id, match_json, role, effect, reason, created_at, updated_at, retracted_at)
         VALUES ('r1', '{"seriesId":"s"}', 'soft', 'self', 'old rule', 1, 1, NULL)`,
      );
      raw.close();

      // Opening through RuleStore must migrate in place.
      const migrated = new RuleStore(path);
      const rules = migrated.active();
      expect(rules).toHaveLength(1);
      expect(rules[0]!.id).toBe("r1");
      expect(rules[0]!.occupants).toBeUndefined(); // null column → no occupants
      // New fanout rules work post-migration.
      const f = migrated.create({
        match: { seriesId: "t" },
        role: "soft",
        effect: "fanout",
        occupants: ["eli"],
        reason: "y",
      });
      expect(migrated.get(f.id!)!.occupants).toEqual(["eli"]);
      migrated.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
