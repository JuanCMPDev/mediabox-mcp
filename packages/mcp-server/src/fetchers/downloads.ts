import type { Download, DownloadStatus } from "@mediabox/contracts";
import { qbitApi } from "../helpers/qbittorrent.js";
import { pyloadApi } from "../helpers/pyload.js";
import { formatBytes, formatEta } from "./utils.js";

function mapQbitState(state: string): DownloadStatus {
  switch (state) {
    case "downloading":
    case "stalledDL":
    case "checkingDL":
    case "allocating":
    case "metaDL":
    case "queuedDL":  return "downloading";
    case "uploading":
    case "stalledUP":
    case "forcedUP":
    case "checkingUP":
    case "queuedUP":  return "seeding";
    case "pausedDL":
    case "pausedUP":  return "paused";
    case "error":
    case "missingFiles": return "error";
    default:          return "downloading";
  }
}

export async function getDownloads(): Promise<Download[]> {
  const [qbitResult, pyloadResult] = await Promise.allSettled([
    qbitApi("torrents/info"),
    pyloadApi("statusDownloads"),
  ]);

  const items: Download[] = [];

  if (qbitResult.status === "fulfilled" && Array.isArray(qbitResult.value)) {
    for (const t of qbitResult.value as any[]) {
      items.push({
        id:          `qbit:${t.hash as string}`,
        name:         t.name        as string,
        progress:     Math.round((t.progress as number) * 100),
        size:         formatBytes(t.size       as number),
        speed:        (t.dlspeed as number) > 0 ? `${((t.dlspeed as number) / 1_048_576).toFixed(1)} MB/s` : "—",
        uploadSpeed:  (t.upspeed as number) > 0 ? `${((t.upspeed as number) / 1_048_576).toFixed(1)} MB/s` : undefined,
        eta:          formatEta(t.eta          as number),
        status:       mapQbitState(t.state     as string),
        category:     (t.category as string)   || undefined,
        source:       "qbittorrent",
      });
    }
  }

  if (pyloadResult.status === "fulfilled" && Array.isArray(pyloadResult.value)) {
    for (const d of pyloadResult.value as any[]) {
      const speedBps = (d.speed as number) ?? 0;
      items.push({
        id:       `pyload:${d.package_id as number}`,
        name:      d.name               as string ?? `Package ${d.package_id as number}`,
        progress: (d.percent            as number) ?? 0,
        size:      d.format_size        as string ?? "—",
        speed:     speedBps > 0 ? `${(speedBps / 1_048_576).toFixed(1)} MB/s` : "—",
        eta:       d.format_eta         as string ?? "—",
        status:   "downloading",
        source:   "pyload",
      });
    }
  }

  // Sort: active first, then seeding, then paused/error
  const rank: Record<DownloadStatus, number> = {
    downloading: 0, seeding: 1, paused: 2, completed: 3, error: 4,
  };
  return items.sort((a, b) => (rank[a.status] ?? 5) - (rank[b.status] ?? 5));
}
