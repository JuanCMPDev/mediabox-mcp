import os from "node:os";
import { statfs } from "node:fs/promises";
import type { ServerHealth, HealthMetric, HealthStatus } from "@mediabox/contracts";
import { jfApi } from "../helpers/api.js";
import { MEDIA_PATH } from "../config.js";
import { formatUptime } from "./utils.js";

function statusFor(pct: number): HealthStatus {
  if (pct >= 90) return "critical";
  if (pct >= 75) return "warning";
  return "ok";
}

function metric(label: string, value: number, unit: string): HealthMetric {
  return { label, value, unit, status: statusFor(value) };
}

function cpuSnapshot(): { idle: number; total: number } {
  let idle = 0, total = 0;
  for (const c of os.cpus()) {
    for (const t of Object.values(c.times)) total += t;
    idle += c.times.idle;
  }
  return { idle, total };
}

// Why: os.loadavg() returns [0,0,0] on Windows, so the previous load-based
// reading made CPU show 0% under the Tauri sidecar. Sampling os.cpus() times
// and computing a delta works on every platform Node supports.
let prevCpu = cpuSnapshot();

function cpuPercent(): number {
  const cur    = cpuSnapshot();
  const idleD  = cur.idle  - prevCpu.idle;
  const totalD = cur.total - prevCpu.total;
  prevCpu = cur;
  if (totalD <= 0) return 0;
  return Math.min(100, Math.max(0, Math.round((1 - idleD / totalD) * 100)));
}

async function diskMetric(): Promise<HealthMetric> {
  try {
    const s     = await statfs(MEDIA_PATH);
    const total = Number(s.blocks) * Number(s.bsize);
    const free  = Number(s.bfree)  * Number(s.bsize);
    const pct   = total > 0 ? Math.round(((total - free) / total) * 100) : 0;
    return metric("Disk", pct, "%");
  } catch {
    return { label: "Disk", value: 0, unit: "%", status: "ok" };
  }
}

export async function getHealth(): Promise<ServerHealth> {
  const totalMem = os.totalmem();
  const freeMem  = os.freemem();
  const ramPct   = Math.round(((totalMem - freeMem) / totalMem) * 100);

  const [sysInfo, disk] = await Promise.all([
    jfApi("/System/Info").catch(() => null),
    diskMetric(),
  ]);

  return {
    cpu:        metric("CPU",  cpuPercent(), "%"),
    ram:        metric("RAM",  ramPct,       "%"),
    disk,
    uptime:     formatUptime(Math.floor(os.uptime())),
    serverName: sysInfo?.ServerName ?? "Mediabox",
    version:    sysInfo?.Version    ?? "—",
    online:     !!sysInfo,
  };
}
