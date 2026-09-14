/**
 * show_details per-season summary (G10 READ-04, experiment 7,
 * pr05-g10-20260914T154155-5e160936). Asked which seasons of Los Guardianes del Puerto
 * were complete, qwen3.5:9b listed the episodes of each season and never said season 2
 * was incomplete. show_details now counts, per season and over the whole season, the
 * episodes with a file; missing episodes and completeness appear only when Jellyfin
 * itself lists episodes without a file. Whatever the model must see has to survive the
 * agent's result compaction.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const upstream = vi.hoisted(() => ({ jellyfin: vi.fn(), count: vi.fn() }));
vi.mock("../helpers/api.js", () => ({
  jfApi: upstream.jellyfin,
  jfCountByParent: upstream.count,
  // Pretty-printed like the real textResult; compaction parses it either way.
  textResult: (data: unknown) => ({ content: [{ type: "text", text: JSON.stringify(data, null, 2) }] }),
}));

import { isMissingEpisode, registerJellyfinTools, summarizeSeason } from "./jellyfin.js";
import { compactToolResult, estimateTokenCount, TOOL_RESULT_TOKEN_CAP } from "../../../chat-core/src/agent/budget.js";

type Item = Record<string, unknown>;
type Handler = (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>;

afterEach(() => vi.resetAllMocks());

/** Serves the three reads show_details makes, answered the way Jellyfin answers them. */
function serveJellyfin(series: Item, seasons: Item[], episodes: Item[]): void {
  upstream.jellyfin.mockImplementation(async (endpoint: string) => {
    const url = new URL(endpoint, "http://jellyfin.test");
    if (url.pathname === "/Items") {
      const found = url.searchParams.get("ids") === series.Id ? [series] : [];
      return { Items: found, TotalRecordCount: found.length, StartIndex: 0 };
    }
    if (url.pathname === `/Shows/${series.Id}/Seasons`) return { Items: seasons, TotalRecordCount: seasons.length, StartIndex: 0 };
    if (url.pathname === `/Shows/${series.Id}/Episodes`) {
      // Every episode of the season: show_details sends no Limit.
      const items = episodes.filter((e) => e.SeasonId === url.searchParams.get("SeasonId"));
      return { Items: items, TotalRecordCount: items.length, StartIndex: 0 };
    }
    throw new Error(`unexpected Jellyfin read ${endpoint}`);
  });
}

async function showDetails(args: Record<string, unknown>): Promise<{ text: string; payload: any }> {
  const tools = new Map<string, Handler>();
  registerJellyfinTools({ registerTool: (name: string, _config: unknown, handler: Handler) => tools.set(name, handler) } as any);
  const text = (await tools.get("show_details")!(args)).content[0].text;
  return { text, payload: JSON.parse(text) };
}

// READ-04 exactly as the synthetic Jellyfin of the G10 corpus answers it
// (evals/local-agent/synthetic/services.mjs with the corpus base seed; READ-04 has no
// seed patch). Season 2 lists only S02E01 and nothing says episodes are missing.
const GUARD = "Los Guardianes del Puerto";
const guardSeries: Item = { Id: "jf-series-guard", Name: GUARD, Type: "Series", ProductionYear: 2019, Status: "Continuing", ParentId: "lib-tv", IsFolder: true, LocationType: "FileSystem" };
const guardSeason = (n: number): Item => ({
  Id: `jf-season-guard-${n}`, Name: `Season ${n}`, Type: "Season", SeriesId: "jf-series-guard", IndexNumber: n,
  SeriesName: GUARD, ParentId: "jf-series-guard", IsFolder: true, LocationType: "FileSystem",
});
const guardEpisode = (season: number, n: number, name: string): Item => {
  const path = `/data/tv/${GUARD} (2019)/Season 0${season}/${GUARD} - S0${season}E0${n}.mkv`;
  return {
    Id: `jf-ep-guard-${season}0${n}`, Name: name, Type: "Episode", SeriesId: "jf-series-guard", SeasonId: `jf-season-guard-${season}`,
    IndexNumber: n, Path: path, SeriesName: GUARD, SeasonName: `Season ${season}`, ParentIndexNumber: season, ParentId: `jf-season-guard-${season}`,
    HasSubtitles: false, MediaType: "Video", IsFolder: false, LocationType: "FileSystem",
    MediaSources: [{ Id: `jf-ep-guard-${season}0${n}`, Path: path, Protocol: "File", Container: "mkv", Type: "Default" }],
  };
};
/** An episode a real Jellyfin lists without a file: virtual, with no path or media source. */
const virtualEpisode = (season: number, n: number, name: string): Item => {
  const episode = guardEpisode(season, n, name);
  delete episode.Path;
  delete episode.MediaSources;
  return { ...episode, LocationType: "Virtual" };
};

