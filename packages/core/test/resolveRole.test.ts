import { describe, expect, it } from "vitest";
import { resolveRole } from "../src/resolveRole.js";
import type { Role } from "../src/types.js";
import { event, makeFamily, rule } from "./fixtures.js";

interface Case {
  name: string;
  buildEvent: () => Parameters<typeof resolveRole>[0];
  family?: Parameters<typeof resolveRole>[1];
  rules?: Parameters<typeof resolveRole>[2];
  expectRole: Role;
  expectBy: "default" | "structural" | "attendance" | "rule";
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
    name: "attendance — NEVER_ATTENDS yields info",
    buildEvent: () => event({ id: "e7", seriesId: "series-A" }),
    family: makeFamily([
      { personId: "p-me", seriesId: "series-A", role: "NEVER_ATTENDS" },
    ]),
    expectRole: "info",
    expectBy: "attendance",
  },
  {
    name: "attendance — SOMETIMES_ATTENDS yields soft",
    buildEvent: () => event({ id: "e8", seriesId: "series-B" }),
    family: makeFamily([
      { personId: "p-me", seriesId: "series-B", role: "SOMETIMES_ATTENDS" },
    ]),
    expectRole: "soft",
    expectBy: "attendance",
  },
  {
    name: "attendance — ATTENDS falls back to source default (hard)",
    buildEvent: () => event({ id: "e9", seriesId: "series-C" }),
    family: makeFamily([
      { personId: "p-me", seriesId: "series-C", role: "ATTENDS" },
    ]),
    expectRole: "hard",
    expectBy: "attendance",
  },
  {
    name: "attendance — only matches when personId AND seriesId both match",
    buildEvent: () => event({ id: "e10", seriesId: "series-A" }),
    family: makeFamily([
      { personId: "p-wife", seriesId: "series-A", role: "NEVER_ATTENDS" },
    ]),
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
    name: "rule ordering — first match wins",
    buildEvent: () => event({ id: "e13", title: "Office hours" }),
    rules: [
      rule({ match: { titleRegex: "Office" }, role: "soft", reason: "first" }),
      rule({ match: { titleRegex: "Office" }, role: "info", reason: "second" }),
    ],
    expectRole: "soft",
    expectBy: "rule",
  },
  {
    name: "layer precedence — structural beats attendance (declined trumps ATTENDS)",
    buildEvent: () =>
      event({ id: "e14", seriesId: "series-C", rsvpStatus: "declined" }),
    family: makeFamily([
      { personId: "p-me", seriesId: "series-C", role: "ATTENDS" },
    ]),
    expectRole: "info",
    expectBy: "structural",
  },
  {
    name: "layer precedence — attendance beats matching rule",
    buildEvent: () =>
      event({ id: "e15", seriesId: "series-D", title: "Practice" }),
    family: makeFamily([
      { personId: "p-me", seriesId: "series-D", role: "SOMETIMES_ATTENDS" },
    ]),
    rules: [rule({ match: { titleRegex: "Practice" }, role: "hard" })],
    expectRole: "soft",
    expectBy: "attendance",
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

  it("attendance edge id is propagated to ResolvedEvent", () => {
    const e = event({ id: "e17", seriesId: "series-Z" });
    const family = makeFamily([
      {
        id: "att-1",
        personId: "p-me",
        seriesId: "series-Z",
        role: "NEVER_ATTENDS",
      },
    ]);
    const resolved = resolveRole(e, family, []);
    expect(resolved.attendanceEdgeId).toBe("att-1");
  });

  it("supports PCRE-style inline (?i) flag in titleRegex", () => {
    const e = event({ id: "e19", title: "STANDUP" });
    const r = rule({ match: { titleRegex: "(?i)standup" }, role: "soft", reason: "optional" });
    const resolved = resolveRole(e, makeFamily(), [r]);
    expect(resolved.resolvedRole).toBe("soft");
    expect(resolved.resolvedBy).toBe("rule");
  });

  it("unknown source defaults to hard with a clear reason", () => {
    const e = event({ id: "e18", sourceId: "src-missing" });
    const resolved = resolveRole(e, makeFamily(), []);
    expect(resolved.resolvedRole).toBe("hard");
    expect(resolved.resolvedBy).toBe("default");
    expect(resolved.resolvedReason).toMatch(/no source registered/);
  });
});
