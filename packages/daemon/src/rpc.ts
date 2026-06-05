import {
  checkAvailability,
  explainEvent,
  findFreeSlots,
  resolveRole,
  type CalEvent,
  type ResolvedEvent,
} from "@cango/core";
import { z } from "zod";
import type { Cache } from "./cache.ts";
import type { LoadedConfig } from "./config.ts";
import type { Refresher } from "./cron.ts";

export interface RpcContext {
  cache: Cache;
  getConfig: () => LoadedConfig;
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

const isoDate = z
  .string()
  .refine((s) => !Number.isNaN(Date.parse(s)), { message: "invalid ISO date" })
  .transform((s) => new Date(s));

const checkParams = z.object({
  start: isoDate,
  end: isoDate,
  people: z.array(z.string()).optional(),
});

const freeSlotParams = z.object({
  duration_minutes: z.number().int().positive(),
  between: z.object({ start: isoDate, end: isoDate }),
  people: z.array(z.string()).optional(),
  working_hours: z.object({ start: z.string(), end: z.string() }).optional(),
});

const listEventsParams = z.object({
  start: isoDate,
  end: isoDate,
  people: z.array(z.string()).optional(),
});

const explainParams = z.object({ event_id: z.string() });
const listSeriesParams = z.object({ source_id: z.string() });

const createEventParams = z
  .object({
    source_id: z.string(),
    title: z.string().min(1).max(500),
    start: isoDate,
    end: isoDate,
    all_day: z.boolean().default(false),
  })
  .refine((p) => p.end > p.start, { message: "end must be after start" });

type Handler = (ctx: RpcContext, params: unknown) => unknown | Promise<unknown>;

export const methods: Record<string, Handler> = {
  checkAvailability(ctx, raw) {
    const p = checkParams.parse(raw);
    const config = ctx.getConfig();
    const people = selectPeople(config, p.people);
    const events = ctx.cache.eventsInWindow(p.start, p.end, p.people);
    const result = checkAvailability({
      window: { start: p.start, end: p.end },
      people,
      events,
      family: config.family,
      rules: config.rules,
    });
    return withStatus(ctx, {
      verdict: result.verdict,
      conflicts: result.conflicts.map((c) => ({
        person: { id: c.person.id, name: c.person.name },
        event: serializeResolved(c.event),
        overlap_minutes: c.overlapMinutes,
      })),
    });
  },

  findFreeSlot(ctx, raw) {
    const p = freeSlotParams.parse(raw);
    const config = ctx.getConfig();
    const people = selectPeople(config, p.people);
    const events = ctx.cache.eventsInWindow(p.between.start, p.between.end, p.people);
    const slots = findFreeSlots({
      range: { start: p.between.start, end: p.between.end },
      duration: p.duration_minutes,
      people,
      events,
      family: config.family,
      rules: config.rules,
      ...(p.working_hours ? { workingHours: p.working_hours } : {}),
    });
    return withStatus(ctx, {
      slots: slots.map((s) => ({ start: s.start.toISOString(), end: s.end.toISOString() })),
    });
  },

  listEvents(ctx, raw) {
    const p = listEventsParams.parse(raw);
    const config = ctx.getConfig();
    const events = ctx.cache.eventsInWindow(p.start, p.end, p.people);
    return withStatus(ctx, {
      events: events.map((e) => serializeResolved(resolveCached(ctx, e))),
    });
  },

  explainEvent(ctx, raw) {
    const p = explainParams.parse(raw);
    const config = ctx.getConfig();
    const event = findEventById(ctx, p.event_id);
    if (!event) {
      throw new RpcError(-32004, `event not found: ${p.event_id}`);
    }
    const result = explainEvent(event, config.family, config.rules);
    return withStatus(ctx, {
      resolved: serializeResolved(result.resolved),
      trace: result.trace,
    });
  },

  listSeries(ctx, raw) {
    const p = listSeriesParams.parse(raw);
    const series = ctx.cache.recentSeries(p.source_id);
    return withStatus(ctx, {
      series: series.map((s) => ({
        series_id: s.seriesId,
        title: s.title,
        last_start: new Date(s.lastStartMs).toISOString(),
        count: s.count,
      })),
    });
  },

  async createEvent(ctx, raw) {
    const p = createEventParams.parse(raw);
    const config = ctx.getConfig();
    const conn = config.connections.find((c) => c.sourceId === p.source_id);
    if (!conn) {
      throw new RpcError(-32004, `unknown source: ${p.source_id}`);
    }
    if (conn.kind !== "caldav" || !conn.writable) {
      throw new RpcError(-32005, `source not writable: ${p.source_id}`);
    }
    // The refresher owns the write + cache-refresh, using the same injected
    // adapters as fetching so listEvents/checkAvailability see it immediately.
    const uid = await ctx.refresher.createEvent(conn, {
      title: p.title,
      start: p.start,
      end: p.end,
      allDay: p.all_day,
    });
    const event = findEventById(ctx, uid);
    return withStatus(ctx, {
      event: event ? serializeResolved(resolveCached(ctx, event)) : { id: uid },
    });
  },

  async reloadConfig(ctx) {
    await ctx.reload();
    return withStatus(ctx, { reloaded: true });
  },

  health(ctx) {
    const statuses = ctx.cache.sourceStatuses();
    const freshness: Record<string, string | null> = {};
    for (const s of statuses) {
      freshness[s.id] = s.lastSuccessAt ? new Date(s.lastSuccessAt).toISOString() : null;
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

function selectPeople(config: LoadedConfig, ids?: string[]) {
  if (!ids || ids.length === 0) return config.family.people;
  const wanted = new Set(ids);
  return config.family.people.filter((p) => wanted.has(p.id));
}

function resolveCached(ctx: RpcContext, event: CalEvent): ResolvedEvent {
  const config = ctx.getConfig();
  const cached = ctx.cache.getResolved(
    event.sourceId,
    event.id,
    config.familyVersion,
    config.rulesVersion,
  );
  if (cached) return cached;
  const resolved = resolveRole(event, config.family, config.rules);
  ctx.cache.putResolved(config.familyVersion, config.rulesVersion, resolved);
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

function serializeResolved(e: ResolvedEvent) {
  return {
    id: e.id,
    source_id: e.sourceId,
    person_id: e.personId,
    series_id: e.seriesId ?? null,
    title: e.title,
    start: e.start.toISOString(),
    end: e.end.toISOString(),
    all_day: e.allDay,
    resolved_role: e.resolvedRole,
    resolved_by: e.resolvedBy,
    resolved_reason: e.resolvedReason,
    ...(e.ruleId !== undefined ? { rule_id: e.ruleId } : {}),
    ...(e.attendanceEdgeId !== undefined ? { attendance_edge_id: e.attendanceEdgeId } : {}),
    ...(e.rsvpStatus !== undefined ? { rsvp_status: e.rsvpStatus } : {}),
  };
}
