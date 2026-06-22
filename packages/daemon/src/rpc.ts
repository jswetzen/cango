import {
  applyFanout,
  applyMasks,
  checkAvailability,
  compileRegex,
  expandGroups,
  explainEvent,
  findFreeSlots,
  resolveRole,
  type CalEvent,
  type ResolvedEvent,
  type Rule,
  type RuleMatch,
} from "@cango/core";
import { z } from "zod";
import type { Cache } from "./cache.ts";
import { ruleEffectSchema, ruleMatchSchema, ruleRoleSchema, toRuleMatch } from "./config.ts";
import type { LoadedConfig } from "./config.ts";
import type { Refresher } from "./cron.ts";
import type { RuleStore } from "./ruleStore.ts";
import { formatInZone, parseInZone, zonedDateOnlyUtc, zonedDayIndex } from "./tz.ts";

export interface RpcContext {
  cache: Cache;
  getConfig: () => LoadedConfig;
  rules: RuleStore;
  refresher: Refresher;
  reload: () => Promise<void>;
}

export class RpcError extends Error {
  constructor(
    public readonly code: number,
    message: string,
    public readonly data?: unknown,
  ) {
    super(message);
  }
}

// Date params are built per-request because parsing an offset-less timestamp
// depends on the configured timezone (see parseInZone). Each is a factory taking
// the resolved tz; date-free param schemas stay static.
const isoDate = (tz: string) =>
  z
    .string()
    .refine((s) => !Number.isNaN(Date.parse(s)), { message: "invalid ISO date" })
    .transform((s) => parseInZone(s, tz));

const checkParams = (tz: string) =>
  z.object({
    start: isoDate(tz),
    end: isoDate(tz),
    people: z.array(z.string()).optional(),
  });

const freeSlotParams = (tz: string) =>
  z.object({
    duration_minutes: z.number().int().positive(),
    between: z.object({ start: isoDate(tz), end: isoDate(tz) }),
    people: z.array(z.string()).optional(),
    working_hours: z.object({ start: z.string(), end: z.string() }).optional(),
  });

// Mirrors the core `Role` union (no zod schema is exported from @cango/core).
const roleEnum = z.enum(["hard", "soft", "info", "conditional"]);

const listEventsParams = (tz: string) =>
  z.object({
    start: isoDate(tz),
    end: isoDate(tz),
    people: z.array(z.string()).optional(),
    // Compact by default: the Exchange GUIDs (`id`/`series_id`) are large and
    // only needed for follow-up calls, so they're opt-in via `extended`.
    extended: z.boolean().default(false),
    // Opt-in role filter. Default drops nothing so a soft-only event is never
    // silently hidden from a caller eyeballing a day.
    exclude_roles: z.array(roleEnum).optional(),
    // High default so a full-month fetch stays a single call.
    limit: z.number().int().positive().default(1000),
    offset: z.number().int().nonnegative().default(0),
  });

const explainParams = z.object({ event_id: z.string() });
const listSeriesParams = z.object({ source_id: z.string() });

const createEventParams = (tz: string) =>
  z
    .object({
      source_id: z.string(),
      title: z.string().min(1).max(500),
      start: isoDate(tz),
      end: isoDate(tz),
      all_day: z.boolean().default(false),
      // Person/group ids who occupy this event. Each person with a known email
      // gets an ATTENDEE line; those without are returned in `unwritten_occupants`.
      occupants: z.array(z.string()).optional(),
    })
    .refine((p) => p.end > p.start, { message: "end must be after start" });

// Rule CRUD params are date-free, so static. `ruleMatchSchema` accepts the
// snake_case match keys at the wire boundary and transforms them to the core
// camelCase `RuleMatch`.
const createRuleParams = z.object({
  match: ruleMatchSchema,
  role: ruleRoleSchema,
  effect: ruleEffectSchema.default("self"),
  occupants: z.array(z.string()).optional(),
  reason: z.string().min(1).max(500),
});

const amendRuleParams = z.object({
  id: z.string().min(1),
  match: ruleMatchSchema.optional(),
  role: ruleRoleSchema.optional(),
  effect: ruleEffectSchema.optional(),
  occupants: z.array(z.string()).optional(),
  reason: z.string().min(1).max(500).optional(),
});

