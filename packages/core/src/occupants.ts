import { expandGroups } from "./groups.js";
import type { CalEvent, FamilyGraph, Role } from "./types.js";

/** One baseline occupant: a person and, when the event carries an explicit
 * per-attendee signal, the role they hold. A `role` of `undefined` means "take
 * the event's base role" — filled in by `finalize`. */
export interface BaseOccupant {
  personId: string;
  role?: Role;
}

/**
 * The baseline occupant set of an event, before any `fanout` rule runs.
 *
 * Layer 1 — the source's `defaultOccupants` (group-expanded), or `[ownerId]`
 *   when unset: "who this calendar's events normally occupy." Role-less, so they
 *   inherit the event's base role.
 * Layer 2 — the event's per-attendee occupancy (`attendees`, each carrying the
 *   role read from its ATTENDEE PARTSTAT/ROLE; falls back to the role-less
 *   `attendeeIds` for cache rows / feeds without the structured field). An
 *   explicit attendee role fills in a person who first appeared role-less.
 *
 * Layer 3 (fanout rules) is applied later as a cross-event post-pass, mirroring
 * masks — see `applyFanout`. Always includes the event's own `personId` (the
 * owning calendar's person), so an event never resolves to an empty set.
 */
export function baseOccupants(event: CalEvent, family: FamilyGraph): BaseOccupant[] {
  const source = family.sources.find((s) => s.id === event.sourceId);
  const defaults =
    source?.defaultOccupants && source.defaultOccupants.length > 0
      ? source.defaultOccupants
      : [event.personId];

  const out: BaseOccupant[] = [];
  const idx = new Map<string, number>();
  const add = (personId: string, role?: Role) => {
    const at = idx.get(personId);
    if (at === undefined) {
      idx.set(personId, out.length);
      out.push(role !== undefined ? { personId, role } : { personId });
      return;
    }
    // Upgrade a role-less entry the first time an explicit role appears.
    if (role !== undefined && out[at]!.role === undefined) out[at]!.role = role;
  };

  // Layer 1: source default occupants (group-expanded), role-less.
  for (const id of expandGroups(defaults, family)) add(id);
  // The owning person is always an occupant — the event is still on their
  // calendar even if `defaultOccupants` was set to a group that omits them.
  add(event.personId);
  // Layer 2: per-attendee occupancy. Prefer the structured `attendees` (carries
  // role); fall back to the id-only `attendeeIds` (role-less) when absent.
  if (event.attendees && event.attendees.length > 0) {
    for (const a of event.attendees) add(a.personId, a.role);
  } else {
    for (const id of expandGroups(event.attendeeIds ?? [], family)) add(id);
  }
  return out;
}
