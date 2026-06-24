import { describe, expect, it } from "vitest";
import { resolveRole } from "../src/resolveRole.js";
import type { Role } from "../src/types.js";
import { attendanceRule, event, makeFamily, rule } from "./fixtures.js";

interface Case {
  name: string;
  buildEvent: () => Parameters<typeof resolveRole>[0];
  family?: Parameters<typeof resolveRole>[1];
  rules?: Parameters<typeof resolveRole>[2];
  expectRole: Role;
  expectBy: "default" | "structural" | "rule";
}

const cases: Case[] = [
  {
    name: "source default — hard when source defaultRole=hard",
    buildEvent: () => event({ id: "e1" }),
    expectRole: "hard",
    expectBy: "default",
  },
  {
    name: "source default — info from source.defaultRole=info",
    buildEvent: () => event({ id: "e2", sourceId: "src-kid-club", personId: "p-kid" }),
    expectRole: "info",
    expectBy: "default",
  },
  {
    name: "structural — declined RSVP becomes info",
    buildEvent: () => event({ id: "e3", rsvpStatus: "declined" }),
    expectRole: "info",
    expectBy: "structural",
  },
  {
    name: "structural — tentative RSVP becomes soft",
    buildEvent: () => event({ id: "e4", rsvpStatus: "tentative" }),
    expectRole: "soft",
    expectBy: "structural",
  },
  {
    name: "structural — self-organized solo meeting is soft",
    buildEvent: () =>
      event({ id: "e5", organizerIsSelf: true, attendeeCount: 1 }),
    expectRole: "soft",
    expectBy: "structural",
  },
  {
    name: "structural — self-organized with others is NOT soft (falls through)",
    buildEvent: () =>
      event({ id: "e6", organizerIsSelf: true, attendeeCount: 4 }),
    expectRole: "hard",
    expectBy: "default",
  },
  {
    name: "attendance rule — NEVER_ATTENDS (info) yields info",
    buildEvent: () => event({ id: "e7", seriesId: "series-A" }),
    rules: [attendanceRule("p-me", "series-A", "NEVER_ATTENDS")],
    expectRole: "info",
    expectBy: "rule",
  },
  {
    name: "attendance rule — SOMETIMES_ATTENDS (soft) yields soft",
    buildEvent: () => event({ id: "e8", seriesId: "series-B" }),
    rules: [attendanceRule("p-me", "series-B", "SOMETIMES_ATTENDS")],
    expectRole: "soft",
    expectBy: "rule",
  },
  {
    name: "attendance rule — ATTENDS (inherit) falls back to source default (hard)",
    buildEvent: () => event({ id: "e9", seriesId: "series-C" }),
    rules: [attendanceRule("p-me", "series-C", "ATTENDS")],
    expectRole: "hard",
    expectBy: "rule",
  },
  {
    name: "attendance rule — only matches when personId AND seriesId both match",
    buildEvent: () => event({ id: "e10", seriesId: "series-A" }),
    rules: [attendanceRule("p-wife", "series-A", "NEVER_ATTENDS")],
    expectRole: "hard",
    expectBy: "default",
  },
  {
    name: "rule — titleRegex match wins over source default",
    buildEvent: () => event({ id: "e11", title: "Standup" }),
    rules: [rule({ match: { titleRegex: "^Standup$" }, role: "soft", reason: "standups optional" })],
    expectRole: "soft",
    expectBy: "rule",
  },
  {
    name: "rule — non-matching rule ignored",
    buildEvent: () => event({ id: "e12", title: "Important review" }),
    rules: [rule({ match: { titleRegex: "^Standup$" }, role: "soft" })],
    expectRole: "hard",
    expectBy: "default",
  },
  {
    name: "rule ordering — equal specificity, earlier createdAt wins",
    buildEvent: () => event({ id: "e13", title: "Office hours" }),
    rules: [
      rule({ match: { titleRegex: "Office" }, role: "soft", reason: "first", createdAt: 1 }),
      rule({ match: { titleRegex: "Office" }, role: "info", reason: "second", createdAt: 2 }),
    ],
    expectRole: "soft",
    expectBy: "rule",
  },
  {
    name: "rule specificity — more specific rule beats broader one regardless of order",
    buildEvent: () => event({ id: "e13b", seriesId: "series-X", title: "Sync" }),
    rules: [
      rule({ match: { titleRegex: "Sync" }, role: "hard", reason: "broad", createdAt: 1 }),
      rule({
        match: { personId: "p-me", seriesId: "series-X" },
        role: "info",
        reason: "specific",
        createdAt: 2,
      }),
    ],
    expectRole: "info",
    expectBy: "rule",
  },
  {
    name: "layer precedence — structural beats rule (declined trumps ATTENDS)",
    buildEvent: () =>
      event({ id: "e14", seriesId: "series-C", rsvpStatus: "declined" }),
    rules: [attendanceRule("p-me", "series-C", "ATTENDS")],
    expectRole: "info",
    expectBy: "structural",
  },
  {
    name: "specificity — person+series attendance rule beats a broad title rule",
    buildEvent: () =>
      event({ id: "e15", seriesId: "series-D", title: "Practice" }),
    rules: [
      attendanceRule("p-me", "series-D", "SOMETIMES_ATTENDS"),
      rule({ match: { titleRegex: "Practice" }, role: "hard" }),
    ],
    expectRole: "soft",
    expectBy: "rule",
  },
  {
    // A2: rules now sit ABOVE the soft heuristics. A tentative RSVP would be
    // soft via the heuristic, but a matching rule overrides it to hard.
    name: "precedence — rule overrides the tentative-RSVP soft heuristic",
    buildEvent: () => event({ id: "e21", rsvpStatus: "tentative" }),
    rules: [
      rule({ match: { rsvpStatusIn: ["tentative"] }, role: "hard", reason: "always attend tentatives" }),
    ],
    expectRole: "hard",
    expectBy: "rule",
  },
  {
    // A2: a rule overrides the self-organized-solo soft heuristic.
    name: "precedence — rule overrides the self-organized-solo soft heuristic",
    buildEvent: () => event({ id: "e22", organizerIsSelf: true, attendeeCount: 1 }),
    rules: [
      rule({ match: { organizerIsSelf: true }, role: "hard", reason: "my solo blocks are real" }),
    ],
    expectRole: "hard",
    expectBy: "rule",
  },
  {
    // A2: declined sits ABOVE rules — no rule can resurrect a decline.
    name: "precedence — declined stays info even with a conflicting rule",
    buildEvent: () =>
      event({ id: "e23", seriesId: "series-E", rsvpStatus: "declined" }),
    rules: [
      rule({
        match: { personId: "p-me", seriesId: "series-E", rsvpStatusIn: ["declined"] },
        role: "hard",
        reason: "force attend",
      }),
    ],
    expectRole: "info",
    expectBy: "structural",
  },
];

