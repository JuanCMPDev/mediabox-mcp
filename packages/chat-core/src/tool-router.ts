/* ─── Virtual → Real MCP tool routing ───────────────────────────────────────
 * Maps virtual tool calls to real MCP tools, pinning safety flags (dryRun: true)
 * and discarding any forbidden/hallucinated parameters.
 * ──────────────────────────────────────────────────────────────────────── */
import type { McpCallFn } from './types.js';

export const MEDIA_FORMAT_DEFAULT_PROFILES = {
  remux: 'mkv_remux',
  'subtitle-convert': 'srt_subtitles',
  transcode: 'cpu_hevc_transcode',
} as const;

export type MediaFormatJob = keyof typeof MEDIA_FORMAT_DEFAULT_PROFILES;

export interface ResolvedVirtualCall {
  tool: string;
  args: Record<string, unknown>;
}

function clean<T extends Record<string, unknown>>(obj: T): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}

export function resolveVirtualCall(
  name: string,
  args: Record<string, unknown> = {},
): ResolvedVirtualCall {
  if (!name || typeof name !== 'string') {
    throw new Error(`Unknown virtual tool: ${name}`);
  }

  const action = args.action as string | undefined;
  if (!action || typeof action !== 'string') {
    throw new Error(`Unknown virtual tool: ${name}.${action}`);
  }

  switch (name) {
    case 'server_info': {
      if (action === 'status') {
        return { tool: 'server_status', args: {} };
      }
      if (action === 'activity') {
        return {
          tool: 'activity_log',
          args: clean({ limit: args.limit }),
        };
      }
      break;
    }

    case 'media_query': {
      if (action === 'search') {
        return {
          tool: 'jellyfin_search',
          args: clean({
            query: args.query,
            type: args.type,
            page: args.page,
            pageSize: args.pageSize,
          }),
        };
      }
      if (action === 'details') {
        return {
          tool: 'show_details',
          args: clean({
            showId: args.showId,
            seasonNumber: args.seasonNumber,
            page: args.page,
            pageSize: args.pageSize,
          }),
        };
      }
      break;
    }

    case 'catalog': {
      if (action === 'search') {
        return {
          tool: 'search_media',
          args: clean({
            query: args.query,
            type: args.type,
            year: args.year,
            cursor: args.cursor,
            pageSize: args.pageSize,
          }),
        };
      }
      if (action === 'details') {
        return {
          tool: 'media_details',
          args: clean({
            mediaRef: args.mediaRef,
          }),
        };
      }
      if (action === 'releases') {
        return {
          tool: 'find_releases',
          args: clean({
            mediaRef: args.mediaRef,
            resolution: args.resolution,
            audioLanguage: args.audioLanguage,
            strictLanguage: args.strictLanguage,
            minSeeders: args.minSeeders,
          }),
        };
      }
      if (action === 'propose_download') {
        return {
          tool: 'propose_download',
          args: clean({
            releaseRef: args.releaseRef,
            mediaRef: args.mediaRef,
            replacement: args.replacement,
          }),
        };
      }
      break;
    }

    case 'library_ops': {
      if (action === 'scan') {
        return { tool: 'manage_library', args: { action: 'scan' } };
      }
      if (action === 'list') {
        return {
          tool: 'manage_files',
          args: clean({
            action: 'list',
            path: args.path,
          }),
        };
      }
      if (action === 'refresh') {
        return {
          tool: 'manage_library',
          args: clean({
            action: 'refresh_metadata',
            itemId: args.itemId,
          }),
        };
      }
      if (action === 'rename') {
        return {
          tool: 'rename_episodes',
          args: clean({
            showPath: args.showPath,
            showName: args.showName,
            seasonNumber: args.seasonNumber,
            startEpisodeNumber: args.startEpisodeNumber,
            dryRun: true,
          }),
        };
      }
      if (action === 'propose_delete') {
        let paths: unknown = args.paths;
        if (typeof paths === 'string' && paths.trim().length > 0) {
          paths = [paths];
        }
        if (
          !Array.isArray(paths) ||
          paths.length === 0 ||
          !paths.every(p => typeof p === 'string' && p.trim().length > 0)
        ) {
          throw new Error('library_ops.propose_delete requires paths: string | string[]');
        }
        return {
          tool: 'propose_cleanup',
          args: { paths },
        };
      }
      break;
    }

    case 'series': {
      if (action === 'search') {
        return {
          tool: 'series_search',
          args: clean({
            query: args.query,
          }),
        };
      }
      if (action === 'status') {
        return {
          tool: 'series_status',
          args: clean({
            view: args.view ?? 'series',
            seriesId: args.seriesId,
            seasonNumber: args.seasonNumber,
            page: args.page,
            pageSize: args.pageSize,
            limit: args.limit,
          }),
        };
      }
      if (action === 'releases') {
        return {
          tool: 'series_releases',
          args: clean({
            seriesId: args.seriesId,
            seasonNumber: args.seasonNumber,
            episodeNumber: args.episodeNumber,
            episodeId: args.episodeId,
          }),
        };
      }
      break;
    }

    case 'movies': {
      if (action === 'search') {
        return {
          tool: 'movie_search',
          args: clean({
            query: args.query,
          }),
        };
      }
      if (action === 'status') {
        return {
          tool: 'movie_status',
          args: clean({
            view: args.view ?? 'movies',
            limit: args.limit,
          }),
        };
      }
      if (action === 'releases') {
        return {
          tool: 'movie_releases',
          args: clean({
            movieId: args.movieId,
          }),
        };
      }
      break;
    }

    case 'downloads': {
      if (action === 'status') {
        return {
          tool: 'download_status',
          args: { action: 'status' },
        };
      }
      if (action === 'list_queue') {
        return {
          tool: 'cancel_downloads',
          args: clean({
            source: args.source ?? 'sonarr',
            action: 'list',
          }),
        };
      }
      break;
    }

    case 'media_format': {
      if (action === 'analyze') {
        return {
          tool: 'inspect_format',
          args: clean({
            path: args.path,
          }),
        };
      }
      if (action === 'propose') {
        const job = args.job as MediaFormatJob | undefined;
        if (!job || !['remux', 'subtitle-convert', 'transcode'].includes(job)) {
          throw new Error('media_format.propose requires job: remux | subtitle-convert | transcode');
        }
        const profileName = (args.profileName as string | undefined) ?? MEDIA_FORMAT_DEFAULT_PROFILES[job];
        return {
          tool: 'propose_media_job',
          args: clean({
            path: args.path,
            action: job,
            profileName,
          }),
        };
      }
      break;
    }

    case 'maintenance': {
      if (action === 'cleanup') {
        return {
          tool: 'cleanup_server',
          args: { dryRun: true },
        };
      }
      if (action === 'check_jobs') {
        return {
          tool: 'check_jobs',
          args: clean({
            jobId: args.jobId,
          }),
        };
      }
      break;
    }

    case 'operations': {
      if (action === 'status') {
        return {
          tool: 'operation_status',
          args: clean({
            planId: args.planId,
          }),
        };
      }
      break;
    }
  }

  throw new Error(`Unknown virtual tool: ${name}.${action}`);
}

export async function executeVirtualTool(
  name: string,
  args: Record<string, unknown>,
  mcpCall: McpCallFn,
): Promise<string> {
  const resolved = resolveVirtualCall(name, args);
  return mcpCall(resolved.tool, resolved.args);
}

