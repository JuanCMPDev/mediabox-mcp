import { Bot, Context } from "grammy";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import OpenAI from "openai";
import { GoogleGenAI, Type } from "@google/genai";
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions.js";

// =============================================================================
// CONFIG
// =============================================================================
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY || "";
const GOOGLE_AI_KEY = process.env.GOOGLE_AI_API_KEY || "";
const MCP_URL = process.env.MCP_SERVER_URL || "http://mcp-server:3000/sse";
const MCP_API_KEY = process.env.MCP_INTERNAL_API_KEY || "";
const MODEL = process.env.LLM_MODEL || "openai/gpt-4o-mini";
const PROVIDER =
  process.env.LLM_PROVIDER || (GOOGLE_AI_KEY ? "google" : "openrouter");
const ALLOWED_USERS = (process.env.ALLOWED_TELEGRAM_USERS || "")
  .split(",")
  .map(Number)
  .filter(Boolean);

const TOOL_TIMEOUT_MS = 60_000;
const MAX_HISTORY_TOKENS = 200_000; // Conservative for Gemini Flash 1M
const CONVERSATION_TTL = 7_200_000; // 2 hours

const SYSTEM_PROMPT = `You are a multimedia server assistant managing Jellyfin, Sonarr, Radarr, qBittorrent, and PyLoad. Respond in Spanish, concisely.

## Core principles

1. **Verify every mutation.** Action outputs report intent, not reality. After any write operation (move, delete, add, optimize, rename), confirm with a read tool (media_query, library_ops list, series status, movies status) before telling the user it worked. If verification fails, report the error — never say "listo" unverified.

2. **Confirm before destructive actions.** Show what will be affected and wait for user approval before deleting, replacing, or optimizing files.

3. **Never fabricate IDs.** Always obtain IDs from a prior search. If you don't have the ID, search first.

4. **Execute fully, then report.** Run all necessary tool calls, verify results, then give the user a single final answer. Don't say "voy a hacer X" — do it.

5. **Errors.** Retry once at most. Then report clearly.

## Service mapping

- Sonarr manages series/anime only → use the "series" tool
- Radarr manages movies only → use the "movies" tool
- qBittorrent is the torrent client → use downloads(action:"list_queue", source:"qbittorrent")
- PyLoad handles file hosters (Mega, MediaFire) → use downloads(action:"add") and downloads(action:"status")
- Jellyfin is the media server/library → use media_query and library_ops

If the user names a service directly, map to the correct tool. If they confuse services (e.g. "series in Radarr"), interpret by content type and clarify politely.

## Language scoring for releases

When choosing releases, use this priority (higher = better):

| Release type | Score |
|---|---|
| Latino/Spanish + Multi | +300 |
| Latino/Spanish only | +200 |
| Multi/Dual generic | +100 |
| English only | 0 |

Score >= 200 triggers immediate grab (bypasses the 15-min delay). Always prefer the highest-scoring release that meets quality and size requirements. Tiebreaker order: language score > quality > smallest size > most seeders.

## Download flows

### Adding and downloading series
- **Search only:** series(action:"search", query) — returns results with TVDB IDs.
- **Register without downloading:** series(action:"add", addTvdbId, monitor:"none") — adds to Sonarr but downloads nothing. Required before fetching individual episode releases.
- **Single episode:** register with monitor:"none" -> media_query(action:"details") to get episodeId -> series(action:"releases", episodeId) -> series(action:"grab", guid, indexerId).
- **Full season:** series(action:"add", addTvdbId, seasons:[N], monitor:"missing").
- **Full series:** series(action:"add", addTvdbId, monitor:"all").
- **Replace episode:** library_ops(action:"delete") -> series(action:"releases", episodeId) -> series(action:"grab").

### Adding and downloading movies
Same pattern via movies tool (uses addTmdbId).

### PyLoad (file hosters)
- downloads(action:"add", urls) to enqueue.
- downloads(action:"organize", showName, seasonNumber, libraryFolder) to move completed downloads into the library.

## Deletion

library_ops with action:"delete" and a jellyfinItemId performs **cross-layer deletion**: removes from Jellyfin + Sonarr/Radarr + disk in one call. Prefer this over partial deletions.

## Async operations

Moves >2 GB and batch operations >3 files run in background and return a jobId with an estimated time. When this happens, tell the user the estimate and that they can check progress with maintenance(action:"check_jobs").

## Maintenance

- **optimize(action:"analyze"):** Always analyze first and show the user what tracks would be removed and estimated space savings. Only optimize after confirmation.
- **optimize(action:"fix_subs"):** Converts ASS/SSA to SRT to prevent transcoding. Run with dryRun:true first.
- **maintenance(action:"cleanup"):** Run with dryRun:true first, show report, then apply with dryRun:false after confirmation.
- **downloads(action:"purge"):** Keeps best-scored release, removes duplicates.
- **downloads(action:"clean_orphans"):** Removes qBittorrent torrents not tracked by Sonarr/Radarr.

## Queue monitoring

After starting a download, verify it entered the queue with series(action:"status", view:"queue") or movies(action:"status", view:"queue").

## Response format

Keep answers short and direct. Use simple lists for options. Avoid complex markdown formatting.`;

