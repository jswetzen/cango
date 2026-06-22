import { randomUUID } from "node:crypto";
import type { CalEvent } from "@cango/core";
import { parseIcs } from "@cango/adapter-ics";
import {
  createDAVClient,
  getBasicAuthHeaders,
  createCalendarObject as davCreateCalendarObject,
  fetchCalendarObjects as davFetchCalendarObjects,
} from "tsdav";

export interface CalDavSourceConfig {
  sourceId: string;
  serverUrl: string;
  username: string;
  password: string;
  resolvePersonId: (sourceId: string) => string;
  /** Map ATTENDEE emails to known person ids; forwarded to the ICS parser. */
  resolveAttendeeIds?: (emails: string[]) => string[];
  selfEmail?: string;
  calendarFilter?: (calendar: CalDavCalendarLike) => boolean;
  /**
   * Exact calendar-collection URL (as DAVx5 / the server's web UI report it).
   * When set, the adapter talks straight to this collection and skips tsdav's
   * account discovery (.well-known + principal lookup) — needed for servers
   * whose discovery is broken (e.g. an owncloud whose /.well-known/caldav
   * redirects to an unreachable host). `calendarFilter` is ignored in this mode.
   */
  calendarUrl?: string;
}

export interface CalDavCalendarLike {
  url: string;
  displayName?: string;
}

export interface CalDavObjectLike {
  url: string;
  data?: string;
}

export interface CalDavClientLike {
  fetchCalendars(): Promise<CalDavCalendarLike[]>;
  fetchCalendarObjects(args: {
    calendar: CalDavCalendarLike;
    timeRange: { start: string; end: string };
  }): Promise<CalDavObjectLike[]>;
  createCalendarObject(args: {
    calendar: CalDavCalendarLike;
    iCalString: string;
    filename: string;
  }): Promise<{ url?: string }>;
}

/** A new event to write. Only simple, non-recurring events are supported. */
/** One attendee to write into the VEVENT — a display name and email. */
export interface CreateEventAttendee {
  name: string;
  email: string;
}

export interface CreateEventInput {
  title: string;
  start: Date;
  end: Date;
  allDay: boolean;
  /** ATTENDEE lines to emit (people with known emails). The daemon resolves
   * occupant ids → emails; the adapter only serializes what it's given. */
  attendees?: CreateEventAttendee[];
  /** ORGANIZER email (the source's self address), emitted when attendees exist. */
  organizerEmail?: string;
  /** Server-generated when omitted; never derive from untrusted input. */
  uid?: string;
}

export interface FetchEventsOptions {
  client?: CalDavClientLike;
}

export async function fetchEvents(
  config: CalDavSourceConfig,
  window: { start: Date; end: Date },
  options: FetchEventsOptions = {},
): Promise<CalEvent[]> {
  if (!(window.end.getTime() > window.start.getTime())) {
    throw new Error("fetchEvents: window.end must be after window.start");
  }

  const client = options.client ?? (await clientFor(config));
  const calendars = await client.fetchCalendars();
  const selected = config.calendarFilter
    ? calendars.filter(config.calendarFilter)
    : calendars;
  if (selected.length === 0) return [];

  const timeRange = { start: window.start.toISOString(), end: window.end.toISOString() };
  const seen = new Set<string>();
  const out: CalEvent[] = [];

  for (const calendar of selected) {
    const objects = await client.fetchCalendarObjects({ calendar, timeRange });
    for (const obj of objects) {
      if (!obj.data) continue;
      const events = parseIcs(
        obj.data,
        {
          sourceId: config.sourceId,
          url: obj.url,
          resolvePersonId: config.resolvePersonId,
          ...(config.resolveAttendeeIds !== undefined
            ? { resolveAttendeeIds: config.resolveAttendeeIds }
            : {}),
          ...(config.selfEmail !== undefined ? { selfEmail: config.selfEmail } : {}),
        },
        window,
      );
      for (const ev of events) {
        if (seen.has(ev.id)) continue;
        seen.add(ev.id);
        out.push(ev);
      }
    }
  }
  return out;
}

/**
 * Create a single non-recurring event on a CalDAV calendar. Returns the UID,
 * which equals the `id` node-ical derives when the event is fetched back, so
 * callers can locate the freshly written event after a refresh.
 *
 * The target calendar is chosen the same way `fetchEvents` selects feeds: the
 * `calendarFilter` (display-name match) if given, else the first calendar.
 */
export async function createEvent(
  config: CalDavSourceConfig,
  input: CreateEventInput,
  options: FetchEventsOptions = {},
): Promise<string> {
  if (!(input.end.getTime() > input.start.getTime())) {
    throw new Error("createEvent: end must be after start");
  }

  const client = options.client ?? (await clientFor(config));
  const calendars = await client.fetchCalendars();
  const selected = config.calendarFilter
    ? calendars.filter(config.calendarFilter)
    : calendars;
  const calendar = selected[0];
  if (!calendar) {
    throw new Error(
      config.calendarFilter
        ? "createEvent: no calendar matched the configured calendarName"
        : "createEvent: the CalDAV account exposes no calendars",
    );
  }

  const uid = input.uid ?? randomUUID();
  const iCalString = buildVevent(input, uid);
  await client.createCalendarObject({ calendar, iCalString, filename: `${uid}.ics` });
  return uid;
}

/**
 * Serialize a minimal RFC-5545 VCALENDAR/VEVENT. `title` is treated as hostile
 * input (it often originates from a third-party invitation), so every text
 * value goes through `escapeText` and the whole document is line-folded — a
 * crafted title must never break out of its property value into a new content
 * line (the iCalendar analogue of header injection).
 */
