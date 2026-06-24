import { describe, expect, it } from "vitest";
import { applyFanout } from "../src/applyFanout.js";
import { baseOccupants } from "../src/occupants.js";
import { resolveRole } from "../src/resolveRole.js";
import type { CalEvent, FamilyGraph, Occupant, Rule, SourceRef } from "../src/types.js";
import { event, familyGroup, makeFamily, rule } from "./fixtures.js";

function resolved(ev: CalEvent, family: FamilyGraph, rules: Rule[] = []) {
  return resolveRole(ev, family, rules);
}

/** occupants as a {personId: role} map for order-free assertions. */
function roles(occupants: Occupant[]): Record<string, string> {
  return Object.fromEntries(occupants.map((o) => [o.personId, o.role]));
}

/** baseOccupants now returns {personId, role?}; project to a sorted id list. */
function ids(occupants: { personId: string }[]): string[] {
  return occupants.map((o) => o.personId).sort();
}

describe("baseOccupants", () => {
  it("defaults to the owning person (role-less)", () => {
    expect(baseOccupants(event({ id: "e" }), makeFamily())).toEqual([
      { personId: "p-me" },
    ]);
  });

  it("uses a source's defaultOccupants (group-expanded), keeping the owner", () => {
    const shared: SourceRef = {
      id: "src-family",
      defaultRole: "hard",
      ownedBy: "person",
      ownerId: "p-me",
      defaultOccupants: ["family"],
    };
    const family = makeFamily([shared], [familyGroup]);
    const ev = event({ id: "e", sourceId: "src-family" });
    expect(ids(baseOccupants(ev, family))).toEqual(["p-kid", "p-me", "p-wife"]);
  });

  it("unions in the event's matched attendeeIds (role-less)", () => {
    const ev = event({ id: "e", attendeeIds: ["p-wife"] });
    expect(ids(baseOccupants(ev, makeFamily()))).toEqual(["p-me", "p-wife"]);
  });

  it("carries a per-attendee role from the structured attendees field", () => {
    const ev = event({
      id: "e",
      attendees: [{ personId: "p-wife", role: "soft" }],
    });
    const out = baseOccupants(ev, makeFamily());
    // owner is role-less (inherits the event role); wife carries soft.
    expect(out).toContainEqual({ personId: "p-me" });
    expect(out).toContainEqual({ personId: "p-wife", role: "soft" });
  });

  it("an explicit attendee role fills in a person first seen role-less", () => {
    // owner p-me appears role-less from the default-occupant layer, then carries
    // an explicit role from the structured attendees layer.
    const ev = event({
      id: "e",
      attendees: [{ personId: "p-me", role: "soft" }],
    });
    const out = baseOccupants(ev, makeFamily());
    expect(out).toEqual([{ personId: "p-me", role: "soft" }]);
  });
});

