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
  attendanceEdgeId?: string;
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
  if (structural) return finalize(event, structural, trace);

  const attendance = resolveAttendance(event, family);
  trace.push({
    layer: "attendance",
    outcome: attendance ? describe(attendance) : "no matching attendance edge",
  });
  if (attendance) return finalize(event, attendance, trace);

  const ruled = resolveRule(event, rules);
  trace.push({
    layer: "rule",
    outcome: ruled ? describe(ruled) : "no matching rule",
  });
  if (ruled) return finalize(event, ruled, trace);

  const fallback = resolveDefault(event, family);
  trace.push({ layer: "default", outcome: describe(fallback) });
  return finalize(event, fallback, trace);
}

function finalize(
  event: CalEvent,
  resolution: Resolution,
  trace: ExplainTraceEntry[],
): ResolveTrace {
  const resolved: ResolvedEvent = {
    ...event,
    resolvedRole: resolution.role,
    resolvedBy: resolution.by,
    resolvedReason: resolution.reason,
    ...(resolution.ruleId !== undefined ? { ruleId: resolution.ruleId } : {}),
    ...(resolution.attendanceEdgeId !== undefined
      ? { attendanceEdgeId: resolution.attendanceEdgeId }
      : {}),
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

function resolveAttendance(
  event: CalEvent,
  family: FamilyGraph,
): Resolution | null {
  if (!event.seriesId) return null;
  const edge = family.attendance.find(
    (a) => a.personId === event.personId && a.seriesId === event.seriesId,
  );
  if (!edge) return null;
  const sourceDefault = findSource(family, event.sourceId)?.defaultRole ?? "hard";
  const role: Role =
    edge.role === "NEVER_ATTENDS"
      ? "info"
      : edge.role === "SOMETIMES_ATTENDS"
        ? "soft"
        : sourceDefault;
  const reason =
    edge.reason ??
    (edge.role === "ATTENDS"
      ? `person attends series ${event.seriesId}`
      : edge.role === "SOMETIMES_ATTENDS"
        ? `person sometimes attends series ${event.seriesId}`
        : `person never attends series ${event.seriesId}`);
  const out: Resolution = { role, by: "attendance", reason };
  if (edge.id !== undefined) out.attendanceEdgeId = edge.id;
  return out;
}

function resolveRule(event: CalEvent, rules: Rule[]): Resolution | null {
  for (const rule of rules) {
    if (matchesRule(event, rule)) {
      const out: Resolution = {
        role: rule.role,
        by: "rule",
        reason: rule.reason,
      };
      if (rule.id !== undefined) out.ruleId = rule.id;
      return out;
    }
  }
  return null;
}

function matchesRule(event: CalEvent, rule: Rule): boolean {
  const m = rule.match;
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
function compileRegex(pattern: string): RegExp {
  const m = /^\(\?([a-z]+)\)/.exec(pattern);
  if (m) {
    const flags = m[1]!.replace(/[^gimsuy]/g, "");
    return new RegExp(pattern.slice(m[0].length), flags);
  }
  return new RegExp(pattern);
}
