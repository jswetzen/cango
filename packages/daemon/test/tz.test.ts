import { describe, expect, test } from "bun:test";
import {
  formatInZone,
  isValidTimeZone,
  parseInZone,
  zonedDateOnlyUtc,
} from "../src/tz.ts";

const STHLM = "Europe/Stockholm";

describe("formatInZone", () => {
  test("summer instant renders as CEST (+02:00)", () => {
    // 2026-06-07T13:00:00Z == 15:00 in Stockholm (CEST)
    const d = new Date("2026-06-07T13:00:00Z");
    expect(formatInZone(d, STHLM)).toBe("2026-06-07T15:00:00+02:00");
  });

  test("winter instant renders as CET (+01:00)", () => {
    // 2026-01-15T12:00:00Z == 13:00 in Stockholm (CET)
    const d = new Date("2026-01-15T12:00:00Z");
    expect(formatInZone(d, STHLM)).toBe("2026-01-15T13:00:00+01:00");
  });

  test("UTC zone renders with Z", () => {
    const d = new Date("2026-06-07T13:00:00Z");
    expect(formatInZone(d, "UTC")).toBe("2026-06-07T13:00:00Z");
  });

  test("sub-second instants do not corrupt the offset", () => {
    const d = new Date("2026-06-07T13:00:00.500Z");
    expect(formatInZone(d, STHLM)).toBe("2026-06-07T15:00:00+02:00");
  });
});

describe("parseInZone", () => {
  test("offset-less summer wall time is interpreted in the zone", () => {
    // 15:00 wall in Stockholm summer == 13:00Z
    expect(parseInZone("2026-06-07T15:00:00", STHLM).toISOString()).toBe(
      "2026-06-07T13:00:00.000Z",
    );
  });

  test("offset-less winter wall time is interpreted in the zone", () => {
    // 13:00 wall in Stockholm winter == 12:00Z
    expect(parseInZone("2026-01-15T13:00:00", STHLM).toISOString()).toBe(
      "2026-01-15T12:00:00.000Z",
    );
  });

  test("date-only midnight is interpreted in the zone", () => {
    // 2026-06-01T00:00 Stockholm == 2026-05-31T22:00Z
    expect(parseInZone("2026-06-01T00:00:00", STHLM).toISOString()).toBe(
      "2026-05-31T22:00:00.000Z",
    );
  });

  test("explicit Z is honored verbatim", () => {
    expect(parseInZone("2026-06-07T13:00:00Z", STHLM).toISOString()).toBe(
      "2026-06-07T13:00:00.000Z",
    );
  });

  test("explicit offset is honored verbatim", () => {
    expect(parseInZone("2026-06-07T15:00:00+02:00", STHLM).toISOString()).toBe(
      "2026-06-07T13:00:00.000Z",
    );
  });

  test("round-trips with formatInZone", () => {
    const d = new Date("2026-06-07T13:00:00Z");
    expect(parseInZone(formatInZone(d, STHLM), STHLM).getTime()).toBe(d.getTime());
  });
});

describe("zonedDateOnlyUtc", () => {
  test("re-anchors a bare date parsed in a positive-offset zone to UTC midnight", () => {
    // The all-day off-by-one repro: 2026-07-01 parsed in Stockholm (+02:00)
    // lands on 2026-06-30T22:00Z, whose UTC date is the day before. The helper
    // recovers the intended calendar date at UTC midnight.
    const localMidnight = parseInZone("2026-07-01", STHLM);
    expect(localMidnight.toISOString()).toBe("2026-06-30T22:00:00.000Z");
    expect(zonedDateOnlyUtc(localMidnight, STHLM).toISOString()).toBe(
      "2026-07-01T00:00:00.000Z",
    );
  });

  test("is idempotent for an instant already at UTC midnight", () => {
    const utcMidnight = new Date("2026-06-16T00:00:00Z");
    expect(zonedDateOnlyUtc(utcMidnight, STHLM).toISOString()).toBe(
      "2026-06-16T00:00:00.000Z",
    );
  });

  test("winter date (CET, +01:00) re-anchors correctly", () => {
    const localMidnight = parseInZone("2026-01-15", STHLM);
    expect(localMidnight.toISOString()).toBe("2026-01-14T23:00:00.000Z");
    expect(zonedDateOnlyUtc(localMidnight, STHLM).toISOString()).toBe(
      "2026-01-15T00:00:00.000Z",
    );
  });

  test("UTC zone is a no-op", () => {
    const d = parseInZone("2026-07-01", "UTC");
    expect(zonedDateOnlyUtc(d, "UTC").toISOString()).toBe("2026-07-01T00:00:00.000Z");
  });
});

describe("isValidTimeZone", () => {
  test("accepts a real zone and rejects junk", () => {
    expect(isValidTimeZone(STHLM)).toBe(true);
    expect(isValidTimeZone("UTC")).toBe(true);
    expect(isValidTimeZone("Mars/Olympus_Mons")).toBe(false);
  });
});
