import { describe, expect, it } from "vitest";
import { applyMasks } from "../src/applyMasks.js";
import { resolveRole } from "../src/resolveRole.js";
import type { Rule } from "../src/types.js";
import { event, makeFamily, rule } from "./fixtures.js";

const family = makeFamily();

function resolve(events: ReturnType<typeof event>[], rules: Rule[]) {
  return applyMasks(
    events.map((e) => resolveRole(e, family, rules)),
    rules,
  );
}

const vacation = event({
  id: "vacation",
  title: "Vacation",
  allDay: true,
  start: new Date("2026-06-01T00:00:00Z"),
  end: new Date("2026-06-03T00:00:00Z"),
});

const maskRule = rule({
  match: { titleRegex: "Vacation" },
  role: "info",
  effect: "mask",
  reason: "out of office",
});

describe("applyMasks (out-of-office)", () => {
  it("demotes a hard same-source event the marker spans to info", () => {
    const meeting = event({ id: "mtg", title: "Sprint planning" });
    const out = resolve([vacation, meeting], [maskRule]);
    const resolvedMtg = out.find((e) => e.id === "mtg")!;
    expect(resolvedMtg.resolvedRole).toBe("info");
    expect(resolvedMtg.resolvedBy).toBe("rule");
    expect(resolvedMtg.resolvedReason).toMatch(/out-of-office: Vacation/);
  });

  it("leaves an overlapping event on a DIFFERENT source untouched", () => {
    const kidPractice = event({
      id: "practice",
      personId: "p-kid",
      sourceId: "src-kid-club",
      title: "Football",
      start: new Date("2026-06-01T10:00:00Z"),
      end: new Date("2026-06-01T11:00:00Z"),
    });
    const out = resolve([vacation, kidPractice], [maskRule]);
    const resolved = out.find((e) => e.id === "practice")!;
    // src-kid-club defaults to info anyway, but crucially resolvedBy is the
    // source default, not the mask.
    expect(resolved.resolvedBy).toBe("default");
  });

  it("does not affect non-overlapping events on the same source", () => {
    const later = event({
      id: "later",
      title: "Sprint planning",
      start: new Date("2026-06-05T10:00:00Z"),
      end: new Date("2026-06-05T11:00:00Z"),
    });
    const out = resolve([vacation, later], [maskRule]);
    const resolved = out.find((e) => e.id === "later")!;
    expect(resolved.resolvedRole).toBe("hard");
    expect(resolved.resolvedBy).toBe("default");
  });

  it("sets the marker event's own role per the rule (info)", () => {
    const out = resolve([vacation], [maskRule]);
    const resolved = out.find((e) => e.id === "vacation")!;
    expect(resolved.resolvedRole).toBe("info");
    expect(resolved.resolvedBy).toBe("rule");
  });

  it("a retracted (absent) mask rule has no effect", () => {
    const meeting = event({ id: "mtg", title: "Sprint planning" });
    // Simulate retraction by not passing the mask rule (RuleStore.active()
    // excludes retracted rules).
    const out = resolve([vacation, meeting], []);
    const resolved = out.find((e) => e.id === "mtg")!;
    expect(resolved.resolvedRole).toBe("hard");
    expect(resolved.resolvedBy).toBe("default");
  });
});