const retractRuleParams = z.object({
  id: z.string().min(1),
  reason: z.string().optional(),
});

// `.default({})` so a no-args `listRules` call (params undefined) is accepted.
const listRulesParams = z.object({ include_retracted: z.boolean().default(false) }).default({});

type Handler = (ctx: RpcContext, params: unknown) => unknown | Promise<unknown>;

export const methods: Record<string, Handler> = {
  checkAvailability(ctx, raw) {
    const config = ctx.getConfig();
    const tz = config.settings.timezone;
    const p = checkParams(tz).parse(raw);
    const people = selectPeople(config, p.people);
    const events = ctx.cache.eventsInWindow(
      p.start,
      p.end,
      p.people,
      occupancyCanFanOut(ctx),
    );
    const result = checkAvailability({
      window: { start: p.start, end: p.end },
      people,
      events,
      family: config.family,
      rules: ctx.rules.active(),
    });
    return withStatus(ctx, {
      verdict: result.verdict,
      conflicts: result.conflicts.map((c) => ({
        person: { id: c.person.id, name: c.person.name },
        event: serializeResolved(c.event, tz),
        overlap_minutes: c.overlapMinutes,
      })),
    });
  },

  findFreeSlot(ctx, raw) {
    const config = ctx.getConfig();
    const tz = config.settings.timezone;
    const p = freeSlotParams(tz).parse(raw);
    const people = selectPeople(config, p.people);
    const events = ctx.cache.eventsInWindow(
      p.between.start,
      p.between.end,
      p.people,
      occupancyCanFanOut(ctx),
    );
    const slots = findFreeSlots({
      range: { start: p.between.start, end: p.between.end },
      duration: p.duration_minutes,
      people,
      events,
      family: config.family,
      rules: ctx.rules.active(),
      ...(p.working_hours ? { workingHours: p.working_hours } : {}),
    });
    return withStatus(ctx, {
      slots: slots.map((s) => ({ start: formatInZone(s.start, tz), end: formatInZone(s.end, tz) })),
    });
  },

  listEvents(ctx, raw) {
    const config = ctx.getConfig();
    const tz = config.settings.timezone;
    const p = listEventsParams(tz).parse(raw);
    const events = ctx.cache.eventsInWindow(p.start, p.end, p.people, occupancyCanFanOut(ctx));
    const exclude = p.exclude_roles ? new Set(p.exclude_roles) : null;
    const active = ctx.rules.active();
    const rulesVersion = ctx.rules.version();
    // Per-event resolution is cached; fan-out and out-of-office masking are
    // cross-event post-passes applied on top of the cached results, in the same
    // order as the availability consumers (fanout, then mask).
    const masked = applyMasks(
      applyFanout(
        events.map((e) => resolveCached(ctx, e, active, rulesVersion)),
        active,
        config.family,
      ),
      active,
    );
    // When people were requested but fan-out forced us to drop the SQL person
    // filter, narrow precisely now on the resolved occupant set.
    const wanted = p.people && p.people.length > 0 ? new Set(p.people) : null;
    const peopleFiltered = wanted
      ? masked.filter((r) => r.occupants.some((o) => wanted.has(o.personId)))
      : masked;
    const resolved = peopleFiltered.filter((r) => !exclude || !exclude.has(r.resolvedRole));
    const total = resolved.length;
    const page = resolved.slice(p.offset, p.offset + p.limit);
    return withStatus(ctx, {
      events: page.map((r) =>
        serializeResolved(r, tz, { extended: p.extended, daySpan: true }),
      ),
      total,
      returned: page.length,
      truncated: p.offset + page.length < total,
    });
  },

  explainEvent(ctx, raw) {
    const p = explainParams.parse(raw);
    const config = ctx.getConfig();
    const tz = config.settings.timezone;
    const event = findEventById(ctx, p.event_id);
    if (!event) {
      throw new RpcError(-32004, `event not found: ${p.event_id}`);
    }
    // Neighbours overlapping this event's span let explainEvent evaluate
    // out-of-office masking (a cross-event effect).
    const neighbors = ctx.cache
      .eventsInWindow(event.start, event.end)
      .filter((e) => !(e.id === event.id && e.sourceId === event.sourceId));
    const result = explainEvent(event, config.family, ctx.rules.active(), neighbors);
    return withStatus(ctx, {
      resolved: serializeResolved(result.resolved, tz),
      trace: result.trace,
    });
  },

  listSeries(ctx, raw) {
    const tz = ctx.getConfig().settings.timezone;
    const p = listSeriesParams.parse(raw);
    const series = ctx.cache.recentSeries(p.source_id);
    return withStatus(ctx, {
      series: series.map((s) => ({
        series_id: s.seriesId,
        title: s.title,
        last_start: formatInZone(new Date(s.lastStartMs), tz),
        count: s.count,
      })),
    });
  },

  async createEvent(ctx, raw) {
    const config = ctx.getConfig();
    const tz = config.settings.timezone;
    const p = createEventParams(tz).parse(raw);
    const conn = config.connections.find((c) => c.sourceId === p.source_id);
    if (!conn) {
      throw new RpcError(-32004, `unknown source: ${p.source_id}`);
    }
    if (conn.kind !== "caldav" || !conn.writable) {
      throw new RpcError(-32005, `source not writable: ${p.source_id}`);
    }
    for (const id of p.occupants ?? []) {
      if (!isKnownOccupant(config, id)) {
        throw new RpcError(-32602, `unknown person/group in occupants: ${id}`);
      }
    }
    // All-day events are date-only: the CalDAV adapter writes `VALUE=DATE` from
    // the instant's UTC calendar date. `parseInZone` placed the bare start/end
    // on tz-local midnight, whose UTC date is the day before for positive-offset
    // zones — so re-anchor to UTC midnight of the tz-local date first.
    const start = p.all_day ? zonedDateOnlyUtc(p.start, tz) : p.start;
    const end = p.all_day ? zonedDateOnlyUtc(p.end, tz) : p.end;

    // Resolve occupant ids → ATTENDEE lines. Group-expand, then split into
    // people we can write (a known email) and those we can't — the latter are
    // reported back so the caller can add an email or a fanout rule instead of
    // silently losing them. The owner is implicit (it's their calendar), so
    // don't write the owner as an ATTENDEE.
    const ownerId = config.personIdForSource(p.source_id);
    const occupantIds = p.occupants
      ? expandGroups(p.occupants, config.family).filter((id) => id !== ownerId)
      : [];
    const peopleById = new Map(config.family.people.map((pp) => [pp.id, pp]));
    const attendees: { name: string; email: string }[] = [];
    const unwritten: string[] = [];
    const attendeeIds: string[] = [];
    for (const id of occupantIds) {
      const person = peopleById.get(id);
      const email = person?.emails?.[0];
      if (person && email) {
        attendees.push({ name: person.name, email });
        attendeeIds.push(id);
      } else {
        unwritten.push(id);
      }
    }

    // The refresher owns the write + cache-refresh, using the same injected
    // adapters as fetching so listEvents/checkAvailability see it immediately.
    const uid = await ctx.refresher.createEvent(conn, {
      title: p.title,
      start,
      end,
      allDay: p.all_day,
      ...(attendees.length > 0
        ? {
            attendees,
            ...(conn.selfEmail !== undefined ? { organizerEmail: conn.selfEmail } : {}),
          }
        : {}),
    });
    const event = findEventById(ctx, uid);
    const resolvedEvent = event
      ? resolveCached(ctx, event, ctx.rules.active(), ctx.rules.version())
      : null;
    return withStatus(ctx, {
      event: resolvedEvent ? serializeResolved(resolvedEvent, tz) : { id: uid },
      ...(unwritten.length > 0 ? { unwritten_occupants: unwritten } : {}),
    });
  },

  listRules(ctx, raw) {
    const tz = ctx.getConfig().settings.timezone;
    const p = listRulesParams.parse(raw);
    const rules = ctx.rules.list(p.include_retracted);
    return withStatus(ctx, { rules: rules.map((r) => serializeRule(r, tz)) });
  },

  createRule(ctx, raw) {
    const config = ctx.getConfig();
    const tz = config.settings.timezone;
    const p = createRuleParams.parse(raw);
    const match = toRuleMatch(p.match);
    validateRuleMatch(config, match);
    validateOccupants(config, p.effect, p.occupants);
    const rule = ctx.rules.create({
      match,
      role: p.role,
      effect: p.effect,
      ...(p.occupants !== undefined ? { occupants: p.occupants } : {}),
      reason: p.reason,
    });
    ctx.cache.clearResolvedCache();
    return withStatus(ctx, { rule: serializeRule(rule, tz) });
  },

  amendRule(ctx, raw) {
    const config = ctx.getConfig();
    const tz = config.settings.timezone;
    const p = amendRuleParams.parse(raw);
    const match = p.match !== undefined ? toRuleMatch(p.match) : undefined;
    if (match) validateRuleMatch(config, match);
    // An empty occupants array is the "clear it" signal on amend; only a
    // non-empty list is validated (and only fanout rules may carry one).
    if (p.occupants !== undefined && p.occupants.length > 0) {
      const effect = p.effect ?? ctx.rules.get(p.id)?.effect ?? "self";
      validateOccupants(config, effect, p.occupants);
    }
    let rule;
    try {
      rule = ctx.rules.amend(p.id, {
        ...(match !== undefined ? { match } : {}),
        ...(p.role !== undefined ? { role: p.role } : {}),
        ...(p.effect !== undefined ? { effect: p.effect } : {}),
        ...(p.occupants !== undefined ? { occupants: p.occupants } : {}),
        ...(p.reason !== undefined ? { reason: p.reason } : {}),
      });
    } catch (err) {
      throw new RpcError(-32004, err instanceof Error ? err.message : String(err));
    }
    ctx.cache.clearResolvedCache();
    return withStatus(ctx, { rule: serializeRule(rule, tz) });
  },

  retractRule(ctx, raw) {
    const tz = ctx.getConfig().settings.timezone;
    const p = retractRuleParams.parse(raw);
    let rule;
    try {
      rule = ctx.rules.retract(p.id);
    } catch (err) {
      throw new RpcError(-32004, err instanceof Error ? err.message : String(err));
    }
    ctx.cache.clearResolvedCache();
    return withStatus(ctx, { rule: serializeRule(rule, tz) });
  },

  async reloadConfig(ctx) {
    await ctx.reload();
    return withStatus(ctx, { reloaded: true });
  },

  health(ctx) {
    const tz = ctx.getConfig().settings.timezone;
    const statuses = ctx.cache.sourceStatuses();
    const freshness: Record<string, string | null> = {};
    for (const s of statuses) {
      freshness[s.id] = s.lastSuccessAt ? formatInZone(new Date(s.lastSuccessAt), tz) : null;
    }
    const stale = ctx.refresher.staleSources();
    return {
      ok: true,
      degraded: stale.length > 0,
      stale_sources: stale,
      source_freshness: freshness,
    };
  },
};

