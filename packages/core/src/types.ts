export type Role = "hard" | "soft" | "info" | "conditional";

export type Verdict = "free" | "soft_conflict" | "hard_conflict";

export type RsvpStatus = "accepted" | "tentative" | "declined" | "needsAction";

export type AttendanceRole = "ATTENDS" | "SOMETIMES_ATTENDS" | "NEVER_ATTENDS";

export type ResolvedBy = "default" | "structural" | "attendance" | "rule" | "llm";

export interface SourceRef {
  id: string;
  defaultRole: Role;
  ownedBy: "person" | "organization";
  ownerId: string;
}

export interface Person {
  id: string;
  name: string;
  sources: SourceRef[];
}

export interface Organization {
  id: string;
  name: string;
  publishes: SourceRef[];
}

export interface AttendanceEdge {
  id?: string;
  personId: string;
  seriesId: string;
  role: AttendanceRole;
  reason?: string;
}

export interface FamilyGraph {
  people: Person[];
  organizations: Organization[];
  sources: SourceRef[];
  attendance: AttendanceEdge[];
}

export interface CalEvent {
  id: string;
  sourceId: string;
  personId: string;
  seriesId?: string;
  title: string;
  start: Date;
  end: Date;
  allDay: boolean;
  rsvpStatus?: RsvpStatus;
  organizerIsSelf?: boolean;
  attendeeCount?: number;
  recurring?: boolean;
  raw?: unknown;
}

export interface RuleMatch {
  sourceId?: string;
  titleRegex?: string;
  seriesId?: string;
  organizerIsSelf?: boolean;
  rsvpStatusIn?: RsvpStatus[];
}

export interface Rule {
  id?: string;
  match: RuleMatch;
  role: Role;
  reason: string;
}

export interface ResolvedEvent extends CalEvent {
  resolvedRole: Role;
  resolvedBy: ResolvedBy;
  resolvedReason: string;
  ruleId?: string;
  attendanceEdgeId?: string;
}

export interface Conflict {
  person: Person;
  event: ResolvedEvent;
  overlapMinutes: number;
}

export interface CheckAvailabilityInput {
  window: { start: Date; end: Date };
  people: Person[];
  events: CalEvent[];
  family: FamilyGraph;
  rules: Rule[];
}

export interface CheckAvailabilityResult {
  verdict: Verdict;
  conflicts: Conflict[];
}

export interface FindFreeSlotsInput {
  range: { start: Date; end: Date };
  duration: number;
  people: Person[];
  events: CalEvent[];
  family: FamilyGraph;
  rules: Rule[];
  workingHours?: { start: string; end: string };
}

export interface FreeSlot {
  start: Date;
  end: Date;
}

export interface ExplainTraceEntry {
  layer: "structural" | "attendance" | "rule" | "default";
  outcome: string;
}

export interface ExplainResult {
  resolved: ResolvedEvent;
  trace: ExplainTraceEntry[];
}
