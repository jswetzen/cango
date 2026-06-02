import { describe, expect, it } from "vitest";
import { findFreeSlots } from "../src/findFreeSlots.js";
import { event, makeFamily, me } from "./fixtures.js";

describe("findFreeSlots", () => {
  const range = {
    start: new Date("2026-06-01T08:00:00Z"),
    end: new Date("2026-06-01T18:00:00Z"),
  };

  it("returns the full range when there are no events", () => {
    const slots = findFreeSlots({
      range,
      duration: 30,
      people: [me],
      events: [],
      family: makeFamily(),
      rules: [],
    });
    expect(slots).toEqual([
      { start: range.start, end: range.end },
    ]);
  });

  it("excludes hard events", () => {
    const slots = findFreeSlots({
      range,
      duration: 30,
      people: [me],
      events: [
        event({
          id: "block",
          start: new Date("2026-06-01T10:00:00Z"),
          end: new Date("2026-06-01T11:00:00Z"),
        }),
      ],
      family: makeFamily(),
      rules: [],
    });
    expect(slots).toEqual([
      { start: new Date("2026-06-01T08:00:00Z"), end: new Date("2026-06-01T10:00:00Z") },
      { start: new Date("2026-06-01T11:00:00Z"), end: new Date("2026-06-01T18:00:00Z") },
    ]);
  });

  it("ignores soft/info events when computing slots", () => {
    const slots = findFreeSlots({
      range,
      duration: 30,
      people: [me],
      events: [
        event({
          id: "soft",
          rsvpStatus: "tentative",
          start: new Date("2026-06-01T10:00:00Z"),
          end: new Date("2026-06-01T11:00:00Z"),
        }),
        event({
          id: "info",
          rsvpStatus: "declined",
          start: new Date("2026-06-01T13:00:00Z"),
          end: new Date("2026-06-01T14:00:00Z"),
        }),
      ],
      family: makeFamily(),
      rules: [],
    });
    expect(slots).toEqual([{ start: range.start, end: range.end }]);
  });

  it("filters out gaps shorter than duration", () => {
    const slots = findFreeSlots({
      range,
      duration: 120,
      people: [me],
      events: [
        event({
          id: "a",
          start: new Date("2026-06-01T09:30:00Z"),
          end: new Date("2026-06-01T10:30:00Z"),
        }),
        event({
          id: "b",
          start: new Date("2026-06-01T11:30:00Z"),
          end: new Date("2026-06-01T12:30:00Z"),
        }),
      ],
      family: makeFamily(),
      rules: [],
    });
    expect(slots).toEqual([
      { start: new Date("2026-06-01T12:30:00Z"), end: new Date("2026-06-01T18:00:00Z") },
    ]);
    expect(slots.every((s) => s.end.getTime() - s.start.getTime() >= 120 * 60_000)).toBe(true);
  });

  it("merges overlapping busy intervals", () => {
    const slots = findFreeSlots({
      range,
      duration: 30,
      people: [me],
      events: [
        event({
          id: "x",
          start: new Date("2026-06-01T10:00:00Z"),
          end: new Date("2026-06-01T11:30:00Z"),
        }),
        event({
          id: "y",
          start: new Date("2026-06-01T11:00:00Z"),
          end: new Date("2026-06-01T12:00:00Z"),
        }),
      ],
      family: makeFamily(),
      rules: [],
    });
    expect(slots).toEqual([
      { start: new Date("2026-06-01T08:00:00Z"), end: new Date("2026-06-01T10:00:00Z") },
      { start: new Date("2026-06-01T12:00:00Z"), end: new Date("2026-06-01T18:00:00Z") },
    ]);
  });

  it("clips to working hours per day", () => {
    const multiDay = {
      start: new Date("2026-06-01T00:00:00Z"),
      end: new Date("2026-06-03T00:00:00Z"),
    };
    const slots = findFreeSlots({
      range: multiDay,
      duration: 30,
      people: [me],
      events: [],
      family: makeFamily(),
      rules: [],
      workingHours: { start: "09:00", end: "17:00" },
    });
    expect(slots).toEqual([
      { start: new Date("2026-06-01T09:00:00Z"), end: new Date("2026-06-01T17:00:00Z") },
      { start: new Date("2026-06-02T09:00:00Z"), end: new Date("2026-06-02T17:00:00Z") },
    ]);
  });
});