// =============================================================================
// VIRTUAL TOOL DEFINITIONS — 8 tools presented to the LLM
// =============================================================================
interface VirtualToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

const VIRTUAL_TOOLS: Record<string, VirtualToolDef> = {
  server_info: {
    name: "server_info",
    description:
      "Server status and activity log. action:'status' for full overview (disk, libraries, sessions, users). action:'activity' for recent playback history.",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["status", "activity"],
          description: "status=full overview, activity=who watched what",
        },
        limit: {
          type: "number",
          description: "Entries for activity log (default 15)",
        },
      },
      required: ["action"],
    },
  },

  media_query: {
    name: "media_query",
    description:
      "Search or list Jellyfin content, or get details of a specific item. action:'search' to find/list media (omit query to list all). action:'details' for seasons/episodes of a series.",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["search", "details"] },
        query: { type: "string", description: "Search term (omit to list all)" },
        type: {
          type: "string",
          enum: ["Movie", "Series", "Episode", "Audio"],
        },
        showId: {
          type: "string",
          description: "Jellyfin item ID (for details)",
        },
        limit: { type: "number" },
      },
      required: ["action"],
    },
  },

  library_ops: {
    name: "library_ops",
    description:
      "Manage files and libraries. scan=refresh Jellyfin. create=new library. move=move files/folders. delete=cross-layer delete (Jellyfin+Sonarr/Radarr+disk). list=browse files. rename=standardize episode names. refresh=refresh metadata.",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["scan", "create", "move", "delete", "list", "rename", "refresh"],
        },
        path: {
          type: "string",
          description: "File path. 'downloads/' prefix for download folder",
        },
        sourcePaths: {
          type: "array",
          items: { type: "string" },
          description: "Paths to move",
        },
        destFolder: { type: "string", description: "Move destination" },
        jellyfinItemId: { type: "string", description: "Item to delete" },
        name: { type: "string", description: "Library name (create)" },
        libraryType: {
          type: "string",
          enum: ["movies", "tvshows", "music", "mixed"],
        },
        folder: { type: "string", description: "Library folder (create)" },
        showPath: { type: "string" },
        showName: { type: "string" },
        seasonNumber: { type: "number" },
        dryRun: { type: "boolean" },
        itemId: { type: "string", description: "For metadata refresh" },
      },
      required: ["action"],
    },
  },

  series: {
    name: "series",
    description:
      "Manage TV series via Sonarr. search=find by name. add=add to monitoring (needs addTvdbId from search). status=view series/calendar/missing/queue/history. remove=delete from Sonarr. releases=find available torrents. grab=download specific release.",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["search", "add", "status", "remove", "releases", "grab"],
        },
        query: { type: "string" },
        addTvdbId: { type: "number" },
        rootFolder: { type: "string", enum: ["/tv", "/anime"] },
        monitor: {
          type: "string",
          enum: ["all", "future", "missing", "none", "firstSeason", "lastSeason"],
        },
        seasons: { type: "array", items: { type: "number" } },
        quality: {
          type: "string",
          enum: ["Any", "SD", "HD-720p", "HD-1080p", "Ultra-HD", "HD - 720p/1080p"],
        },
        view: {
          type: "string",
          enum: ["series", "calendar", "missing", "queue", "history"],
        },
        seriesId: { type: "number" },
        seasonNumber: { type: "number" },
        episodeId: { type: "number" },
        guid: { type: "string" },
        indexerId: { type: "number" },
        deleteFiles: { type: "boolean" },
        limit: { type: "number" },
      },
      required: ["action"],
    },
  },

  movies: {
    name: "movies",
    description:
      "Manage movies via Radarr. search=find by name. add=add to monitoring (needs addTmdbId from search). status=view movies/queue/history. remove=delete from Radarr. releases=find available torrents. grab=download specific release.",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["search", "add", "status", "remove", "releases", "grab"],
        },
        query: { type: "string" },
        addTmdbId: { type: "number" },
        quality: {
          type: "string",
          enum: ["Any", "SD", "HD-720p", "HD-1080p", "Ultra-HD", "HD - 720p/1080p"],
        },
        searchNow: { type: "boolean" },
        view: { type: "string", enum: ["movies", "queue", "history"] },
        movieId: { type: "number" },
        guid: { type: "string" },
        indexerId: { type: "number" },
        deleteFiles: { type: "boolean" },
        limit: { type: "number" },
      },
      required: ["action"],
    },
  },

  downloads: {
    name: "downloads",
    description:
      "Manage downloads: PyLoad file hosters and qBittorrent/Sonarr/Radarr queues. add=send URLs to PyLoad. status=check PyLoad progress. organize=move completed to library. cancel=cancel specific downloads. purge=remove duplicates. clean_orphans=remove orphan qBit torrents. list_queue=show download queue.",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["add", "status", "organize", "cancel", "purge", "clean_orphans", "list_queue"],
        },
        urls: { type: "array", items: { type: "string" } },
        packageName: { type: "string" },
        source: {
          type: "string",
          enum: ["sonarr", "radarr", "qbittorrent"],
        },
        showName: { type: "string" },
        seasonNumber: { type: "number" },
        episodeNumber: { type: "number" },
        libraryFolder: {
          type: "string",
          enum: ["tv", "movies", "music", "anime"],
        },
        archivePassword: { type: "string" },
        packageFolder: { type: "string" },
        queueIds: { type: "array", items: { type: "number" } },
        torrentHashes: { type: "array", items: { type: "string" } },
        seriesId: { type: "number" },
        movieId: { type: "number" },
      },
      required: ["action"],
    },
  },

  optimize: {
    name: "optimize",
    description:
      "Optimize media files. analyze=show audio/subtitle tracks. optimize=remove unwanted tracks (specify keepAudioLangs). fix_subs=convert ASS/SSA subtitles to SRT to prevent transcoding.",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["analyze", "optimize", "fix_subs"] },
        mediaPath: {
          type: "string",
          description: "Path relative to media volume",
        },
        keepAudioLangs: {
          type: "array",
          items: { type: "string" },
          description: "Audio languages to keep (e.g. ['spa','eng'])",
        },
        keepSubLangs: { type: "array", items: { type: "string" } },
        removeAllSubs: { type: "boolean" },
        dryRun: { type: "boolean" },
      },
      required: ["action", "mediaPath"],
    },
  },

  maintenance: {
    name: "maintenance",
    description:
      "Server maintenance. cleanup=clean temp files, orphan downloads, ghost entries. check_jobs=monitor background operations by jobId.",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["cleanup", "check_jobs"] },
        dryRun: { type: "boolean" },
        jobId: { type: "string" },
      },
      required: ["action"],
    },
  },
};

