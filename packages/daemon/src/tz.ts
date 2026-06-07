// Timezone-aware formatting/parsing at cango's RPC boundary.
//
// Internally every instant is a UTC `Date`; node-ical/tsdav already resolve
// TZID/Z/VTIMEZONE correctly. The only place a zone matters is where we emit
// strings to (and accept strings from) the outside world, where a naked
// `toISOString()` / `new Date(str)` silently means UTC or the process TZ. These
// helpers pin both ends to a configured IANA zone, using native `Intl` only
// (Bun ships full ICU) — no extra dependency.

/** True when `tz` is a usable IANA zone (so config can fail loudly on typos). */
export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

interface WallParts {
  year: string;
  month: string;
  day: string;
  hour: string;
  minute: string;
  second: string;
}

/** Wall-clock components of `date` as seen in `tz`. */
function zonedParts(date: Date, tz: string): WallParts {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = dtf.formatToParts(date);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  let hour = get("hour");
  if (hour === "24") hour = "00"; // some engines emit 24 for midnight
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour,
    minute: get("minute"),
    second: get("second"),
  };
}

/** Offset of `tz` from UTC at the given instant, in whole-minute milliseconds. */
function zoneOffsetMs(date: Date, tz: string): number {
  const p = zonedParts(date, tz);
  const wallAsUtc = Date.UTC(
    Number(p.year),
    Number(p.month) - 1,
    Number(p.day),
    Number(p.hour),
    Number(p.minute),
    Number(p.second),
  );
  // Round away sub-second noise; real offsets are whole minutes.
  return Math.round((wallAsUtc - date.getTime()) / 60000) * 60000;
}

function formatOffsetMs(ms: number): string {
  if (ms === 0) return "Z";
  const sign = ms > 0 ? "+" : "-";
  const abs = Math.abs(ms);
  const hh = String(Math.floor(abs / 3_600_000)).padStart(2, "0");
  const mm = String(Math.floor((abs % 3_600_000) / 60_000)).padStart(2, "0");
  return `${sign}${hh}:${mm}`;
}

/** Format an instant as offset-bearing ISO in `tz`, e.g. `2026-06-07T15:00:00+02:00`. */
export function formatInZone(date: Date, tz: string): string {
  const p = zonedParts(date, tz);
  const offset = formatOffsetMs(zoneOffsetMs(date, tz));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}${offset}`;
}

/**
 * Integer count of days from the Unix epoch to the wall-clock *date* of `date`
 * as seen in `tz`. Two instants on the same local calendar day share an index,
 * so `b - a` is the number of day boundaries between them — the basis for an
 * event's day span.
 */
export function zonedDayIndex(date: Date, tz: string): number {
  const p = zonedParts(date, tz);
  return Math.floor(
    Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day)) / 86_400_000,
  );
}

// Explicit offset/Z already present on the time portion (e.g. `...T13:00:00Z` or
// `...+02:00`); such inputs are unambiguous and parsed as-is.
const HAS_OFFSET = /([Zz]|[+-]\d{2}:?\d{2})$/;
const WALL_CLOCK = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?/;

/**
 * Parse an ISO-ish string to a UTC instant. If it carries an explicit offset/Z,
 * honor it; otherwise interpret the wall-clock components in `tz`.
 */
export function parseInZone(input: string, tz: string): Date {
  const trimmed = input.trim();
  if (HAS_OFFSET.test(trimmed)) return new Date(trimmed);

  const m = WALL_CLOCK.exec(trimmed);
  if (!m) return new Date(trimmed); // unrecognized shape: fall back to native

  const [, y, mo, d, hh = "00", mi = "00", ss = "00"] = m;
  const wallAsUtc = Date.UTC(
    Number(y),
    Number(mo) - 1,
    Number(d),
    Number(hh),
    Number(mi),
    Number(ss),
  );
  // Subtract the zone offset to recover the true instant. Re-evaluate once so a
  // wall time landing near a DST transition settles on the right side.
  const offset1 = zoneOffsetMs(new Date(wallAsUtc), tz);
  let instant = wallAsUtc - offset1;
  const offset2 = zoneOffsetMs(new Date(instant), tz);
  if (offset2 !== offset1) instant = wallAsUtc - offset2;
  return new Date(instant);
}
