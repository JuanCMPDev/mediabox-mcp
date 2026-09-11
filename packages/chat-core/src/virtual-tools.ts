/* ─── Virtual tools presented to the LLM ─────────────────────────────────────
 * Each virtual tool wraps one or more real MCP tools under a single action-based
 * interface, keeping the LLM's tool surface small, semantically clear, and strictly
 * proposal-based for mutations.
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

  catalog: {
    name: 'catalog',
    description: "Unified media catalog and releases across Arr services. action:'search'=search unified catalog. action:'details'=get item details by mediaRef. action:'releases'=find releases by mediaRef. action:'propose_download'=propose downloading a release by releaseRef (and optional mediaRef / replacement).",
    parameters: {
      type: 'object',
      properties: {
        action:         { type: 'string', enum: ['search', 'details', 'releases', 'propose_download'] },
        query:          { type: 'string', description: 'Search query' },
        type:           { type: 'string', description: 'media type filter (movie, series, etc.)' },
        year:           { type: 'number', description: 'Release year' },
        cursor:         { type: 'string', description: 'Opaque pagination cursor' },
        page:           { type: 'number' },
        pageSize:       { type: 'number' },
        mediaRef:       { type: 'string', description: 'Opaque media reference token' },
        releaseRef:     { type: 'string', description: 'Opaque release reference token' },
        replacement:    { type: 'boolean', description: 'Whether this replaces an existing media file' },
        resolution:     { type: 'string', description: 'Resolution preference (e.g. 1080p)' },
        audioLanguage:  { type: 'string', description: 'Preferred audio language code (e.g. es)' },
        strictLanguage: { type: 'boolean', description: 'Require strict audio language match' },
        minSeeders:     { type: 'number', description: 'Minimum seeder threshold' },
      },
      required: ['action'],
    },
  },

  library_ops: {
    name: 'library_ops',
    description: "Manage files and libraries safely. scan=refresh Jellyfin. list=browse files. refresh=refresh metadata by itemId. rename=preview standardized episode names (dryRun is pinned to true). propose_delete=propose deleting files/directories via an approved plan.",
    parameters: {
      type: 'object',
      properties: {
        action:             { type: 'string', enum: ['scan', 'list', 'refresh', 'rename', 'propose_delete'] },
        path:               { type: 'string', description: "File path. 'downloads/' prefix for download folder" },
        paths:              { description: 'Path or array of paths to propose for cleanup/deletion' },
        showPath:           { type: 'string' },
        showName:           { type: 'string' },
        seasonNumber:       { type: 'number' },
        startEpisodeNumber: { type: 'number' },
        dryRun:             { type: 'boolean' },
        itemId:             { type: 'string', description: 'For metadata refresh' },
      },
      required: ['action'],
    },
  },

  series: {
    name: 'series',
    description: "Inspect TV series via Sonarr. action:'search'=find by name. action:'status'=view series/episodes/calendar/missing/queue/history. action:'releases'=find torrents for a series/episode.",
    parameters: {
      type: 'object',
      properties: {
        action:        { type: 'string', enum: ['search', 'status', 'releases'] },
        query:         { type: 'string' },
        view:          { type: 'string', enum: ['series', 'episodes', 'calendar', 'missing', 'queue', 'history'] },
        seriesId:      { type: 'number', description: 'Sonarr internal series id' },
        seasonNumber:  { type: 'number' },
        episodeNumber: { type: 'number', description: 'Episode number' },
        page:          { type: 'number', description: 'Page number' },
        pageSize:      { type: 'number', description: 'Items per page' },
        episodeId:     { type: 'number', description: 'Sonarr internal episode id' },
        limit:         { type: 'number' },
      },
      required: ['action'],
    },
  },

  movies: {
    name: 'movies',
    description: "Inspect movies via Radarr. action:'search'=find by name. action:'status'=view movies/queue/history. action:'releases'=find torrents.",
    parameters: {
      type: 'object',
      properties: {
        action:   { type: 'string', enum: ['search', 'status', 'releases'] },
        query:    { type: 'string' },
        view:     { type: 'string', enum: ['movies', 'queue', 'history'] },
        movieId:  { type: 'number', description: 'Radarr internal movie id' },
        limit:    { type: 'number' },
      },
      required: ['action'],
    },
  },

  downloads: {
    name: 'downloads',
    description: "Check download queues and status. action:'status'=check client queue and folders. action:'list_queue'=list active downloads in Sonarr, Radarr, or qBittorrent.",
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['status', 'list_queue'] },
        source: { type: 'string', enum: ['sonarr', 'radarr', 'qbittorrent'] },
      },
      required: ['action'],
    },
  },

  media_format: {
    name: 'media_format',
    description: "Analyze and propose media format transformations. action:'analyze'=inspect audio and subtitle streams. action:'propose'=propose a recoverable remux, subtitle conversion, or transcode job.",
    parameters: {
      type: 'object',
      properties: {
        action:      { type: 'string', enum: ['analyze', 'propose'] },
        path:        { type: 'string', description: 'Logical path to the media file' },
        job:         { type: 'string', enum: ['remux', 'subtitle-convert', 'transcode'], description: 'Job type for propose' },
        profileName: { type: 'string', description: 'Target profile name (optional, defaults per job type)' },
      },
      required: ['action'],
    },
  },

  maintenance: {
    name: 'maintenance',
    description: "Server maintenance. action:'cleanup'=preview server cleanup (dryRun is always true). action:'check_jobs'=monitor background operations by jobId.",
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

  operations: {
    name: 'operations',
    description: "Operation plans and status. action:'status'=check execution state and steps of an operation plan by planId.",
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['status'] },
        planId: { type: 'string', description: 'Operation plan identifier' },
      },
      required: ['action'],
    },
  },

  present_choices: {
    name: 'present_choices',
    description:
      "UI helper — render clickable option cards. THIS IS MANDATORY for any pick the user has to make: multi-result searches (>1 hit), release pickers with >1 result, season/episode ranges, replace-vs-keep. NEVER list options as text bullets when present_choices applies. Each item may carry mediaRef/releaseRef/selectionType so user clicks produce typed selections.",
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Optional one-line question shown above the cards. Keep brief.' },
        items: {
          type: 'array',
          minItems: 2,
          maxItems: 8,
          items: {
            type: 'object',
            properties: {
              label:         { type: 'string', description: 'Headline' },
              subtitle:      { type: 'string', description: 'Key facts' },
              meta:          { type: 'string', description: 'Optional secondary context' },
              value:         { type: 'string', description: 'Verbatim text echoed as next message' },
              mediaRef:      { type: 'string', description: 'Opaque candidate media reference' },
              releaseRef:    { type: 'string', description: 'Opaque release reference' },
              selectionType: { type: 'string', description: 'Type of selection: select_candidate, select_release, propose_download' },
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
