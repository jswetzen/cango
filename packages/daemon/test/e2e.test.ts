import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cache } from "../src/cache.ts";
import { loadConfig, type LoadedConfig } from "../src/config.ts";
import { Refresher } from "../src/cron.ts";
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

const RULES_SOFT = `
rules:
  - id: standup-soft
    match:
      titleRegex: "(?i)standup"
    role: soft
    reason: optional standup
`;

const RULES_HARD = `
rules:
  - id: standup-hard
    match:
      titleRegex: "(?i)standup"
    role: hard
    reason: mandatory now
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
  let rulesPath: string;
  let cache: Cache;
  let server: SocketServer;
  let socketPath: string;
  let config: LoadedConfig;
  let refresher: Refresher;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "cango-e2e-"));
    familyPath = join(dir, "family.yaml");
    rulesPath = join(dir, "rules.yaml");
    socketPath = join(dir, "cango.sock");
    writeFileSync(familyPath, FAMILY_YAML);
    writeFileSync(rulesPath, RULES_SOFT);

    config = await loadConfig(familyPath, rulesPath);
    cache = new Cache(":memory:");
    refresher = new Refresher(cache, config, { now: () => Date.now() });

    // Seed events directly — no network in e2e.
    cache.replaceSourceEvents("src-work", [
      event({ id: "w1", title: "Sprint review" }),
      event({ id: "w2", title: "Standup", start: new Date("2026-06-01T14:00:00Z"), end: new Date("2026-06-01T14:15:00Z") }),
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
      refresher,
      reload: async () => {
        config = await loadConfig(familyPath, rulesPath);
        refresher.setConfig(config);
        cache.clearResolvedCache();
      },
    };
    server = startServer(socketPath, ctx);
  });

  afterEach(() => {
    server.stop();
    cache.close();
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

  test("attendance ATTENDS makes the club training a hard conflict for the kid", async () => {
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

  test("listEvents returns resolved roles", async () => {
    const res = (await rpcCall(socketPath, "listEvents", {
      start: "2026-06-01T00:00:00Z",
      end: "2026-06-02T00:00:00Z",
      people: ["p-me"],
    })) as { events: Array<{ id: string; resolved_role: string }> };
    const ids = res.events.map((e) => e.id).sort();
    expect(ids).toEqual(["w1", "w2"]);
  });

  test("reloadConfig hot-swaps rules and changes the verdict", async () => {
    // Standup is soft under RULES_SOFT.
    let res = (await rpcCall(socketPath, "checkAvailability", {
      start: "2026-06-01T13:30:00Z",
      end: "2026-06-01T15:00:00Z",
      people: ["p-me"],
    })) as { verdict: string };
    expect(res.verdict).toBe("soft_conflict");

    // Swap rules on disk, reload.
    writeFileSync(rulesPath, RULES_HARD);
    await rpcCall(socketPath, "reloadConfig");

    res = (await rpcCall(socketPath, "checkAvailability", {
      start: "2026-06-01T13:30:00Z",
      end: "2026-06-01T15:00:00Z",
      people: ["p-me"],
    })) as { verdict: string };
    expect(res.verdict).toBe("hard_conflict");
  });

  test("unknown method returns an RPC error", async () => {
    await expect(rpcCall(socketPath, "nope")).rejects.toThrow(/method not found/);
  });
});
