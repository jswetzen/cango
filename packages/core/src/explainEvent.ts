import { resolveRoleWithTrace } from "./resolveRole.js";
import type { CalEvent, ExplainResult, FamilyGraph, Rule } from "./types.js";

export function explainEvent(
  event: CalEvent,
  family: FamilyGraph,
  rules: Rule[],
): ExplainResult {
  return resolveRoleWithTrace(event, family, rules);
}