describe("resolveRole layered resolution", () => {
  it.each(cases)("$name", (c) => {
    const family = c.family ?? makeFamily();
    const rules = c.rules ?? [];
    const resolved = resolveRole(c.buildEvent(), family, rules);
    expect(resolved.resolvedRole).toBe(c.expectRole);
    expect(resolved.resolvedBy).toBe(c.expectBy);
  });

  it("rule match composes sourceId + rsvpStatusIn + organizerIsSelf", () => {
    const e = event({
      id: "e16",
      sourceId: "src-work",
      organizerIsSelf: true,
      attendeeCount: 5,
      rsvpStatus: "accepted",
    });
    const r = rule({
      match: {
        sourceId: "src-work",
        organizerIsSelf: true,
        rsvpStatusIn: ["accepted"],
      },
      role: "soft",
      reason: "owned meeting on work calendar",
    });
    const resolved = resolveRole(e, makeFamily(), [r]);
    expect(resolved.resolvedRole).toBe("soft");
    expect(resolved.resolvedBy).toBe("rule");
  });

  it("rule id is propagated to ResolvedEvent", () => {
    const e = event({ id: "e17", seriesId: "series-Z" });
    const r = attendanceRule("p-me", "series-Z", "NEVER_ATTENDS", { id: "rule-1" });
    const resolved = resolveRole(e, makeFamily(), [r]);
    expect(resolved.ruleId).toBe("rule-1");
  });

  it("supports PCRE-style inline (?i) flag in titleRegex", () => {
    const e = event({ id: "e19", title: "STANDUP" });
    const r = rule({ match: { titleRegex: "(?i)standup" }, role: "soft", reason: "optional" });
    const resolved = resolveRole(e, makeFamily(), [r]);
    expect(resolved.resolvedRole).toBe("soft");
    expect(resolved.resolvedBy).toBe("rule");
  });

  it("mask-effect rules are ignored by per-event resolution", () => {
    const e = event({ id: "e20", title: "Vacation" });
    const r = rule({ match: { titleRegex: "Vacation" }, role: "info", effect: "mask" });
    const resolved = resolveRole(e, makeFamily(), [r]);
    // The mask rule does not set the event's own role here (applyMasks does).
    expect(resolved.resolvedBy).toBe("default");
    expect(resolved.resolvedRole).toBe("hard");
  });

  it("unknown source defaults to hard with a clear reason", () => {
    const e = event({ id: "e18", sourceId: "src-missing" });
    const resolved = resolveRole(e, makeFamily(), []);
    expect(resolved.resolvedRole).toBe("hard");
    expect(resolved.resolvedBy).toBe("default");
    expect(resolved.resolvedReason).toMatch(/no source registered/);
  });
});
