import type { PlaybackSession, MediaType } from "@mediabox/contracts";
import { jfApi } from "../helpers/api.js";
import { JELLYFIN_URL } from "../config.js";
import { formatTicks } from "./utils.js";

export async function getSessions(): Promise<PlaybackSession[]> {
  const raw = await jfApi("/Sessions?ActiveWithinSeconds=60");
  if (!Array.isArray(raw)) return [];

  return raw
    .filter((s: any) => s.NowPlayingItem)
    .map((s: any): PlaybackSession => {
      const item = s.NowPlayingItem as any;
      const ps   = s.PlayState        as any;

      const totalTicks = (item.RunTimeTicks   as number) || 0;
      const posTicks   = (ps?.PositionTicks   as number) || 0;
      const progress   = totalTicks > 0
        ? Math.round((posTicks / totalTicks) * 100)
        : 0;

      const mediaType: MediaType =
        item.Type === "Movie" ? "movie"
        : item.Type === "Audio" ? "music"
        : "episode";

      // Public image endpoint — no API key needed on most Jellyfin installs
      const coverUrl = item.Id
        ? `${JELLYFIN_URL}/Items/${item.Id as string}/Images/Primary?quality=90`
        : undefined;

      const seriesName = item.SeriesName as string | undefined;
      const epNum = item.IndexNumber         as number | undefined;
      const seNum = item.ParentIndexNumber   as number | undefined;

      const mediaSubtitle = seriesName
        ? `S${String(seNum ?? 1).padStart(2, "0")}E${String(epNum ?? 1).padStart(2, "0")} — ${item.Name as string}`
        : (item.ProductionYear ? String(item.ProductionYear as number) : "");

      return {
        id:               s.Id             as string,
        userName:         s.UserName       as string,
        userId:           s.UserId         as string | undefined,
        deviceName:       s.DeviceName     as string | undefined,
        mediaTitle:       seriesName       ?? (item.Name as string),
        mediaSubtitle,
        mediaType,
        coverUrl,
        progress,
        currentTime:      formatTicks(posTicks),
        totalTime:        formatTicks(totalTicks),
        isPlaying:        !(ps?.IsPaused   as boolean),
        jellyfinSessionId: s.Id            as string,
      };
    });
}
