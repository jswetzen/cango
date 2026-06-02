import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Cache } from "../src/cache.ts";
import type { CalEvent, ResolvedEvent } from "@cango/core";

function ev(partial: Partial<CalEvent> & Pick<CalEvent, "id">): CalEvent {
  return {
    sourceId: "src-a",
    personId: "p-me",
    title: "Event",
    start: new Date("2026-06-01T10:00:00Z"),
    end: new Date("2026-06-01T11:00:00Z"),
    allDay: false,
    ...partial,
  };
}

describe("Cache", () => {
  let cache: Cache;

  beforeEach(() => {
    cache = new Cache(":memory:");
  });
  afterEach(() => cache.close());

  test("replaceSourceEvents then eventsInWindow round-trips", () => {
    cache.replaceSourceEvents("src-a", [
      ev({ id: "e1", seriesId: "s1", rsvpStatus: "tentative" }),
      ev({
        id: "e2",
        start: new Date("2026-06-05T09:00:00Z"),
        end: new Date("2026-06-05T10:00:00Z"),
      }),
    ]);
    const inWindow = cache.eventsInWindow(
      new Date("2026-06-01T00:00:00Z"),
      new Date("2026-06-02T00:00:00Z"),
    );
    expect(inWindow).toHaveLength(1);
    expect(inWindow[0]!.id).toBe("e1");
    expect(inWindow[0]!.rsvpStatus).toBe("tentative");
    expect(inWindow[0]!.start instanceof Date).toBe(true);
  });

  test("replaceSourceEvents replaces, does not append", () => {
    cache.replaceSourceEvents("src-a", [ev({ id: "e1" })]);
    cache.replaceSourceEvents("src-a", [ev({ id: "e2" })]);
    const all = cache.eventsInWindow(
      new Date("2026-06-01T00:00:00Z"),
      new Date("2026-07-01T00:00:00Z"),
    );
    expect(all.map((e) => e.id)).toEqual(["e2"]);
  });

  test("eventsInWindow filters by personIds", () => {
    cache.replaceSourceEvents("src-a", [
      ev({ id: "e1", personId: "p-me" }),
      ev({ id: "e2", personId: "p-wife" }),
    ]);
    const mine = cache.eventsInWindow(
      new Date("2026-06-01T00:00:00Z"),
      new Date("2026-06-02T00:00:00Z"),
      ["p-me"],
    );
    expect(mine.map((e) => e.id)).toEqual(["e1"]);
  });

  test("recentSeries groups by series", () => {
    cache.replaceSourceEvents("src-a", [
      ev({ id: "e1", seriesId: "s1", start: new Date("2026-06-01T10:00:00Z") }),
      ev({ id: "e2", seriesId: "s1", start: new Date("2026-06-08T10:00:00Z") }),
      ev({ id: "e3", seriesId: "s2", start: new Date("2026-06-03T10:00:00Z") }),
    ]);
    const series = cache.recentSeries("src-a");
    expect(series).toHaveLength(2);
    expect(series[0]!.seriesId).toBe("s1");
    expect(series[0]!.count).toBe(2);
  });

  test("resolved cache get/put round-trips and is version-keyed", () => {
    const resolved: ResolvedEvent = {
      ...ev({ id: "e1" }),
      resolvedRole: "soft",
      resolvedBy: "rule",
      resolvedReason: "test",
      ruleId: "r1",
    };
    cache.putResolved("famv1", "rulev1", resolved);
    expect(cache.getResolved("src-a", "e1", "famv1", "rulev1")?.resolvedRole).toBe("soft");
    expect(cache.getResolved("src-a", "e1", "famv2", "rulev1")).toBeNull();
  });

  test("replaceSourceEvents invalidates resolved cache for that source", () => {
    const resolved: ResolvedEvent = {
      ...ev({ id: "e1" }),
      resolvedRole: "hard",
      resolvedBy: "default",
      resolvedReason: "x",
    };
    cache.putResolved("famv1", "rulev1", resolved);
    cache.replaceSourceEvents("src-a", [ev({ id: "e1" })]);
    expect(cache.getResolved("src-a", "e1", "famv1", "rulev1")).toBeNull();
  });

  test("markSuccess / markError tracked per source", () => {
    cache.markError("src-a", "boom", 1000);
    let st = cache.sourceStatuses();
    expect(st[0]!.lastError).toBe("boom");
    expect(st[0]!.lastErrorAt).toBe(1000);
    cache.markSuccess("src-a", 2000);
    st = cache.sourceStatuses();
    expect(st[0]!.lastSuccessAt).toBe(2000);
    expect(st[0]!.lastError).toBeNull();
  });
});
