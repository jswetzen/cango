import { createHash } from "node:crypto";

export function deriveSeriesId(
  sourceId: string,
  uid: string | undefined,
  title: string,
): string {
  if (uid && uid.length > 0) return uid;
  const normalizedTitle = title.trim().toLowerCase().replace(/\s+/g, " ");
  const h = createHash("sha1").update(`${sourceId}\u0000${normalizedTitle}`).digest("hex");
  return `hash:${h.slice(0, 16)}`;
}
