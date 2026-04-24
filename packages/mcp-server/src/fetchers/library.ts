import type { LibraryStats } from "@mediabox/contracts";
import { jfApi } from "../helpers/api.js";
import { execFileAsync } from "../helpers/files.js";
import { MEDIA_PATH } from "../config.js";

export async function getLibrary(): Promise<LibraryStats> {
  const folders = await jfApi("/Library/VirtualFolders").catch(() => [] as any[]);

  if (!Array.isArray(folders) || folders.length === 0) {
    return { movies: 0, shows: 0, episodes: 0, music: 0, totalSize: "—" };
  }

  const countResults = await Promise.allSettled(
    folders.map(async (f: any) => ({
      type:   f.CollectionType as string,
      counts: await jfApi(`/Items/Counts?ParentId=${f.ItemId as string}`),
    }))
  );

  let movies = 0, shows = 0, episodes = 0, music = 0;
  for (const r of countResults) {
    if (r.status !== "fulfilled") continue;
    const { type, counts } = r.value;
    if (type === "movies")  { movies   += (counts.MovieCount    as number) || 0; }
    if (type === "tvshows") { shows    += (counts.SeriesCount   as number) || 0;
                              episodes += (counts.EpisodeCount  as number) || 0; }
    if (type === "music")   { music    += (counts.SongCount     as number) || 0; }
  }

  let totalSize = "—";
  try {
    const { stdout } = await execFileAsync("df", ["-h", "--output=used", MEDIA_PATH]);
    const [, used] = stdout.trim().split("\n");
    if (used) totalSize = used.trim();
  } catch { /* df unavailable */ }

  return { movies, shows, episodes, music, totalSize };
}
