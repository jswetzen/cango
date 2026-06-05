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

const RULES = `rules: []\n`;

// A fake CalDAV backend: createCalDav records the write and models the server
// so the next fetchCalDav returns the freshly created event (what refreshOnce
// pulls into the cache).
function fakeAdapters(): { adapters: Adapters; written: Array<{ title: string }> } {
  const written: Array<{ title: string }> = [];
  let stored: CalEvent[] = [];
  const adapters: Adapters = {
    fetchIcs: async () => [],
    fetchCalDav: async () => stored,
    createCalDav: async (config, input) => {
      const uid = input.uid ?? "new-uid";
      written.push({ title: input.title });
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
  let refresher: Refresher;
  let written: Array<{ title: string }>;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "cango-create-"));
    const familyPath = join(dir, "family.yaml");
    const rulesPath = join(dir, "rules.yaml");
    socketPath = join(dir, "cango.sock");
    writeFileSync(familyPath, FAMILY_YAML);
    writeFileSync(rulesPath, RULES);

    config = await loadConfig(familyPath, rulesPath);
    cache = new Cache(":memory:");
    const fake = fakeAdapters();
    written = fake.written;
    // Pin the clock near the event so the warm refresh window covers it.
    const now = () => new Date("2026-06-10T00:00:00Z").getTime();
    refresher = new Refresher(cache, config, { now, adapters: fake.adapters });

    const ctx: RpcContext = {
      cache,
      getConfig: () => config,
      refresher,
      reload: async () => {},
    };
    server = startServer(socketPath, ctx);
  });

  afterEach(() => {
    server.stop();
    cache.close();
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

    expect(written).toEqual([{ title: "Torpkonferensen" }]);
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
