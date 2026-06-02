import { resolveRole } from "./resolveRole.js";
import type {
  CalEvent,
  CheckAvailabilityInput,
  CheckAvailabilityResult,
  Conflict,
  ResolvedEvent,
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

  for (const ev of events) {
    const person = peopleById.get(ev.personId);
    if (!person) continue;
    const overlap = overlapMinutes(ev, windowStart, windowEnd);
    if (overlap <= 0) continue;

    const resolved: ResolvedEvent = resolveRole(ev, family, rules);
    if (resolved.resolvedRole === "info") continue;
    if (resolved.resolvedRole === "conditional") continue;

    conflicts.push({ person, event: resolved, overlapMinutes: overlap });
    if (resolved.resolvedRole === "hard") hasHard = true;
    else if (resolved.resolvedRole === "soft") hasSoft = true;
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
