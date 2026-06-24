import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import type { FamilyGraph, Role, RuleMatch } from "@cango/core";
import { isValidTimeZone } from "./tz.ts";

// `conditional` was removed — it resolved identically to `info` in every
// consumer. Coerce any value lingering in an existing family.yaml so the daemon
// still loads rather than failing the enum.
const roleSchema = z.preprocess(
  (v) => (v === "conditional" ? "info" : v),
  z.enum(["hard", "soft", "info"]),
);
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
    // Exact calendar-collection URL; when set the adapter skips tsdav discovery
    // and talks straight to it (for servers with broken .well-known/principal).
    calendarUrl: z.string().optional(),
    // Opt-in write access. Only caldav can be writable; default read-only.
    writable: z.boolean().default(false),
    // Who this calendar's events normally occupy (person or group ids). When
    // omitted the baseline is [ownerId] — today's behaviour. A shared family
    // calendar sets this to a group.
    defaultOccupants: z.array(z.string()).optional(),
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
    if (s.kind === "ics" && s.writable) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `ics source ${s.id} cannot be writable`,
      });
    }
  });

const personSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  sourceIds: z.array(z.string()).default([]),
  // Addresses used to match this person against an event's ATTENDEE props.
  // Optional: a person with no email is never ATTENDEE-matched.
  emails: z.array(z.string()).optional(),
});

const groupSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  memberIds: z.array(z.string()).default([]),
});

const orgSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  sourceIds: z.array(z.string()).default([]),
});

// DEPRECATED. Attendance edges are no longer a live config layer — they are
// seeded once into the rule store (state.db) on first run and managed via the
// agent thereafter. This schema is kept only so existing family.yaml files
// still validate and can be read by the one-time seeder.
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
  groups: z.array(groupSchema).default([]),
  attendance: z.array(attendanceSchema).default([]),
  settings: z
    .object({
      refreshIntervalMinutes: z.number().int().positive().default(60),
      maxStaleHours: z.number().positive().default(6),
      // IANA zone used to format event times in output and to interpret
      // offset-less input timestamps. Defaults to UTC for back-compat.
      timezone: z
        .string()
        .default("UTC")
        .refine(isValidTimeZone, { message: "unknown IANA timezone" }),
    })
    .default({ refreshIntervalMinutes: 60, maxStaleHours: 6, timezone: "UTC" }),
});

// Rule shape, shared by the create/amend RPC param schemas (rpc.ts). Rules are
// no longer loaded from a file — they live in the rule store — but their shape
// is still validated at write time. `personId` (new vs the old rules.yaml) and
// the `inherit` role let a rule subsume the former attendance edges; `mask` is
// the out-of-office cross-event effect.
// Wire shape is snake_case (matching the rest of the RPC boundary); map to the
// core camelCase `RuleMatch` with `toRuleMatch`.
export const ruleMatchSchema = z.object({
  person_id: z.string().optional(),
  source_id: z.string().optional(),
  title_regex: z.string().optional(),
  series_id: z.string().optional(),
  organizer_is_self: z.boolean().optional(),
  rsvp_status_in: z.array(rsvpSchema).optional(),
});

export const ruleRoleSchema = z.preprocess(
  (v) => (v === "conditional" ? "info" : v),
  z.enum(["hard", "soft", "info", "inherit"]),
);
export const ruleEffectSchema = z.enum(["self", "mask", "fanout"]);

/** snake_case wire match → core `RuleMatch`. Conditional spreads keep optional
 * keys absent (not `undefined`) for exactOptionalPropertyTypes. */
export function toRuleMatch(m: z.infer<typeof ruleMatchSchema>): RuleMatch {
  return {
    ...(m.person_id !== undefined ? { personId: m.person_id } : {}),
    ...(m.source_id !== undefined ? { sourceId: m.source_id } : {}),
    ...(m.title_regex !== undefined ? { titleRegex: m.title_regex } : {}),
    ...(m.series_id !== undefined ? { seriesId: m.series_id } : {}),
    ...(m.organizer_is_self !== undefined ? { organizerIsSelf: m.organizer_is_self } : {}),
    ...(m.rsvp_status_in !== undefined ? { rsvpStatusIn: m.rsvp_status_in } : {}),
  };
}

