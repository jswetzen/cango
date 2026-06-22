import { baseOccupants } from "./occupants.js";
import type {
  CalEvent,
  ExplainTraceEntry,
  FamilyGraph,
  ResolvedBy,
  ResolvedEvent,
  Role,
  Rule,
  SourceRef,
} from "./types.js";

interface Resolution {
  role: Role;
  by: ResolvedBy;
  reason: string;
  ruleId?: string;
}

export interface ResolveTrace {
  resolved: ResolvedEvent;
  trace: ExplainTraceEntry[];
}

export function resolveRole(
  event: CalEvent,
  family: FamilyGraph,
  rules: Rule[],
): ResolvedEvent {
  return resolveRoleWithTrace(event, family, rules).resolved;
}

export function resolveRoleWithTrace(
  event: CalEvent,
  family: FamilyGraph,
  rules: Rule[],
): ResolveTrace {
  const trace: ExplainTraceEntry[] = [];

  const structural = resolveStructural(event);
  trace.push({
    layer: "structural",
    outcome: structural ? describe(structural) : "no match",
  });
  if (structural) return finalize(event, family, structural, trace);

  const ruled = resolveRule(event, family, rules);
  trace.push({
    layer: "rule",
    outcome: ruled ? describe(ruled) : "no matching rule",
  });
  if (ruled) return finalize(event, family, ruled, trace);

  const fallback = resolveDefault(event, family);
  trace.push({ layer: "default", outcome: describe(fallback) });
  return finalize(event, family, fallback, trace);
}

function finalize(
  event: CalEvent,
  family: FamilyGraph,
  resolution: Resolution,
  trace: ExplainTraceEntry[],
): ResolveTrace {
  const resolved: ResolvedEvent = {
    ...event,
    resolvedRole: resolution.role,
    resolvedBy: resolution.by,
    resolvedReason: resolution.reason,
    // Per-event occupancy baseline (source defaults + ATTENDEE matches), each at
    // the event's base role. Fanout rules add occupants (possibly at a different
    // role) in a later cross-event pass (`applyFanout`).
    occupants: baseOccupants(event, family).map((personId) => ({
      personId,
      role: resolution.role,
    })),
    ...(resolution.ruleId !== undefined ? { ruleId: resolution.ruleId } : {}),
  };
  return { resolved, trace };
}

function describe(r: Resolution): string {
  return `${r.role} (${r.by}): ${r.reason}`;
}

function resolveStructural(event: CalEvent): Resolution | null {
  if (event.rsvpStatus === "declined") {
    return {
      role: "info",
      by: "structural",
      reason: "RSVP declined",
    };
  }
  if (event.organizerIsSelf === true && event.attendeeCount === 1) {
    return {
      role: "soft",
      by: "structural",
      reason: "self-organized event with no other attendees",
    };
  }
  if (event.rsvpStatus === "tentative") {
    return {
      role: "soft",
      by: "structural",
      reason: "RSVP tentative",
    };
  }
  return null;
}

/**
 * The unified tiebreaker layer (formerly two layers: attendance + rules).
 *
 * Rules are sorted by *specificity* — a rule matching more fields wins, ties
 * broken by creation time (older first). This makes a `personId+seriesId` rule
 * (a former attendance edge) outrank a broad `sourceId` rule without anyone
 * having to manage priorities. `mask`-effect rules are skipped here; their
 * effect is cross-event and applied separately by `applyMasks`.
 */
function resolveRule(
  event: CalEvent,
  family: FamilyGraph,
  rules: Rule[],
): Resolution | null {
  const candidates = rules
    .filter((r) => (r.effect ?? "self") === "self")
    .filter((r) => matchesRule(event, r))
    .sort(
      (a, b) =>
        ruleSpecificity(b) - ruleSpecificity(a) ||
        (a.createdAt ?? 0) - (b.createdAt ?? 0),
    );
  const rule = candidates[0];
  if (!rule) return null;

  // `inherit` falls through to the source default (the former ATTENDS role).
  const role: Role =
    rule.role === "inherit"
      ? (findSource(family, event.sourceId)?.defaultRole ?? "hard")
      : rule.role;
  const out: Resolution = { role, by: "rule", reason: rule.reason };
  if (rule.id !== undefined) out.ruleId = rule.id;
  return out;
}

/** Number of defined keys in a rule's match — its specificity score. */
export function ruleSpecificity(rule: Rule): number {
  return Object.values(rule.match).filter((v) => v !== undefined).length;
}

export function matchesRule(event: CalEvent, rule: Rule): boolean {
  const m = rule.match;
  if (m.personId !== undefined && m.personId !== event.personId) return false;
  if (m.sourceId !== undefined && m.sourceId !== event.sourceId) return false;
  if (m.seriesId !== undefined && m.seriesId !== event.seriesId) return false;
  if (
    m.organizerIsSelf !== undefined &&
    m.organizerIsSelf !== (event.organizerIsSelf ?? false)
  ) {
    return false;
  }
  if (m.rsvpStatusIn !== undefined) {
    if (!event.rsvpStatus || !m.rsvpStatusIn.includes(event.rsvpStatus)) {
      return false;
    }
  }
  if (m.titleRegex !== undefined) {
    try {
      if (!compileRegex(m.titleRegex).test(event.title)) return false;
    } catch {
      return false;
    }
  }
  return true;
}

function resolveDefault(event: CalEvent, family: FamilyGraph): Resolution {
  const source = findSource(family, event.sourceId);
  const role: Role = source?.defaultRole ?? "hard";
  return {
    role,
    by: "default",
    reason: source
      ? `source default for ${source.id}`
      : `no source registered for ${event.sourceId}; assuming hard`,
  };
}

function findSource(family: FamilyGraph, sourceId: string): SourceRef | undefined {
  return family.sources.find((s) => s.id === sourceId);
}

/**
 * Compile a title pattern. JS RegExp has no inline-flag syntax, but config
 * authors reach for the PCRE-style `(?i)` / `(?im)` prefix out of habit, so we
 * lift a leading inline-flag group into real RegExp flags.
 */
export function compileRegex(pattern: string): RegExp {
  const m = /^\(\?([a-z]+)\)/.exec(pattern);
  if (m) {
    const flags = m[1]!.replace(/[^gimsuy]/g, "");
    return new RegExp(pattern.slice(m[0].length), flags);
  }
  return new RegExp(pattern);
}
