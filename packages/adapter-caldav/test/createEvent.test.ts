import { describe, expect, it } from "vitest";
import { parseIcs } from "@cango/adapter-ics";
import { createEvent, escapeText } from "../src/fetchEvents.js";
import type {
  CalDavCalendarLike,
  CalDavClientLike,
  CalDavSourceConfig,
  CreateEventInput,
} from "../src/fetchEvents.js";

const baseConfig = (overrides: Partial<CalDavSourceConfig> = {}): CalDavSourceConfig => ({
  sourceId: "src-caldav",
  serverUrl: "https://caldav.invalid/",
  username: "user",
  password: "pw",
  resolvePersonId: () => "p-me",
  ...overrides,
});

interface Captured {
  calendar: CalDavCalendarLike;
  iCalString: string;
  filename: string;
}

function captureClient(calendars: CalDavCalendarLike[]): {
  client: CalDavClientLike;
  writes: Captured[];
} {
  const writes: Captured[] = [];
  const client: CalDavClientLike = {
    fetchCalendars: async () => calendars,
    fetchCalendarObjects: async () => [],
    createCalendarObject: async (args) => {
      writes.push(args);
      return { url: `${args.calendar.url}${args.filename}` };
    },
  };
  return { client, writes };
}

const timedInput = (overrides: Partial<CreateEventInput> = {}): CreateEventInput => ({
  title: "Lunch",
  start: new Date("2026-06-16T11:00:00Z"),
  end: new Date("2026-06-16T12:00:00Z"),
  allDay: false,
  ...overrides,
});

/** Parse a produced iCalString back to events through the real ICS parser. */
function roundTrip(iCalString: string, input: CreateEventInput) {
  return parseIcs(
    iCalString,
    { sourceId: "src-caldav", url: "obj.ics", resolvePersonId: () => "p-me" },
    { start: new Date(input.start.getTime() - 1000), end: new Date(input.end.getTime() + 1000) },
  );
}

describe("createEvent", () => {
  it("writes a timed VEVENT and returns the uid", async () => {
    const { client, writes } = captureClient([{ url: "https://cal/1/" }]);
    const uid = await createEvent(baseConfig(), timedInput({ uid: "fixed-uid" }), { client });

    expect(uid).toBe("fixed-uid");
    expect(writes).toHaveLength(1);
    expect(writes[0]!.filename).toBe("fixed-uid.ics");
    const ics = writes[0]!.iCalString;
    expect(ics).toContain("UID:fixed-uid");
    expect(ics).toContain("DTSTART:20260616T110000Z");
    expect(ics).toContain("DTEND:20260616T120000Z");
    expect(ics).toContain("SUMMARY:Lunch");
  });

  it("writes an all-day VEVENT with an exclusive DTEND", async () => {
    const { client, writes } = captureClient([{ url: "https://cal/1/" }]);
    await createEvent(
      baseConfig(),
      {
        title: "Torpkonferensen",
        start: new Date("2026-06-16T00:00:00Z"),
        end: new Date("2026-06-21T00:00:00Z"), // exclusive: covers 16–20
        allDay: true,
        uid: "torp",
      },
      { client },
    );
    const ics = writes[0]!.iCalString;
    expect(ics).toContain("DTSTART;VALUE=DATE:20260616");
    expect(ics).toContain("DTEND;VALUE=DATE:20260621");
  });

  it("selects the calendar matching calendarFilter", async () => {
    const { client, writes } = captureClient([
      { url: "https://cal/work/", displayName: "Work" },
      { url: "https://cal/home/", displayName: "Home" },
    ]);
    await createEvent(
      baseConfig({ calendarFilter: (c) => c.displayName === "Home" }),
      timedInput({ uid: "u" }),
      { client },
    );
    expect(writes[0]!.calendar.url).toBe("https://cal/home/");
  });

  it("throws when no calendar matches the filter", async () => {
    const { client } = captureClient([{ url: "https://cal/work/", displayName: "Work" }]);
    await expect(
      createEvent(baseConfig({ calendarFilter: (c) => c.displayName === "Nope" }), timedInput(), {
        client,
      }),
    ).rejects.toThrow(/no calendar matched/);
  });

  it("throws when end is not after start", async () => {
    const { client } = captureClient([{ url: "https://cal/1/" }]);
    await expect(
      createEvent(baseConfig(), timedInput({ end: new Date("2026-06-16T11:00:00Z") }), { client }),
    ).rejects.toThrow(/end must be after start/);
  });

  it("neutralizes iCalendar injection in the title", async () => {
    const { client, writes } = captureClient([{ url: "https://cal/1/" }]);
    const malicious =
      "Fika\r\nBEGIN:VALARM\r\nACTION:DISPLAY\r\nTRIGGER:-PT15M\r\nEND:VALARM\r\nSUMMARY:pwned";
    const input = timedInput({ title: malicious, uid: "inj" });
    await createEvent(baseConfig(), input, { client });
    const ics = writes[0]!.iCalString;

    // No injected component or stray property lines leaked into the stream.
    expect(ics).not.toMatch(/^BEGIN:VALARM/m);
    expect(ics).not.toMatch(/^ACTION:/m);
    expect(ics.match(/^BEGIN:VEVENT/gm)).toHaveLength(1);
    expect(ics.match(/^SUMMARY:/gm)).toHaveLength(1);

    // The whole payload survives as inert text on the single SUMMARY value.
    const events = roundTrip(ics, input);
    expect(events).toHaveLength(1);
    expect(events[0]!.title).toContain("BEGIN:VALARM");
    expect(events[0]!.title).not.toContain("\r");
  });

  it("round-trips reserved characters verbatim", async () => {
    const { client, writes } = captureClient([{ url: "https://cal/1/" }]);
    const input = timedInput({ title: "a, b; c \\ d", uid: "esc" });
    await createEvent(baseConfig(), input, { client });
    const events = roundTrip(writes[0]!.iCalString, input);
    expect(events[0]!.title).toBe("a, b; c \\ d");
  });

  it("folds and round-trips a long title", async () => {
    const { client, writes } = captureClient([{ url: "https://cal/1/" }]);
    const long = "Planning ".repeat(20).trim(); // > 75 octets
    const input = timedInput({ title: long, uid: "fold" });
    await createEvent(baseConfig(), input, { client });
    const ics = writes[0]!.iCalString;
    // Folded continuation lines begin with a single space.
    expect(ics).toMatch(/\r\n /);
    const events = roundTrip(ics, input);
    expect(events[0]!.title).toBe(long);
  });
});

describe("escapeText", () => {
  it("escapes reserved characters and strips control chars", () => {
    expect(escapeText("a,b;c\\d")).toBe("a\\,b\\;c\\\\d");
    expect(escapeText("line1\r\nline2")).toBe("line1\\nline2");
    // HTAB is valid in iCalendar TEXT (kept); the BELL control char is stripped.
    expect(escapeText("tab\tbell\x07x")).toBe("tab\tbellx");
  });
});
