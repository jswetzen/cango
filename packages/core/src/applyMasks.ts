import { matchesRule } from "./resolveRole.js";
import type { ResolvedEvent, Role, Rule } from "./types.js";

/**
 * The cross-event layer: out-of-office / vacation masking.
 *
 * A `mask`-effect rule matches an OOO marker event (e.g. a "Vacation" block on
 * the work calendar). While that marker is happening, every *other* event on
 * the **same calendar (source)** that it spans is demoted to `info` — "I'm away
 * from this calendar, ignore what's on it." This cannot live in per-event
 * `resolveRole` (event X's verdict depends on the existence of marker M), so it
 * runs as a pure post-pass over an already-resolved set. Because it runs after
 * the per-event resolution, the daemon's per-event `resolved_cache` stays valid.
 *
 * Scope is the marker's own `sourceId`, so an OOO on work never touches the
 * kid's practice or the family calendar. Idempotent and order-independent.
 */
export function applyMasks(events: ResolvedEvent[], rules: Rule[]): ResolvedEvent[] {
  const maskRules = rules.filter((r) => r.effect === "mask");
  if (maskRules.length === 0) return events;

  const maskers: { event: ResolvedEvent; rule: Rule }[] = [];
  for (const ev of events) {
    const rule = maskRules.find((r) => matchesRule(ev, r));
    if (rule) maskers.push({ event: ev, rule });
  }
  if (maskers.length === 0) return events;

  return events.map((ev) => {
    // The marker event itself takes its rule's role (typically `info` — a
    // marker, not a commitment). `inherit` leaves the base resolution alone.
    const self = maskers.find((m) => m.event === ev);
    if (self) {
      if (self.rule.role === "inherit") return ev;
      return rerole(ev, self.rule.role, self.rule.reason, self.rule.id);
    }

    // Otherwise: is `ev` covered by a marker on the same source?
    const cover = maskers.find(
      (m) =>
        m.event !== ev &&
        m.event.sourceId === ev.sourceId &&
        overlaps(m.event, ev),
    );
    if (cover) {
      return rerole(ev, "info", `during out-of-office: ${cover.event.title}`, cover.rule.id);
    }
    return ev;
  });
}

function rerole(ev: ResolvedEvent, role: Role, reason: string, ruleId?: string): ResolvedEvent {
  return {
    ...ev,
    resolvedRole: role,
    resolvedBy: "rule",
    resolvedReason: reason,
    ...(ruleId !== undefined ? { ruleId } : {}),
  };
}

/** Half-open interval overlap: [start, end). */
function overlaps(a: ResolvedEvent, b: ResolvedEvent): boolean {
  return a.start.getTime() < b.end.getTime() && a.end.getTime() > b.start.getTime();
}