describe("applyFanout", () => {
  it("leaves a normal event untouched", () => {
    const r = [resolved(event({ id: "e" }), makeFamily())];
    const out = applyFanout(r, [], makeFamily());
    expect(roles(out[0]!.occupants)).toEqual({ "p-me": "hard" });
  });

  it("adds the named people at the rule's role, owner keeps base role", () => {
    const family = makeFamily();
    const r = [resolved(event({ id: "e", title: "Camp" }), family)];
    const rules: Rule[] = [
      rule({ match: { titleRegex: "Camp" }, role: "soft", effect: "fanout", occupants: ["p-wife"] }),
    ];
    const out = applyFanout(r, rules, family);
    // owner stays hard (src-work default); wife joins as soft ("might go").
    expect(roles(out[0]!.occupants)).toEqual({ "p-me": "hard", "p-wife": "soft" });
  });

  it("expands a group in the rule's occupants", () => {
    const family = makeFamily([], [familyGroup]);
    const r = [resolved(event({ id: "e", title: "Camp" }), family)];
    const rules: Rule[] = [
      rule({ match: { titleRegex: "Camp" }, role: "soft", effect: "fanout", occupants: ["family"] }),
    ];
    const out = applyFanout(r, rules, family);
    expect(roles(out[0]!.occupants)).toEqual({
      "p-me": "hard", // owner already present at base role
      "p-wife": "soft",
      "p-kid": "soft",
    });
  });

  it("unions occupants from two matching rules", () => {
    const family = makeFamily();
    const r = [resolved(event({ id: "e", title: "Camp" }), family)];
    const rules: Rule[] = [
      rule({ match: { titleRegex: "Camp" }, role: "soft", effect: "fanout", occupants: ["p-wife"] }),
      rule({ match: { titleRegex: "amp" }, role: "info", effect: "fanout", occupants: ["p-kid"] }),
    ];
    const out = applyFanout(r, rules, family);
    expect(roles(out[0]!.occupants)).toEqual({
      "p-me": "hard",
      "p-wife": "soft",
      "p-kid": "info",
    });
  });

  it("is idempotent", () => {
    const family = makeFamily();
    const rules: Rule[] = [
      rule({ match: { titleRegex: "Camp" }, role: "soft", effect: "fanout", occupants: ["p-wife"] }),
    ];
    const once = applyFanout([resolved(event({ id: "e", title: "Camp" }), family)], rules, family);
    const twice = applyFanout(once, rules, family);
    expect(roles(twice[0]!.occupants)).toEqual(roles(once[0]!.occupants));
  });

  it("a fanout rule may LOWER a non-owner occupant's role (most-specific-wins)", () => {
    const family = makeFamily();
    // wife present at hard via attendee; a soft fanout now demotes her — the
    // rule is the authority, not an escalate-only escalator.
    const r = [resolved(event({ id: "e", title: "Camp", attendeeIds: ["p-wife"] }), family)];
    const rules: Rule[] = [
      rule({ match: { titleRegex: "Camp" }, role: "soft", effect: "fanout", occupants: ["p-wife"] }),
    ];
    const out = applyFanout(r, rules, family);
    expect(roles(out[0]!.occupants)).toEqual({ "p-me": "hard", "p-wife": "soft" });
  });

  it("most-specific rule wins when several name the same person", () => {
    const family = makeFamily();
    const r = [resolved(event({ id: "e", sourceId: "src-work", title: "Camp" }), family)];
    const rules: Rule[] = [
      // broad (1 match field) — would set wife soft
      rule({
        match: { titleRegex: "Camp" },
        role: "soft",
        effect: "fanout",
        occupants: ["p-wife"],
        createdAt: 1,
      }),
      // specific (2 match fields) — wins, sets wife info
      rule({
        match: { titleRegex: "Camp", sourceId: "src-work" },
        role: "info",
        effect: "fanout",
        occupants: ["p-wife"],
        createdAt: 2,
      }),
    ];
    const out = applyFanout(r, rules, family);
    expect(roles(out[0]!.occupants)).toEqual({ "p-me": "hard", "p-wife": "info" });
  });

  it("ties on specificity break by older createdAt", () => {
    const family = makeFamily();
    const r = [resolved(event({ id: "e", title: "Camp" }), family)];
    const rules: Rule[] = [
      rule({
        match: { titleRegex: "Camp" },
        role: "soft",
        effect: "fanout",
        occupants: ["p-wife"],
        createdAt: 1,
      }),
      rule({
        match: { titleRegex: "Camp" },
        role: "info",
        effect: "fanout",
        occupants: ["p-wife"],
        createdAt: 2,
      }),
    ];
    const out = applyFanout(r, rules, family);
    // older (createdAt 1, soft) decides wife.
    expect(roles(out[0]!.occupants)).toEqual({ "p-me": "hard", "p-wife": "soft" });
  });

  it("role: info removes a fanned occupant from the verdict", () => {
    const family = makeFamily();
    const r = [resolved(event({ id: "e", title: "Camp", attendeeIds: ["p-wife"] }), family)];
    const rules: Rule[] = [
      rule({ match: { titleRegex: "Camp" }, role: "info", effect: "fanout", occupants: ["p-wife"] }),
    ];
    const out = applyFanout(r, rules, family);
    // wife is now info — present in the set but excluded from any conflict tally.
    expect(roles(out[0]!.occupants)).toEqual({ "p-me": "hard", "p-wife": "info" });
  });

  it("owner is protected from a group-driven demotion below the event role", () => {
    const family = makeFamily([], [familyGroup]);
    // owner p-me resolves hard; a soft household fanout via the group must not
    // quietly demote the calendar owner.
    const r = [resolved(event({ id: "e", title: "Camp" }), family)];
    const rules: Rule[] = [
      rule({ match: { titleRegex: "Camp" }, role: "soft", effect: "fanout", occupants: ["family"] }),
    ];
    const out = applyFanout(r, rules, family);
    expect(roles(out[0]!.occupants)).toEqual({
      "p-me": "hard", // protected — stays at the event role
      "p-wife": "soft",
      "p-kid": "soft",
    });
  });

  it("owner IS demotable when a rule names them literally", () => {
    const family = makeFamily();
    const r = [resolved(event({ id: "e", title: "Camp" }), family)];
    const rules: Rule[] = [
      rule({
        match: { titleRegex: "Camp" },
        role: "soft",
        effect: "fanout",
        occupants: ["p-me", "p-wife"],
      }),
    ];
    const out = applyFanout(r, rules, family);
    // p-me named literally → demotion to soft is honoured.
    expect(roles(out[0]!.occupants)).toEqual({ "p-me": "soft", "p-wife": "soft" });
  });

  it("inherit role adds the occupant at the event's base role", () => {
    const family = makeFamily();
    const r = [
      resolved(event({ id: "e", sourceId: "src-kid-club", personId: "p-kid", title: "Camp" }), family),
    ];
    const rules: Rule[] = [
      rule({ match: { titleRegex: "Camp" }, role: "inherit", effect: "fanout", occupants: ["p-me"] }),
    ];
    const out = applyFanout(r, rules, family);
    // base role for src-kid-club is info; inherit adds p-me at info too.
    expect(roles(out[0]!.occupants)).toEqual({ "p-kid": "info", "p-me": "info" });
  });
});