// =============================================================================
// KEYWORD ROUTING — Select relevant virtual tools per message
// =============================================================================
const TOOL_GROUPS: Record<string, string[]> = {
  series: ["series"],
  movies: ["movies"],
  files: ["library_ops", "media_query"],
  maintenance: ["optimize", "maintenance"],
  downloads: ["downloads"],
  status: ["server_info", "media_query"],
};

const KEYWORD_MAP: Record<string, string[]> = {
  // Content types
  serie: ["series", "files"],
  series: ["series", "files"],
  anime: ["series", "files"],
  temporada: ["series", "files"],
  season: ["series", "files"],
  episodio: ["series", "files"],
  episode: ["series", "files"],
  capitulo: ["series", "files"],
  pelicula: ["movies", "files"],
  peliculas: ["movies", "files"],
  movie: ["movies", "files"],
  movies: ["movies", "files"],
  film: ["movies", "files"],

  // Service names
  sonarr: ["series", "downloads"],
  radarr: ["movies", "downloads"],
  qbittorrent: ["downloads"],
  qbit: ["downloads"],
  jellyfin: ["status", "files"],
  pyload: ["downloads"],

  // Download actions
  descargar: ["series", "movies", "downloads"],
  descarga: ["downloads", "series", "movies"],
  descargas: ["downloads", "series", "movies"],
  download: ["downloads", "series", "movies"],
  bajar: ["series", "movies", "downloads"],

  // Delete actions
  borrar: ["files", "series", "movies"],
  eliminar: ["files", "series", "movies"],
  quitar: ["files", "series", "movies"],
  delete: ["files", "series", "movies"],

  // File actions
  mover: ["files"],
  move: ["files"],
  renombrar: ["files"],
  rename: ["files"],
  archivo: ["files"],
  archivos: ["files"],

  // Maintenance
  optimizar: ["maintenance"],
  optimize: ["maintenance"],
  espacio: ["maintenance", "status"],
  limpiar: ["maintenance"],
  limpieza: ["maintenance"],
  cleanup: ["maintenance"],
  subtitulo: ["maintenance"],
  subtitulos: ["maintenance"],
  subtitle: ["maintenance"],
  srt: ["maintenance"],
  ass: ["maintenance"],
  tracks: ["maintenance"],
  audio: ["maintenance"],

  // Status
  estado: ["status", "downloads"],
  status: ["status", "downloads"],
  servidor: ["status", "maintenance"],
  server: ["status", "maintenance"],
  disco: ["status"],
  disk: ["status"],
  usuarios: ["status"],

  // Queue
  cola: ["downloads", "series", "movies"],
  queue: ["downloads", "series", "movies"],
  torrent: ["downloads"],
  torrents: ["downloads"],
  mega: ["downloads"],
  mediafire: ["downloads"],

  // Browse / list
  listar: ["files", "status"],
  lista: ["files", "status"],
  buscar: ["series", "movies", "files"],
  search: ["series", "movies", "files"],
  tengo: ["status", "files"],
  hay: ["status", "files"],
  contenido: ["status", "files"],
  biblioteca: ["status", "files"],
  library: ["status", "files"],

  // Jobs
  job: ["maintenance"],
  jobs: ["maintenance"],
  progreso: ["maintenance", "downloads"],
  progress: ["maintenance", "downloads"],
};

