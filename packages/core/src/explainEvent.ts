import { applyMasks } from "./applyMasks.js";
import { resolveRole, resolveRoleWithTrace } from "./resolveRole.js";
import type { CalEvent, ExplainResult, FamilyGraph, Rule } from "./types.js";

/**
 * Explain how an event's role was resolved, layer by layer.
 *
 * The per-event layers (structural / rule / default) come from
 * `resolveRoleWithTrace`. Out-of-office masking is cross-event, so the caller
 * passes the event's `neighbors` (other events overlapping its window); we
 * resolve the set, run `applyMasks`, and report whether a mask changed the
 * verdict as a final `mask` trace entry.
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
  const masked = applyMasks(set, rules);
  const self =
    masked.find((e) => e.id === event.id && e.sourceId === event.sourceId) ?? base.resolved;

  const changed =
    self.resolvedRole !== base.resolved.resolvedRole ||
    self.resolvedReason !== base.resolved.resolvedReason;
  if (changed) {
    trace.push({ layer: "mask", outcome: `${self.resolvedRole} (mask): ${self.resolvedReason}` });
    return { resolved: self, trace };
  }
  trace.push({ layer: "mask", outcome: "no out-of-office mask applies" });
  return { resolved: base.resolved, trace };
}
