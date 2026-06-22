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

describe("baseOccupants", () => {
  it("defaults to the owning person", () => {
    expect(baseOccupants(event({ id: "e" }), makeFamily())).toEqual(["p-me"]);
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
    expect(baseOccupants(ev, family).sort()).toEqual(["p-kid", "p-me", "p-wife"]);
  });

  it("unions in the event's matched attendeeIds", () => {
    const ev = event({ id: "e", attendeeIds: ["p-wife"] });
    expect(baseOccupants(ev, makeFamily()).sort()).toEqual(["p-me", "p-wife"]);
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

  it("escalates an existing occupant's role, never demotes", () => {
    const family = makeFamily();
    // wife present at hard via attendee; a soft fanout must not demote her.
    const r = [resolved(event({ id: "e", title: "Camp", attendeeIds: ["p-wife"] }), family)];
    const rules: Rule[] = [
      rule({ match: { titleRegex: "Camp" }, role: "soft", effect: "fanout", occupants: ["p-wife"] }),
    ];
    const out = applyFanout(r, rules, family);
    expect(roles(out[0]!.occupants)).toEqual({ "p-me": "hard", "p-wife": "hard" });
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
