/**
 * KLEO INSTAGRAM PUBLISHER — THE SQL OF THE OWNER'S SIDE (scripts/ig-schedule.mjs).
 *
 * `wrangler d1 execute --command` takes no bound parameters, so every text goes in as a hex BLOB cast to TEXT: a
 * caption with quotes, emoji or new lines cannot break out of its value. Every write names the states it may start
 * from, so that it never races the Worker: a post being published cannot be cancelled or re-checked.
 */
import type { Post } from "./rules.ts";

const hex = (s: string): string => [...new TextEncoder().encode(s)].map((b) => b.toString(16).padStart(2, "0")).join("");
export const sqlText = (s: string | null): string => (s === null ? "NULL" : s === "" ? "''" : `CAST(X'${hex(s)}' AS TEXT)`);
export function sqlInt(n: number | null): string {
  if (n === null) return "NULL";
  if (!Number.isSafeInteger(n)) throw new Error(`${n} is not a whole number`);
  return String(n);
}

export function insertPostSql(p: Post, nowIso: string): string {
  const values = [
    sqlText(p.id), sqlText(p.video_url), sqlText(p.caption), sqlText(p.publish_at), sqlText(p.at_local), sqlText(p.cover_url),
    sqlInt(p.thumb_offset_ms), sqlText(p.trial), sqlInt(p.outside_window), "'new'", sqlText(nowIso), sqlText(nowIso),
  ];
  return `INSERT INTO ig_posts (id, video_url, caption, publish_at, at_local, cover_url, thumb_offset_ms, trial, outside_window, state, created_at, updated_at) VALUES (${values.join(", ")})`;
}

/** The owner's "sì" for one checked post: his words, and the hash of what he approved (approvalHash, src/ig/rules.ts). */
export function approveSql(id: string, hash: string, ownerWords: string, nowIso: string): string {
  return `UPDATE ig_posts SET approved_at = ${sqlText(nowIso)}, approved_hash = ${sqlText(hash)}, approved_note = ${sqlText(ownerWords)}, updated_at = ${sqlText(nowIso)} WHERE id = ${sqlText(id)} AND state = 'checked' AND approved_at IS NULL`;
}

export function cancelSql(id: string, nowIso: string): string {
  return `UPDATE ig_posts SET state = 'cancelled', updated_at = ${sqlText(nowIso)} WHERE id = ${sqlText(id)} AND state IN ('new', 'checked', 'invalid', 'container', 'ready')`;
}

/** Back to 'new' for the cloud check, e.g. once the token is in: only a post nobody approved yet. */
export function recheckSql(id: string, nowIso: string): string {
  return `UPDATE ig_posts SET state = 'new', check_json = NULL, checked_at = NULL, video_etag = NULL, error = NULL, updated_at = ${sqlText(nowIso)} WHERE id = ${sqlText(id)} AND approved_at IS NULL AND state IN ('invalid', 'checked')`;
}
