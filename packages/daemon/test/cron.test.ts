import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Cache } from "../src/cache.ts";
import { Refresher } from "../src/cron.ts";
import { buildFamily, type LoadedConfig } from "../src/config.ts";
import type { Adapters } from "../src/sources.ts";
import type { CalEvent } from "@cango/core";

function makeConfig(
  sourceIds: string[] = ["src-ics"],
  refreshIntervalMinutes = 60,
): LoadedConfig {
  const { family, connections, settings, attendanceSeed } = buildFamily({
    people: [{ id: "p-me", name: "Me", sourceIds }],
    organizations: [],
    sources: sourceIds.map((id) => ({
      id,
      kind: "ics" as const,
      defaultRole: "hard" as const,
      ownedBy: "person" as const,
      ownerId: "p-me",
      url: "https://example.invalid/cal.ics",
      writable: false,
    })),
    groups: [],
    attendance: [],
    settings: { refreshIntervalMinutes, maxStaleHours: 6, timezone: "UTC" },
  });
  return {
    family,
    connections,
    settings,
    personIdForSource: () => "p-me",
    resolveAttendeeIds: () => [],
    familyVersion: "fv",
    attendanceSeed,
    issues: [],
  };
}

function stubAdapters(events: CalEvent[], opts: { fail?: boolean } = {}): Adapters {
  return {
    fetchIcs: async () => {
      if (opts.fail) throw new Error("network down");
      return events;
    },
    fetchCalDav: async () => [],
    createCalDav: async () => "stub-uid",
  };
}

describe("Refresher", () => {
  let cache: Cache;
  beforeEach(() => {
    cache = new Cache(":memory:");
  });
  afterEach(() => cache.close());

  test("refreshOnce populates cache and marks success", async () => {
    const config = makeConfig();
    const event: CalEvent = {
      id: "e1",
      sourceId: "src-ics",
      personId: "p-me",
      title: "Mtg",
      start: new Date("2026-06-01T10:00:00Z"),
      end: new Date("2026-06-01T11:00:00Z"),
      allDay: false,
    };
    const refresher = new Refresher(cache, config, {
      adapters: stubAdapters([event]),
      now: () => 1_000,
    });
    await refresher.refreshOnce(config.connections[0]!);
    expect(cache.sourceStatuses()[0]!.lastSuccessAt).toBe(1_000);
    const cached = cache.eventsInWindow(
      new Date("2026-06-01T00:00:00Z"),
      new Date("2026-06-02T00:00:00Z"),
    );
    expect(cached.map((e) => e.id)).toEqual(["e1"]);
  });

  test("refreshOnce records error and rethrows on failure", async () => {
    const config = makeConfig();
    const refresher = new Refresher(cache, config, {
      adapters: stubAdapters([], { fail: true }),
      now: () => 2_000,
    });
    await expect(refresher.refreshOnce(config.connections[0]!)).rejects.toThrow("network down");
    const status = cache.sourceStatuses()[0]!;
    expect(status.lastError).toBe("network down");
    expect(status.lastErrorAt).toBe(2_000);
    expect(status.lastSuccessAt).toBeNull();
  });

  // Each scheduled timer closes over its own connection, so without explicit
  // cancellation a source dropped from family.yaml keeps fetching on the old
  // schedule — re-inserting the very rows the reload-time prune just dropped.
  test("setConfig unschedules a source dropped from config", async () => {
    const logs: string[] = [];
    const refresher = new Refresher(cache, makeConfig(["src-a", "src-b"]), {
      adapters: stubAdapters([]),
      log: (m) => logs.push(m),
    });
    // start() is what creates the per-source timers setConfig has to cancel.
    await refresher.start();
    refresher.setConfig(makeConfig(["src-a"]));
    expect(logs).toContain("unscheduled removed source: src-b");
    expect(logs).not.toContain("unscheduled removed source: src-a");
    refresher.stop();
  });

  test("a removed source's timer does not resurrect pruned events", async () => {
    // 60ms refresh interval: without cancellation the timer fires during the
    // wait below and re-populates src-b.
    const config = makeConfig(["src-a", "src-b"], 0.001);
    const stampBySource: Adapters = {
      fetchIcs: async (cfg) => [
        {
          id: `e-${cfg.sourceId}`,
          sourceId: cfg.sourceId,
          personId: "p-me",
          title: "Mtg",
          start: new Date("2026-06-01T10:00:00Z"),
          end: new Date("2026-06-01T11:00:00Z"),
          allDay: false,
        },
      ],
      fetchCalDav: async () => [],
      createCalDav: async () => "stub-uid",
    };
    const refresher = new Refresher(cache, config, { adapters: stampBySource });
    await refresher.start();

    const ids = () =>
      cache
        .eventsInWindow(new Date("2026-06-01T00:00:00Z"), new Date("2026-06-02T00:00:00Z"))
        .map((e) => e.id)
        .sort();
    expect(ids()).toEqual(["e-src-a", "e-src-b"]);

    // Mirror a reload that drops src-b.
    refresher.setConfig(makeConfig(["src-a"], 0.001));
    cache.pruneUnknownSources(["src-a"]);
    expect(ids()).toEqual(["e-src-a"]);

    await new Promise((r) => setTimeout(r, 300));
    expect(ids()).toEqual(["e-src-a"]);
    refresher.stop();
  });

  test("staleSources flags never-fetched and past-maxStale sources", () => {
    const config = makeConfig();
    const refresher = new Refresher(cache, config, { now: () => 100 * 60 * 60 * 1000 });
    // Never fetched → stale.
    expect(refresher.staleSources()).toEqual(["src-ics"]);
    // Fresh success → not stale.
    cache.markSuccess("src-ics", 100 * 60 * 60 * 1000);
    expect(refresher.staleSources()).toEqual([]);
    // Success 7h ago, maxStale 6h → stale.
    cache.markSuccess("src-ics", 100 * 60 * 60 * 1000 - 7 * 60 * 60 * 1000);
    expect(refresher.staleSources()).toEqual(["src-ics"]);
  });
});
