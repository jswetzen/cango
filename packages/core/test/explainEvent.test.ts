import { describe, expect, it } from "vitest";
import { explainEvent } from "../src/explainEvent.js";
import { event, makeFamily, rule } from "./fixtures.js";

describe("explainEvent trace", () => {
  it("traces every layer up to and including the deciding one, plus fanout + mask", () => {
    const result = explainEvent(event({ id: "e1" }), makeFamily(), []);
    expect(result.trace.map((t) => t.layer)).toEqual([
      "structural",
      "rule",
      "default",
      "fanout",
      "mask",
    ]);
    expect(result.resolved.resolvedBy).toBe("default");
  });

  it("structural decision short-circuits the per-event layers; fanout + mask still report", () => {
    const result = explainEvent(
      event({ id: "e2", rsvpStatus: "declined" }),
      makeFamily(),
      [],
    );
    expect(result.trace.map((t) => t.layer)).toEqual(["structural", "fanout", "mask"]);
    expect(result.trace[0]!.outcome).toMatch(/info \(structural\)/);
    expect(result.trace.at(-1)!.outcome).toMatch(/no out-of-office mask/);
    expect(result.resolved.resolvedBy).toBe("structural");
  });

  it("shows structural miss then rule hit", () => {
    const result = explainEvent(
      event({ id: "e3", title: "Standup" }),
      makeFamily(),
      [rule({ match: { titleRegex: "Standup" }, role: "soft", reason: "ignore standups" })],
    );
    expect(result.trace.map((t) => t.layer)).toEqual([
      "structural",
      "rule",
      "fanout",
      "mask",
    ]);
    const ruleEntry = result.trace.find((t) => t.layer === "rule");
    expect(ruleEntry?.outcome).toMatch(/soft \(rule\)/);
    expect(result.resolved.resolvedBy).toBe("rule");
  });

  it("explains an OOO mask demoting a same-source neighbour", () => {
    const vacation = event({
      id: "vacation",
      title: "Vacation",
      allDay: true,
      start: new Date("2026-06-01T00:00:00Z"),
      end: new Date("2026-06-02T00:00:00Z"),
    });
    const meeting = event({ id: "mtg", title: "Sprint planning" });
    const rules = [rule({ match: { titleRegex: "Vacation" }, role: "info", effect: "mask" })];

    const result = explainEvent(meeting, makeFamily(), rules, [vacation]);
    expect(result.resolved.resolvedRole).toBe("info");
    const mask = result.trace.at(-1)!;
    expect(mask.layer).toBe("mask");
    expect(mask.outcome).toMatch(/out-of-office: Vacation/);
  });
});
