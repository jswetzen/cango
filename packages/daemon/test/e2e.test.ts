import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cache } from "../src/cache.ts";
import { loadConfig, type LoadedConfig } from "../src/config.ts";
import { Refresher } from "../src/cron.ts";
import { RuleStore } from "../src/ruleStore.ts";
import { startServer, type SocketServer } from "../src/server.ts";
import { rpcCall } from "../src/client.ts";
import type { RpcContext } from "../src/rpc.ts";
import type { CalEvent } from "@cango/core";

const FAMILY_YAML = `
settings:
  refreshIntervalMinutes: 60
  maxStaleHours: 6
people:
  - id: p-me
    name: Me
    sourceIds: [src-work]
  - id: p-kid
    name: Kid
    sourceIds: [src-club]
organizations:
  - id: org-club
    name: Club
    sourceIds: [src-club]
sources:
  - id: src-work
    kind: ics
    ownedBy: person
    ownerId: p-me
    defaultRole: hard
    url: https://example.invalid/work.ics
  - id: src-club
    kind: ics
    ownedBy: organization
    ownerId: p-kid
    defaultRole: hard
    url: https://example.invalid/club.ics
attendance:
  - personId: p-kid
    seriesId: club-training
    role: ATTENDS
    reason: on the squad
`;

function event(p: Partial<CalEvent> & Pick<CalEvent, "id" | "title">): CalEvent {
  return {
    sourceId: "src-work",
    personId: "p-me",
    start: new Date("2026-06-01T10:00:00Z"),
    end: new Date("2026-06-01T11:00:00Z"),
    allDay: false,
    ...p,
  };
}

