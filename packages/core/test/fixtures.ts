import type {
  AttendanceEdge,
  CalEvent,
  FamilyGraph,
  Person,
  Rule,
  SourceRef,
} from "../src/types.js";

export const sourceWorkHard: SourceRef = {
  id: "src-work",
  defaultRole: "hard",
  ownedBy: "person",
  ownerId: "p-me",
};

export const sourceWifeWork: SourceRef = {
  id: "src-wife-work",
  defaultRole: "hard",
  ownedBy: "person",
  ownerId: "p-wife",
};

export const sourceKidClub: SourceRef = {
  id: "src-kid-club",
  defaultRole: "info",
  ownedBy: "organization",
  ownerId: "org-football",
};

export const me: Person = {
  id: "p-me",
  name: "Me",
  sources: [sourceWorkHard],
};

export const wife: Person = {
  id: "p-wife",
  name: "Wife",
  sources: [sourceWifeWork],
};

export const kid: Person = {
  id: "p-kid",
  name: "Kid",
  sources: [sourceKidClub],
};

export function makeFamily(
  attendance: AttendanceEdge[] = [],
  extraSources: SourceRef[] = [],
): FamilyGraph {
  return {
    people: [me, wife, kid],
    organizations: [],
    sources: [sourceWorkHard, sourceWifeWork, sourceKidClub, ...extraSources],
    attendance,
  };
}

export function event(partial: Partial<CalEvent> & Pick<CalEvent, "id">): CalEvent {
  return {
    sourceId: "src-work",
    personId: "p-me",
    title: "Untitled",
    start: new Date("2026-06-01T10:00:00Z"),
    end: new Date("2026-06-01T11:00:00Z"),
    allDay: false,
    ...partial,
  };
}

export function rule(partial: Partial<Rule> & Pick<Rule, "match" | "role">): Rule {
  return {
    reason: "test rule",
    ...partial,
  };
}