function buildVevent(input: CreateEventInput, uid: string): string {
  const dtstamp = formatUtc(new Date());
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//cango//caldav-write//EN",
    "BEGIN:VEVENT",
    `UID:${uid}`,
    `DTSTAMP:${dtstamp}`,
    ...(input.allDay
      ? [
          `DTSTART;VALUE=DATE:${formatDate(input.start)}`,
          // All-day DTEND is exclusive, so it names the day after the last day.
          `DTEND;VALUE=DATE:${formatDate(input.end)}`,
        ]
      : [`DTSTART:${formatUtc(input.start)}`, `DTEND:${formatUtc(input.end)}`]),
    `SUMMARY:${escapeText(input.title)}`,
    // ORGANIZER/ATTENDEE: the CN is hostile text (escaped); the email is a
    // mailto: URI value, validated by the daemon before it reaches here.
    ...(input.attendees && input.attendees.length > 0 && input.organizerEmail
      ? [`ORGANIZER:mailto:${input.organizerEmail}`]
      : []),
    ...(input.attendees ?? []).map(
      (a) =>
        `ATTENDEE;CN=${escapeText(a.name)};ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION:mailto:${a.email}`,
    ),
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  return lines.map(foldLine).join("\r\n") + "\r\n";
}

/**
 * RFC-5545 §3.3.11 TEXT escaping plus control-character removal. The order
 * matters: backslash first so we don't double-escape the escapes we add. Raw
 * CR/LF and other C0/C1 control chars are stripped outright — that, not the
 * char-escaping, is what prevents a value from starting a new content line.
 */
export function escapeText(value: string): string {
  return value
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "")
    .replace(/\r\n|\r|\n/g, "\n")
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\n/g, "\\n");
}

/** Fold a content line to <=75 octets per RFC-5545 §3.1 (CRLF + space). */
function foldLine(line: string): string {
  const bytes = Buffer.from(line, "utf8");
  if (bytes.length <= 75) return line;
  const chunks: string[] = [];
  let start = 0;
  while (start < bytes.length) {
    // First line takes 75 octets; continuation lines lose one to the leading space.
    let limit = start === 0 ? 75 : 74;
    let endByte = Math.min(start + limit, bytes.length);
    // Don't split a multi-byte UTF-8 sequence: back off to a char boundary.
    while (endByte < bytes.length && (bytes[endByte]! & 0xc0) === 0x80) endByte--;
    chunks.push(bytes.subarray(start, endByte).toString("utf8"));
    start = endByte;
  }
  return chunks.join("\r\n ");
}

function formatUtc(d: Date): string {
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

function formatDate(d: Date): string {
  return formatUtc(d).slice(0, 8);
}

/** Pick the discovery-based client or the direct (explicit-URL) one. */
function clientFor(config: CalDavSourceConfig): Promise<CalDavClientLike> {
  return config.calendarUrl
    ? Promise.resolve(directClient(config))
    : defaultClient(config);
}

/**
 * Talk directly to a known calendar-collection URL, skipping tsdav's account
 * discovery. Uses the standalone tsdav verbs with a Basic-auth header, so there
 * is no /.well-known or principal lookup — the exact collection URL is the only
 * input. The synthetic single "calendar" it reports is that collection.
 */
function directClient(config: CalDavSourceConfig): CalDavClientLike {
  const url = config.calendarUrl;
  if (!url) throw new Error("directClient: calendarUrl is required");
  const headers = getBasicAuthHeaders({
    username: config.username,
    password: config.password,
  });
  type DavCalArg = Parameters<typeof davCreateCalendarObject>[0]["calendar"];
  return {
    fetchCalendars: async () => [{ url }],
    fetchCalendarObjects: async ({ calendar, timeRange }) => {
      const objects = await davFetchCalendarObjects({
        calendar: { url: calendar.url } as DavCalArg,
        timeRange,
        headers,
      });
      return objects.map((o) => ({
        url: o.url,
        ...(typeof o.data === "string" ? { data: o.data } : {}),
      }));
    },
    createCalendarObject: async ({ calendar, iCalString, filename }) => {
      const res = await davCreateCalendarObject({
        calendar: { url: calendar.url } as DavCalArg,
        iCalString,
        filename,
        headers,
      });
      if (!res.ok) {
        throw new Error(`CalDAV createCalendarObject failed: ${res.status} ${res.statusText}`);
      }
      return { url: res.url };
    },
  };
}

async function defaultClient(config: CalDavSourceConfig): Promise<CalDavClientLike> {
  const dav = await createDAVClient({
    serverUrl: config.serverUrl,
    credentials: {
      username: config.username,
      password: config.password,
    },
    authMethod: "Basic",
    defaultAccountType: "caldav",
  });
  return {
    fetchCalendars: async () => {
      const calendars = await dav.fetchCalendars();
      return calendars.map((c) => ({
        url: c.url,
        ...(typeof c.displayName === "string" ? { displayName: c.displayName } : {}),
      }));
    },
    fetchCalendarObjects: async ({ calendar, timeRange }) => {
      const objects = await dav.fetchCalendarObjects({
        calendar: calendar as Parameters<typeof dav.fetchCalendarObjects>[0]["calendar"],
        timeRange,
      });
      return objects.map((o) => ({
        url: o.url,
        ...(typeof o.data === "string" ? { data: o.data } : {}),
      }));
    },
    createCalendarObject: async ({ calendar, iCalString, filename }) => {
      const res = await dav.createCalendarObject({
        calendar: calendar as Parameters<typeof dav.createCalendarObject>[0]["calendar"],
        iCalString,
        filename,
      });
      if (!res.ok) {
        throw new Error(`CalDAV createCalendarObject failed: ${res.status} ${res.statusText}`);
      }
      return { url: res.url };
    },
  };
}
