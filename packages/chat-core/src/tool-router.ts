/* ─── Virtual → Real MCP tool routing ───────────────────────────────────────
 * Mirrors the executeVirtualTool() function from @mediabox/mcp-telegram-client.
 * The mcpCall parameter decouples routing from transport (loopback HTTP, in-process, etc.).
 * ──────────────────────────────────────────────────────────────────────── */
import type { McpCallFn } from './types.js';

export async function executeVirtualTool(
  name: string,
  args: Record<string, unknown>,
  mcpCall: McpCallFn,
): Promise<string> {
  const action = args.action as string;
  const { action: _a, ...params } = args;

  switch (name) {
    case 'server_info':
      if (action === 'status') return mcpCall('server_status', {});
      return mcpCall('activity_log', params);

    case 'media_query':
      if (action === 'details')
        return mcpCall('show_details', {
          showId: params.showId, seasonNumber: params.seasonNumber,
          page: params.page, pageSize: params.pageSize,
        });
      return mcpCall('search_media', {
        query: params.query, type: params.type,
        page: params.page, pageSize: params.pageSize,
      });

    case 'library_ops':
      if (action === 'scan')    return mcpCall('manage_library', { action: 'scan' });
      if (action === 'create')  return mcpCall('manage_library', { action: 'create', name: params.name, type: params.libraryType, folder: params.folder });
      if (action === 'refresh') return mcpCall('manage_library', { action: 'refresh_metadata', itemId: params.itemId });
      if (action === 'rename')  return mcpCall('rename_episodes', params);
      return mcpCall('manage_files', { action, ...params });

    case 'series':
      if (action === 'search' || action === 'add')
        return mcpCall('series_search', { ...params, searchNow: params.searchNow ?? false });
      if (action === 'status')
        return mcpCall('series_status', { view: params.view ?? 'series', seriesId: params.seriesId, seasonNumber: params.seasonNumber, page: params.page, pageSize: params.pageSize, limit: params.limit });
      if (action === 'remove')   return mcpCall('series_remove', params);
      if (action === 'releases') return mcpCall('series_releases', { seriesId: params.seriesId, seasonNumber: params.seasonNumber, episodeNumber: params.episodeNumber, episodeId: params.episodeId });
      if (action === 'grab')     return mcpCall('series_grab', { guid: params.guid, indexerId: params.indexerId, seriesId: params.seriesId, seasonNumber: params.seasonNumber, episodeNumber: params.episodeNumber, episodeId: params.episodeId });
      break;

    case 'movies':
      if (action === 'search' || action === 'add')
        return mcpCall('movie_search', { ...params, searchNow: params.searchNow ?? false });
      if (action === 'status')   return mcpCall('movie_status', params);
      if (action === 'remove')   return mcpCall('movie_remove', params);
      if (action === 'releases') return mcpCall('movie_releases', params);
      if (action === 'grab')     return mcpCall('movie_grab', params);
      break;

    case 'downloads':
      if (action === 'direct')
        return mcpCall('download_direct', { url: params.url, showName: params.showName, libraryFolder: params.libraryFolder, seasonNumber: params.seasonNumber, episodeNumber: params.episodeNumber });
      if (action === 'add')
        return mcpCall('download_add', { urls: params.urls, packageName: params.packageName });
      if (action === 'status')
        return mcpCall('download_status', { action: 'status' });
      if (action === 'organize')
        return mcpCall('download_status', { action: 'organize', packageFolder: params.packageFolder, showName: params.showName, libraryFolder: params.libraryFolder, seasonNumber: params.seasonNumber, episodeNumber: params.episodeNumber, archivePassword: params.archivePassword });
      if (action === 'delete_pyload')
        return mcpCall('download_status', { action: 'delete', packageIds: params.packageIds });
      if (action === 'list_queue')
        return mcpCall('cancel_downloads', { source: params.source ?? 'sonarr', action: 'list' });
      if (action === 'cancel')
        return mcpCall('cancel_downloads', { source: params.source ?? 'sonarr', action: 'cancel', queueIds: params.queueIds, torrentHashes: params.torrentHashes });
      if (action === 'purge')
        return mcpCall('cancel_downloads', { source: params.source ?? 'sonarr', action: 'purge_duplicates' });
      if (action === 'clean_orphans')
        return mcpCall('cancel_downloads', { source: 'qbittorrent', action: 'clean_orphans' });
      break;

    case 'optimize':
      if (action === 'fix_subs')
        return mcpCall('fix_subtitles', { mediaPath: params.mediaPath, dryRun: params.dryRun ?? true });
      return mcpCall('optimize_media', { action: action === 'analyze' ? 'analyze' : 'optimize', ...params });

    case 'maintenance':
      if (action === 'check_jobs') return mcpCall('check_jobs', { jobId: params.jobId });
      return mcpCall('cleanup_server', { dryRun: params.dryRun ?? true });
  }

  throw new Error(`Unknown virtual tool: ${name}.${action}`);
}