export type FamilyFile = z.infer<typeof familyFileSchema>;
export type SourceDef = z.infer<typeof sourceSchema>;

/** A single problem found by the standalone validator. */
export interface ValidationIssue {
  file: "family" | "rules";
  /** Dotted path into the parsed document, e.g. `sources[0].ownerId`. */
  path: string;
  message: string;
}

/**
 * Semantic cross-reference checks that the Zod schemas can't express.
 *
 * The schemas validate the shape of each file in isolation, but several real
 * footguns only show up across references — most notably dangling `sourceIds`,
 * which `buildFamily` silently drops (see buildFamily above), so a typo there
 * produces a daemon that quietly ignores a calendar rather than failing.
 *
 * Pure and side-effect free: takes already-parsed documents, returns issues.
 */
export function checkReferences(family: FamilyFile): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const add = (path: string, message: string, file: "family" | "rules" = "family") =>
    issues.push({ file, path, message });

  const peopleIds = new Set<string>();
  const orgIds = new Set<string>();
  const sourceIds = new Set<string>();
  const groupIds = new Set<string>(family.groups.map((g) => g.id));

  // Duplicate detection. People, organizations, and sources share one id
  // namespace as far as references go (sourceIds, ownerId), so a collision
  // between any of them is ambiguous.
  const seen = new Map<string, string>(); // id -> first place it appeared
  const claim = (id: string, where: string, path: string) => {
    const prev = seen.get(id);
    if (prev) add(path, `duplicate id "${id}" (already used by ${prev})`);
    else seen.set(id, where);
  };

  for (const [i, p] of family.people.entries()) {
    peopleIds.add(p.id);
    claim(p.id, `people[${i}]`, `people[${i}].id`);
  }
  for (const [i, o] of family.organizations.entries()) {
    orgIds.add(o.id);
    claim(o.id, `organizations[${i}]`, `organizations[${i}].id`);
  }
  for (const [i, s] of family.sources.entries()) {
    sourceIds.add(s.id);
    claim(s.id, `sources[${i}]`, `sources[${i}].id`);
  }
  for (const [i, g] of family.groups.entries()) {
    claim(g.id, `groups[${i}]`, `groups[${i}].id`);
  }

  // A person/group id, for occupancy references (defaultOccupants, group members).
  const isOccupant = (id: string) => peopleIds.has(id) || groupIds.has(id);

  // Group members must resolve to a known person or group.
  for (const [i, g] of family.groups.entries()) {
    for (const [j, mid] of g.memberIds.entries()) {
      if (!isOccupant(mid)) {
        add(`groups[${i}].memberIds[${j}]`, `unknown person/group "${mid}"`);
      }
    }
  }

  // Source defaultOccupants must resolve to known people/groups.
  for (const [i, s] of family.sources.entries()) {
    if (!s.defaultOccupants) continue;
    for (const [j, oid] of s.defaultOccupants.entries()) {
      if (!isOccupant(oid)) {
        add(`sources[${i}].defaultOccupants[${j}]`, `unknown person/group "${oid}"`);
      }
    }
  }

  // Dangling sourceIds on people / organizations (silently dropped at runtime).
  for (const [i, p] of family.people.entries()) {
    for (const [j, sid] of p.sourceIds.entries()) {
      if (!sourceIds.has(sid)) {
        add(`people[${i}].sourceIds[${j}]`, `unknown source "${sid}" (would be silently ignored)`);
      }
    }
  }
  for (const [i, o] of family.organizations.entries()) {
    for (const [j, sid] of o.sourceIds.entries()) {
      if (!sourceIds.has(sid)) {
        add(
          `organizations[${i}].sourceIds[${j}]`,
          `unknown source "${sid}" (would be silently ignored)`,
        );
      }
    }
  }

  // Source ownerId must resolve in the matching namespace.
  for (const [i, s] of family.sources.entries()) {
    if (s.ownedBy === "person" && !peopleIds.has(s.ownerId)) {
      add(`sources[${i}].ownerId`, `"${s.ownerId}" is not a known person (ownedBy: person)`);
    }
    // Org-owned feeds stamp ownerId as the *person* who follows them (see the
    // ownerId note in examples/family.yaml.example), so an org source's ownerId
    // is expected to be a person id.
    if (s.ownedBy === "organization" && !peopleIds.has(s.ownerId)) {
      add(
        `sources[${i}].ownerId`,
        `"${s.ownerId}" is not a known person — org-owned feeds stamp ownerId as the following person`,
      );
    }
  }

  // Attendance personId must be a real person.
  for (const [i, a] of family.attendance.entries()) {
    if (!peopleIds.has(a.personId)) {
      add(`attendance[${i}].personId`, `unknown person "${a.personId}"`);
    }
  }

  return issues;
}

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
  /** Exact calendar-collection URL; bypasses tsdav discovery when set. */
  calendarUrl?: string;
  selfEmail?: string;
  /** Whether the daemon may write events to this source (opt-in). */
  writable: boolean;
}