function selectTools(userMessage: string): VirtualToolDef[] {
  const msg = userMessage.toLowerCase();
  const groups = new Set<string>();

  for (const [keyword, groupNames] of Object.entries(KEYWORD_MAP)) {
    if (msg.includes(keyword)) {
      groupNames.forEach((g) => groups.add(g));
    }
  }

  // Fallback: load all if nothing matched
  if (groups.size === 0) return Object.values(VIRTUAL_TOOLS);

  // Always include status for post-mutation verification
  groups.add("status");

  const selected = new Set<string>();
  for (const g of groups) {
    (TOOL_GROUPS[g] || []).forEach((t) => selected.add(t));
  }

  return Object.values(VIRTUAL_TOOLS).filter((t) => selected.has(t.name));
}

// =============================================================================
// VIRTUAL TOOL ROUTER — Maps virtual calls to real MCP calls
// =============================================================================
async function executeVirtualTool(
  name: string,
  args: Record<string, unknown>
): Promise<string> {
  const action = args.action as string;
  const { action: _, ...params } = args;

  switch (name) {
    case "server_info":
      if (action === "status") return callMCPSmart("server_status", {});
      return callMCPSmart("activity_log", params);

    case "media_query":
      if (action === "details")
        return callMCPSmart("show_details", { showId: params.showId });
      return callMCPSmart("search_media", params);

    case "library_ops":
      if (action === "scan")
        return callMCPSmart("manage_library", { action: "scan" });
      if (action === "create")
        return callMCPSmart("manage_library", {
          action: "create",
          name: params.name,
          type: params.libraryType,
          folder: params.folder,
        });
      if (action === "refresh")
        return callMCPSmart("manage_library", {
          action: "refresh_metadata",
          itemId: params.itemId,
        });
      if (action === "rename")
        return callMCPSmart("rename_episodes", params);
      return callMCPSmart("manage_files", { action, ...params });

    case "series":
      if (action === "search" || action === "add")
        return callMCPSmart("series_search", params);
      if (action === "status")
        return callMCPSmart("series_status", params);
      if (action === "remove")
        return callMCPSmart("series_remove", params);
      if (action === "releases")
        return callMCPSmart("series_releases", params);
      if (action === "grab") return callMCPSmart("series_grab", params);
      break;

    case "movies":
      if (action === "search" || action === "add")
        return callMCPSmart("movie_search", params);
      if (action === "status")
        return callMCPSmart("movie_status", params);
      if (action === "remove")
        return callMCPSmart("movie_remove", params);
      if (action === "releases")
        return callMCPSmart("movie_releases", params);
      if (action === "grab") return callMCPSmart("movie_grab", params);
      break;

    case "downloads":
      if (action === "add")
        return callMCPSmart("download_add", {
          urls: params.urls,
          packageName: params.packageName,
        });
      if (action === "status")
        return callMCPSmart("download_status", { organize: false });
      if (action === "organize")
        return callMCPSmart("download_status", { organize: true, ...params });
      if (action === "list_queue")
        return callMCPSmart("cancel_downloads", {
          source: params.source || "sonarr",
          action: "list",
        });
      if (action === "cancel")
        return callMCPSmart("cancel_downloads", {
          source: params.source || "sonarr",
          action: "cancel",
          queueIds: params.queueIds,
          torrentHashes: params.torrentHashes,
        });
      if (action === "purge")
        return callMCPSmart("cancel_downloads", {
          source: params.source || "sonarr",
          action: "purge_duplicates",
        });
      if (action === "clean_orphans")
        return callMCPSmart("cancel_downloads", {
          source: "qbittorrent",
          action: "clean_orphans",
        });
      break;

    case "optimize":
      if (action === "fix_subs")
        return callMCPSmart("fix_subtitles", {
          mediaPath: params.mediaPath,
          dryRun: params.dryRun ?? true,
        });
      return callMCPSmart("optimize_media", {
        action: action === "analyze" ? "analyze" : "optimize",
        ...params,
      });

    case "maintenance":
      if (action === "check_jobs")
        return callMCPSmart("check_jobs", { jobId: params.jobId });
      return callMCPSmart("cleanup_server", { dryRun: params.dryRun ?? true });
  }

  throw new Error(`Unknown: ${name}.${action}`);
}

// =============================================================================
// MCP CLIENT — Reconnection with exponential backoff
// =============================================================================
let mcpClient: Client | null = null;
let reconnectAttempts = 0;

async function connectMCP(): Promise<void> {
  console.log(`Connecting to MCP: ${MCP_URL}`);
  const client = new Client({ name: "telegram-bot", version: "0.3.0" });
  const headers: Record<string, string> = {};
  if (MCP_API_KEY) headers["Authorization"] = `Bearer ${MCP_API_KEY}`;
  const transport = new SSEClientTransport(new URL(MCP_URL), {
    requestInit: { headers },
  });
  await client.connect(transport);
  mcpClient = client;
  reconnectAttempts = 0;

  const { tools } = await client.listTools();
  console.log(
    `Connected. ${tools.length} MCP tools, ${Object.keys(VIRTUAL_TOOLS).length} virtual tools`
  );
}

