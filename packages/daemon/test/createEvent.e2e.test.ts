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
import type { Adapters } from "../src/sources.ts";
import type { CalEvent } from "@cango/core";

const FAMILY_YAML = `
settings:
  refreshIntervalMinutes: 60
  maxStaleHours: 6
people:
  - id: p-me
    name: Me
    sourceIds: [src-cal, src-ro, src-ics]
sources:
  - id: src-cal
    kind: caldav
    ownedBy: person
    ownerId: p-me
    defaultRole: hard
    serverUrl: https://caldav.invalid/
    username: me
    password: pw
    writable: true
  - id: src-ro
    kind: caldav
    ownedBy: person
    ownerId: p-me
    defaultRole: hard
    serverUrl: https://caldav.invalid/
    username: me
    password: pw
  - id: src-ics
    kind: ics
    ownedBy: person
    ownerId: p-me
    defaultRole: hard
    url: https://example.invalid/me.ics
`;

// Same family, but pinned to a positive-offset zone — the condition under which
// the all-day off-by-one surfaced (bare date → tz-local midnight → UTC date is
// the day before).
const FAMILY_YAML_STHLM = FAMILY_YAML.replace(
  "  maxStaleHours: 6\n",
  "  maxStaleHours: 6\n  timezone: Europe/Stockholm\n",
);

// A fake CalDAV backend: createCalDav records the write and models the server
// so the next fetchCalDav returns the freshly created event (what refreshOnce
// pulls into the cache). `written` keeps the exact instants the daemon handed
// the adapter, so a test can assert the all-day date-anchoring (the real
// adapter turns these UTC fields into a `VALUE=DATE`).
interface Written {
  title: string;
  start: Date;
  end: Date;
  allDay: boolean;
}
function fakeAdapters(): { adapters: Adapters; written: Written[] } {
  const written: Written[] = [];
  let stored: CalEvent[] = [];
  const adapters: Adapters = {
    fetchIcs: async () => [],
    fetchCalDav: async () => stored,
    createCalDav: async (config, input) => {
      const uid = input.uid ?? "new-uid";
      written.push({
        title: input.title,
        start: input.start,
        end: input.end,
        allDay: input.allDay,
      });
      stored = [
        {
          id: uid,
          sourceId: config.sourceId,
          personId: config.resolvePersonId(config.sourceId),
          title: input.title,
          start: input.start,
          end: input.end,
          allDay: input.allDay,
        },
      ];
      return uid;
    },
  };
  return { adapters, written };
}

describe("daemon createEvent over the socket", () => {
  let dir: string;
  let cache: Cache;
  let server: SocketServer;
  let socketPath: string;
  let config: LoadedConfig;
  let rules: RuleStore;
  let refresher: Refresher;
  let written: Written[];

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "cango-create-"));
    const familyPath = join(dir, "family.yaml");
    socketPath = join(dir, "cango.sock");
    writeFileSync(familyPath, FAMILY_YAML);

    config = await loadConfig(familyPath);
    cache = new Cache(":memory:");
    rules = new RuleStore(":memory:");
    const fake = fakeAdapters();
    written = fake.written;
    // Pin the clock near the event so the warm refresh window covers it.
    const now = () => new Date("2026-06-10T00:00:00Z").getTime();
    refresher = new Refresher(cache, config, { now, adapters: fake.adapters });

    const ctx: RpcContext = {
      cache,
      getConfig: () => config,
      rules,
      refresher,
      reload: async () => {},
    };
    server = startServer(socketPath, ctx);
  });

  afterEach(() => {
    server.stop();
    cache.close();
    rules.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("creates an event on a writable source and it becomes visible", async () => {
    const res = (await rpcCall(socketPath, "createEvent", {
      source_id: "src-cal",
      title: "Torpkonferensen",
      start: "2026-06-16T00:00:00Z",
      end: "2026-06-21T00:00:00Z",
      all_day: true,
    })) as { event: { id: string; title: string; all_day: boolean } };

    expect(written.map((w) => w.title)).toEqual(["Torpkonferensen"]);
    expect(res.event.title).toBe("Torpkonferensen");
    expect(res.event.all_day).toBe(true);

    // The write-through refresh lands it in the cache: listEvents now sees it.
    const list = (await rpcCall(socketPath, "listEvents", {
      start: "2026-06-16T00:00:00Z",
      end: "2026-06-21T00:00:00Z",
      people: ["p-me"],
    })) as { events: Array<{ title: string }> };
    expect(list.events.map((e) => e.title)).toContain("Torpkonferensen");
  });

  test("rejects writing to a non-writable caldav source", async () => {
    await expect(
      rpcCall(socketPath, "createEvent", {
        source_id: "src-ro",
        title: "Nope",
        start: "2026-06-16T09:00:00Z",
        end: "2026-06-16T10:00:00Z",
      }),
    ).rejects.toThrow(/not writable/);
  });

  test("rejects writing to an ics source", async () => {
    await expect(
      rpcCall(socketPath, "createEvent", {
        source_id: "src-ics",
        title: "Nope",
        start: "2026-06-16T09:00:00Z",
        end: "2026-06-16T10:00:00Z",
      }),
    ).rejects.toThrow(/not writable/);
  });

  test("rejects an unknown source", async () => {
    await expect(
      rpcCall(socketPath, "createEvent", {
        source_id: "src-missing",
        title: "Nope",
        start: "2026-06-16T09:00:00Z",
        end: "2026-06-16T10:00:00Z",
      }),
    ).rejects.toThrow(/unknown source/);
  });

  test("rejects end before start", async () => {
    await expect(
      rpcCall(socketPath, "createEvent", {
        source_id: "src-cal",
        title: "Backwards",
        start: "2026-06-16T10:00:00Z",
        end: "2026-06-16T09:00:00Z",
      }),
    ).rejects.toThrow();
  });
});

