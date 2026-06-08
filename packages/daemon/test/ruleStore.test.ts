import { afterEach, beforeEach, describe, expect, test } from "bun:test";
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
});
