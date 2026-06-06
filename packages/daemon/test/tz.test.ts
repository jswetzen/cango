import { describe, expect, test } from "bun:test";
import { formatInZone, isValidTimeZone, parseInZone } from "../src/tz.ts";

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

describe("isValidTimeZone", () => {
  test("accepts a real zone and rejects junk", () => {
    expect(isValidTimeZone(STHLM)).toBe(true);
    expect(isValidTimeZone("UTC")).toBe(true);
    expect(isValidTimeZone("Mars/Olympus_Mons")).toBe(false);
  });
});