// Regression for the all-day off-by-one: in a positive-offset zone a bare date
// parsed via parseInZone lands on tz-local midnight, whose UTC date is the day
// before. The createEvent handler must re-anchor all-day start/end to UTC
// midnight of the tz-local date so the date-only CalDAV write names the right
// day. See knowitall task 821c93f0.
describe("daemon createEvent all-day date anchoring (Europe/Stockholm)", () => {
  let dir: string;
  let cache: Cache;
  let server: SocketServer;
  let socketPath: string;
  let config: LoadedConfig;
  let rules: RuleStore;
  let refresher: Refresher;
  let written: Written[];

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "cango-create-sthlm-"));
    const familyPath = join(dir, "family.yaml");
    socketPath = join(dir, "cango.sock");
    writeFileSync(familyPath, FAMILY_YAML_STHLM);

    config = await loadConfig(familyPath);
    cache = new Cache(":memory:");
    rules = new RuleStore(":memory:");
    const fake = fakeAdapters();
    written = fake.written;
    const now = () => new Date("2026-06-25T00:00:00Z").getTime();
    refresher = new Refresher(cache, config, { now, adapters: fake.adapters });

    const ctx: RpcContext = {
      cache,
      getConfig: () => config,
      rules,
      refresher,
      reload: async () => {},
    };
    server = startServer(socketPath, ctx);
  });

  afterEach(() => {
    server.stop();
    cache.close();
    rules.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("anchors bare all-day dates to UTC midnight of the intended day", async () => {
    await rpcCall(socketPath, "createEvent", {
      source_id: "src-cal",
      title: "Torpkonferensen",
      start: "2026-07-01",
      end: "2026-07-06", // exclusive: covers 1–5
      all_day: true,
    });

    // The instants handed to the adapter must be UTC midnight of the named days,
    // not the tz-local-midnight 2026-06-30T22:00Z / 2026-07-05T22:00Z that
    // parseInZone produced — those would write VALUE=DATE one day early.
    expect(written).toHaveLength(1);
    expect(written[0]!.allDay).toBe(true);
    expect(written[0]!.start.toISOString()).toBe("2026-07-01T00:00:00.000Z");
    expect(written[0]!.end.toISOString()).toBe("2026-07-06T00:00:00.000Z");
  });

  test("a same-day all-day event keeps an exclusive next-day DTEND", async () => {
    await rpcCall(socketPath, "createEvent", {
      source_id: "src-cal",
      title: "Midsommar",
      start: "2026-06-26",
      end: "2026-06-27",
      all_day: true,
    });

    expect(written[0]!.start.toISOString()).toBe("2026-06-26T00:00:00.000Z");
    expect(written[0]!.end.toISOString()).toBe("2026-06-27T00:00:00.000Z");
  });

  test("timed events still honor the wall-clock zone interpretation", async () => {
    await rpcCall(socketPath, "createEvent", {
      source_id: "src-cal",
      title: "Lunch",
      start: "2026-07-01T12:00:00", // 12:00 Stockholm summer == 10:00Z
      end: "2026-07-01T13:00:00",
      all_day: false,
    });

    expect(written[0]!.allDay).toBe(false);
    expect(written[0]!.start.toISOString()).toBe("2026-07-01T10:00:00.000Z");
    expect(written[0]!.end.toISOString()).toBe("2026-07-01T11:00:00.000Z");
  });
});
