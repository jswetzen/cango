import type { CalEvent } from "@cango/core";
import { parseIcs } from "@cango/adapter-ics";
import { createDAVClient } from "tsdav";

export interface CalDavSourceConfig {
  sourceId: string;
  serverUrl: string;
  username: string;
  password: string;
  resolvePersonId: (sourceId: string) => string;
  selfEmail?: string;
  calendarFilter?: (calendar: CalDavCalendarLike) => boolean;
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

  const client = options.client ?? (await defaultClient(config));
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
  };
}
