import { describe, expect, it } from "vitest";
import { checkAvailability } from "../src/checkAvailability.js";
import { event, kid, makeFamily, me, rule, wife } from "./fixtures.js";

const window = {
  start: new Date("2026-06-01T09:00:00Z"),
  end: new Date("2026-06-01T17:00:00Z"),
};

describe("checkAvailability verdicts", () => {
  it("free when no events overlap", () => {
    const result = checkAvailability({
      window,
      people: [me],
      events: [
        event({
          id: "outside",
          start: new Date("2026-06-02T10:00:00Z"),
          end: new Date("2026-06-02T11:00:00Z"),
        }),
      ],
      family: makeFamily(),
      rules: [],
    });
    expect(result.verdict).toBe("free");
    expect(result.conflicts).toEqual([]);
  });

  it("hard_conflict when any event resolves to hard inside window", () => {
    const result = checkAvailability({
      window,
      people: [me],
      events: [event({ id: "work-mtg" })],
      family: makeFamily(),
      rules: [],
    });
    expect(result.verdict).toBe("hard_conflict");
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]!.overlapMinutes).toBe(60);
  });

  it("soft_conflict when only soft roles overlap", () => {
    const result = checkAvailability({
      window,
      people: [me],
      events: [event({ id: "tentative-mtg", rsvpStatus: "tentative" })],
      family: makeFamily(),
      rules: [],
    });
    expect(result.verdict).toBe("soft_conflict");
  });

  it("info-only events do not create conflicts (verdict stays free)", () => {
    const result = checkAvailability({
      window,
      people: [me],
      events: [event({ id: "declined-mtg", rsvpStatus: "declined" })],
      family: makeFamily(),
      rules: [],
    });
    expect(result.verdict).toBe("free");
    expect(result.conflicts).toEqual([]);
  });

  it("hard wins over coexisting soft (verdict = hard_conflict)", () => {
    const result = checkAvailability({
      window,
      people: [me],
      events: [
        event({
          id: "soft",
          rsvpStatus: "tentative",
          start: new Date("2026-06-01T09:30:00Z"),
          end: new Date("2026-06-01T10:00:00Z"),
        }),
        event({
          id: "hard",
          start: new Date("2026-06-01T14:00:00Z"),
          end: new Date("2026-06-01T15:00:00Z"),
        }),
      ],
      family: makeFamily(),
      rules: [],
    });
    expect(result.verdict).toBe("hard_conflict");
    expect(result.conflicts.map((c) => c.event.id).sort()).toEqual(["hard", "soft"]);
  });

  it("multi-person — one person's hard conflict triggers hard_conflict", () => {
    const result = checkAvailability({
      window,
      people: [me, wife],
      events: [
        event({
          id: "wife-mtg",
          personId: "p-wife",
          sourceId: "src-wife-work",
          start: new Date("2026-06-01T13:00:00Z"),
          end: new Date("2026-06-01T14:00:00Z"),
        }),
      ],
      family: makeFamily(),
      rules: [],
    });
    expect(result.verdict).toBe("hard_conflict");
    expect(result.conflicts[0]!.person.id).toBe("p-wife");
  });

  it("events for people not in the input people list are ignored", () => {
    const result = checkAvailability({
      window,
      people: [me],
      events: [
        event({
          id: "kid-club",
          personId: "p-kid",
          sourceId: "src-kid-club",
        }),
      ],
      family: makeFamily(),
      rules: [],
    });
    expect(result.verdict).toBe("free");
  });

  it("partial overlap computes overlapMinutes correctly", () => {
    const result = checkAvailability({
      window,
      people: [me],
      events: [
        event({
          id: "spans-end",
          start: new Date("2026-06-01T16:30:00Z"),
          end: new Date("2026-06-01T18:00:00Z"),
        }),
      ],
      family: makeFamily(),
      rules: [],
    });
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]!.overlapMinutes).toBe(30);
  });

  it("all-day event spanning candidate window registers as hard with full overlap", () => {
    const result = checkAvailability({
      window,
      people: [me],
      events: [
        event({
          id: "allday",
          allDay: true,
          start: new Date("2026-06-01T00:00:00Z"),
          end: new Date("2026-06-02T00:00:00Z"),
        }),
      ],
      family: makeFamily(),
      rules: [],
    });
    expect(result.verdict).toBe("hard_conflict");
    expect(result.conflicts[0]!.overlapMinutes).toBe(8 * 60);
  });

  it("attendance NEVER_ATTENDS on a kid practice keeps verdict free", () => {
    const result = checkAvailability({
      window,
      people: [kid],
      events: [
        event({
          id: "practice",
          personId: "p-kid",
          sourceId: "src-kid-club",
          seriesId: "series-football",
        }),
      ],
      family: makeFamily([
        {
          personId: "p-kid",
          seriesId: "series-football",
          role: "NEVER_ATTENDS",
        },
      ]),
      rules: [],
    });
    expect(result.verdict).toBe("free");
  });

  it("rule downgrades a hard event to soft", () => {
    const result = checkAvailability({
      window,
      people: [me],
      events: [event({ id: "standup", title: "Standup" })],
      family: makeFamily(),
      rules: [rule({ match: { titleRegex: "^Standup$" }, role: "soft" })],
    });
    expect(result.verdict).toBe("soft_conflict");
  });

  it("throws on a degenerate window", () => {
    expect(() =>
      checkAvailability({
        window: { start: new Date("2026-06-01T10:00:00Z"), end: new Date("2026-06-01T10:00:00Z") },
        people: [me],
        events: [],
        family: makeFamily(),
        rules: [],
      }),
    ).toThrow();
  });
});
