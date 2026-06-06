import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Cache } from "../src/cache.ts";
import { Refresher } from "../src/cron.ts";
import { buildFamily, type LoadedConfig } from "../src/config.ts";
import type { Adapters } from "../src/sources.ts";
import type { CalEvent } from "@cango/core";

function makeConfig(): LoadedConfig {
  const { family, connections, settings } = buildFamily({
    people: [{ id: "p-me", name: "Me", sourceIds: ["src-ics"] }],
    organizations: [],
    sources: [
      {
        id: "src-ics",
        kind: "ics",
        defaultRole: "hard",
        ownedBy: "person",
        ownerId: "p-me",
        url: "https://example.invalid/cal.ics",
        writable: false,
      },
    ],
    attendance: [],
    settings: { refreshIntervalMinutes: 60, maxStaleHours: 6, timezone: "UTC" },
  });
  return {
    family,
    rules: [],
    connections,
    settings,
    personIdForSource: () => "p-me",
    familyVersion: "fv",
    rulesVersion: "rv",
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
