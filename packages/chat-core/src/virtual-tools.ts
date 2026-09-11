/* ─── Virtual tools presented to the LLM ─────────────────────────────────────
 * High-level action-based virtual tools wrapping real MCP tools. Descriptions
 * are concise to respect the per-phase schema budget of <= 1200 tokens.
 * ──────────────────────────────────────────────────────────────────────── */
import type { VirtualToolDef } from './types.js';

export const VIRTUAL_TOOLS: Record<string, VirtualToolDef> = {
  server_info: {
    name: 'server_info',
    description: 'Server status and playback activity. status=overview, activity=recent history.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['status', 'activity'] },
        limit:  { type: 'number', description: 'Activity entries limit' },
      },
      required: ['action'],
    },
  },

  media_query: {
    name: 'media_query',
    description: 'Search or list Jellyfin library content, seasons, and episodes.',
    parameters: {
      type: 'object',
      properties: {
        action:       { type: 'string', enum: ['search', 'details'] },
        query:        { type: 'string', description: 'Search title' },
        type:         { type: 'string', enum: ['Movie', 'Series', 'Episode', 'Audio'] },
        showId:       { type: 'string', description: 'Jellyfin item ID' },
        seasonNumber: { type: 'number', description: 'Season filter' },
        page:         { type: 'number' },
        pageSize:     { type: 'number' },
      },
      required: ['action'],
    },
  },

  catalog: {
    name: 'catalog',
    description: 'Unified media catalog and releases. search=find, details=item info, releases=find releases, propose_download=propose download.',
    parameters: {
      type: 'object',
      properties: {
        action:         { type: 'string', enum: ['search', 'details', 'releases', 'propose_download'] },
        query:          { type: 'string' },
        type:           { type: 'string', description: 'movie or series' },
        year:           { type: 'number' },
        cursor:         { type: 'string' },
        page:           { type: 'number' },
        pageSize:       { type: 'number' },
        mediaRef:       { type: 'string', description: 'Opaque media token' },
        releaseRef:     { type: 'string', description: 'Opaque release token' },
        replacement:    { type: 'boolean' },
        resolution:     { type: 'string' },
        audioLanguage:  { type: 'string' },
        strictLanguage: { type: 'boolean' },
        minSeeders:     { type: 'number' },
      },
      required: ['action'],
    },
  },

  library_ops: {
    name: 'library_ops',
    description: 'Manage files and libraries. scan=refresh, list=browse, refresh=metadata, rename=preview names, propose_delete=propose deletion.',
    parameters: {
      type: 'object',
      properties: {
        action:             { type: 'string', enum: ['scan', 'list', 'refresh', 'rename', 'propose_delete'] },
        path:               { type: 'string', description: 'File path' },
        paths:              { description: 'Path or array of paths to propose for deletion' },
        showPath:           { type: 'string' },
        showName:           { type: 'string' },
        seasonNumber:       { type: 'number' },
        startEpisodeNumber: { type: 'number' },
        dryRun:             { type: 'boolean' },
        itemId:             { type: 'string' },
      },
      required: ['action'],
    },
  },

  series: {
    name: 'series',
    description: 'Inspect TV series via Sonarr. search=find, status=details/queue/history, releases=find releases.',
    parameters: {
      type: 'object',
      properties: {
        action:        { type: 'string', enum: ['search', 'status', 'releases'] },
        query:         { type: 'string' },
        view:          { type: 'string', enum: ['series', 'episodes', 'calendar', 'missing', 'queue', 'history'] },
        seriesId:      { type: 'number' },
        seasonNumber:  { type: 'number' },
        episodeNumber: { type: 'number' },
        page:          { type: 'number' },
        pageSize:      { type: 'number' },
        episodeId:     { type: 'number' },
        limit:         { type: 'number' },
      },
      required: ['action'],
    },
  },

  movies: {
    name: 'movies',
    description: 'Inspect movies via Radarr. search=find, status=details/queue/history, releases=find releases.',
    parameters: {
      type: 'object',
      properties: {
        action:   { type: 'string', enum: ['search', 'status', 'releases'] },
        query:    { type: 'string' },
        view:     { type: 'string', enum: ['movies', 'queue', 'history'] },
        movieId:  { type: 'number' },
        limit:    { type: 'number' },
      },
      required: ['action'],
    },
  },

  downloads: {
    name: 'downloads',
    description: 'Check download queues and status in clients.',
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
    description: 'Analyze streams and propose format transformations. analyze=inspect streams, propose=propose remux/transcode job.',
    parameters: {
      type: 'object',
      properties: {
        action:      { type: 'string', enum: ['analyze', 'propose'] },
        path:        { type: 'string' },
        job:         { type: 'string', enum: ['remux', 'subtitle-convert', 'transcode'] },
        profileName: { type: 'string' },
      },
      required: ['action'],
    },
  },

  maintenance: {
    name: 'maintenance',
    description: 'Server maintenance and background jobs. cleanup=preview cleanup, check_jobs=job status.',
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
    description: 'Operation plans. status=check execution state and steps of an operation plan by planId.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['status'] },
        planId: { type: 'string' },
      },
      required: ['action'],
    },
  },

  present_choices: {
    name: 'present_choices',
    description: 'Render clickable choice cards for disambiguation and selection.',
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Question shown above cards' },
        items: {
          type: 'array',
          minItems: 2,
          maxItems: 8,
          items: {
            type: 'object',
            properties: {
              label:         { type: 'string' },
              subtitle:      { type: 'string' },
              meta:          { type: 'string' },
              value:         { type: 'string' },
              mediaRef:      { type: 'string' },
              releaseRef:    { type: 'string' },
              selectionType: { type: 'string' },
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
