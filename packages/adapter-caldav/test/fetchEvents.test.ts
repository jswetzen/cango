import { describe, expect, it, vi } from "vitest";
import { fetchEvents } from "../src/fetchEvents.js";
import type {
  CalDavCalendarLike,
  CalDavClientLike,
  CalDavObjectLike,
  CalDavSourceConfig,
} from "../src/fetchEvents.js";

const baseConfig = (overrides: Partial<CalDavSourceConfig> = {}): CalDavSourceConfig => ({
  sourceId: "src-caldav",
  serverUrl: "https://caldav.invalid/",
  username: "user",
  password: "pw",
  resolvePersonId: () => "p-me",
  ...overrides,
});

function fakeClient(
  calendars: CalDavCalendarLike[],
  objectsByCalendarUrl: Record<string, CalDavObjectLike[]>,
): CalDavClientLike & {
  fetchCalendarObjects: ReturnType<typeof vi.fn>;
} {
  const fetchCalendarObjects = vi.fn(
    async ({ calendar }: { calendar: CalDavCalendarLike }) =>
      objectsByCalendarUrl[calendar.url] ?? [],
  );
  return {
    fetchCalendars: async () => calendars,
    fetchCalendarObjects,
    createCalendarObject: async () => ({}),
  };
}

const SINGLE_ICS = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Cango Test//EN
BEGIN:VEVENT
UID:dav-1@cango.test
SUMMARY:Practice
DTSTAMP:20260601T080000Z
DTSTART:20260605T160000Z
DTEND:20260605T170000Z
END:VEVENT
END:VCALENDAR
`;

const WEEKLY_ICS = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Cango Test//EN
BEGIN:VEVENT
UID:dav-weekly@cango.test
SUMMARY:Team meeting
DTSTAMP:20260601T080000Z
DTSTART:20260601T130000Z
DTEND:20260601T140000Z
RRULE:FREQ=WEEKLY;BYDAY=TU
END:VEVENT
END:VCALENDAR
`;

describe("@cango/adapter-caldav fetchEvents", () => {
  const window = {
    start: new Date("2026-06-01T00:00:00Z"),
    end: new Date("2026-06-30T00:00:00Z"),
  };

  it("queries each calendar with the window as ISO timeRange", async () => {
    const client = fakeClient(
      [{ url: "https://caldav.invalid/cal/work/", displayName: "Work" }],
      {
        "https://caldav.invalid/cal/work/": [
          { url: "https://caldav.invalid/cal/work/dav-1.ics", data: SINGLE_ICS },
        ],
      },
    );

    const events = await fetchEvents(baseConfig(), window, { client });

    expect(client.fetchCalendarObjects).toHaveBeenCalledTimes(1);
    const call = client.fetchCalendarObjects.mock.calls[0]![0];
    expect(call.timeRange).toEqual({
      start: window.start.toISOString(),
      end: window.end.toISOString(),
    });
    expect(events).toHaveLength(1);
    expect(events[0]!.id).toBe("dav-1@cango.test");
    expect(events[0]!.seriesId).toBe("dav-1@cango.test");
    expect(events[0]!.sourceId).toBe("src-caldav");
    expect(events[0]!.personId).toBe("p-me");
  });

  it("expands recurring events from a CalDAV body", async () => {
    const client = fakeClient(
      [{ url: "https://caldav.invalid/cal/work/" }],
      {
        "https://caldav.invalid/cal/work/": [
          { url: "https://caldav.invalid/cal/work/weekly.ics", data: WEEKLY_ICS },
        ],
      },
    );
    const events = await fetchEvents(baseConfig(), window, { client });
    // Tuesdays in June 2026: 2, 9, 16, 23, 30. The 30th is at 13:00Z, before window end 30T00:00Z → excluded.
    const starts = events.map((e) => e.start.toISOString()).sort();
    expect(starts).toEqual([
      "2026-06-02T13:00:00.000Z",
      "2026-06-09T13:00:00.000Z",
      "2026-06-16T13:00:00.000Z",
      "2026-06-23T13:00:00.000Z",
    ]);
    for (const e of events) {
      expect(e.seriesId).toBe("dav-weekly@cango.test");
      expect(e.recurring).toBe(true);
    }
  });

  it("merges events from multiple calendars and dedups by event id", async () => {
    const client = fakeClient(
      [
        { url: "https://caldav.invalid/cal/a/", displayName: "A" },
        { url: "https://caldav.invalid/cal/b/", displayName: "B" },
      ],
      {
        "https://caldav.invalid/cal/a/": [
          { url: "https://caldav.invalid/cal/a/x.ics", data: SINGLE_ICS },
        ],
        "https://caldav.invalid/cal/b/": [
          { url: "https://caldav.invalid/cal/b/x.ics", data: SINGLE_ICS },
        ],
      },
    );
    const events = await fetchEvents(baseConfig(), window, { client });
    expect(events).toHaveLength(1);
  });

  it("calendarFilter selects which calendars to query", async () => {
    const client = fakeClient(
      [
        { url: "https://caldav.invalid/cal/work/", displayName: "Work" },
        { url: "https://caldav.invalid/cal/personal/", displayName: "Personal" },
      ],
      {
        "https://caldav.invalid/cal/work/": [
          { url: "https://caldav.invalid/cal/work/x.ics", data: SINGLE_ICS },
        ],
        "https://caldav.invalid/cal/personal/": [],
      },
    );
    const events = await fetchEvents(
      baseConfig({ calendarFilter: (c) => c.displayName === "Work" }),
      window,
      { client },
    );
    expect(client.fetchCalendarObjects).toHaveBeenCalledTimes(1);
    expect(events).toHaveLength(1);
  });

  it("returns empty array when no calendars match", async () => {
    const client = fakeClient(
      [{ url: "https://caldav.invalid/cal/x/", displayName: "X" }],
      { "https://caldav.invalid/cal/x/": [] },
    );
    const events = await fetchEvents(
      baseConfig({ calendarFilter: () => false }),
      window,
      { client },
    );
    expect(client.fetchCalendarObjects).not.toHaveBeenCalled();
    expect(events).toEqual([]);
  });

  it("skips DAV objects with no data", async () => {
    const client = fakeClient(
      [{ url: "https://caldav.invalid/cal/" }],
      {
        "https://caldav.invalid/cal/": [
          { url: "https://caldav.invalid/cal/empty.ics" },
          { url: "https://caldav.invalid/cal/x.ics", data: SINGLE_ICS },
        ],
      },
    );
    const events = await fetchEvents(baseConfig(), window, { client });
    expect(events).toHaveLength(1);
  });

  it("throws on a degenerate window before talking to the server", async () => {
    const client = fakeClient([], {});
    const spy = vi.spyOn(client, "fetchCalendars");
    await expect(
      fetchEvents(
        baseConfig(),
        { start: window.start, end: window.start },
        { client },
      ),
    ).rejects.toThrow();
    expect(spy).not.toHaveBeenCalled();
  });
});
