export type Role = "hard" | "soft" | "info" | "conditional";

/** A rule may set a concrete role, or `inherit` to fall through to the source
 * default — this reproduces the old attendance `ATTENDS` semantic. The
 * *resolved* role is always a concrete `Role`. */
export type RuleRole = Role | "inherit";

/** `self` decides the matched event's own role (the common case, including the
 * former attendance edges). `mask` marks an out-of-office/vacation event that
 * demotes other events on its own calendar (source) that it spans. */
export type RuleEffect = "self" | "mask";

export type Verdict = "free" | "soft_conflict" | "hard_conflict";

export type RsvpStatus = "accepted" | "tentative" | "declined" | "needsAction";

export type ResolvedBy = "default" | "structural" | "rule" | "llm";

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

export interface FamilyGraph {
  people: Person[];
  organizations: Organization[];
  sources: SourceRef[];
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
  personId?: string;
  sourceId?: string;
  titleRegex?: string;
  seriesId?: string;
  organizerIsSelf?: boolean;
  rsvpStatusIn?: RsvpStatus[];
}

export interface Rule {
  id?: string;
  match: RuleMatch;
  role: RuleRole;
  /** Defaults to "self" when absent. */
  effect?: RuleEffect;
  reason: string;
  /** Epoch ms; used as the specificity tiebreaker (older wins). Optional so
   * core stays storage-agnostic. */
  createdAt?: number;
  updatedAt?: number;
  retractedAt?: number;
}

export interface ResolvedEvent extends CalEvent {
  resolvedRole: Role;
  resolvedBy: ResolvedBy;
  resolvedReason: string;
  ruleId?: string;
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
  layer: "structural" | "rule" | "default" | "mask";
  outcome: string;
}

export interface ExplainResult {
  resolved: ResolvedEvent;
  trace: ExplainTraceEntry[];
}