describe("daemon e2e over the socket", () => {
  let dir: string;
  let familyPath: string;
  let cache: Cache;
  let rules: RuleStore;
  let server: SocketServer;
  let socketPath: string;
  let config: LoadedConfig;
  let refresher: Refresher;
  let standupRuleId: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "cango-e2e-"));
    familyPath = join(dir, "family.yaml");
    socketPath = join(dir, "cango.sock");
    writeFileSync(familyPath, FAMILY_YAML);

    config = await loadConfig(familyPath);
    cache = new Cache(":memory:");
    rules = new RuleStore(":memory:");
    // Mirror main.ts: seed attendance edges, then add a soft standup rule.
    rules.seedFromAttendance(config.attendanceSeed);
    standupRuleId = rules.create({
      match: { titleRegex: "(?i)standup" },
      role: "soft",
      reason: "optional standup",
    }).id!;
    refresher = new Refresher(cache, config, { now: () => Date.now() });

    // Seed events directly — no network in e2e.
    cache.replaceSourceEvents("src-work", [
      event({ id: "w1", title: "Sprint review" }),
      event({ id: "w2", title: "Standup", start: new Date("2026-06-01T14:00:00Z"), end: new Date("2026-06-01T14:15:00Z") }),
      // Multi-day, mid-month so it stays out of the 1 June window other tests use.
      event({ id: "w3", title: "Conference", start: new Date("2026-06-12T18:00:00Z"), end: new Date("2026-06-14T19:00:00Z") }),
    ]);
    cache.replaceSourceEvents("src-club", [
      event({
        id: "c1",
        title: "Training",
        sourceId: "src-club",
        personId: "p-kid",
        seriesId: "club-training",
        start: new Date("2026-06-01T16:00:00Z"),
        end: new Date("2026-06-01T17:00:00Z"),
      }),
    ]);
    cache.markSuccess("src-work");
    cache.markSuccess("src-club");

    const ctx: RpcContext = {
      cache,
      getConfig: () => config,
      rules,
      refresher,
      reload: async () => {
        config = await loadConfig(familyPath);
        refresher.setConfig(config);
        cache.clearResolvedCache();
      },
    };
    server = startServer(socketPath, ctx);
  });

  afterEach(() => {
    server.stop();
    cache.close();
    rules.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("health reports source freshness and not degraded", async () => {
    const res = (await rpcCall(socketPath, "health")) as {
      ok: boolean;
      degraded: boolean;
      source_freshness: Record<string, string | null>;
    };
    expect(res.ok).toBe(true);
    expect(res.degraded).toBe(false);
    expect(res.source_freshness["src-work"]).not.toBeNull();
  });

  test("checkAvailability returns hard_conflict for the work meeting", async () => {
    const res = (await rpcCall(socketPath, "checkAvailability", {
      start: "2026-06-01T09:00:00Z",
      end: "2026-06-01T12:00:00Z",
      people: ["p-me"],
    })) as { verdict: string; conflicts: unknown[] };
    expect(res.verdict).toBe("hard_conflict");
    expect(res.conflicts).toHaveLength(1);
  });

  test("rule downgrades standup to soft_conflict", async () => {
    const res = (await rpcCall(socketPath, "checkAvailability", {
      start: "2026-06-01T13:30:00Z",
      end: "2026-06-01T15:00:00Z",
      people: ["p-me"],
    })) as { verdict: string };
    expect(res.verdict).toBe("soft_conflict");
  });

  test("seeded ATTENDS rule makes the club training a hard conflict for the kid", async () => {
    const res = (await rpcCall(socketPath, "checkAvailability", {
      start: "2026-06-01T15:30:00Z",
      end: "2026-06-01T18:00:00Z",
      people: ["p-kid"],
    })) as { verdict: string };
    expect(res.verdict).toBe("hard_conflict");
  });

  test("findFreeSlot returns gaps around the work meeting", async () => {
    const res = (await rpcCall(socketPath, "findFreeSlot", {
      duration_minutes: 30,
      between: { start: "2026-06-01T09:00:00Z", end: "2026-06-01T12:00:00Z" },
      people: ["p-me"],
    })) as { slots: Array<{ start: string; end: string }> };
    // No timezone configured -> default UTC, formatted to second resolution.
    expect(res.slots).toEqual([
      { start: "2026-06-01T09:00:00Z", end: "2026-06-01T10:00:00Z" },
      { start: "2026-06-01T11:00:00Z", end: "2026-06-01T12:00:00Z" },
    ]);
  });

  test("explainEvent returns a resolution trace", async () => {
    const res = (await rpcCall(socketPath, "explainEvent", { event_id: "w2" })) as {
      resolved: { resolved_role: string; resolved_by: string };
      trace: Array<{ layer: string }>;
    };
    expect(res.resolved.resolved_role).toBe("soft");
    expect(res.resolved.resolved_by).toBe("rule");
    expect(res.trace.map((t) => t.layer)).toContain("rule");
  });

  test("listSeries surfaces the club training series", async () => {
    const res = (await rpcCall(socketPath, "listSeries", { source_id: "src-club" })) as {
      series: Array<{ series_id: string; count: number }>;
    };
    expect(res.series.some((s) => s.series_id === "club-training")).toBe(true);
  });

  test("listEvents returns resolved roles (extended exposes ids)", async () => {
    const res = (await rpcCall(socketPath, "listEvents", {
      start: "2026-06-01T00:00:00Z",
      end: "2026-06-02T00:00:00Z",
      people: ["p-me"],
      extended: true,
    })) as { events: Array<{ id: string; resolved_role: string }> };
    const ids = res.events.map((e) => e.id).sort();
    expect(ids).toEqual(["w1", "w2"]);
  });

  test("listEvents is compact by default: no ids, default verdicts trimmed", async () => {
    const res = (await rpcCall(socketPath, "listEvents", {
      start: "2026-06-01T00:00:00Z",
      end: "2026-06-02T00:00:00Z",
      people: ["p-me"],
    })) as {
      events: Array<{
        id?: string;
        series_id?: string;
        title: string;
        resolved_role: string;
        resolved_by?: string;
      }>;
      total: number;
      returned: number;
      truncated: boolean;
    };
    expect(res.total).toBe(2);
    expect(res.returned).toBe(2);
    expect(res.truncated).toBe(false);
    for (const e of res.events) {
      expect(e.id).toBeUndefined();
      expect(e.series_id).toBeUndefined();
    }
    const sprint = res.events.find((e) => e.title === "Sprint review");
    const standup = res.events.find((e) => e.title === "Standup");
    // Plain source-default verdict: boilerplate dropped.
    expect(sprint?.resolved_by).toBeUndefined();
    // Rule-decided verdict: kept even in compact mode.
    expect(standup?.resolved_by).toBe("rule");
  });

  test("listEvents flags multi-day events with day_span", async () => {
    const res = (await rpcCall(socketPath, "listEvents", {
      start: "2026-06-12T00:00:00Z",
      end: "2026-06-15T00:00:00Z",
      people: ["p-me"],
    })) as { events: Array<{ title: string; day_span?: number }> };
    const conf = res.events.find((e) => e.title === "Conference");
    expect(conf?.day_span).toBe(3); // Fri→Sun
    // Same-day events carry no day_span.
    const sameDay = (await rpcCall(socketPath, "listEvents", {
      start: "2026-06-01T00:00:00Z",
      end: "2026-06-02T00:00:00Z",
      people: ["p-me"],
    })) as { events: Array<{ day_span?: number }> };
    expect(sameDay.events.every((e) => e.day_span === undefined)).toBe(true);
  });

  test("listEvents exclude_roles drops matching events", async () => {
    const res = (await rpcCall(socketPath, "listEvents", {
      start: "2026-06-01T00:00:00Z",
      end: "2026-06-02T00:00:00Z",
      people: ["p-me"],
      exclude_roles: ["soft"],
    })) as { events: Array<{ title: string }>; total: number };
    expect(res.total).toBe(1);
    expect(res.events.map((e) => e.title)).toEqual(["Sprint review"]);
  });

  test("listEvents paginates with limit/offset", async () => {
    const page1 = (await rpcCall(socketPath, "listEvents", {
      start: "2026-06-01T00:00:00Z",
      end: "2026-06-02T00:00:00Z",
      people: ["p-me"],
      limit: 1,
    })) as { events: Array<{ title: string }>; total: number; returned: number; truncated: boolean };
    expect(page1.total).toBe(2);
    expect(page1.returned).toBe(1);
    expect(page1.truncated).toBe(true);
    expect(page1.events[0]?.title).toBe("Sprint review"); // earliest start

    const page2 = (await rpcCall(socketPath, "listEvents", {
      start: "2026-06-01T00:00:00Z",
      end: "2026-06-02T00:00:00Z",
      people: ["p-me"],
      limit: 1,
      offset: 1,
    })) as { events: Array<{ title: string }>; truncated: boolean };
    expect(page2.events[0]?.title).toBe("Standup");
    expect(page2.truncated).toBe(false);
  });

  test("amendRule live-changes a verdict (and invalidates the resolved cache)", async () => {
    // Standup is soft as seeded.
    let res = (await rpcCall(socketPath, "checkAvailability", {
      start: "2026-06-01T13:30:00Z",
      end: "2026-06-01T15:00:00Z",
      people: ["p-me"],
    })) as { verdict: string };
    expect(res.verdict).toBe("soft_conflict");

    // Promote the standup rule to hard via the mutation RPC.
    await rpcCall(socketPath, "amendRule", { id: standupRuleId, role: "hard" });

    res = (await rpcCall(socketPath, "checkAvailability", {
      start: "2026-06-01T13:30:00Z",
      end: "2026-06-01T15:00:00Z",
      people: ["p-me"],
    })) as { verdict: string };
    expect(res.verdict).toBe("hard_conflict");
  });

  test("listRules / createRule / forget via retractRule round-trip", async () => {
    const before = (await rpcCall(socketPath, "listRules")) as { rules: Array<{ id: string }> };
    const created = (await rpcCall(socketPath, "createRule", {
      match: { title_regex: "(?i)lunch" },
      role: "info",
      reason: "lunch is not a meeting",
    })) as { rule: { id: string; role: string; effect: string } };
    expect(created.rule.role).toBe("info");
    expect(created.rule.effect).toBe("self");

    const after = (await rpcCall(socketPath, "listRules")) as { rules: Array<{ id: string }> };
    expect(after.rules.length).toBe(before.rules.length + 1);

    await rpcCall(socketPath, "retractRule", { id: created.rule.id });
    const active = (await rpcCall(socketPath, "listRules")) as { rules: Array<{ id: string }> };
    expect(active.rules.find((r) => r.id === created.rule.id)).toBeUndefined();
    const all = (await rpcCall(socketPath, "listRules", { include_retracted: true })) as {
      rules: Array<{ id: string }>;
    };
    expect(all.rules.find((r) => r.id === created.rule.id)).toBeDefined();
  });

  test("OOO mask demotes a same-source meeting to free", async () => {
    // Add a vacation marker on src-work spanning 1 June, and a mask rule.
    cache.replaceSourceEvents("src-work", [
      event({
        id: "vac",
        title: "Vacation",
        allDay: true,
        start: new Date("2026-06-01T00:00:00Z"),
        end: new Date("2026-06-02T00:00:00Z"),
      }),
      event({ id: "mtg", title: "Sprint review" }),
    ]);
    await rpcCall(socketPath, "createRule", {
      match: { source_id: "src-work", title_regex: "(?i)vacation" },
      role: "info",
      effect: "mask",
      reason: "out of office",
    });
    const res = (await rpcCall(socketPath, "checkAvailability", {
      start: "2026-06-01T09:00:00Z",
      end: "2026-06-01T12:00:00Z",
      people: ["p-me"],
    })) as { verdict: string };
    expect(res.verdict).toBe("free");
  });

  test("unknown method returns an RPC error", async () => {
    await expect(rpcCall(socketPath, "nope")).rejects.toThrow(/method not found/);
  });
});