async function connectWithRetry(): Promise<void> {
  const MAX = 10;
  const BASE = 1000;
  while (reconnectAttempts < MAX) {
    try {
      await connectMCP();
      return;
    } catch (err: any) {
      reconnectAttempts++;
      const delay = Math.min(BASE * 2 ** reconnectAttempts, 30_000);
      console.error(
        `MCP connect failed (${reconnectAttempts}/${MAX}), retry in ${delay}ms: ${err.message}`
      );
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  console.error("MCP reconnection exhausted.");
}

// =============================================================================
// MCP TOOL EXECUTION — Timeout + cache + smart invalidation
// =============================================================================

// FIX #3: Only invalidate on actual writes, not search-only calls
function isWriteCall(name: string, args: Record<string, unknown>): boolean {
  const ALWAYS_WRITE = new Set([
    "series_grab",
    "movie_grab",
    "manage_files",
    "manage_library",
    "series_remove",
    "movie_remove",
    "optimize_media",
    "fix_subtitles",
    "cleanup_server",
    "download_add",
    "cancel_downloads",
    "rename_episodes",
  ]);
  if (ALWAYS_WRITE.has(name)) return true;

  // series_search and movie_search are writes ONLY when adding
  if (name === "series_search" && args.addTvdbId) return true;
  if (name === "movie_search" && args.addTmdbId) return true;

  return false;
}

const cache = new Map<string, { data: string; expires: number }>();
const CACHE_TTL: Record<string, number> = {
  server_status: 60_000,
  search_media: 30_000,
  show_details: 300_000,
  series_status: 30_000,
  movie_status: 30_000,
};

// FIX #4: Timeout wrapper
async function callMCPToolWithTimeout(
  name: string,
  args: Record<string, unknown>
): Promise<string> {
  if (!mcpClient) {
    await connectWithRetry();
    if (!mcpClient) throw new Error("MCP not connected");
  }

  const resultPromise = mcpClient.callTool({ name, arguments: args });
  const timeoutPromise = new Promise<never>((_, reject) =>
    setTimeout(
      () => reject(new Error(`Tool ${name} timed out after ${TOOL_TIMEOUT_MS / 1000}s`)),
      TOOL_TIMEOUT_MS
    )
  );

  const result = await Promise.race([resultPromise, timeoutPromise]);
  const content = result.content as Array<{ type: string; text?: string }>;
  let text = content
    .filter((c) => c.type === "text" && c.text)
    .map((c) => c.text!)
    .join("\n");
  if (text.length > 8000) text = text.slice(0, 8000) + "\n...(truncated)";
  return text;
}

async function callMCPSmart(
  name: string,
  args: Record<string, unknown>
): Promise<string> {
  // Clean undefined values
  const cleanArgs: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (v !== undefined && v !== null) cleanArgs[k] = v;
  }

  console.log(`[MCP] ${name}(${JSON.stringify(cleanArgs).slice(0, 120)})`);

  if (isWriteCall(name, cleanArgs)) {
    cache.clear();
    return callMCPToolWithTimeout(name, cleanArgs);
  }

  const ttl = CACHE_TTL[name];
  if (ttl) {
    const key = `${name}:${JSON.stringify(cleanArgs)}`;
    const cached = cache.get(key);
    if (cached && Date.now() < cached.expires) {
      console.log(`[Cache HIT] ${name}`);
      return cached.data;
    }
    const result = await callMCPToolWithTimeout(name, cleanArgs);
    cache.set(key, { data: result, expires: Date.now() + ttl });
    return result;
  }

  return callMCPToolWithTimeout(name, cleanArgs);
}

// =============================================================================
// LLM PROVIDERS
// =============================================================================
const openai = OPENROUTER_KEY
  ? new OpenAI({ baseURL: "https://openrouter.ai/api/v1", apiKey: OPENROUTER_KEY })
  : null;
const googleAI = GOOGLE_AI_KEY
  ? new GoogleGenAI({ apiKey: GOOGLE_AI_KEY })
  : null;

function toOpenAITools(tools: VirtualToolDef[]): ChatCompletionTool[] {
  return tools.map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));
}

function toGeminiTools(tools: VirtualToolDef[]) {
  return [
    {
      functionDeclarations: tools.map((t) => ({
        name: t.name,
        description: t.description,
        parameters: convertGeminiSchema(t.parameters),
      })),
    },
  ];
}

function convertGeminiSchema(
  params: Record<string, unknown>
): Record<string, unknown> {
  const props = (params.properties as Record<string, any>) || {};
  const required = (params.required as string[]) || [];
  const geminiProps: Record<string, any> = {};
  for (const [key, val] of Object.entries(props)) {
    const prop: any = { description: val.description || "" };
    if (val.type === "string") {
      prop.type = Type.STRING;
      if (val.enum) prop.enum = val.enum;
    } else if (val.type === "number" || val.type === "integer") {
      prop.type = Type.NUMBER;
    } else if (val.type === "boolean") {
      prop.type = Type.BOOLEAN;
    } else if (val.type === "array") {
      prop.type = Type.ARRAY;
      prop.items = {
        type:
          val.items?.type === "number" ? Type.NUMBER : Type.STRING,
      };
    } else {
      prop.type = Type.STRING;
    }
    geminiProps[key] = prop;
  }
  return { type: Type.OBJECT, properties: geminiProps, required };
}

