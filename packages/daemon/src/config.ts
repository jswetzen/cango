import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import type { FamilyGraph, Role, Rule } from "@cango/core";

const roleSchema = z.enum(["hard", "soft", "info", "conditional"]);
const rsvpSchema = z.enum(["accepted", "tentative", "declined", "needsAction"]);

const sourceKindSchema = z.enum(["ics", "caldav"]);

const sourceSchema = z
  .object({
    id: z.string().min(1),
    kind: sourceKindSchema,
    defaultRole: roleSchema.default("hard"),
    ownedBy: z.enum(["person", "organization"]),
    ownerId: z.string().min(1),
    selfEmail: z.string().optional(),
    // ics
    url: z.string().optional(),
    // caldav
    serverUrl: z.string().optional(),
    username: z.string().optional(),
    password: z.string().optional(),
    calendarName: z.string().optional(),
  })
  .superRefine((s, ctx) => {
    if (s.kind === "ics" && !s.url) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `ics source ${s.id} needs url` });
    }
    if (s.kind === "caldav" && (!s.serverUrl || !s.username || !s.password)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `caldav source ${s.id} needs serverUrl, username, password`,
      });
    }
  });

const personSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  sourceIds: z.array(z.string()).default([]),
});

const orgSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  sourceIds: z.array(z.string()).default([]),
});

const attendanceSchema = z.object({
  id: z.string().optional(),
  personId: z.string().min(1),
  seriesId: z.string().min(1),
  role: z.enum(["ATTENDS", "SOMETIMES_ATTENDS", "NEVER_ATTENDS"]),
  reason: z.string().optional(),
});

export const familyFileSchema = z.object({
  people: z.array(personSchema).default([]),
  organizations: z.array(orgSchema).default([]),
  sources: z.array(sourceSchema).default([]),
  attendance: z.array(attendanceSchema).default([]),
  settings: z
    .object({
      refreshIntervalMinutes: z.number().int().positive().default(60),
      maxStaleHours: z.number().positive().default(6),
    })
    .default({ refreshIntervalMinutes: 60, maxStaleHours: 6 }),
});

const ruleSchema = z.object({
  id: z.string().optional(),
  match: z.object({
    sourceId: z.string().optional(),
    titleRegex: z.string().optional(),
    seriesId: z.string().optional(),
    organizerIsSelf: z.boolean().optional(),
    rsvpStatusIn: z.array(rsvpSchema).optional(),
  }),
  role: roleSchema,
  reason: z.string(),
});

export const rulesFileSchema = z.object({
  rules: z.array(ruleSchema).default([]),
});

export type FamilyFile = z.infer<typeof familyFileSchema>;
export type SourceDef = z.infer<typeof sourceSchema>;

export interface IcsConnection {
  kind: "ics";
  sourceId: string;
  url: string;
  selfEmail?: string;
}

export interface CalDavConnection {
  kind: "caldav";
  sourceId: string;
  serverUrl: string;
  username: string;
  password: string;
  calendarName?: string;
  selfEmail?: string;
}

export type SourceConnection = IcsConnection | CalDavConnection;

export interface DaemonSettings {
  refreshIntervalMinutes: number;
  maxStaleHours: number;
}

export interface LoadedConfig {
  family: FamilyGraph;
  rules: Rule[];
  connections: SourceConnection[];
  settings: DaemonSettings;
  /** sourceId -> personId, derived from source ownership when owned by a person. */
  personIdForSource: (sourceId: string) => string;
  familyVersion: string;
  rulesVersion: string;
}

export interface FamilySource {
  load(): Promise<{ family: FamilyGraph; connections: SourceConnection[]; settings: DaemonSettings }>;
}

export class YamlFamilySource implements FamilySource {
  constructor(private readonly path: string) {}

  async load(): Promise<{
    family: FamilyGraph;
    connections: SourceConnection[];
    settings: DaemonSettings;
  }> {
    const text = await readFile(this.path, "utf8");
    const parsed = familyFileSchema.parse(parseYaml(text) ?? {});
    return buildFamily(parsed);
  }
}

