import { expandGroups } from "./groups.js";
import { matchesRule, ruleSpecificity } from "./resolveRole.js";
import { roleRank } from "./types.js";
import type { FamilyGraph, Occupant, ResolvedEvent, Role, Rule } from "./types.js";

/**
 * The cross-event occupancy layer: household / family fan-out (and demotion).
 *
 * A `fanout`-effect rule names people (`occupants`, person or group ids) and a
 * `role` they carry for a matched event. The named people are set to that role
 * in the event's occupant set — so "Saras läger" on Johan's calendar can stay
 * `hard` for Johan (he's driving) while being `soft` for the kids (they might
 * go): the same event, a different blocking strength per person. A pure,
 * idempotent post-pass over an already-resolved set, run after per-event
 * `resolveRole` so the daemon's `resolved_cache` stays valid.
 *
 * Per-occupant precedence: when several fanout rules name the same person, the
 * MOST SPECIFIC rule wins (more match fields; ties broken by older `createdAt`),
 * mirroring the `self`-rule tiebreak in `resolveRole`. A rule may raise OR lower
 * an occupant's role — `role: "info"` removes them from the verdict entirely
 * (the per-occupant "doesn't really attend"), the missing inverse of adding
 * someone. `inherit` uses the event's base role.
 *
 * Owner protection: the calendar owner is never demoted below the event's own
 * role by a fanout rule UNLESS a matched rule names them literally (by person
 * id, not merely via a group) — so a broad household fanout like
 * `occupants:[family]` can't quietly downgrade the person whose calendar it is.
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
    const matched = fanoutRules
      .filter((r) => matchesRule(ev, r))
      .sort(
        (a, b) =>
          ruleSpecificity(b) - ruleSpecificity(a) || (a.createdAt ?? 0) - (b.createdAt ?? 0),
      );
    if (matched.length === 0) return ev;

    const byPerson = new Map<string, Occupant>(ev.occupants.map((o) => [o.personId, { ...o }]));
    // Each person's role is set by the most-specific matching rule that names
    // them; `decided` stops a broader/younger rule overwriting that choice.
    const decided = new Set<string>();
    const ownerNamedLiterally = matched.some((r) => (r.occupants ?? []).includes(ev.personId));

    for (const rule of matched) {
      const addRole: Role = rule.role === "inherit" ? ev.resolvedRole : rule.role;
      for (const personId of expandGroups(rule.occupants ?? [], family)) {
        if (decided.has(personId)) continue;
        decided.add(personId);
        // Protect the owner from a group-driven demotion below the event role.
        if (
          personId === ev.personId &&
          !ownerNamedLiterally &&
          roleRank(addRole) < roleRank(ev.resolvedRole)
        ) {
          continue;
        }
        const existing = byPerson.get(personId);
        if (existing) existing.role = addRole;
        else byPerson.set(personId, { personId, role: addRole });
      }
    }

    return { ...ev, occupants: [...byPerson.values()] };
  });
}
