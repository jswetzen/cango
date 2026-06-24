import type { CalEvent, Role, RsvpStatus } from "@cango/core";
import * as nodeIcal from "node-ical";
import type { CalendarComponent, VEvent } from "node-ical";
import { deriveSeriesId } from "./seriesId.js";

export interface IcsSourceConfig {
  sourceId: string;
  url: string;
  resolvePersonId: (sourceId: string) => string;
  /** Map ATTENDEE emails to known person ids (unmatched/external are dropped).
   * Optional: without it, events carry no `attendeeIds` and occupancy falls
   * back to the source owner + fanout rules. */
  resolveAttendeeIds?: (emails: string[]) => string[];
  selfEmail?: string;
}

export type IcsFetcher = (url: string) => Promise<string>;

export interface FetchEventsOptions {
  fetcher?: IcsFetcher;
}

export async function fetchEvents(
  config: IcsSourceConfig,
  window: { start: Date; end: Date },
  options: FetchEventsOptions = {},
): Promise<CalEvent[]> {
  if (!(window.end.getTime() > window.start.getTime())) {
    throw new Error("fetchEvents: window.end must be after window.start");
  }

  const fetcher = options.fetcher ?? defaultFetcher;
  const body = await fetcher(config.url);
  return parseIcs(body, config, window);
}

export function parseIcs(
  body: string,
  config: IcsSourceConfig,
  window: { start: Date; end: Date },
): CalEvent[] {
  const parsed = nodeIcal.sync.parseICS(body);
  const personId = config.resolvePersonId(config.sourceId);
  const out: CalEvent[] = [];

  for (const key of Object.keys(parsed)) {
    const component = parsed[key] as CalendarComponent | undefined;
    if (!component || component.type !== "VEVENT") continue;
    const vevent = component;
    appendOccurrences(vevent, config, personId, window, out);
  }
  return out;
}

function appendOccurrences(
  vevent: VEvent,
  config: IcsSourceConfig,
  personId: string,
  window: { start: Date; end: Date },
  out: CalEvent[],
): void {
  if (!vevent.start || !vevent.end) return;
  const baseDurationMs = vevent.end.getTime() - vevent.start.getTime();
  if (baseDurationMs <= 0) return;

  const uid = vevent.uid;
  const title = vevent.summary ?? "";
  const seriesId = deriveSeriesId(config.sourceId, uid, title);
  const allDay = isAllDay(vevent);

  const overrides = vevent.recurrences ?? {};
  const exDates = collectExDates(vevent);

  if (vevent.rrule) {
    const occurrences = vevent.rrule.between(window.start, window.end, true);
    for (const occStart of occurrences) {
      const overrideKey = occurrenceKey(occStart);
      if (exDates.has(overrideKey)) continue;
      const override = overrides[overrideKey];
      if (override) {
        const oStart = override.start;
        const oEnd = override.end;
        if (!oStart || !oEnd) continue;
        if (!overlapsWindow(oStart, oEnd, window)) continue;
        out.push(
          toCalEvent(override, config, personId, seriesId, allDay, uid, true),
        );
        continue;
      }
      const occEnd = new Date(occStart.getTime() + baseDurationMs);
      if (!overlapsWindow(occStart, occEnd, window)) continue;
      out.push(
        buildEvent({
          uid,
          occurrenceKey: overrideKey,
          vevent,
          config,
          personId,
          seriesId,
          allDay,
          start: occStart,
          end: occEnd,
          recurring: true,
        }),
      );
    }
  } else {
    if (!overlapsWindow(vevent.start, vevent.end, window)) return;
    out.push(toCalEvent(vevent, config, personId, seriesId, allDay, uid, false));
  }
}