export function buildFamily(file: FamilyFile): {
  family: FamilyGraph;
  connections: SourceConnection[];
  settings: DaemonSettings;
} {
  const sourceRefs = file.sources.map((s) => ({
    id: s.id,
    defaultRole: s.defaultRole as Role,
    ownedBy: s.ownedBy,
    ownerId: s.ownerId,
  }));
  const refById = new Map(sourceRefs.map((r) => [r.id, r]));

  const family: FamilyGraph = {
    people: file.people.map((p) => ({
      id: p.id,
      name: p.name,
      sources: p.sourceIds
        .map((id) => refById.get(id))
        .filter((r): r is NonNullable<typeof r> => r !== undefined),
    })),
    organizations: file.organizations.map((o) => ({
      id: o.id,
      name: o.name,
      publishes: o.sourceIds
        .map((id) => refById.get(id))
        .filter((r): r is NonNullable<typeof r> => r !== undefined),
    })),
    sources: sourceRefs,
    attendance: file.attendance.map((a) => ({
      ...(a.id !== undefined ? { id: a.id } : {}),
      personId: a.personId,
      seriesId: a.seriesId,
      role: a.role,
      ...(a.reason !== undefined ? { reason: a.reason } : {}),
    })),
  };

  const connections: SourceConnection[] = file.sources.map((s) =>
    s.kind === "ics"
      ? {
          kind: "ics",
          sourceId: s.id,
          url: s.url!,
          ...(s.selfEmail !== undefined ? { selfEmail: s.selfEmail } : {}),
        }
      : {
          kind: "caldav",
          sourceId: s.id,
          serverUrl: s.serverUrl!,
          username: s.username!,
          password: s.password!,
          ...(s.calendarName !== undefined ? { calendarName: s.calendarName } : {}),
          ...(s.selfEmail !== undefined ? { selfEmail: s.selfEmail } : {}),
        },
  );

  return { family, connections, settings: file.settings };
}

export async function loadConfig(
  familyPath: string,
  rulesPath: string,
): Promise<LoadedConfig> {
  const familySource = new YamlFamilySource(familyPath);
  const { family, connections, settings } = await familySource.load();

  const rulesText = await readFile(rulesPath, "utf8").catch(() => "");
  const rulesParsed = rulesFileSchema.parse(rulesText ? (parseYaml(rulesText) ?? {}) : {});
  const rules: Rule[] = rulesParsed.rules.map((r) => {
    const match: Rule["match"] = {
      ...(r.match.sourceId !== undefined ? { sourceId: r.match.sourceId } : {}),
      ...(r.match.titleRegex !== undefined ? { titleRegex: r.match.titleRegex } : {}),
      ...(r.match.seriesId !== undefined ? { seriesId: r.match.seriesId } : {}),
      ...(r.match.organizerIsSelf !== undefined
        ? { organizerIsSelf: r.match.organizerIsSelf }
        : {}),
      ...(r.match.rsvpStatusIn !== undefined ? { rsvpStatusIn: r.match.rsvpStatusIn } : {}),
    };
    return {
      ...(r.id !== undefined ? { id: r.id } : {}),
      match,
      role: r.role as Role,
      reason: r.reason,
    };
  });

  const ownerBySource = new Map<string, { ownedBy: string; ownerId: string }>(
    family.sources.map((s) => [s.id, { ownedBy: s.ownedBy, ownerId: s.ownerId }]),
  );

  const personIdForSource = (sourceId: string): string => {
    const owner = ownerBySource.get(sourceId);
    if (!owner) {
      throw new Error(`personIdForSource: unknown source ${sourceId}`);
    }
    // Person-owned sources map to that person. Org-owned sources also carry a
    // personId on each event — the owning ownerId points at the consuming person
    // (e.g. a kid's club feed owned by the kid's id is fine; clubs owned by an org
    // must set ownerId to the person who follows them).
    return owner.ownerId;
  };

  return {
    family,
    rules,
    connections,
    settings,
    personIdForSource,
    familyVersion: hashJson(family),
    rulesVersion: hashJson(rules),
  };
}

function hashJson(value: unknown): string {
  return createHash("sha1").update(JSON.stringify(value)).digest("hex").slice(0, 16);
}