// =============================================================================
// CONVERSATION — Unified history that preserves tool calls for both providers
// =============================================================================

// FIX #1 & #6: Unified message types that can reconstruct both OpenRouter and
// Gemini formats correctly, including function calls and responses.

interface ToolCallInfo {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

interface ToolResultInfo {
  id: string; // maps to tool call id
  name: string;
  result: string;
}

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  toolCalls?: ToolCallInfo[]; // assistant message with tool invocations
  toolResults?: ToolResultInfo[]; // user message carrying tool responses
}

const conversations = new Map<number, ChatMessage[]>();
const lastActivity = new Map<number, number>();
const chatLocks = new Map<number, Promise<void>>();

// FIX #5: Token-based trimming instead of message count
function estimateTokens(msg: ChatMessage): number {
  let chars = msg.content.length;
  if (msg.toolCalls) {
    for (const tc of msg.toolCalls) {
      chars += tc.name.length + JSON.stringify(tc.args).length;
    }
  }
  if (msg.toolResults) {
    for (const tr of msg.toolResults) {
      chars += tr.result.length;
    }
  }
  return Math.ceil(chars / 3.5);
}

function trimHistory(history: ChatMessage[]): ChatMessage[] {
  let total = 0;
  // Walk backward, keep messages until budget exceeded
  for (let i = history.length - 1; i >= 0; i--) {
    total += estimateTokens(history[i]);
    if (total > MAX_HISTORY_TOKENS) {
      // Keep from i+1 onward, but ensure we don't start mid-exchange
      // (don't start with an assistant tool-call without its result)
      let start = i + 1;
      while (
        start < history.length &&
        history[start].role === "assistant" &&
        history[start].toolCalls?.length
      ) {
        // Skip the tool-call assistant message AND the following tool-result user message
        start++;
        if (start < history.length && history[start].toolResults?.length) {
          start++;
        }
      }
      return history.slice(start);
    }
  }
  return history;
}

function getHistory(chatId: number): ChatMessage[] {
  if (!conversations.has(chatId)) conversations.set(chatId, []);
  return conversations.get(chatId)!;
}

// Cleanup stale conversations every 10 min
setInterval(() => {
  const cutoff = Date.now() - CONVERSATION_TTL;
  lastActivity.forEach((ts, id) => {
    if (ts < cutoff) {
      conversations.delete(id);
      lastActivity.delete(id);
    }
  });
}, 600_000);

async function withLock<T>(chatId: number, fn: () => Promise<T>): Promise<T> {
  const prev = chatLocks.get(chatId) || Promise.resolve();
  let resolve: () => void;
  chatLocks.set(chatId, new Promise<void>((r) => (resolve = r)));
  await prev;
  try {
    return await fn();
  } finally {
    resolve!();
  }
}

// =============================================================================
// BUILD PROVIDER-SPECIFIC MESSAGE ARRAYS FROM UNIFIED HISTORY
// =============================================================================

function buildOpenRouterMessages(
  history: ChatMessage[],
  selectedTools: VirtualToolDef[]
): { messages: ChatCompletionMessageParam[]; tools: ChatCompletionTool[] } {
  const messages: ChatCompletionMessageParam[] = [
    { role: "system", content: SYSTEM_PROMPT },
  ];

  for (const msg of history) {
    if (msg.role === "user" && msg.toolResults?.length) {
      // This is a tool result message — emit as individual tool messages
      for (const tr of msg.toolResults) {
        messages.push({
          role: "tool",
          tool_call_id: tr.id,
          content: tr.result,
        } as any);
      }
    } else if (msg.role === "user") {
      messages.push({ role: "user", content: msg.content });
    } else if (msg.role === "assistant" && msg.toolCalls?.length) {
      messages.push({
        role: "assistant",
        content: msg.content || null,
        tool_calls: msg.toolCalls.map((tc) => ({
          id: tc.id,
          type: "function" as const,
          function: {
            name: tc.name,
            arguments: JSON.stringify(tc.args),
          },
        })),
      } as any);
    } else {
      messages.push({ role: "assistant", content: msg.content });
    }
  }

  return { messages, tools: toOpenAITools(selectedTools) };
}

// FIX #6: Gemini role mapping — functionResponse goes in "user" role,
// functionCall goes in "model" role. Text goes in appropriate role.
interface GeminiMsg {
  role: "user" | "model";
  parts: Array<{
    text?: string;
    functionCall?: { name: string; args: Record<string, unknown> };
    functionResponse?: {
      name: string;
      response: Record<string, unknown>;
    };
  }>;
}

