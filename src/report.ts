import type { Env } from "./env";
import { getFile } from "./storage";

/**
 * WHAT KLEO SAYS ABOUT ITS OWN VIDEOS (27 September 2026, worker/kleo_report.py).
 *
 * Every test film of 22-25 September surfaced its defect only when a person watched it: 39.4 s for a 30 s order, the
 * music 3 dB under the voice in the pauses, eleven one-second shots, a 59.94 master refused by a string comparison.
 * The worker now measures every video it makes, on the box that made it, and uploads report.json beside the
 * deliverables: the length against the order, the loudness, the pauses and what lies under them, the cuts and the
 * shortest shots, the longest frozen run, the subtitles, and a list of problems in words. The user never sees it
 * (resultLinks skips it); these two admin routes read it back.
 *
 *   GET /internal/admin/report?job_id=gt_…   one video's whole report
 *   GET /internal/admin/reports?limit=20    the latest videos that have one: the order, the length, the problems
 */
export const REPORT_FILE = "report.json";
export const REPORTS_MAX = 50;

export async function readReport(env: Env, jobId: string): Promise<Record<string, unknown> | null> {
  const f = await getFile(env, `renders/${jobId}/${REPORT_FILE}`, null);
  if (!f) return null;
  try {
    const parsed = await new Response(f.body as ReadableStream | ArrayBuffer).json();
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

interface ReportRow { job_id: string; created_at: string; state: string; template: string | null; params: string | null }

/** The latest `limit` videos with a report, newest first, each cut down to what tells a good film from a bad one. */
export async function recentReports(env: Env, limit: number): Promise<Record<string, unknown>[]> {
  const n = Math.min(REPORTS_MAX, Math.max(1, Math.floor(Number(limit)) || 20));
  const rows = (await env.DB.prepare(
    "SELECT f.job_id AS job_id, j.created_at AS created_at, j.state AS state, j.template AS template, j.params AS params " +
    "FROM job_files f JOIN jobs j ON j.id = f.job_id WHERE f.name = ? ORDER BY j.created_at DESC LIMIT ?",
  ).bind(REPORT_FILE, n).all<ReportRow>()).results;
  const out: Record<string, unknown>[] = [];
  for (const r of rows) {
    const rep = await readReport(env, r.job_id);
    let product: unknown = null;
    try { product = (JSON.parse(r.params ?? "{}") as { product?: unknown }).product ?? null; } catch { /* a row without params */ }
    const video = (rep?.video ?? {}) as { duration?: unknown };
    const audio = (rep?.audio ?? {}) as { longest_pause_s?: unknown; bed_db?: unknown };
    const cuts = (rep?.cuts ?? {}) as { count?: unknown; shortest_s?: unknown };
    out.push({
      job_id: r.job_id, created_at: r.created_at, state: r.state, template: r.template, product,
      ordered_s: rep?.ordered_s ?? null, duration_s: video.duration ?? null,
      longest_pause_s: audio.longest_pause_s ?? null, bed_db: audio.bed_db ?? null,
      cuts: cuts.count ?? null, shortest_shot_s: cuts.shortest_s ?? null,
      problems: Array.isArray(rep?.problems) ? rep!.problems : rep ? [] : ["report.json listed but unreadable"],
    });
  }
  return out;
}
