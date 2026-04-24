import crypto from "crypto";

export interface Job { id: string; type: string; status: "running" | "completed" | "failed"; message: string; startedAt: number; result?: unknown }

export const jobs = new Map<string, Job>();

setInterval(() => { const cutoff = Date.now() - 7200_000; jobs.forEach((v, k) => { if (v.startedAt < cutoff) jobs.delete(k); }); }, 1800_000);

export function startJob(type: string, fn: (job: Job) => Promise<void>): Job {
  const job: Job = { id: crypto.randomUUID().slice(0, 8), type, status: "running", message: "Starting...", startedAt: Date.now() };
  jobs.set(job.id, job);
  fn(job).then(() => { if (job.status === "running") job.status = "completed"; }).catch(e => { job.status = "failed"; job.message = e.message; });
  return job;
}

export function estimateTime(sizeBytes: number, operation: "move" | "ffmpeg" | "extract"): string {
  const sizeMB = sizeBytes / 1048576;
  const rates: Record<string, number> = { move: 200, ffmpeg: 50, extract: 100 };
  const seconds = Math.ceil(sizeMB / (rates[operation] || 100));
  if (seconds < 60) return `~${seconds}s`;
  return `~${Math.ceil(seconds / 60)}min`;
}
