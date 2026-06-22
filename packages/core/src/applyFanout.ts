import { expandGroups } from "./groups.js";
import { matchesRule } from "./resolveRole.js";
import { roleRank } from "./types.js";
import type { FamilyGraph, Occupant, ResolvedEvent, Role, Rule } from "./types.js";

/**
 * The cross-event occupancy layer: household / family fan-out.
 *
 * A `fanout`-effect rule names extra people (`occupants`, person or group ids)
 * who attend a matched event beyond the calendar owner, and a `role` they carry
 * for that event. When the rule matches, those people are unioned into the
 * event's occupant set *at the rule's role* — so "Saras läger" on Johan's
 * calendar can stay `hard` for Johan (he's driving) while being `soft` for the
 * kids (they might go). The same event, a different blocking strength per
 * person. Mirrors `applyMasks`: a pure, idempotent, order-independent post-pass
 * over an already-resolved set, run after per-event `resolveRole` so the
 * daemon's `resolved_cache` stays valid.
 *
 * Role semantics: `soft` = "we *might* go, surface it"; `hard` = "attending".
 * For an occupant already present (e.g. the owner), the role only ever escalates
 * (a fanout never demotes someone below the role they already had); demoting /
 * dropping people is a `self`-effect rule's job. `inherit` adds the occupant at
 * the event's base role.
 *
 * Ordering vs masks (see `applyMasks`): fan-out runs FIRST, masks SECOND, so an
 * out-of-office marker on the family calendar can still suppress a fanned event
 * — being away wins over "the family might go." `checkAvailability` /
 * `findFreeSlots` / `listEvents` compose them in that order.
 */
export function applyFanout(
  events: ResolvedEvent[],
  rules: Rule[],
  family: FamilyGraph,
): ResolvedEvent[] {
  const fanoutRules = rules.filter((r) => r.effect === "fanout");
  if (fanoutRules.length === 0) return events;

  return events.map((ev) => {
    const matched = fanoutRules.filter((r) => matchesRule(ev, r));
    if (matched.length === 0) return ev;

    const byPerson = new Map<string, Occupant>(
      ev.occupants.map((o) => [o.personId, { ...o }]),
    );

    for (const rule of matched) {
      const addRole: Role = rule.role === "inherit" ? ev.resolvedRole : rule.role;
      for (const personId of expandGroups(rule.occupants ?? [], family)) {
        const existing = byPerson.get(personId);
        if (!existing) {
          byPerson.set(personId, { personId, role: addRole });
        } else if (roleRank(addRole) > roleRank(existing.role)) {
          // Escalate an existing occupant's role; never demote.
          existing.role = addRole;
        }
      }
    }

    return { ...ev, occupants: [...byPerson.values()] };
  });
}
