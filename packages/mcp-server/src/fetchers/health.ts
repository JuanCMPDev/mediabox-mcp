import os from "node:os";
import type { ServerHealth, HealthMetric, HealthStatus } from "@mediabox/contracts";
import { jfApi } from "../helpers/api.js";
import { execFileAsync } from "../helpers/files.js";
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

/** 1-minute load average expressed as percentage of available CPU cores.
 *  Reflects host system (Docker shares the host kernel's scheduler). */
function cpuPercent(): number {
  const load  = os.loadavg()[0];
  const cores = os.cpus().length;
  return Math.min(100, Math.round((load / cores) * 100));
}

async function diskMetric(): Promise<HealthMetric> {
  try {
    const { stdout } = await execFileAsync("df", ["--output=used,size", "-k", MEDIA_PATH]);
    const [, nums] = stdout.trim().split("\n");
    const [used, total] = (nums ?? "0 1").trim().split(/\s+/).map(Number);
    const pct = total > 0 ? Math.round((used / total) * 100) : 0;
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
