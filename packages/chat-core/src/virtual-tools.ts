/* ─── 8 virtual tools presented to the LLM ──────────────────────────────────
 * Mirrors exactly what the Telegram bot exposes. Each virtual tool wraps
 * one or more real MCP tools under a single action-based interface,
 * keeping the LLM's tool surface small and semantically clear.
 * ──────────────────────────────────────────────────────────────────────── */
import type { VirtualToolDef } from './types.js';

export const VIRTUAL_TOOLS: Record<string, VirtualToolDef> = {
  server_info: {
    name: 'server_info',
    description: "Server status and activity log. action:'status' for full overview (disk, libraries, sessions, users). action:'activity' for recent playback history.",
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['status', 'activity'], description: 'status=full overview, activity=who watched what' },
        limit:  { type: 'number', description: 'Entries for activity log (default 15)' },
      },
      required: ['action'],
    },
  },

  media_query: {
    name: 'media_query',
    description: "Search or list Jellyfin content, or get details of a specific item. action:'search' to find/list media (omit query to list all, use page/pageSize to paginate). action:'details' for seasons/episodes of a series (use seasonNumber to filter one season, page/pageSize to paginate episodes).",
    parameters: {
      type: 'object',
      properties: {
        action:       { type: 'string', enum: ['search', 'details'] },
        query:        { type: 'string', description: 'Search term (omit to list all)' },
        type:         { type: 'string', enum: ['Movie', 'Series', 'Episode', 'Audio'] },
        showId:       { type: 'string', description: 'Jellyfin item ID (for details)' },
        seasonNumber: { type: 'number', description: 'Filter details to this season only (recommended for large series)' },
        page:         { type: 'number', description: 'Page number for pagination (default 1)' },
        pageSize:     { type: 'number', description: 'Items per page for pagination (default 50)' },
      },
      required: ['action'],
    },
  },

  library_ops: {
    name: 'library_ops',
    description: 'Manage files and libraries. scan=refresh Jellyfin. create=new library. move=move files/folders. delete=cross-layer delete (Jellyfin+Sonarr/Radarr+disk). list=browse files. rename=standardize episode names. refresh=refresh metadata.',
    parameters: {
      type: 'object',
      properties: {
        action:       { type: 'string', enum: ['scan', 'create', 'move', 'delete', 'list', 'rename', 'refresh'] },
        path:         { type: 'string', description: "File path. 'downloads/' prefix for download folder" },
        sourcePaths:  { type: 'array', items: { type: 'string' }, description: 'Paths to move' },
        destFolder:   { type: 'string', description: 'Move destination' },
        jellyfinItemId: { type: 'string', description: 'Item to delete' },
        name:         { type: 'string', description: 'Library name (create)' },
        libraryType:  { type: 'string', enum: ['movies', 'tvshows', 'music', 'mixed'] },
        folder:       { type: 'string', description: 'Library folder (create)' },
        showPath:     { type: 'string' },
        showName:     { type: 'string' },
        seasonNumber: { type: 'number' },
        dryRun:       { type: 'boolean' },
        itemId:       { type: 'string', description: 'For metadata refresh' },
      },
      required: ['action'],
    },
  },

  series: {
    name: 'series',
    description:
      "Manage TV series via Sonarr. action:'search'=find by name (results include sonarrId only when the show is already in Sonarr). action:'add'=add to monitoring (needs addTvdbId from search). action:'status'=view series/episodes/calendar/missing/queue/history. action:'remove'=delete. action:'releases'=find torrents. action:'grab'=download a specific release. ID rule: pass `seriesId` (the Sonarr internal id, or a tvdbId — both are auto-resolved) for releases/grab/remove/episodes-view; never pass tvdbId blindly to grab/releases without searching first.",
    parameters: {
      type: 'object',
      properties: {
        action:        { type: 'string', enum: ['search', 'add', 'status', 'remove', 'releases', 'grab'] },
        query:         { type: 'string' },
        addTvdbId:     { type: 'number', description: 'TVDB id from a prior search result. Use ONLY with action:"add".' },
        rootFolder:    { type: 'string', enum: ['/tv', '/anime'] },
        monitor:       { type: 'string', enum: ['all', 'future', 'missing', 'none', 'firstSeason', 'lastSeason'] },
        seasons:       { type: 'array', items: { type: 'number' } },
        quality:       { type: 'string', enum: ['Any', 'SD', 'HD-720p', 'HD-1080p', 'Ultra-HD', 'HD - 720p/1080p'] },
        searchNow:     { type: 'boolean', description: 'false=add without downloading (default). true=auto-search.' },
        view:          { type: 'string', enum: ['series', 'episodes', 'calendar', 'missing', 'queue', 'history'] },
        seriesId:      { type: 'number', description: 'Sonarr internal series id (or a tvdbId — auto-resolved). Required by status:episodes, releases, grab, remove.' },
        seasonNumber:  { type: 'number' },
        episodeNumber: { type: 'number', description: 'Episode number (for releases/grab)' },
        page:          { type: 'number', description: 'Page number for episodes/series view (default 1)' },
        pageSize:      { type: 'number', description: 'Items per page for episodes/series view (default 50)' },
        episodeId:     { type: 'number', description: 'Sonarr internal episode id. If you have it, pass it directly to releases/grab.' },
        guid:          { type: 'string', description: 'Release guid from a prior series:releases call. Required by grab.' },
        indexerId:     { type: 'number', description: 'Indexer id from a prior series:releases call. Required by grab.' },
        deleteFiles:   { type: 'boolean' },
        limit:         { type: 'number' },
      },
      required: ['action'],
    },
  },

  movies: {
    name: 'movies',
    description:
      "Manage movies via Radarr. action:'search'=find by name (results include movieId only when the movie is already in Radarr — `inRadarr:true`). action:'add'=add to monitoring (needs addTmdbId from search). action:'status'=view movies/queue/history. action:'remove'=delete. action:'releases'=find torrents. action:'grab'=download a specific release. ID rule: tmdbId comes from search and is ONLY for action:'add' (as addTmdbId). For releases/grab/remove use `movieId` (the Radarr internal id from a prior search where inRadarr:true, or from the response of action:'add'). The router auto-resolves a tmdbId passed as movieId, but only if the movie has already been added — if not it fails with a clear hint.",
    parameters: {
      type: 'object',
      properties: {
        action:      { type: 'string', enum: ['search', 'add', 'status', 'remove', 'releases', 'grab'] },
        query:       { type: 'string' },
        addTmdbId:   { type: 'number', description: 'TMDB id from a prior search result. Use ONLY with action:"add".' },
        quality:     { type: 'string', enum: ['Any', 'SD', 'HD-720p', 'HD-1080p', 'Ultra-HD', 'HD - 720p/1080p'] },
        searchNow:   { type: 'boolean' },
        view:        { type: 'string', enum: ['movies', 'queue', 'history'] },
        movieId:     { type: 'number', description: 'Radarr internal movie id (preferred) or tmdbId of an already-added movie. Required by releases/grab/remove. NEVER pass a tmdbId here for a movie that hasn\'t been added — call action:"add" first.' },
        guid:        { type: 'string', description: 'Release guid from a prior movies:releases call. Required by grab.' },
        indexerId:   { type: 'number', description: 'Indexer id from a prior movies:releases call. Required by grab.' },
        deleteFiles: { type: 'boolean' },
        limit:       { type: 'number' },
      },
      required: ['action'],
    },
  },

  downloads: {
    name: 'downloads',
    description: "Manage downloads. direct=download from direct HTTP URL or YouTube/video sites ONLY (never for Google Drive, Mega, MediaFire). add=send to PyLoad for file hosters (Google Drive, Mega, MediaFire, etc.). status=check PyLoad queue + download folders. organize=move completed to Jellyfin. delete_pyload=remove PyLoad packages. Sonarr/Radarr/qBit: list_queue, cancel, purge, clean_orphans.",
    parameters: {
      type: 'object',
      properties: {
        action:          { type: 'string', enum: ['direct', 'add', 'status', 'organize', 'delete_pyload', 'cancel', 'purge', 'clean_orphans', 'list_queue'] },
        url:             { type: 'string', description: 'Single URL for direct download (action=direct)' },
        urls:            { type: 'array', items: { type: 'string' } },
        packageName:     { type: 'string', description: 'Descriptive name for PyLoad download (becomes folder name)' },
        packageIds:      { type: 'array', items: { type: 'number' }, description: 'PyLoad package IDs to delete' },
        packageFolder:   { type: 'string', description: 'Download subfolder to organize (from status response)' },
        showName:        { type: 'string', description: 'Target name in Jellyfin' },
        libraryFolder:   { type: 'string', enum: ['tv', 'movies', 'music', 'anime'] },
        seasonNumber:    { type: 'number' },
        episodeNumber:   { type: 'number' },
        archivePassword: { type: 'string', description: 'Password for RAR/ZIP/7z archives' },
        source:          { type: 'string', enum: ['sonarr', 'radarr', 'qbittorrent'] },
        queueIds:        { type: 'array', items: { type: 'number' } },
        torrentHashes:   { type: 'array', items: { type: 'string' } },
        seriesId:        { type: 'number' },
        movieId:         { type: 'number' },
      },
      required: ['action'],
    },
  },

  optimize: {
    name: 'optimize',
    description: 'Optimize media files. analyze=show audio/subtitle tracks. optimize=remove unwanted tracks (specify keepAudioLangs). fix_subs=convert ASS/SSA subtitles to SRT to prevent transcoding.',
    parameters: {
      type: 'object',
      properties: {
        action:        { type: 'string', enum: ['analyze', 'optimize', 'fix_subs'] },
        mediaPath:     { type: 'string', description: "Path to media (relative like 'anime/Show' or absolute like '/data/anime/Show' — both work)" },
        keepAudioLangs:{ type: 'array', items: { type: 'string' }, description: "Audio languages to keep (e.g. ['spa','eng'])" },
        keepSubLangs:  { type: 'array', items: { type: 'string' } },
        removeAllSubs: { type: 'boolean' },
        dryRun:        { type: 'boolean' },
      },
      required: ['action', 'mediaPath'],
    },
  },

  maintenance: {
    name: 'maintenance',
    description: 'Server maintenance. cleanup=clean temp files, orphan downloads, ghost entries. check_jobs=monitor background operations by jobId.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['cleanup', 'check_jobs'] },
        dryRun: { type: 'boolean' },
        jobId:  { type: 'string' },
      },
      required: ['action'],
    },
  },

  present_choices: {
    name: 'present_choices',
    description:
      "UI helper — render clickable option cards. THIS IS MANDATORY for any pick the user has to make: multi-result searches (>1 hit), release pickers (movies/series action:'releases' with >1 result), season/episode rangers, replace-vs-keep. NEVER list options as text bullets when present_choices applies — the user click won't carry IDs and the next tool call will fail. Each item.value MUST be a verbatim instruction with EVERY ID the next turn needs (e.g. \"Grab this release: guid=<guid> indexerId=<n> movieId=<m>\"). The user clicks a card and that exact value becomes their next message — there is no other way for IDs to round-trip. Call this tool ALONE (no other tool calls in the same response) with zero or one short sentence of text alongside it (in the user's locale). Cap to 4–8 items — pre-filter (drop 0-seeder, drop rejected, take top scores).",
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Optional one-line question shown above the cards. Keep brief — the cards carry the detail.' },
        items: {
          type: 'array',
          minItems: 2,
          maxItems: 8,
          items: {
            type: 'object',
            properties: {
              label:    { type: 'string', description: 'Headline. Include the year/quality/episode etc. so the user can pick.' },
              subtitle: { type: 'string', description: 'IDs or key facts (e.g. "TMDB ID: 10331 · Director: Romero").' },
              meta:     { type: 'string', description: 'Optional secondary context (genre, runtime, indexer name).' },
              value:    { type: 'string', description: 'Verbatim text echoed as the next user message — embed every ID the LLM needs.' },
            },
            required: ['label', 'value'],
          },
        },
      },
      required: ['items'],
    },
  },
};

/** Tool name reserved for UI-side handling (no MCP call, intercepted by engine). */
export const PRESENT_CHOICES_TOOL = 'present_choices';