export async function dispatch(
  ctx: RpcContext,
  method: string,
  params: unknown,
): Promise<unknown> {
  const handler = methods[method];
  if (!handler) {
    throw new RpcError(-32601, `method not found: ${method}`);
  }
  // `return await` (not bare `return`) so a rejection from an async handler is
  // adopted within this frame, rather than briefly floating as an unhandled
  // rejected promise before the caller's await attaches a handler.
  return await handler(ctx, params);
}

function withStatus<T extends Record<string, unknown>>(ctx: RpcContext, body: T): T & {
  degraded: boolean;
  stale_sources: string[];
} {
  const stale = ctx.refresher.staleSources();
  return { ...body, degraded: stale.length > 0, stale_sources: stale };
}

function validateRuleMatch(config: LoadedConfig, match: RuleMatch): void {
  if (Object.values(match).every((v) => v === undefined)) {
    throw new RpcError(-32602, "rule match must constrain at least one field");
  }
  if (match.titleRegex !== undefined) {
    try {
      compileRegex(match.titleRegex);
    } catch (err) {
      throw new RpcError(
        -32602,
        `invalid titleRegex: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  if (match.sourceId !== undefined && !config.family.sources.some((s) => s.id === match.sourceId)) {
    throw new RpcError(-32602, `unknown source: ${match.sourceId}`);
  }
  if (match.personId !== undefined && !config.family.people.some((p) => p.id === match.personId)) {
    throw new RpcError(-32602, `unknown person: ${match.personId}`);
  }
}

/** A person or group id known to the family graph — the universe of valid
 * occupant references (fanout rules, createEvent occupants, defaultOccupants). */
function isKnownOccupant(config: LoadedConfig, id: string): boolean {
  return (
    config.family.people.some((p) => p.id === id) ||
    (config.family.groups ?? []).some((g) => g.id === id)
  );
}

function validateOccupants(
  config: LoadedConfig,
  effect: string | undefined,
  occupants: string[] | undefined,
): void {
  if (occupants === undefined) return;
  if ((effect ?? "self") !== "fanout") {
    throw new RpcError(-32602, "occupants are only valid on a fanout-effect rule");
  }
  if (occupants.length === 0) {
    throw new RpcError(-32602, "a fanout rule needs at least one occupant");
  }
  for (const id of occupants) {
    if (!isKnownOccupant(config, id)) {
      throw new RpcError(-32602, `unknown person/group in occupants: ${id}`);
    }
  }
}

function serializeMatch(m: RuleMatch): Record<string, unknown> {
  return {
    ...(m.personId !== undefined ? { person_id: m.personId } : {}),
    ...(m.sourceId !== undefined ? { source_id: m.sourceId } : {}),
    ...(m.titleRegex !== undefined ? { title_regex: m.titleRegex } : {}),
    ...(m.seriesId !== undefined ? { series_id: m.seriesId } : {}),
    ...(m.organizerIsSelf !== undefined ? { organizer_is_self: m.organizerIsSelf } : {}),
    ...(m.rsvpStatusIn !== undefined ? { rsvp_status_in: m.rsvpStatusIn } : {}),
  };
}

function serializeRule(r: Rule, tz: string) {
  return {
    id: r.id,
    match: serializeMatch(r.match),
    role: r.role,
    effect: r.effect ?? "self",
    ...(r.occupants !== undefined ? { occupants: r.occupants } : {}),
    reason: r.reason,
    ...(r.createdAt !== undefined ? { created_at: formatInZone(new Date(r.createdAt), tz) } : {}),
    ...(r.updatedAt !== undefined ? { updated_at: formatInZone(new Date(r.updatedAt), tz) } : {}),
    ...(r.retractedAt !== undefined
      ? { retracted_at: formatInZone(new Date(r.retractedAt), tz) }
      : {}),
  };
}

/**
 * Can occupancy attach a requested person to an event whose stored
 * owner/`attendee_ids` don't name them? If so the cache's SQL person filter
 * must be dropped (and narrowing done post-resolution on the resolved
 * `occupants`), because that filter only keys off the row's `person_id` and
 * `attendee_ids_json`. Three occupancy sources reach beyond those columns:
 *   - a `fanout` rule (targets live in the rule store, not on the row);
 *   - a source's `defaultOccupants` set to anything other than its owner (the
 *     shared-family-calendar case — config-derived, not on the row);
 *   - ATTENDEE matches that resolve to a *different* person than the owner —
 *     only possible if more than one person carries an email, so the resolver
 *     can map an attendee to a non-owner. (With at most one emailed person, any
 *     match is that person on their own calendar, already covered by person_id.)
 * Any of these makes the SQL pre-filter unsafe to trust, so we widen.
 */
function occupancyCanFanOut(ctx: RpcContext): boolean {
  if (ctx.rules.active().some((r) => r.effect === "fanout")) return true;
  const family = ctx.getConfig().family;
  const ownerBySource = new Map(family.sources.map((s) => [s.id, s.ownerId]));
  const sharedSource = family.sources.some(
    (s) =>
      s.defaultOccupants !== undefined &&
      s.defaultOccupants.some((id) => id !== ownerBySource.get(s.id)),
  );
  if (sharedSource) return true;
  const emailedPeople = family.people.filter((p) => (p.emails?.length ?? 0) > 0);
  return emailedPeople.length > 1;
}

function selectPeople(config: LoadedConfig, ids?: string[]) {
  if (!ids || ids.length === 0) return config.family.people;
  const wanted = new Set(ids);
  return config.family.people.filter((p) => wanted.has(p.id));
}

// `rules`/`rulesVersion` are passed in (computed once by the caller) so a
// per-event map doesn't recompute the rule-store version hash for every event.
function resolveCached(
  ctx: RpcContext,
  event: CalEvent,
  rules: Rule[],
  rulesVersion: string,
): ResolvedEvent {
  const config = ctx.getConfig();
  const cached = ctx.cache.getResolved(
    event.sourceId,
    event.id,
    config.familyVersion,
    rulesVersion,
  );
  if (cached) return cached;
  const resolved = resolveRole(event, config.family, rules);
  ctx.cache.putResolved(config.familyVersion, rulesVersion, resolved);
  return resolved;
}

function findEventById(ctx: RpcContext, eventId: string): CalEvent | null {
  // Search a wide window; events live in the warm refresh window.
  const events = ctx.cache.eventsInWindow(
    new Date(Date.now() - 365 * 24 * 60 * 60 * 1000),
    new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
  );
  return events.find((e) => e.id === eventId) ?? null;
}

/** Distinct tz-local calendar days an event touches; 1 for a same-day event. */
function eventDaySpan(e: ResolvedEvent, tz: string): number {
  // All-day events store an exclusive end (8 00:00 → 9 00:00 = one day), so
  // step back an instant before taking its date.
  const endRef = e.allDay ? new Date(e.end.getTime() - 1) : e.end;
  return Math.max(1, zonedDayIndex(endRef, tz) - zonedDayIndex(e.start, tz) + 1);
}

/** True when an event occupies only its owner at its own role — the common
 * case, where the `occupants` array adds nothing over `person_id`/`resolved_role`
 * and is omitted from output to stay compact. */
function isPlainOccupancy(e: ResolvedEvent): boolean {
  return (
    e.occupants.length === 1 &&
    e.occupants[0]!.personId === e.personId &&
    e.occupants[0]!.role === e.resolvedRole
  );
}

// `extended` defaults true and `daySpan` false so callers other than listEvents
// (checkAvailability/explainEvent/createEvent) get byte-identical output.
function serializeResolved(
  e: ResolvedEvent,
  tz: string,
  opts: { extended?: boolean; daySpan?: boolean } = {},
) {
  const { extended = true, daySpan = false } = opts;
  const span = daySpan ? eventDaySpan(e, tz) : 1;
  return {
    ...(extended ? { id: e.id } : {}),
    source_id: e.sourceId,
    person_id: e.personId,
    ...(extended ? { series_id: e.seriesId ?? null } : {}),
    title: e.title,
    start: formatInZone(e.start, tz),
    end: formatInZone(e.end, tz),
    all_day: e.allDay,
    resolved_role: e.resolvedRole,
    // Occupancy: only surface it when the event occupies someone other than its
    // owner at its base role (a household / fanned event). A plain single-owner
    // event carries no new information here, so it stays compact.
    ...(isPlainOccupancy(e)
      ? {}
      : { occupants: e.occupants.map((o) => ({ person_id: o.personId, role: o.role })) }),
    // In compact mode a plain source-default verdict carries no information, so
    // drop its boilerplate; keep it whenever a rule/attendance/etc. decided it.
    ...(!extended && e.resolvedBy === "default"
      ? {}
      : { resolved_by: e.resolvedBy, resolved_reason: e.resolvedReason }),
    ...(span > 1 ? { day_span: span } : {}),
    ...(e.ruleId !== undefined ? { rule_id: e.ruleId } : {}),
    ...(e.rsvpStatus !== undefined ? { rsvp_status: e.rsvpStatus } : {}),
  };
}
