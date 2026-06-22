import type { FamilyGraph } from "./types.js";

/**
 * Expand a list of person/group ids to a flat set of *person* ids.
 *
 * Group membership may nest (a group can list other groups); expansion is
 * transitive and cycle-guarded (a group referencing itself, directly or via a
 * loop, is visited once). Ids that are neither a known group nor a known person
 * are dropped — occupancy never invents a person. Person ids that aren't in the
 * graph are still kept (an event may legitimately reference a person id the
 * resolver knows about even if the group layer doesn't enumerate them); only
 * *group* ids must resolve. The result is deduplicated, order-preserving by
 * first appearance.
 */
export function expandGroups(ids: string[], family: FamilyGraph): string[] {
  const groupsById = new Map((family.groups ?? []).map((g) => [g.id, g]));
  const out: string[] = [];
  const seen = new Set<string>();
  const visiting = new Set<string>();

  const walk = (id: string): void => {
    const group = groupsById.get(id);
    if (!group) {
      // A plain person id (or an unknown leaf): emit once.
      if (!seen.has(id)) {
        seen.add(id);
        out.push(id);
      }
      return;
    }
    if (visiting.has(id)) return; // cycle guard
    visiting.add(id);
    for (const member of group.memberIds) walk(member);
    visiting.delete(id);
  };

  for (const id of ids) walk(id);
  return out;
}