describe("fanout ∘ mask ordering", () => {
  it("an OOO mask on the family calendar suppresses a fanned event", async () => {
    const { applyMasks } = await import("../src/applyMasks.js");
    const family = makeFamily([], [familyGroup]);
    // A camp fanned to the whole family, and a Vacation OOO on the same source.
    const camp = resolved(
      event({
        id: "camp",
        title: "Camp",
        start: new Date("2026-07-01T00:00:00Z"),
        end: new Date("2026-07-02T00:00:00Z"),
        allDay: true,
      }),
      family,
    );
    const vac = resolved(
      event({
        id: "vac",
        title: "Vacation",
        start: new Date("2026-07-01T00:00:00Z"),
        end: new Date("2026-07-02T00:00:00Z"),
        allDay: true,
      }),
      family,
    );
    const rules: Rule[] = [
      rule({ match: { titleRegex: "Camp" }, role: "soft", effect: "fanout", occupants: ["family"] }),
      rule({ match: { titleRegex: "Vacation" }, role: "info", effect: "mask" }),
    ];
    // Compose in consumer order: fanout first, then mask.
    const out = applyMasks(applyFanout([camp, vac], rules, family), rules);
    const fannedCamp = out.find((e) => e.id === "camp")!;
    // Every occupant demoted to info by the mask — fanned attendance suppressed.
    expect(fannedCamp.occupants.every((o) => o.role === "info")).toBe(true);
  });
});
