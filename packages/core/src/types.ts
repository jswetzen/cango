export type Role = "hard" | "soft" | "info" | "conditional";

/** Blocking strength, high to low: hard > soft > conditional > info. Shared so
 * the fan-out and mask passes agree on which role is "stronger" when they raise
 * or cap an occupant's role. */
export function roleRank(role: Role): number {
  switch (role) {
    case "hard":
      return 3;
    case "soft":
      return 2;
    case "conditional":
      return 1;
    case "info":
      return 0;
  }
}

/** A rule may set a concrete role, or `inherit` to fall through to the source
 * default — this reproduces the old attendance `ATTENDS` semantic. The
 * *resolved* role is always a concrete `Role`. */
export type RuleRole = Role | "inherit";

/** `self` decides the matched event's own role (the common case, including the
 * former attendance edges). `mask` marks an out-of-office/vacation event that
 * demotes other events on its own calendar (source) that it spans. `fanout`
 * adds people to a matched event's occupant set (a household/family event that
 * occupies more than the calendar owner). */
export type RuleEffect = "self" | "mask" | "fanout";

export type Verdict = "free" | "soft_conflict" | "hard_conflict";

export type RsvpStatus = "accepted" | "tentative" | "declined" | "needsAction";

export type ResolvedBy = "default" | "structural" | "rule" | "llm";

export interface SourceRef {
  id: string;
  defaultRole: Role;
  ownedBy: "person" | "organization";
  ownerId: string;
  /** Who a calendar's events normally occupy (person or group ids). When
   * absent, the baseline is `[ownerId]` — today's behaviour. A shared family
   * calendar sets this to a group so every event on it occupies the household. */
  defaultOccupants?: string[];
}

export interface Person {
  id: string;
  name: string;
  sources: SourceRef[];
  /** Addresses used to match this person against an event's ATTENDEE props.
   * Optional: a person with no email is simply never ATTENDEE-matched (they can
   * still be an occupant via a source default or a fanout rule). */
  emails?: string[];
}

/** A named set of people, so occupancy can reference "family" instead of every
 * id. `memberIds` may name people or other groups (expanded, cycle-guarded). */
export interface Group {
  id: string;
  name: string;
  memberIds: string[];
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
  groups?: Group[];
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
  /** Person ids matched from the event's ATTENDEE props via per-person emails.
   * Adapter-populated at fetch (and seeded by `createEvent` for write-back), so
   * an event can occupy people beyond its calendar owner without a rule. */
  attendeeIds?: string[];
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
  /** For `fanout` rules: person/group ids added to a matched event's occupant
   * set. Ignored for `self`/`mask` effects. */
  occupants?: string[];
  reason: string;
  /** Epoch ms; used as the specificity tiebreaker (older wins). Optional so
   * core stays storage-agnostic. */
  createdAt?: number;
  updatedAt?: number;
  retractedAt?: number;
}

/** One person an event occupies, with the role it carries *for them*. A camp on
 * Johan's calendar can be `hard` for Johan (he's driving) and `soft` for the
 * kids (they might go) — the same event, different blocking strength per
 * person. */
export interface Occupant {
  personId: string;
  role: Role;
}

export interface ResolvedEvent extends CalEvent {
  /** The event's role for its base occupants (source default / structural /
   * `self`-rule). Fanned-in occupants may carry a different role — see
   * `occupants`. Kept for back-compat and as the role of the owning person. */
  resolvedRole: Role;
  resolvedBy: ResolvedBy;
  resolvedReason: string;
  ruleId?: string;
  /** Who this event occupies and at what role each: the source's default
   * occupants and matched ATTENDEEs (at `resolvedRole`), plus any `fanout`-rule
   * additions (at the rule's role). A normal event resolves to a single
   * occupant `[{personId, role: resolvedRole}]`. Every availability consumer
   * keys conflicts off this, not the scalar `personId`. */
  occupants: Occupant[];
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
  layer: "structural" | "rule" | "default" | "mask" | "fanout";
  outcome: string;
}

export interface ExplainResult {
  resolved: ResolvedEvent;
  trace: ExplainTraceEntry[];
}