export type SourceConnection = IcsConnection | CalDavConnection;

export interface DaemonSettings {
  refreshIntervalMinutes: number;
  maxStaleHours: number;
  timezone: string;
}

export interface LoadedConfig {
  family: FamilyGraph;
  connections: SourceConnection[];
  settings: DaemonSettings;
  /** sourceId -> personId, derived from source ownership when owned by a person. */
  personIdForSource: (sourceId: string) => string;
  /** ATTENDEE emails -> known person ids (case-insensitive, deduped, external
   * addresses dropped). Used by adapters to populate `attendeeIds`. */
  resolveAttendeeIds: (emails: string[]) => string[];
  familyVersion: string;
  /** Deprecated family.yaml attendance edges, for the one-time rule-store seed. */
  attendanceSeed: FamilyFile["attendance"];
}

export interface FamilySource {
  load(): Promise<{
    family: FamilyGraph;
    connections: SourceConnection[];
    settings: DaemonSettings;
    attendanceSeed: FamilyFile["attendance"];
  }>;
}

/**
 * Substitute `${VAR}` placeholders with values from the environment. Config
 * authors keep secrets out of family.yaml by writing e.g. `${CANGO_WORK_PASSWORD}`
 * and supplying the value via /etc/cango.env, so we expand them at load time.
 * Returns the names of any referenced vars that aren't set so the caller can
 * fail loudly rather than silently authenticate with a blank value.
 */
export function expandEnvVars(value: string): { value: string; missing: string[] } {
  const missing: string[] = [];
  const out = value.replace(/\$\{([A-Z0-9_]+)\}/gi, (_m, name: string) => {
    const v = process.env[name];
    if (v === undefined) {
      missing.push(name);
      return "";
    }
    return v;
  });
  return { value: out, missing };
}

/** Expand `${VAR}` placeholders in a connection's URL/credential fields. */
export function expandConnectionEnv(conn: SourceConnection): {
  connection: SourceConnection;
  missing: string[];
} {
  const missing: string[] = [];
  const ex = (v: string): string => {
    const r = expandEnvVars(v);
    missing.push(...r.missing);
    return r.value;
  };
  if (conn.kind === "ics") {
    return {
      connection: {
        ...conn,
        url: ex(conn.url),
        ...(conn.selfEmail !== undefined ? { selfEmail: ex(conn.selfEmail) } : {}),
      },
      missing,
    };
  }
  return {
    connection: {
      ...conn,
      serverUrl: ex(conn.serverUrl),
      username: ex(conn.username),
      password: ex(conn.password),
      ...(conn.calendarName !== undefined ? { calendarName: ex(conn.calendarName) } : {}),
      ...(conn.calendarUrl !== undefined ? { calendarUrl: ex(conn.calendarUrl) } : {}),
      ...(conn.selfEmail !== undefined ? { selfEmail: ex(conn.selfEmail) } : {}),
    },
    missing,
  };
}

