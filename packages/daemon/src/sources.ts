import type { CalEvent } from "@cango/core";
import { fetchEvents as fetchIcs } from "@cango/adapter-ics";
import {
  fetchEvents as fetchCalDav,
  createEvent as createCalDav,
  type CreateEventInput,
} from "@cango/adapter-caldav";
import type { SourceConnection } from "./config.ts";

export type { CreateEventInput };

export interface FetchWindow {
  start: Date;
  end: Date;
}

/** Injectable adapters so the refresher can be tested without network. */
export interface Adapters {
  fetchIcs: typeof fetchIcs;
  fetchCalDav: typeof fetchCalDav;
  createCalDav: typeof createCalDav;
}

export const realAdapters: Adapters = {
  fetchIcs,
  fetchCalDav,
  createCalDav,
};

export async function fetchSource(
  connection: SourceConnection,
  window: FetchWindow,
  personIdForSource: (sourceId: string) => string,
  adapters: Adapters = realAdapters,
  resolveAttendeeIds?: (emails: string[]) => string[],
): Promise<CalEvent[]> {
  if (connection.kind === "ics") {
    return adapters.fetchIcs(
      {
        sourceId: connection.sourceId,
        url: connection.url,
        resolvePersonId: personIdForSource,
        ...(resolveAttendeeIds !== undefined ? { resolveAttendeeIds } : {}),
        ...(connection.selfEmail !== undefined ? { selfEmail: connection.selfEmail } : {}),
      },
      window,
    );
  }
  return adapters.fetchCalDav(
    caldavConfig(connection, personIdForSource, resolveAttendeeIds),
    window,
  );
}

/** Build the adapter config shared by the read and write paths. */
function caldavConfig(
  connection: Extract<SourceConnection, { kind: "caldav" }>,
  personIdForSource: (sourceId: string) => string,
  resolveAttendeeIds?: (emails: string[]) => string[],
) {
  return {
    sourceId: connection.sourceId,
    serverUrl: connection.serverUrl,
    username: connection.username,
    password: connection.password,
    resolvePersonId: personIdForSource,
    ...(resolveAttendeeIds !== undefined ? { resolveAttendeeIds } : {}),
    ...(connection.selfEmail !== undefined ? { selfEmail: connection.selfEmail } : {}),
    ...(connection.calendarUrl !== undefined ? { calendarUrl: connection.calendarUrl } : {}),
    // calendarName is ignored when an explicit calendarUrl pins the collection.
    ...(connection.calendarName !== undefined && connection.calendarUrl === undefined
      ? { calendarFilter: (c: { displayName?: string }) => c.displayName === connection.calendarName }
      : {}),
  };
}

/**
 * Create an event on a writable source. Only CalDAV sources can be written
 * today; ICS feeds are read-only by nature. Returns the new event's UID, which
 * matches the `id` it will carry once refetched. Writability (the `writable`
 * opt-in) is enforced by the RPC layer before this is called.
 */
export async function createInSource(
  connection: SourceConnection,
  input: CreateEventInput,
  personIdForSource: (sourceId: string) => string,
  adapters: Adapters = realAdapters,
): Promise<string> {
  if (connection.kind !== "caldav") {
    throw new Error(`source kind '${connection.kind}' is not writable`);
  }
  return adapters.createCalDav(caldavConfig(connection, personIdForSource), input);
}

/** Window the daemon keeps warm: a small look-back plus a forward horizon. */
export function refreshWindow(now = new Date(), lookbackDays = 7, horizonDays = 120): FetchWindow {
  const start = new Date(now.getTime() - lookbackDays * 24 * 60 * 60 * 1000);
  const end = new Date(now.getTime() + horizonDays * 24 * 60 * 60 * 1000);
  return { start, end };
}
