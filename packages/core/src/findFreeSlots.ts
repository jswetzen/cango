import { applyMasks } from "./applyMasks.js";
import { resolveRole } from "./resolveRole.js";
import type { FindFreeSlotsInput, FreeSlot } from "./types.js";

interface Interval {
  start: number;
  end: number;
}

export function findFreeSlots(input: FindFreeSlotsInput): FreeSlot[] {
  const { range, duration, people, events, family, rules, workingHours } = input;

  if (duration <= 0) {
    throw new Error("findFreeSlots: duration must be positive minutes");
  }
  if (!(range.end.getTime() > range.start.getTime())) {
    throw new Error("findFreeSlots: range.end must be after range.start");
  }

  const peopleIds = new Set(people.map((p) => p.id));
  const durationMs = duration * 60_000;
  const rangeStart = range.start.getTime();
  const rangeEnd = range.end.getTime();

  const candidateWindows: Interval[] = workingHours
    ? expandWorkingHours(rangeStart, rangeEnd, workingHours)
    : [{ start: rangeStart, end: rangeEnd }];

  // Resolve + mask the whole set first; only `hard` events for the requested
  // people block a slot (a masked-out work meeting no longer does).
  const resolvedAll = applyMasks(
    events.map((ev) => resolveRole(ev, family, rules)),
    rules,
  );

  const busy: Interval[] = [];
  for (const resolved of resolvedAll) {
    if (!peopleIds.has(resolved.personId)) continue;
    if (resolved.resolvedRole !== "hard") continue;
    const start = Math.max(resolved.start.getTime(), rangeStart);
    const end = Math.min(resolved.end.getTime(), rangeEnd);
    if (end <= start) continue;
    busy.push({ start, end });
  }
  const merged = mergeIntervals(busy);

  const slots: FreeSlot[] = [];
  for (const window of candidateWindows) {
    for (const gap of subtractIntervals(window, merged)) {
      if (gap.end - gap.start >= durationMs) {
        slots.push({ start: new Date(gap.start), end: new Date(gap.end) });
      }
    }
  }
  return slots;
}

function mergeIntervals(intervals: Interval[]): Interval[] {
  if (intervals.length === 0) return [];
  const sorted = [...intervals].sort((a, b) => a.start - b.start);
  const out: Interval[] = [{ start: sorted[0]!.start, end: sorted[0]!.end }];
  for (let i = 1; i < sorted.length; i++) {
    const cur = sorted[i]!;
    const last = out[out.length - 1]!;
    if (cur.start <= last.end) {
      last.end = Math.max(last.end, cur.end);
    } else {
      out.push({ start: cur.start, end: cur.end });
    }
  }
  return out;
}

function subtractIntervals(window: Interval, busy: Interval[]): Interval[] {
  const result: Interval[] = [];
  let cursor = window.start;
  for (const b of busy) {
    if (b.end <= cursor) continue;
    if (b.start >= window.end) break;
    if (b.start > cursor) result.push({ start: cursor, end: Math.min(b.start, window.end) });
    cursor = Math.max(cursor, b.end);
    if (cursor >= window.end) break;
  }
  if (cursor < window.end) result.push({ start: cursor, end: window.end });
  return result;
}

function expandWorkingHours(
  rangeStart: number,
  rangeEnd: number,
  hours: { start: string; end: string },
): Interval[] {
  const startMin = parseHHMM(hours.start);
  const endMin = parseHHMM(hours.end);
  if (endMin <= startMin) {
    throw new Error("findFreeSlots: workingHours.end must be after workingHours.start");
  }

  const out: Interval[] = [];
  const day = new Date(rangeStart);
  day.setUTCHours(0, 0, 0, 0);
  while (day.getTime() <= rangeEnd) {
    const dayStart = day.getTime();
    const winStart = dayStart + startMin * 60_000;
    const winEnd = dayStart + endMin * 60_000;
    const clippedStart = Math.max(winStart, rangeStart);
    const clippedEnd = Math.min(winEnd, rangeEnd);
    if (clippedEnd > clippedStart) {
      out.push({ start: clippedStart, end: clippedEnd });
    }
    day.setUTCDate(day.getUTCDate() + 1);
  }
  return out;
}

function parseHHMM(s: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s);
  if (!m) throw new Error(`findFreeSlots: invalid HH:MM "${s}"`);
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h < 0 || h > 24 || min < 0 || min > 59) {
    throw new Error(`findFreeSlots: out-of-range HH:MM "${s}"`);
  }
  return h * 60 + min;
}