function buildGeminiHistory(history: ChatMessage[]): GeminiMsg[] {
  const gemini: GeminiMsg[] = [];

  for (const msg of history) {
    if (msg.role === "user" && msg.toolResults?.length) {
      // Tool results → role: "user" with functionResponse parts
      gemini.push({
        role: "user",
        parts: msg.toolResults.map((tr) => {
          let parsed: Record<string, unknown>;
          try {
            const p = JSON.parse(tr.result);
            parsed = Array.isArray(p)
              ? { result: p }
              : typeof p === "object" && p !== null
                ? (p as Record<string, unknown>)
                : { result: p };
          } catch {
            parsed = { result: tr.result };
          }
          return {
            functionResponse: { name: tr.name, response: parsed },
          };
        }),
      });
    } else if (msg.role === "user") {
      gemini.push({
        role: "user",
        parts: [{ text: msg.content }],
      });
    } else if (msg.role === "assistant" && msg.toolCalls?.length) {
      // Tool calls → role: "model" with functionCall parts
      const parts: GeminiMsg["parts"] = [];
      if (msg.content) parts.push({ text: msg.content });
      for (const tc of msg.toolCalls) {
        parts.push({
          functionCall: { name: tc.name, args: tc.args },
        });
      }
      gemini.push({ role: "model", parts });
    } else {
      gemini.push({
        role: "model",
        parts: [{ text: msg.content || "(sin respuesta)" }],
      });
    }
  }

  return gemini;
}

// =============================================================================
// CHAT — OpenRouter
// =============================================================================
async function handleChatOpenRouter(
  chatId: number,
  selectedTools: VirtualToolDef[]
): Promise<string> {
  const history = getHistory(chatId);
  const { messages, tools } = buildOpenRouterMessages(history, selectedTools);

  for (let i = 0; i < 10; i++) {
    let res;
    try {
      res = await openai!.chat.completions.create({
        model: MODEL,
        messages,
        tools: tools.length ? tools : undefined,
        temperature: 0.3,
      });
    } catch (err: any) {
      return formatError(err);
    }

    if (!res.choices?.length) return "El modelo no respondió. Usa /clear.";
    const msg = res.choices[0].message;
    if (!msg) return "Respuesta vacía.";

    if (msg.tool_calls?.length) {
      const tcs: ToolCallInfo[] = msg.tool_calls.map((tc) => ({
        id: tc.id,
        name: tc.function.name,
        args: JSON.parse(tc.function.arguments || "{}"),
      }));

      // Save assistant message with tool calls
      history.push({
        role: "assistant",
        content: msg.content || "",
        toolCalls: tcs,
      });

      // Execute tools
      const results: ToolResultInfo[] = [];
      for (const tc of tcs) {
        let r: string;
        try {
          r = await executeVirtualTool(tc.name, tc.args);
        } catch (e: any) {
          r = JSON.stringify({ error: e.message });
        }
        results.push({ id: tc.id, name: tc.name, result: r });
      }

      // Save tool results as a user message
      history.push({
        role: "user",
        content: "",
        toolResults: results,
      });

      // Also append to the local messages array for this loop
      messages.push({
        role: "assistant",
        content: msg.content || null,
        tool_calls: msg.tool_calls.map((tc) => ({
          id: tc.id,
          type: "function" as const,
          function: {
            name: tc.function.name,
            arguments: tc.function.arguments || "{}",
          },
        })),
      } as any);
      for (const tr of results) {
        messages.push({
          role: "tool",
          tool_call_id: tr.id,
          content: tr.result,
        } as any);
      }

      continue;
    }

    const reply = msg.content || "(sin respuesta)";
    history.push({ role: "assistant", content: reply });
    conversations.set(chatId, trimHistory(history));
    return reply;
  }
  return "Límite de iteraciones. Usa /clear.";
}

// =============================================================================
// CHAT — Gemini
// =============================================================================
async function handleChatGemini(
  chatId: number,
  selectedTools: VirtualToolDef[]
): Promise<string> {
  const history = getHistory(chatId);
  const geminiHistory = buildGeminiHistory(history);

  for (let i = 0; i < 10; i++) {
    let res;
    try {
      res = await googleAI!.models.generateContent({
        model: MODEL,
        contents: geminiHistory,
        config: {
          systemInstruction: SYSTEM_PROMPT,
          tools: toGeminiTools(selectedTools),
          temperature: 0.3,
        },
      });
    } catch (err: any) {
      return formatError(err);
    }

    const parts = res.candidates?.[0]?.content?.parts || [];
    const fCalls = parts.filter((p) => p.functionCall);
    const textContent = parts
      .filter((p) => p.text)
      .map((p) => p.text!)
      .join("");

    if (fCalls.length) {
      const tcs: ToolCallInfo[] = fCalls.map((fc, idx) => ({
        id: `call_${Date.now()}_${idx}`,
        name: fc.functionCall!.name!,
        args: (fc.functionCall!.args || {}) as Record<string, unknown>,
      }));

      // Save assistant message with tool calls
      history.push({
        role: "assistant",
        content: textContent || "",
        toolCalls: tcs,
      });

      // Add to gemini history
      const modelParts: GeminiMsg["parts"] = [];
      if (textContent) modelParts.push({ text: textContent });
      for (const tc of tcs) {
        modelParts.push({
          functionCall: { name: tc.name, args: tc.args },
        });
      }
      geminiHistory.push({ role: "model", parts: modelParts });

      // Execute tools
      const results: ToolResultInfo[] = [];
      const responseParts: GeminiMsg["parts"] = [];
      for (const tc of tcs) {
        let r: string;
        try {
          r = await executeVirtualTool(tc.name, tc.args);
        } catch (e: any) {
          r = JSON.stringify({ error: e.message });
        }
        results.push({ id: tc.id, name: tc.name, result: r });

        let parsed: Record<string, unknown>;
        try {
          const p = JSON.parse(r);
          parsed = Array.isArray(p)
            ? { result: p }
            : typeof p === "object" && p !== null
              ? (p as Record<string, unknown>)
              : { result: p };
        } catch {
          parsed = { result: r };
        }
        responseParts.push({
          functionResponse: { name: tc.name, response: parsed },
        });
      }

      // Save tool results
      history.push({
        role: "user",
        content: "",
        toolResults: results,
      });

      // Add to gemini history as user role
      geminiHistory.push({ role: "user", parts: responseParts });
      continue;
    }

    const reply = textContent || "(sin respuesta)";
    history.push({ role: "assistant", content: reply });
    conversations.set(chatId, trimHistory(history));
    return reply;
  }
  return "Límite de iteraciones. Usa /clear.";
}