const READ04_SEASONS = [guardSeason(1), guardSeason(2)];
const READ04_EPISODES = [guardEpisode(1, 1, "La Bruma"), guardEpisode(1, 2, "El Muelle"), guardEpisode(1, 3, "La Farola"), guardEpisode(2, 1, "Mar de Fondo")];
const READ04_WITH_MISSING = [...READ04_EPISODES, virtualEpisode(2, 2, "Resaca"), virtualEpisode(2, 3, "Calma Chicha")];

// READ-11: one season of 80 episodes (evals/local-agent/runner.mjs longSeason).
const DELTA = "Crónicas del Delta (2018)";
const deltaSeries: Item = { Id: "jf-series-delta", Name: "Crónicas del Delta", Type: "Series", ProductionYear: 2018, LocationType: "FileSystem" };
const deltaSeason: Item = { Id: "jf-season-delta-1", Name: "Season 1", Type: "Season", SeriesId: "jf-series-delta", IndexNumber: 1, LocationType: "FileSystem" };
const deltaEpisodes = (count: number, virtualFrom = Infinity): Item[] => Array.from({ length: count }, (_, i) => {
  const n = String(i + 1).padStart(2, "0");
  const episode: Item = {
    Id: `jf-season-delta-1-e${n}`, Name: `Remanso ${n}`, Type: "Episode", SeriesId: "jf-series-delta", SeasonId: "jf-season-delta-1",
    IndexNumber: i + 1, ParentIndexNumber: 1, HasSubtitles: false, LocationType: "FileSystem",
    Path: `/data/tv/${DELTA}/Season 01/${DELTA} - S01E${n}.mkv`,
  };
  if (i + 1 < virtualFrom) return episode;
  delete episode.Path;
  return { ...episode, LocationType: "Virtual" };
});

describe("isMissingEpisode", () => {
  it("is true only for an episode Jellyfin lists without a file", () => {
    expect(isMissingEpisode({ LocationType: "Virtual" })).toBe(true);
    expect(isMissingEpisode({ LocationType: "FileSystem", IsMissing: true })).toBe(true);
    expect(isMissingEpisode({ LocationType: "FileSystem", Path: "/data/tv/a.mkv" })).toBe(false);
    expect(isMissingEpisode({})).toBe(false);
    expect(isMissingEpisode(undefined)).toBe(false);
  });
});

describe("summarizeSeason", () => {
  it("never states completeness or an expected count the source did not give", () => {
    expect(summarizeSeason({ IndexNumber: 2, Name: "Season 2" }, [guardEpisode(2, 1, "Mar de Fondo")]))
      .toEqual({ season: 2, name: "Season 2", episodesWithFile: 1 });
    expect(summarizeSeason({ IndexNumber: 2, Name: "Season 2" }, [])).toEqual({ season: 2, name: "Season 2", episodesWithFile: 0 });
  });

  it("counts the episodes Jellyfin lists without a file as missing and the season as incomplete", () => {
    expect(summarizeSeason({ IndexNumber: 2, Name: "Season 2" }, READ04_WITH_MISSING.filter((e) => e.SeasonId === "jf-season-guard-2")))
      .toEqual({ season: 2, name: "Season 2", episodesWithFile: 1, missingEpisodes: 2, complete: false });
  });
});