function buildEvent(args: {
  uid: string;
  occurrenceKey: string;
  vevent: VEvent;
  config: IcsSourceConfig;
  personId: string;
  seriesId: string;
  allDay: boolean;
  start: Date;
  end: Date;
  recurring: boolean;
}): CalEvent {
  const { uid, occurrenceKey, vevent, config, personId, seriesId, allDay, start, end, recurring } =
    args;
  const id = recurring ? `${uid}@${occurrenceKey}` : uid;
  return assembleCalEvent({
    id,
    config,
    personId,
    seriesId,
    title: vevent.summary ?? "",
    start,
    end,
    allDay,
    vevent,
    recurring,
  });
}

function toCalEvent(
  vevent: VEvent,
  config: IcsSourceConfig,
  personId: string,
  seriesId: string,
  allDay: boolean,
  baseUid: string,
  recurring: boolean,
): CalEvent {
  const start = vevent.start!;
  const end = vevent.end!;
  const id = recurring ? `${baseUid}@${occurrenceKey(start)}` : vevent.uid;
  return assembleCalEvent({
    id,
    config,
    personId,
    seriesId,
    title: vevent.summary ?? "",
    start,
    end,
    allDay,
    vevent,
    recurring,
  });
}

function assembleCalEvent(args: {
  id: string;
  config: IcsSourceConfig;
  personId: string;
  seriesId: string;
  title: string;
  start: Date;
  end: Date;
  allDay: boolean;
  vevent: VEvent;
  recurring: boolean;
}): CalEvent {
  const { id, config, personId, seriesId, title, start, end, allDay, vevent, recurring } = args;
  const rsvp = extractRsvp(vevent, config.selfEmail);
  const organizerIsSelf = isOrganizerSelf(vevent, config.selfEmail);
  const attendeeCount = countAttendees(vevent);
  const attendees = resolveAttendees(vevent, config);
  const attendeeIds = attendees.map((a) => a.personId);
  return {
    id,
    sourceId: config.sourceId,
    personId,
    seriesId,
    title,
    start,
    end,
    allDay,
    recurring,
    ...(rsvp !== undefined ? { rsvpStatus: rsvp } : {}),
    ...(organizerIsSelf !== undefined ? { organizerIsSelf } : {}),
    ...(attendeeCount !== undefined ? { attendeeCount } : {}),
    ...(attendeeIds.length > 0 ? { attendeeIds } : {}),
    ...(attendees.length > 0 ? { attendees } : {}),
    raw: vevent,
  };
}

function overlapsWindow(start: Date, end: Date, window: { start: Date; end: Date }): boolean {
  return start.getTime() < window.end.getTime() && end.getTime() > window.start.getTime();
}

function isAllDay(vevent: VEvent): boolean {
  // node-ical: datetype === 'date' for all-day; fallback heuristic: exact midnight + 24h
  if ((vevent as { datetype?: string }).datetype === "date") return true;
  const start = vevent.start;
  const end = vevent.end;
  if (!start || !end) return false;
  const sameDayBoundary =
    start.getUTCHours() === 0 &&
    start.getUTCMinutes() === 0 &&
    start.getUTCSeconds() === 0 &&
    end.getTime() - start.getTime() >= 24 * 60 * 60 * 1000 - 1 &&
    (end.getTime() - start.getTime()) % (24 * 60 * 60 * 1000) === 0;
  return sameDayBoundary;
}

function occurrenceKey(d: Date): string {
  return d.toISOString();
}

function collectExDates(vevent: VEvent): Set<string> {
  const out = new Set<string>();
  const raw = (vevent as { exdate?: unknown }).exdate;
  if (!raw || typeof raw !== "object") return out;
  for (const value of Object.values(raw as Record<string, unknown>)) {
    if (value instanceof Date) out.add(occurrenceKey(value));
  }
  return out;
}

