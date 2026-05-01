import { statfs } from "node:fs/promises";
import type { LibraryStats } from "@mediabox/contracts";
import { jfApi, jfCountByParent } from "../helpers/api.js";
import { MEDIA_PATH } from "../config.js";
import { formatBytes } from "./utils.js";

export async function getLibrary(): Promise<LibraryStats> {
  const folders = await jfApi("/Library/VirtualFolders").catch(() => [] as any[]);

  if (!Array.isArray(folders) || folders.length === 0) {
    return { movies: 0, shows: 0, episodes: 0, music: 0, totalSize: "—" };
  }

  const countResults = await Promise.allSettled(
    folders.map(async (f: any) => {
      const t = String(f.CollectionType || "").toLowerCase();
      const id = f.ItemId as string;
      if (t === "movies")  return { movies: await jfCountByParent(id, "Movie") };
      if (t === "tvshows") {
        const [shows, episodes] = await Promise.all([
          jfCountByParent(id, "Series"),
          jfCountByParent(id, "Episode"),
        ]);
        return { shows, episodes };
      }
      if (t === "music")   return { music: await jfCountByParent(id, "Audio") };
      return {};
    })
  );

  let movies = 0, shows = 0, episodes = 0, music = 0;
  for (const r of countResults) {
    if (r.status !== "fulfilled") continue;
    const v = r.value as { movies?: number; shows?: number; episodes?: number; music?: number };
    movies   += v.movies   ?? 0;
    shows    += v.shows    ?? 0;
    episodes += v.episodes ?? 0;
    music    += v.music    ?? 0;
  }

  let totalSize = "—";
  try {
    const s     = await statfs(MEDIA_PATH);
    const total = Number(s.blocks) * Number(s.bsize);
    const free  = Number(s.bfree)  * Number(s.bsize);
    if (total > 0) totalSize = formatBytes(total - free);
  } catch { /* MEDIA_PATH unavailable */ }

  return { movies, shows, episodes, music, totalSize };
}
