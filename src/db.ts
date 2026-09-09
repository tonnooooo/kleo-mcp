import type { Env } from "./env";

export interface User {
  id: string;
  email: string;
  display_name: string | null;
  credits: number;
  plan: string;
  invite_code: string | null;
  created_at: string;
  last_seen_at: string | null;
}

export type JobState = "queued" | "starting" | "rendering" | "finishing" | "done" | "failed" | "cancelled";
export const ACTIVE_STATES: JobState[] = ["starting", "rendering", "finishing"];
export const OPEN_STATES: JobState[] = ["queued", ...ACTIVE_STATES];

export interface Job {
  id: string;
  user_id: string;
  template: string;
  prompt: string;
  params: string;
  state: JobState;
  track: string | null;
  percent: number;
  eta_min: number | null;
  credits: number;
  backend: string | null;
  instance_id: string | null;
  instance_meta: string | null;
  worker_secret: string;
  attempts: number;
  error: string | null;
  notify_email: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  expires_at: string | null;
  purged_at: string | null;
  cost_usd: number | null;
}

export interface JobParams {
  duration_s: number;
  format: "16:9" | "9:16";
  language: string;
  voice: string | null;
}

export interface JobFile {
  job_id: string;
  name: string;
  key: string;
  size: number;
  content_type: string;
}

export interface Invite {
  code: string;
  credits: number;
  max_uses: number;
  uses: number;
  note: string | null;
}

const inList = (states: JobState[]) => states.map((s) => `'${s}'`).join(",");

export const getUser = (env: Env, id: string) => env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(id).first<User>();
export const getUserByEmail = (env: Env, email: string) =>
  env.DB.prepare("SELECT * FROM users WHERE email = ?").bind(email.toLowerCase()).first<User>();

export async function createUser(env: Env, u: { id: string; email: string; credits: number; inviteCode: string | null }): Promise<User> {
  await env.DB.prepare("INSERT INTO users (id, email, credits, invite_code) VALUES (?, ?, ?, ?)")
    .bind(u.id, u.email.toLowerCase(), u.credits, u.inviteCode).run();
  return (await getUser(env, u.id))!;
}
export const touchUser = (env: Env, id: string) =>
  env.DB.prepare("UPDATE users SET last_seen_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?").bind(id).run();

/** Atomic debit: succeeds only if the user has enough credits. */
export async function debitCredits(env: Env, userId: string, amount: number): Promise<boolean> {
  const r = await env.DB.prepare("UPDATE users SET credits = credits - ? WHERE id = ? AND credits >= ?").bind(amount, userId, amount).run();
  return (r.meta.changes ?? 0) === 1;
}
export const creditCredits = (env: Env, userId: string, amount: number) =>
  env.DB.prepare("UPDATE users SET credits = credits + ? WHERE id = ?").bind(amount, userId).run();

export const getInvite = (env: Env, code: string) => env.DB.prepare("SELECT * FROM invites WHERE code = ?").bind(code).first<Invite>();
export const useInvite = (env: Env, code: string) =>
  env.DB.prepare("UPDATE invites SET uses = uses + 1 WHERE code = ? AND uses < max_uses").bind(code).run();

export const getJob = (env: Env, id: string) => env.DB.prepare("SELECT * FROM jobs WHERE id = ?").bind(id).first<Job>();
export const getUserJob = (env: Env, userId: string, id: string) =>
  env.DB.prepare("SELECT * FROM jobs WHERE id = ? AND user_id = ?").bind(id, userId).first<Job>();

export async function countOpenForUser(env: Env, userId: string): Promise<number> {
  const r = await env.DB.prepare(`SELECT COUNT(*) AS n FROM jobs WHERE user_id = ? AND state IN (${inList(OPEN_STATES)})`).bind(userId).first<{ n: number }>();
  return r?.n ?? 0;
}
export async function countRunning(env: Env): Promise<number> {
  const r = await env.DB.prepare(`SELECT COUNT(*) AS n FROM jobs WHERE state IN (${inList(ACTIVE_STATES)})`).first<{ n: number }>();
  return r?.n ?? 0;
}
export async function queuedJobs(env: Env, limit: number): Promise<Job[]> {
  if (limit <= 0) return [];
  return (await env.DB.prepare("SELECT * FROM jobs WHERE state = 'queued' ORDER BY created_at LIMIT ?").bind(limit).all<Job>()).results;
}
export async function activeJobs(env: Env): Promise<Job[]> {
  return (await env.DB.prepare(`SELECT * FROM jobs WHERE state IN (${inList(ACTIVE_STATES)}) ORDER BY started_at`).all<Job>()).results;
}
export async function recentJobsForUser(env: Env, userId: string, limit = 10): Promise<Job[]> {
  return (await env.DB.prepare("SELECT * FROM jobs WHERE user_id = ? ORDER BY created_at DESC LIMIT ?").bind(userId, limit).all<Job>()).results;
}
export async function expiredJobs(env: Env, limit = 20): Promise<Job[]> {
  return (await env.DB.prepare(
    "SELECT * FROM jobs WHERE state = 'done' AND purged_at IS NULL AND expires_at < strftime('%Y-%m-%dT%H:%M:%fZ','now') LIMIT ?"
  ).bind(limit).all<Job>()).results;
}

export async function insertJob(env: Env, j: Job): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO jobs (id, user_id, template, prompt, params, state, percent, eta_min, credits, worker_secret, notify_email, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(j.id, j.user_id, j.template, j.prompt, j.params, j.state, j.percent, j.eta_min, j.credits, j.worker_secret, j.notify_email, j.created_at).run();
}

export async function updateJob(env: Env, id: string, fields: Partial<Job>): Promise<void> {
  const keys = Object.keys(fields) as (keyof Job)[];
  if (!keys.length) return;
  const sets = keys.map((k) => `${k} = ?`).join(", ");
  const values = keys.map((k) => fields[k] as unknown);
  await env.DB.prepare(`UPDATE jobs SET ${sets} WHERE id = ?`).bind(...values, id).run();
}

export const audit = (env: Env, userId: string | null, jobId: string | null, event: string, detail?: unknown) =>
  env.DB.prepare("INSERT INTO audit (user_id, job_id, event, detail) VALUES (?, ?, ?, ?)")
    .bind(userId, jobId, event, detail === undefined ? null : JSON.stringify(detail)).run();

export const setFile = (env: Env, f: JobFile) =>
  env.DB.prepare("INSERT OR REPLACE INTO job_files (job_id, name, key, size, content_type) VALUES (?, ?, ?, ?, ?)")
    .bind(f.job_id, f.name, f.key, f.size, f.content_type).run();
export async function listFiles(env: Env, jobId: string): Promise<JobFile[]> {
  return (await env.DB.prepare("SELECT * FROM job_files WHERE job_id = ?").bind(jobId).all<JobFile>()).results;
}
export const deleteFiles = (env: Env, jobId: string) => env.DB.prepare("DELETE FROM job_files WHERE job_id = ?").bind(jobId).run();
