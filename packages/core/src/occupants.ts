import { expandGroups } from "./groups.js";
import type { CalEvent, FamilyGraph } from "./types.js";

/**
 * The baseline occupant set of an event, before any `fanout` rule runs.
 *
 * Layer 1 — the source's `defaultOccupants` (group-expanded), or `[ownerId]`
 *   when unset: "who this calendar's events normally occupy."
 * Layer 2 — the event's `attendeeIds` (group-expanded for safety, though the
 *   adapter emits person ids): per-event ATTENDEE matches.
 *
 * Layer 3 (fanout rules) is applied later as a cross-event post-pass, mirroring
 * masks — see `applyFanout`. Always includes the event's own `personId` (the
 * owning calendar's person), so an event never resolves to an empty set.
 */
export function baseOccupants(event: CalEvent, family: FamilyGraph): string[] {
  const source = family.sources.find((s) => s.id === event.sourceId);
  const defaults =
    source?.defaultOccupants && source.defaultOccupants.length > 0
      ? source.defaultOccupants
      : [event.personId];

  const out = expandGroups(defaults, family);
  const seen = new Set(out);
  const add = (id: string) => {
    if (!seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  };

  // The owning person is always an occupant — the event is still on their
  // calendar even if `defaultOccupants` was set to a group that omits them.
  add(event.personId);
  for (const id of expandGroups(event.attendeeIds ?? [], family)) add(id);
  return out;
}
