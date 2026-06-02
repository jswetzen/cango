import { describe, expect, it } from "vitest";
import { explainEvent } from "../src/explainEvent.js";
import { event, makeFamily, rule } from "./fixtures.js";

describe("explainEvent trace", () => {
  it("traces every layer up to and including the deciding one", () => {
    const result = explainEvent(event({ id: "e1" }), makeFamily(), []);
    expect(result.trace.map((t) => t.layer)).toEqual([
      "structural",
      "attendance",
      "rule",
      "default",
    ]);
    expect(result.resolved.resolvedBy).toBe("default");
  });

  it("stops naming a deciding layer at the first hit, but earlier layers report no-match", () => {
    const result = explainEvent(
      event({ id: "e2", rsvpStatus: "declined" }),
      makeFamily(),
      [],
    );
    expect(result.trace[0]!.layer).toBe("structural");
    expect(result.trace[0]!.outcome).toMatch(/info \(structural\)/);
    expect(result.trace).toHaveLength(1);
    expect(result.resolved.resolvedBy).toBe("structural");
  });

  it("shows attendance miss then rule hit", () => {
    const result = explainEvent(
      event({ id: "e3", title: "Standup" }),
      makeFamily(),
      [rule({ match: { titleRegex: "Standup" }, role: "soft", reason: "ignore standups" })],
    );
    expect(result.trace.map((t) => t.layer)).toEqual([
      "structural",
      "attendance",
      "rule",
    ]);
    const rules = result.trace.find((t) => t.layer === "rule");
    expect(rules?.outcome).toMatch(/soft \(rule\)/);
    expect(result.resolved.resolvedBy).toBe("rule");
  });
});