function extractRsvp(vevent: VEvent, selfEmail?: string): RsvpStatus | undefined {
  if (!selfEmail) return undefined;
  const attendees = normalizeAttendees(vevent);
  const lowerSelf = selfEmail.toLowerCase();
  for (const att of attendees) {
    const email = attendeeEmail(att);
    if (!email) continue;
    if (email.toLowerCase() !== lowerSelf) continue;
    const partstat = ((att as { params?: { PARTSTAT?: string } }).params?.PARTSTAT ?? "")
      .toUpperCase();
    switch (partstat) {
      case "ACCEPTED":
        return "accepted";
      case "TENTATIVE":
        return "tentative";
      case "DECLINED":
        return "declined";
      case "NEEDS-ACTION":
        return "needsAction";
      default:
        return undefined;
    }
  }
  return undefined;
}

function isOrganizerSelf(vevent: VEvent, selfEmail?: string): boolean | undefined {
  if (!selfEmail) return undefined;
  const org = (vevent as { organizer?: unknown }).organizer;
  if (!org) return false;
  const email = attendeeEmail(org);
  if (!email) return false;
  return email.toLowerCase() === selfEmail.toLowerCase();
}

function countAttendees(vevent: VEvent): number | undefined {
  const attendees = normalizeAttendees(vevent);
  return attendees.length || undefined;
}

/** Map the event's ATTENDEEs to known {personId, role}, reading each attendee's
 * PARTSTAT/ROLE for the role. Returns [] when no resolver is supplied or nothing
 * matches — occupancy then leans on the source owner + fanout rules. Deduped by
 * personId (first ATTENDEE wins), order-preserving. */
function resolveAttendees(
  vevent: VEvent,
  config: IcsSourceConfig,
): Array<{ personId: string; role?: Role }> {
  const resolve = config.resolveAttendeeIds;
  if (!resolve) return [];
  const out: Array<{ personId: string; role?: Role }> = [];
  const seen = new Set<string>();
  for (const att of normalizeAttendees(vevent)) {
    const email = attendeeEmail(att);
    if (!email) continue;
    const [personId] = resolve([email]);
    if (!personId || seen.has(personId)) continue;
    seen.add(personId);
    const params = (att as { params?: { PARTSTAT?: string; ROLE?: string } }).params;
    const role = attendeeRole(params?.PARTSTAT, params?.ROLE);
    out.push(role !== undefined ? { personId, role } : { personId });
  }
  return out;
}

/** Read an ATTENDEE's occupancy role from its iCal props. PARTSTAT is the
 * attendance signal and wins; ROLE is the fallback; an unknown/NEEDS-ACTION
 * attendee yields `undefined` so the occupant inherits the event's base role. */
function attendeeRole(partstat?: string, role?: string): Role | undefined {
  switch ((partstat ?? "").toUpperCase()) {
    case "ACCEPTED":
      return "hard";
    case "TENTATIVE":
      return "soft";
    case "DECLINED":
      return "info";
  }
  switch ((role ?? "").toUpperCase()) {
    case "REQ-PARTICIPANT":
      return "hard";
    case "OPT-PARTICIPANT":
      return "soft";
    case "NON-PARTICIPANT":
      return "info";
  }
  return undefined;
}

function normalizeAttendees(vevent: VEvent): unknown[] {
  const raw = (vevent as { attendee?: unknown }).attendee;
  if (!raw) return [];
  return Array.isArray(raw) ? raw : [raw];
}

function attendeeEmail(att: unknown): string | undefined {
  if (typeof att === "string") return mailtoToEmail(att);
  if (att && typeof att === "object") {
    const obj = att as { val?: string; params?: { CN?: string } };
    if (typeof obj.val === "string") return mailtoToEmail(obj.val);
  }
  return undefined;
}

function mailtoToEmail(s: string): string | undefined {
  const v = s.trim();
  if (v.toLowerCase().startsWith("mailto:")) return v.slice(7);
  if (v.includes("@")) return v;
  return undefined;
}

const defaultFetcher: IcsFetcher = async (url) => {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`fetchEvents: ${url} returned ${res.status}`);
  }
  return res.text();
};