describe("show_details season summary", () => {
  it("READ-04 on the synthetic source: episodes with a file per season, and no completeness claim", async () => {
    serveJellyfin(guardSeries, READ04_SEASONS, READ04_EPISODES);
    const { payload } = await showDetails({ showId: "jf-series-guard", page: 1, pageSize: 50 });

    // What the model gets for READ-04 in the G10 corpus: 3 and 1 episodes with a file.
    // The synthetic Jellyfin lists no episode without a file, so nothing says season 2
    // is incomplete; only the synthetic Sonarr knows about S02E02 and S02E03.
    expect(payload.seasonSummary).toEqual([
      { season: 1, name: "Season 1", episodesWithFile: 3 },
      { season: 2, name: "Season 2", episodesWithFile: 1 },
    ]);
    for (const season of payload.seasonSummary) {
      expect(season).not.toHaveProperty("missingEpisodes");
      expect(season).not.toHaveProperty("complete");
    }

    // The episode list and pagination keep their shape (READ-19 and READ-20 read them).
    expect(payload.totalSeasons).toBe(2);
    expect(payload.seasons.map((s: any) => [s.number, s.name, s.episodes.map((e: any) => e.name)])).toEqual([
      [1, "Season 1", ["La Bruma", "El Muelle", "La Farola"]],
      [2, "Season 2", ["Mar de Fondo"]],
    ]);
    expect(payload.seasons[0].episodes[0]).toEqual({
      id: "jf-ep-guard-101", number: 1, name: "La Bruma", hasSubtitles: false,
      path: "/data/tv/Los Guardianes del Puerto (2019)/Season 01/Los Guardianes del Puerto - S01E01.mkv",
    });
    expect(payload.pagination).toEqual({ page: 1, pageSize: 50, totalPages: 1, totalItems: 4 });
  });

  it("reports missing episodes and an incomplete season only where Jellyfin lists episodes without a file", async () => {
    serveJellyfin(guardSeries, READ04_SEASONS, READ04_WITH_MISSING);
    const { payload } = await showDetails({ showId: "jf-series-guard", page: 1, pageSize: 50 });

    expect(payload.seasonSummary).toEqual([
      { season: 1, name: "Season 1", episodesWithFile: 3 },
      { season: 2, name: "Season 2", episodesWithFile: 1, missingEpisodes: 2, complete: false },
    ]);
    // Jellyfin listing no missing episode in season 1 is not a statement that it is complete.
    expect(payload.seasonSummary[0]).not.toHaveProperty("complete");
    // The listed episodes it has no file for say so, and have no path.
    expect(payload.seasons[1].episodes).toEqual([
      expect.objectContaining({ name: "Mar de Fondo", path: expect.stringContaining("S02E01") }),
      { id: "jf-ep-guard-202", number: 2, name: "Resaca", hasSubtitles: false, missing: true },
      { id: "jf-ep-guard-203", number: 3, name: "Calma Chicha", hasSubtitles: false, missing: true },
    ]);
    expect(payload.seasons[1].episodes[0]).not.toHaveProperty("missing");
  });

  it("counts the whole season, not the returned page (READ-11 pages 80 episodes)", async () => {
    serveJellyfin(deltaSeries, [deltaSeason], deltaEpisodes(80));
    const { payload } = await showDetails({ showId: "jf-series-delta", page: 2, pageSize: 50 });

    expect(payload.seasonSummary).toEqual([{ season: 1, name: "Season 1", episodesWithFile: 80 }]);
    expect(payload.pagination).toEqual({ page: 2, pageSize: 50, totalPages: 2, totalItems: 80 });
    const episodes = payload.seasons[0].episodes;
    expect(episodes).toHaveLength(30);
    expect(episodes[0]).toMatchObject({ number: 51, name: "Remanso 51" });
    expect(episodes.find((e: any) => e.number === 57)).toMatchObject({ name: "Remanso 57" });
  });

  it("counts missing episodes the page does not list", async () => {
    // Episodes 78-80 are listed without a file; page 1 of 50 shows none of them.
    serveJellyfin(deltaSeries, [deltaSeason], deltaEpisodes(80, 78));
    const { payload } = await showDetails({ showId: "jf-series-delta", page: 1, pageSize: 50 });

    expect(payload.seasonSummary).toEqual([{ season: 1, name: "Season 1", episodesWithFile: 77, missingEpisodes: 3, complete: false }]);
    expect(payload.seasons[0].episodes).toHaveLength(50);
    expect(payload.seasons[0].episodes.some((e: any) => e.missing)).toBe(false);
  });

  it("seasonNumber narrows the summary to that season", async () => {
    serveJellyfin(guardSeries, READ04_SEASONS, READ04_EPISODES);
    const { payload } = await showDetails({ showId: "jf-series-guard", seasonNumber: 2, page: 1, pageSize: 50 });
    expect(payload.seasonSummary).toEqual([{ season: 2, name: "Season 2", episodesWithFile: 1 }]);
    expect(payload.totalSeasons).toBe(2);
    await expect(showDetails({ showId: "jf-series-guard", seasonNumber: 3, page: 1, pageSize: 50 })).rejects.toThrow("Season 3 not found");
  });
});

