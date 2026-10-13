/**
 * KLEO STUDIO — KLEO FILMS IN THE CHAT (14 October 2026). The chat and Kleo are one product: besides single clips and
 * pictures, the agent can order a complete Kleo film — the treatment, the storyboard, a narrator, Seedance footage,
 * music, subtitles, 4K 60 fps, 15 seconds to 5 minutes — the same film the MCP tool kleo_create_video makes.
 *
 * Studio does not copy the film pipeline: it asks the MCP Worker over the service binding `MCP`
 * (src/studio-film.ts there), which prices, debits and creates the job exactly as the MCP tool does. Studio keeps a
 * generation row of kind "film" whose task is the job id, and reads the job's progress and files from the shared
 * database. The MCP Worker refunds a failed film itself, so Studio never refunds one.
 */
import type { StudioEnv } from "./env.ts";
import { StudioError } from "./generate.ts";
import { getGeneration, insertGeneration, moveGeneration, markChecked, type GenerationRow } from "./store.ts";
import { rid } from "../util.ts";

export interface FilmSettings {
  duration: number; format: "16:9" | "9:16"; style: "realistic" | "animation"; product: "film" | "animatic";
  music: boolean; subtitles: boolean; language: "en" | "it";
}
export const FILM_LENGTHS = [15, 30, 45, 60, 90, 120, 180, 300];

export function normalizeFilm(raw: Record<string, unknown>): FilmSettings {
  const d = Number(raw.duration ?? raw.duration_s);
  const duration = FILM_LENGTHS.reduce((best, v) => (Math.abs(v - d) < Math.abs(best - d) ? v : best), 30);
  return {
    duration: Number.isFinite(d) ? duration : 30,
    format: raw.format === "9:16" ? "9:16" : "16:9",
    style: raw.style === "animation" ? "animation" : "realistic",
    product: raw.product === "animatic" ? "animatic" : "film",
    music: raw.music === false || raw.music === "no" ? false : true,
    subtitles: raw.subtitles === true || raw.subtitles === "yes",
    language: raw.language === "it" ? "it" : "en",
  };
}

async function mcp<T>(env: StudioEnv, path: string, body: unknown): Promise<{ status: number; data: T }> {
  if (!env.MCP) throw new StudioError("Films are not available right now.", 503, "no_films");
  const res = await env.MCP.fetch(`https://kleo-mcp${path}`, {
    method: "POST", headers: { authorization: `Bearer ${env.INTERNAL_SECRET}`, "content-type": "application/json" }, body: JSON.stringify(body),
  });
  return { status: res.status, data: (await res.json().catch(() => ({}))) as T };
}

export interface FilmQuote { film: { credits: number; allowed: boolean; min_s: number; max_s: number }; animatic: { credits: number; allowed: boolean; max_s: number }; has_paid: boolean; credits: number; credits_for_choice: number }
export async function quoteFilm(env: StudioEnv, userId: string, s: FilmSettings): Promise<FilmQuote> {
  const r = await mcp<FilmQuote>(env, "/internal/studio/film/quote", { userId, duration_s: s.duration, style: s.style, product: s.product });
  if (r.status !== 200) throw new StudioError("Films are not available right now.", 503, "no_films");
  return r.data;
}

export async function orderFilm(env: StudioEnv, userId: string, req: { prompt: string; settings: FilmSettings; chatId: string | null; messageId: string | null }): Promise<GenerationRow> {
  const s = req.settings;
  if (s.product === "animatic" && s.duration > 60) s.duration = 60;
  const r = await mcp<{ job?: { job_id: string; credits: number; eta_min: number | null }; error?: string; code?: string }>(env, "/internal/studio/film", {
    userId, prompt: req.prompt, duration_s: s.duration, format: s.format, style: s.style, product: s.product,
    music: s.music ? "yes" : "no", subtitles: s.subtitles, language: s.language,
  });
  if (r.status !== 200 || !r.data.job) throw new StudioError(r.data.error ?? "Kleo couldn't start this film.", r.status === 200 ? 500 : r.status, r.data.code ?? "refused");
  const job = r.data.job;
  const id = rid("g", 12);
  await insertGeneration(env, { id, userId, chatId: req.chatId, messageId: req.messageId, model: s.product === "animatic" ? "kleo-animatic" : "kleo-film", settings: s, prompt: req.prompt, images: [], credits: job.credits, estUsd: 0, kind: "film" });
  await moveGeneration(env, id, ["submitting"], "running", { task_id: job.job_id, usage: JSON.stringify({ percent: 0, track: null, eta_min: job.eta_min, state: "queued" }) });
  return (await getGeneration(env, id))!;
}

interface JobRow { state: string; percent: number | null; track: string | null; eta_min: number | null; error: string | null }
const TRACKS: Record<string, string> = { script: "Writing the script", voice: "Recording the narration", music: "Adding the music", clips: "Filming the scenes", film: "Finishing the film", edit: "Editing", finishing: "Finishing up" };

/** Mirrors the film job into the generation row (progress while it runs, the video when it is done). */
export async function refreshFilm(env: StudioEnv, g: GenerationRow): Promise<GenerationRow> {
  if (!g.task_id) return g;
  await markChecked(env, g.id);
  const job = await env.DB.prepare("SELECT state, percent, track, eta_min, error FROM jobs WHERE id = ?").bind(g.task_id).first<JobRow>();
  if (!job) return g;
  const progress = JSON.stringify({ percent: job.percent ?? 0, track: job.track, label: job.state === "queued" ? "Waiting for a studio slot" : TRACKS[job.track ?? ""] ?? "Working", eta_min: job.eta_min, state: job.state });
  if (job.state === "done") {
    const file = await env.DB.prepare("SELECT key, size FROM job_files WHERE job_id = ? AND name = 'video.mp4'").bind(g.task_id).first<{ key: string; size: number }>();
    if (!file) return g;
    // The MCP server deletes a film's files after a week; the copy under studio/ stays with the account.
    if (!(await moveGeneration(env, g.id, ["running"], "saving", { usage: progress }))) return (await getGeneration(env, g.id))!;
    const key = `studio/${g.user_id}/${g.id}.mp4`;
    try {
      const src = await env.RENDERS.get(file.key);
      if (!src) throw new Error("film file missing");
      await env.RENDERS.put(key, src.body, { httpMetadata: { contentType: "video/mp4" } });
      await moveGeneration(env, g.id, ["saving"], "done", { file_key: key, size: src.size });
    } catch {
      await moveGeneration(env, g.id, ["saving"], "running");
    }
  } else if (job.state === "failed" || job.state === "cancelled") {
    // The MCP Worker gave the credits back already (failJob / cancelJob): only the row changes here.
    await moveGeneration(env, g.id, ["running", "saving"], "failed", { error: job.state === "cancelled" ? "The film was cancelled. Your credits are back." : "Kleo couldn't finish this film. Your credits are back.", refunded: 1, usage: progress });
  } else {
    await env.DB.prepare("UPDATE studio_generations SET usage = ? WHERE id = ?").bind(progress, g.id).run();
  }
  return (await getGeneration(env, g.id))!;
}
