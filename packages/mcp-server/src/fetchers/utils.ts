export function formatBytes(bytes: number): string {
  if (bytes >= 1_099_511_627_776) return `${(bytes / 1_099_511_627_776).toFixed(1)} TB`;
  if (bytes >= 1_073_741_824)     return `${(bytes / 1_073_741_824).toFixed(1)} GB`;
  if (bytes >= 1_048_576)         return `${(bytes / 1_048_576).toFixed(1)} MB`;
  if (bytes >= 1024)              return `${Math.round(bytes / 1024)} KB`;
  // Below 1 KB the exact byte count, never "0 KB": the models read a size that looks
  // like zero as a wrong figure or as space a cleanup frees (STORAGE-05, experiments 5 and 6).
  return `${bytes} B`;
}

export function formatEta(seconds: number): string {
  if (!seconds || seconds < 0 || seconds > 8_640_000) return "—";
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${s}s`;
}

export function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const parts: string[] = [];
  if (d) parts.push(`${d}d`);
  if (h) parts.push(`${h}h`);
  parts.push(`${m}m`);
  return parts.join(" ");
}

export function formatTicks(ticks: number): string {
  const totalSec = Math.floor(ticks / 10_000_000);
  const h  = Math.floor(totalSec / 3600);
  const m  = Math.floor((totalSec % 3600) / 60);
  const s  = totalSec % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
    : `${m}:${String(s).padStart(2, "0")}`;
}

/** Drops any user:password embedded in a URL before it is shown to anyone (NET-05). */
export function stripUrlCredentials(url: string): string {
  try {
    const parsed = new URL(url);
    if (!parsed.username && !parsed.password) return url;
    parsed.username = "";
    parsed.password = "";
    return parsed.toString().replace(/\/$/, url.endsWith("/") ? "/" : "");
  } catch {
    return url.replace(/\/\/[^@/]*@/, "//");
  }
}

/** Replace Docker container hostname with localhost for browser-accessible URLs */
export function toHostUrl(containerUrl: string, hostPort?: string): string {
  const withLocal = stripUrlCredentials(containerUrl).replace(/\/\/[^:/]+/, "//localhost");
  if (hostPort) return withLocal.replace(/:\d+/, `:${hostPort}`);
  return withLocal;
}