// =============================================================================
// CHAT HANDLER
// =============================================================================
async function handleChat(
  chatId: number,
  userMessage: string
): Promise<string> {
  lastActivity.set(chatId, Date.now());
  const history = getHistory(chatId);
  history.push({ role: "user", content: userMessage });
  conversations.set(chatId, trimHistory(history));

  const selectedTools = selectTools(userMessage);
  console.log(
    `[Route] ${selectedTools.map((t) => t.name).join(", ")} (${selectedTools.length}/${Object.keys(VIRTUAL_TOOLS).length})`
  );

  return PROVIDER === "google"
    ? handleChatGemini(chatId, selectedTools)
    : handleChatOpenRouter(chatId, selectedTools);
}

// =============================================================================
// ERROR FORMATTING
// =============================================================================
function formatError(err: Error): string {
  const msg = err.message || "";
  if (!mcpClient) return "⚠️ Servidor no disponible. Reconectando...";
  if (msg.includes("timed out"))
    return "⚠️ La operación tardó demasiado. Intenta de nuevo.";
  if (msg.includes("ECONNREFUSED"))
    return "⚠️ No se puede conectar al servidor.";
  if (msg.includes("429") || msg.includes("rate"))
    return "⚠️ Demasiadas peticiones. Espera un momento.";
  return `⚠️ Error: ${msg.slice(0, 200)}`;
}

// =============================================================================
// TELEGRAM BOT
// =============================================================================
const bot = new Bot(TELEGRAM_TOKEN);

bot.use(async (ctx: Context, next) => {
  const uid = ctx.from?.id;
  if (!uid || (ALLOWED_USERS.length && !ALLOWED_USERS.includes(uid))) {
    await ctx.reply("No autorizado.");
    return;
  }
  await next();
});

bot.command("start", (ctx) =>
  ctx.reply(
    `Media Server Bot\nModelo: ${MODEL} (${PROVIDER})\nTools: ${Object.keys(VIRTUAL_TOOLS).length} virtual / 24 MCP\n\n/clear - Reiniciar\n/model - Info`
  )
);
bot.command("clear", (ctx) => {
  conversations.delete(ctx.chat.id);
  ctx.reply("Conversación reiniciada.");
});
bot.command("model", (ctx) =>
  ctx.reply(
    `Provider: ${PROVIDER}\nModelo: ${MODEL}\nMCP: ${mcpClient ? "connected" : "disconnected"}`
  )
);

function startTyping(chatId: number): () => void {
  bot.api.sendChatAction(chatId, "typing").catch(() => {});
  const interval = setInterval(() => {
    bot.api.sendChatAction(chatId, "typing").catch(() => {});
  }, 4000);
  return () => clearInterval(interval);
}

bot.on("message:text", async (ctx) => {
  const chatId = ctx.chat.id;
  await withLock(chatId, async () => {
    const stopTyping = startTyping(chatId);
    try {
      const reply = await handleChat(chatId, ctx.message.text);
      for (let i = 0; i < reply.length; i += 4096) {
        await ctx.reply(reply.slice(i, i + 4096));
      }
    } catch (err: any) {
      console.error(`[Error] ${err.message}`);
      await ctx.reply(formatError(err));
    } finally {
      stopTyping();
    }
  });
});

// =============================================================================
// STARTUP & SHUTDOWN
// =============================================================================
async function shutdown(sig: string) {
  console.log(`${sig}, shutting down...`);
  try {
    bot.stop();
  } catch {}
  try {
    if (mcpClient) await mcpClient.close();
  } catch {}
  process.exit(0);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

async function main() {
  console.log(`Media Server Bot | ${PROVIDER}/${MODEL}`);
  console.log(
    `MCP: ${MCP_URL} | Users: ${ALLOWED_USERS.length ? ALLOWED_USERS.join(",") : "all"}`
  );
  await connectWithRetry();
  bot.start({ onStart: (info) => console.log(`Bot: @${info.username}`) });
}

main().catch(console.error);