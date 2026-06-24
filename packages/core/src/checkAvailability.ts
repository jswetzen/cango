import { applyFanout } from "./applyFanout.js";
import { applyMasks } from "./applyMasks.js";
import { resolveRole } from "./resolveRole.js";
import type {
  CalEvent,
  CheckAvailabilityInput,
  CheckAvailabilityResult,
  Conflict,
  Verdict,
} from "./types.js";

export function checkAvailability(
  input: CheckAvailabilityInput,
): CheckAvailabilityResult {
  const { window, people, events, family, rules } = input;
  const peopleById = new Map(people.map((p) => [p.id, p]));
  const windowStart = window.start.getTime();
  const windowEnd = window.end.getTime();

  if (!(windowEnd > windowStart)) {
    throw new Error("checkAvailability: window.end must be after window.start");
  }

  const conflicts: Conflict[] = [];
  let hasHard = false;
  let hasSoft = false;

  // Resolve every event, fan out household occupancy, then apply out-of-office
  // masking before tallying (fanout first so an OOO marker can still suppress a
  // fanned event; a masked event becomes `info` and stops blocking).
  const resolvedAll = applyMasks(
    applyFanout(
      events.map((ev) => resolveRole(ev, family, rules)),
      rules,
      family,
    ),
    rules,
  );

  for (const resolved of resolvedAll) {
    const overlap = overlapMinutes(resolved, windowStart, windowEnd);
    if (overlap <= 0) continue;

    // An event may occupy several of the requested people, each at its own role
    // (a household event is `hard` for the owner, `soft` for "might go" kids);
    // emit one conflict row per requested occupant, tallied at *their* role.
    for (const occupant of resolved.occupants) {
      if (occupant.role === "info") continue;
      const person = peopleById.get(occupant.personId);
      if (!person) continue;
      conflicts.push({ person, event: resolved, overlapMinutes: overlap });
      if (occupant.role === "hard") hasHard = true;
      else if (occupant.role === "soft") hasSoft = true;
    }
  }

  const verdict: Verdict = hasHard
    ? "hard_conflict"
    : hasSoft
      ? "soft_conflict"
      : "free";

  return { verdict, conflicts };
}

function overlapMinutes(event: CalEvent, winStart: number, winEnd: number): number {
  const start = Math.max(event.start.getTime(), winStart);
  const end = Math.min(event.end.getTime(), winEnd);
  if (end <= start) return 0;
  return Math.round((end - start) / 60_000);
}
