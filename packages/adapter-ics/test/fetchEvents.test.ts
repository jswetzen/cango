import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { fetchEvents } from "../src/fetchEvents.js";
import type { IcsFetcher, IcsSourceConfig } from "../src/fetchEvents.js";

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

function fixtureFetcher(file: string): IcsFetcher {
  return async () => readFile(join(fixturesDir, file), "utf8");
}

const baseConfig = (extras: Partial<IcsSourceConfig> = {}): IcsSourceConfig => ({
  sourceId: "src-test",
  url: "https://example.invalid/test.ics",
  resolvePersonId: () => "p-me",
  ...extras,
});

describe("@cango/adapter-ics fetchEvents", () => {
  it("parses a single non-recurring event in window", async () => {
    const events = await fetchEvents(
      baseConfig(),
      { start: new Date("2026-06-01T00:00:00Z"), end: new Date("2026-06-30T00:00:00Z") },
      { fetcher: fixtureFetcher("single.ics") },
    );
    expect(events).toHaveLength(1);
    const e = events[0]!;
    expect(e.id).toBe("single-event-001@cango.test");
    expect(e.seriesId).toBe("single-event-001@cango.test");
    expect(e.sourceId).toBe("src-test");
    expect(e.personId).toBe("p-me");
    expect(e.title).toBe("Dentist appointment");
    expect(e.start.toISOString()).toBe("2026-06-15T09:00:00.000Z");
    expect(e.end.toISOString()).toBe("2026-06-15T10:00:00.000Z");
    expect(e.recurring).toBe(false);
  });

  it("skips events outside the window", async () => {
    const events = await fetchEvents(
      baseConfig(),
      { start: new Date("2026-07-01T00:00:00Z"), end: new Date("2026-07-31T00:00:00Z") },
      { fetcher: fixtureFetcher("single.ics") },
    );
    expect(events).toEqual([]);
  });

  it("expands a weekly RRULE into occurrences within window only", async () => {
    const events = await fetchEvents(
      baseConfig(),
      { start: new Date("2026-06-01T00:00:00Z"), end: new Date("2026-06-30T00:00:00Z") },
      { fetcher: fixtureFetcher("weekly.ics") },
    );
    // Mondays in June 2026: 1, 8, 15, 22, 29
    expect(events).toHaveLength(5);
    for (const e of events) {
      expect(e.seriesId).toBe("weekly-standup@cango.test");
      expect(e.recurring).toBe(true);
      expect(e.id.startsWith("weekly-standup@cango.test@")).toBe(true);
    }
    const starts = events.map((e) => e.start.toISOString()).sort();
    expect(starts).toEqual([
      "2026-06-01T09:00:00.000Z",
      "2026-06-08T09:00:00.000Z",
      "2026-06-15T09:00:00.000Z",
      "2026-06-22T09:00:00.000Z",
      "2026-06-29T09:00:00.000Z",
    ]);
    expect(new Set(events.map((e) => e.id)).size).toBe(events.length);
  });

  it("extracts rsvpStatus, organizerIsSelf, attendeeCount when selfEmail provided", async () => {
    const events = await fetchEvents(
      baseConfig({ selfEmail: "me@cango.test" }),
      { start: new Date("2026-06-01T00:00:00Z"), end: new Date("2026-06-30T00:00:00Z") },
      { fetcher: fixtureFetcher("with-rsvp.ics") },
    );
    expect(events).toHaveLength(2);
    const byId = new Map(events.map((e) => [e.id, e]));

    const declined = byId.get("invite-001@cango.test")!;
    expect(declined.rsvpStatus).toBe("declined");
    expect(declined.organizerIsSelf).toBe(false);
    expect(declined.attendeeCount).toBe(2);

    const focus = byId.get("self-organized-001@cango.test")!;
    expect(focus.organizerIsSelf).toBe(true);
    expect(focus.rsvpStatus).toBe("accepted");
    expect(focus.attendeeCount).toBe(1);
  });

  it("populates attendeeIds from ATTENDEE emails via the resolver", async () => {
    // Map only known family emails; external attendees (bob@) resolve to nothing.
    const resolveAttendeeIds = (emails: string[]) =>
      emails.flatMap((e) => (e.toLowerCase() === "me@cango.test" ? ["p-me"] : []));
    const events = await fetchEvents(
      baseConfig({ resolveAttendeeIds }),
      { start: new Date("2026-06-01T00:00:00Z"), end: new Date("2026-06-30T00:00:00Z") },
      { fetcher: fixtureFetcher("with-rsvp.ics") },
    );
    const declined = events.find((e) => e.id === "invite-001@cango.test")!;
    // me@ maps to p-me; bob@example.com is external and dropped.
    expect(declined.attendeeIds).toEqual(["p-me"]);
  });

  it("leaves attendeeIds unset when no resolver is supplied", async () => {
    const events = await fetchEvents(
      baseConfig(),
      { start: new Date("2026-06-01T00:00:00Z"), end: new Date("2026-06-30T00:00:00Z") },
      { fetcher: fixtureFetcher("with-rsvp.ics") },
    );
    for (const e of events) expect(e.attendeeIds).toBeUndefined();
  });

  it("omits rsvp/organizer fields when selfEmail not provided", async () => {
    const events = await fetchEvents(
      baseConfig(),
      { start: new Date("2026-06-01T00:00:00Z"), end: new Date("2026-06-30T00:00:00Z") },
      { fetcher: fixtureFetcher("with-rsvp.ics") },
    );
    for (const e of events) {
      expect(e.rsvpStatus).toBeUndefined();
      expect(e.organizerIsSelf).toBeUndefined();
    }
  });

  it("falls back to a deterministic hashed seriesId when UID is missing", async () => {
    const events = await fetchEvents(
      baseConfig(),
      { start: new Date("2026-06-01T00:00:00Z"), end: new Date("2026-06-30T00:00:00Z") },
      { fetcher: fixtureFetcher("no-uid.ics") },
    );
    expect(events).toHaveLength(1);
    const e = events[0]!;
    expect(e.seriesId.startsWith("hash:")).toBe(true);
    // Stable across reruns
    const again = await fetchEvents(
      baseConfig(),
      { start: new Date("2026-06-01T00:00:00Z"), end: new Date("2026-06-30T00:00:00Z") },
      { fetcher: fixtureFetcher("no-uid.ics") },
    );
    expect(again[0]!.seriesId).toBe(e.seriesId);
  });

  it("throws on a degenerate window", async () => {
    await expect(
      fetchEvents(
        baseConfig(),
        { start: new Date("2026-06-01T00:00:00Z"), end: new Date("2026-06-01T00:00:00Z") },
        { fetcher: fixtureFetcher("single.ics") },
      ),
    ).rejects.toThrow();
  });

  it("uses the resolvePersonId callback per sourceId", async () => {
    const calls: string[] = [];
    const events = await fetchEvents(
      baseConfig({
        resolvePersonId: (sid) => {
          calls.push(sid);
          return "p-wife";
        },
      }),
      { start: new Date("2026-06-01T00:00:00Z"), end: new Date("2026-06-30T00:00:00Z") },
      { fetcher: fixtureFetcher("single.ics") },
    );
    expect(calls).toContain("src-test");
    expect(events[0]!.personId).toBe("p-wife");
  });
});