describe("show_details season summary through compaction", () => {
  it("READ-04: the summary and the episode names reach the model", async () => {
    serveJellyfin(guardSeries, READ04_SEASONS, READ04_EPISODES);
    const { text, payload } = await showDetails({ showId: "jf-series-guard", page: 1, pageSize: 50 });
    const compactedText = compactToolResult("media_query", text);
    expect(estimateTokenCount(compactedText)).toBeLessThanOrEqual(TOOL_RESULT_TOKEN_CAP);

    const compacted = JSON.parse(compactedText);
    expect(compacted.seasonSummary).toEqual(payload.seasonSummary);
    expect(compacted.seasons[1].episodes).toEqual([expect.objectContaining({ name: "Mar de Fondo" })]);
    expect(compacted.pagination).toEqual(payload.pagination);
  });

  it("a season Jellyfin reports as incomplete stays incomplete after compaction", async () => {
    serveJellyfin(guardSeries, READ04_SEASONS, READ04_WITH_MISSING);
    const { text } = await showDetails({ showId: "jf-series-guard", page: 1, pageSize: 50 });
    const compacted = JSON.parse(compactToolResult("media_query", text));
    expect(compacted.seasonSummary[1]).toEqual({ season: 2, name: "Season 2", episodesWithFile: 1, missingEpisodes: 2, complete: false });
  });

  it("READ-11 page 2: the whole-season count survives next to the cut episode list", async () => {
    serveJellyfin(deltaSeries, [deltaSeason], deltaEpisodes(80));
    const { text } = await showDetails({ showId: "jf-series-delta", page: 2, pageSize: 50 });
    const compactedText = compactToolResult("media_query", text);
    expect(estimateTokenCount(compactedText)).toBeLessThanOrEqual(TOOL_RESULT_TOKEN_CAP);

    const compacted = JSON.parse(compactedText);
    expect(compacted.seasonSummary).toEqual([{ season: 1, name: "Season 1", episodesWithFile: 80 }]);
    expect(compacted.seasons[0].episodes.at(-1)).toMatch(/^\[\+\d+ more\]$/);
    expect(compacted.pagination).toMatchObject({ page: 2, totalItems: 80 });
  });

  it("a series with more seasons than compaction keeps says how many seasons were left out", async () => {
    const seasons = Array.from({ length: 8 }, (_, i) => ({ ...guardSeason(i + 1) }));
    const episodes = seasons.flatMap((_, i) => [guardEpisode(i + 1, 1, `Uno ${i + 1}`), guardEpisode(i + 1, 2, `Dos ${i + 1}`)]);
    serveJellyfin(guardSeries, seasons, episodes);
    const { text, payload } = await showDetails({ showId: "jf-series-guard", page: 1, pageSize: 50 });
    expect(payload.seasonSummary).toHaveLength(8);

    const compactedText = compactToolResult("media_query", text);
    expect(estimateTokenCount(compactedText)).toBeLessThanOrEqual(TOOL_RESULT_TOKEN_CAP);
    const kept = JSON.parse(compactedText).seasonSummary as unknown[];
    const shown = kept.length - 1;
    expect(kept.slice(0, shown)).toEqual(payload.seasonSummary.slice(0, shown));
    expect(kept.at(-1)).toBe(`[+${8 - shown} more]`);
  });
});
