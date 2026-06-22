import { applyFanout } from "./applyFanout.js";
import { applyMasks } from "./applyMasks.js";
import { resolveRole, resolveRoleWithTrace } from "./resolveRole.js";
import type { CalEvent, ExplainResult, FamilyGraph, Rule } from "./types.js";

/**
 * Explain how an event's role and occupants were resolved, layer by layer.
 *
 * The per-event layers (structural / rule / default) come from
 * `resolveRoleWithTrace`. Fan-out and out-of-office masking are cross-event, so
 * the caller passes the event's `neighbors` (other events overlapping its
 * window); we resolve the set, run `applyFanout` then `applyMasks` (the same
 * order the availability consumers use), and report each as a trace entry —
 * including the final occupant set, which is the whole point of this feature.
 */
export function explainEvent(
  event: CalEvent,
  family: FamilyGraph,
  rules: Rule[],
  neighbors: CalEvent[] = [],
): ExplainResult {
  const base = resolveRoleWithTrace(event, family, rules);
  const trace = base.trace;

  const set = [event, ...neighbors].map((e) => resolveRole(e, family, rules));
  const fanned = applyFanout(set, rules, family);
  const masked = applyMasks(fanned, rules);
  const pick = (events: typeof set) =>
    events.find((e) => e.id === event.id && e.sourceId === event.sourceId);
  const fannedSelf = pick(fanned) ?? base.resolved;
  const self = pick(masked) ?? fannedSelf;

  // Fan-out trace: did a household rule add occupants or raise the role?
  const fanoutChanged =
    fannedSelf.occupants.length !== base.resolved.occupants.length ||
    fannedSelf.resolvedRole !== base.resolved.resolvedRole;
  trace.push({
    layer: "fanout",
    outcome: fanoutChanged
      ? `fanout: occupants [${fannedSelf.occupants
          .map((o) => `${o.personId}=${o.role}`)
          .join(", ")}]`
      : "no household fan-out applies",
  });

  const maskChanged =
    self.resolvedRole !== fannedSelf.resolvedRole ||
    self.resolvedReason !== fannedSelf.resolvedReason;
  trace.push({
    layer: "mask",
    outcome: maskChanged
      ? `${self.resolvedRole} (mask): ${self.resolvedReason}`
      : "no out-of-office mask applies",
  });

  return { resolved: self, trace };
}
