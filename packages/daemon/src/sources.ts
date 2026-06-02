import type { CalEvent } from "@cango/core";
import { fetchEvents as fetchIcs } from "@cango/adapter-ics";
import { fetchEvents as fetchCalDav } from "@cango/adapter-caldav";
import type { SourceConnection } from "./config.ts";

export interface FetchWindow {
  start: Date;
  end: Date;
}

/** Injectable adapters so the refresher can be tested without network. */
export interface Adapters {
  fetchIcs: typeof fetchIcs;
  fetchCalDav: typeof fetchCalDav;
}

export const realAdapters: Adapters = {
  fetchIcs,
  fetchCalDav,
};

export async function fetchSource(
  connection: SourceConnection,
  window: FetchWindow,
  personIdForSource: (sourceId: string) => string,
  adapters: Adapters = realAdapters,
): Promise<CalEvent[]> {
  if (connection.kind === "ics") {
    return adapters.fetchIcs(
      {
        sourceId: connection.sourceId,
        url: connection.url,
        resolvePersonId: personIdForSource,
        ...(connection.selfEmail !== undefined ? { selfEmail: connection.selfEmail } : {}),
      },
      window,
    );
  }
  return adapters.fetchCalDav(
    {
      sourceId: connection.sourceId,
      serverUrl: connection.serverUrl,
      username: connection.username,
      password: connection.password,
      resolvePersonId: personIdForSource,
      ...(connection.selfEmail !== undefined ? { selfEmail: connection.selfEmail } : {}),
      ...(connection.calendarName !== undefined
        ? { calendarFilter: (c) => c.displayName === connection.calendarName }
        : {}),
    },
    window,
  );
}

/** Window the daemon keeps warm: a small look-back plus a forward horizon. */
export function refreshWindow(now = new Date(), lookbackDays = 7, horizonDays = 120): FetchWindow {
  const start = new Date(now.getTime() - lookbackDays * 24 * 60 * 60 * 1000);
  const end = new Date(now.getTime() + horizonDays * 24 * 60 * 60 * 1000);
  return { start, end };
}