export class YamlFamilySource implements FamilySource {
  constructor(private readonly path: string) {}

  async load(): Promise<{
    family: FamilyGraph;
    connections: SourceConnection[];
    settings: DaemonSettings;
    attendanceSeed: FamilyFile["attendance"];
  }> {
    const text = await readFile(this.path, "utf8");
    const parsed = familyFileSchema.parse(parseYaml(text) ?? {});
    const built = buildFamily(parsed);

    const missing = new Set<string>();
    const connections = built.connections.map((conn) => {
      const r = expandConnectionEnv(conn);
      for (const m of r.missing) missing.add(m);
      return r.connection;
    });
    if (missing.size > 0) {
      throw new Error(
        `config references unset environment variable(s): ${[...missing].join(", ")}`,
      );
    }

    return { ...built, connections };
  }
}

export function buildFamily(file: FamilyFile): {
  family: FamilyGraph;
  connections: SourceConnection[];
  settings: DaemonSettings;
  attendanceSeed: FamilyFile["attendance"];
} {
  const sourceRefs = file.sources.map((s) => ({
    id: s.id,
    defaultRole: s.defaultRole as Role,
    ownedBy: s.ownedBy,
    ownerId: s.ownerId,
    ...(s.defaultOccupants !== undefined ? { defaultOccupants: s.defaultOccupants } : {}),
  }));
  const refById = new Map(sourceRefs.map((r) => [r.id, r]));

  const family: FamilyGraph = {
    people: file.people.map((p) => ({
      id: p.id,
      name: p.name,
      sources: p.sourceIds
        .map((id) => refById.get(id))
        .filter((r): r is NonNullable<typeof r> => r !== undefined),
      ...(p.emails !== undefined ? { emails: p.emails } : {}),
    })),
    organizations: file.organizations.map((o) => ({
      id: o.id,
      name: o.name,
      publishes: o.sourceIds
        .map((id) => refById.get(id))
        .filter((r): r is NonNullable<typeof r> => r !== undefined),
    })),
    sources: sourceRefs,
    ...(file.groups.length > 0
      ? { groups: file.groups.map((g) => ({ id: g.id, name: g.name, memberIds: g.memberIds })) }
      : {}),
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
          writable: s.writable,
          ...(s.calendarName !== undefined ? { calendarName: s.calendarName } : {}),
          ...(s.calendarUrl !== undefined ? { calendarUrl: s.calendarUrl } : {}),
          ...(s.selfEmail !== undefined ? { selfEmail: s.selfEmail } : {}),
        },
  );

  return { family, connections, settings: file.settings, attendanceSeed: file.attendance };
}

export async function loadConfig(familyPath: string): Promise<LoadedConfig> {
  const familySource = new YamlFamilySource(familyPath);
  const { family, connections, settings, attendanceSeed } = await familySource.load();

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

  // email (lowercased) -> personId, for ATTENDEE matching. A person may list
  // several addresses; a duplicate address across people is a config error
  // caught by checkReferences (first wins here, defensively).
  const personIdByEmail = new Map<string, string>();
  for (const p of family.people) {
    for (const e of p.emails ?? []) {
      const key = e.toLowerCase();
      if (!personIdByEmail.has(key)) personIdByEmail.set(key, p.id);
    }
  }
  const resolveAttendeeIds = (emails: string[]): string[] => {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const e of emails) {
      const id = personIdByEmail.get(e.toLowerCase());
      if (id && !seen.has(id)) {
        seen.add(id);
        out.push(id);
      }
    }
    return out;
  };

  return {
    family,
    connections,
    settings,
    personIdForSource,
    resolveAttendeeIds,
    familyVersion: hashJson(family),
    attendanceSeed,
  };
}

function hashJson(value: unknown): string {
  return createHash("sha1").update(JSON.stringify(value)).digest("hex").slice(0, 16);
}
