import { describe, expect, it } from 'vitest';
import { resolveVirtualCall, executeVirtualTool, MEDIA_FORMAT_DEFAULT_PROFILES } from './tool-router.js';
import { VIRTUAL_TOOLS, PRESENT_CHOICES_TOOL } from './virtual-tools.js';
import type { McpCallFn } from './types.js';

/** Every MCP tool the chat agent is allowed to reach (reads + proposals). */
const ALLOWED_MCP_TOOLS = new Set([
  'server_status', 'activity_log',
  'jellyfin_search', 'show_details',
  'search_media', 'media_details', 'find_releases', 'propose_download',
  'manage_library', 'manage_files', 'rename_episodes', 'propose_cleanup',
  'series_search', 'series_status', 'series_releases',
  'movie_search', 'movie_status', 'movie_releases',
  'download_status', 'cancel_downloads',
  'inspect_format', 'propose_media_job',
  'cleanup_server', 'check_jobs',
  'operation_status',
]);

/** Blocked / removed tools — routing must never produce these. */
const BLOCKED_MCP_TOOLS = new Set([
  'series_grab', 'movie_grab', 'series_remove', 'movie_remove', 'series_import', 'movie_import',
  'series_rescan', 'movie_rescan', 'download_add', 'download_direct', 'optimize_media', 'fix_subtitles',
]);

/** Parameters that only ever belonged to blocked flows; they must never be forwarded. */
const FORBIDDEN_ARG_KEYS = [
  'addTvdbId', 'addTmdbId', 'confirmToken', 'sourcePaths', 'destFolder', 'jellyfinItemId',
  'guid', 'indexerId', 'deleteFiles', 'searchNow', 'monitor', 'seasons', 'quality', 'rootFolder',
  'urls', 'url', 'packageName', 'packageIds', 'packageFolder', 'queueIds', 'torrentHashes',
  'keepAudioLangs', 'keepSubLangs', 'removeAllSubs', 'mediaPath', 'name', 'libraryType', 'folder',
];

/** Representative args covering every declared parameter plus junk the model might hallucinate. */
const REPRESENTATIVE_ARGS: Record<string, unknown> = {
  query: 'Dark', type: 'series', year: 2017, cursor: 'cur_1', page: 1, pageSize: 10, limit: 5,
  showId: 'jf-1', seasonNumber: 1, mediaRef: 'mref_abc', releaseRef: 'rref_abc', replacement: true,
  resolution: '1080p', audioLanguage: 'es', strictLanguage: true, minSeeders: 3,
  path: 'tv/Dark', paths: ['tv/Dark/Season 01/e1.mkv'], itemId: 'jf-1',
  showPath: 'tv/Dark', showName: 'Dark', startEpisodeNumber: 1,
  view: 'episodes', seriesId: 5, episodeNumber: 3, episodeId: 77, movieId: 9, source: 'qbittorrent',
  job: 'remux', profileName: 'mkv_remux', jobId: 'job-1', planId: 'plan-1',
  // junk that must never be forwarded
  addTvdbId: 1, addTmdbId: 2, confirmToken: 'tok', sourcePaths: ['a'], destFolder: 'b', jellyfinItemId: 'x',
  guid: 'g', indexerId: 1, deleteFiles: true, searchNow: true, monitor: 'all', seasons: [1], quality: 'Any', rootFolder: '/tv',
  urls: ['http://x'], url: 'http://x', packageName: 'p', packageIds: [1], packageFolder: 'f', queueIds: [1], torrentHashes: ['h'],
  keepAudioLangs: ['spa'], keepSubLangs: ['spa'], removeAllSubs: true, mediaPath: 'x', name: 'n', libraryType: 'movies', folder: '/x',
  dryRun: false,
};

function enumActions(tool: string): string[] {
  const params = VIRTUAL_TOOLS[tool].parameters as { properties: Record<string, { enum?: string[] }> };
  return params.properties.action.enum ?? [];
}

describe('resolveVirtualCall — allowlist', () => {
  it('routes every enum action of every virtual tool to an allowed, non-blocked MCP tool', () => {
    const virtualNames = Object.keys(VIRTUAL_TOOLS).filter(n => n !== PRESENT_CHOICES_TOOL);
    expect(virtualNames.length).toBeGreaterThan(0);

    for (const name of virtualNames) {
      const actions = enumActions(name);
      expect(actions.length, `${name} declares an action enum`).toBeGreaterThan(0);

      for (const action of actions) {
        const { tool, args } = resolveVirtualCall(name, { ...REPRESENTATIVE_ARGS, action });
        expect(ALLOWED_MCP_TOOLS.has(tool), `${name}.${action} → ${tool} is not allowlisted`).toBe(true);
        expect(BLOCKED_MCP_TOOLS.has(tool), `${name}.${action} must not reach ${tool}`).toBe(false);
        for (const key of FORBIDDEN_ARG_KEYS) {
          expect(args, `${name}.${action} forwards forbidden arg ${key}`).not.toHaveProperty(key);
        }
      }
    }
  });

  it('pins preview-only and read-only tools to their safe form regardless of input', () => {
    expect(resolveVirtualCall('library_ops', { action: 'rename', showPath: 'a', showName: 'A', dryRun: false }).args.dryRun).toBe(true);
    expect(resolveVirtualCall('maintenance', { action: 'cleanup', dryRun: false, confirmToken: 'tok' }).args).toEqual({ dryRun: true });
    expect(resolveVirtualCall('library_ops', { action: 'list', path: 'tv/', sourcePaths: ['x'], destFolder: 'y' }).args).toEqual({ action: 'list', path: 'tv/' });
    expect(resolveVirtualCall('downloads', { action: 'status', packageIds: [1] }).args).toEqual({ action: 'status' });
    expect(resolveVirtualCall('downloads', { action: 'list_queue', source: 'radarr', queueIds: [1] }).args).toEqual({ source: 'radarr', action: 'list' });
    expect(resolveVirtualCall('series', { action: 'search', query: 'Dark', addTvdbId: 123 }).args).toEqual({ query: 'Dark' });
    expect(resolveVirtualCall('movies', { action: 'search', query: 'Heat', addTmdbId: 123 }).args).toEqual({ query: 'Heat' });
  });
});

type Row = [virtual: string, input: Record<string, unknown>, tool: string, args: Record<string, unknown>];

const ROUTING_TABLE: Row[] = [
  ['server_info', { action: 'status', limit: 3 }, 'server_status', {}],
  ['server_info', { action: 'activity', limit: 5 }, 'activity_log', { limit: 5 }],

  ['media_query', { action: 'search', query: 'Dark', type: 'Series', page: 2, pageSize: 20 }, 'jellyfin_search', { query: 'Dark', type: 'Series', page: 2, pageSize: 20 }],
  ['media_query', { action: 'details', showId: 'jf-1', seasonNumber: 1, page: 1, pageSize: 50 }, 'show_details', { showId: 'jf-1', seasonNumber: 1, page: 1, pageSize: 50 }],

  ['catalog', { action: 'search', query: 'Dark', type: 'series', year: 2017, cursor: 'c1', pageSize: 10 }, 'search_media', { query: 'Dark', type: 'series', year: 2017, cursor: 'c1', pageSize: 10 }],
  ['catalog', { action: 'details', mediaRef: 'mref_1' }, 'media_details', { mediaRef: 'mref_1' }],
  ['catalog', { action: 'releases', mediaRef: 'mref_1', resolution: '1080p', audioLanguage: 'es', strictLanguage: true, minSeeders: 2 }, 'find_releases', { mediaRef: 'mref_1', resolution: '1080p', audioLanguage: 'es', strictLanguage: true, minSeeders: 2 }],
  ['catalog', { action: 'propose_download', releaseRef: 'rref_1', mediaRef: 'mref_1', replacement: true }, 'propose_download', { releaseRef: 'rref_1', mediaRef: 'mref_1', replacement: true }],
  ['catalog', { action: 'propose_download', releaseRef: 'rref_1' }, 'propose_download', { releaseRef: 'rref_1' }],

  ['library_ops', { action: 'scan' }, 'manage_library', { action: 'scan' }],
  ['library_ops', { action: 'list', path: 'downloads/' }, 'manage_files', { action: 'list', path: 'downloads/' }],
  ['library_ops', { action: 'list' }, 'manage_files', { action: 'list' }],
  ['library_ops', { action: 'refresh', itemId: 'jf-1' }, 'manage_library', { action: 'refresh_metadata', itemId: 'jf-1' }],
  ['library_ops', { action: 'rename', showPath: 'anime/X', showName: 'X', seasonNumber: 2, startEpisodeNumber: 5, dryRun: false }, 'rename_episodes', { showPath: 'anime/X', showName: 'X', seasonNumber: 2, startEpisodeNumber: 5, dryRun: true }],
  ['library_ops', { action: 'propose_delete', paths: ['tv/Dark', 'downloads/old.mkv'] }, 'propose_cleanup', { paths: ['tv/Dark', 'downloads/old.mkv'] }],
  ['library_ops', { action: 'propose_delete', paths: 'movies/Heat (1995)' }, 'propose_cleanup', { paths: ['movies/Heat (1995)'] }],

  ['series', { action: 'search', query: 'Dark', addTvdbId: 1, searchNow: true }, 'series_search', { query: 'Dark' }],
  ['series', { action: 'status', view: 'episodes', seriesId: 5, seasonNumber: 1, page: 1, pageSize: 50, limit: 20 }, 'series_status', { view: 'episodes', seriesId: 5, seasonNumber: 1, page: 1, pageSize: 50, limit: 20 }],
  ['series', { action: 'status' }, 'series_status', { view: 'series' }],
  ['series', { action: 'releases', seriesId: 5, seasonNumber: 4, episodeNumber: 6, episodeId: 77 }, 'series_releases', { seriesId: 5, seasonNumber: 4, episodeNumber: 6, episodeId: 77 }],

  ['movies', { action: 'search', query: 'Heat', addTmdbId: 2, searchNow: true }, 'movie_search', { query: 'Heat' }],
  ['movies', { action: 'status', view: 'queue', limit: 10 }, 'movie_status', { view: 'queue', limit: 10 }],
  ['movies', { action: 'status' }, 'movie_status', { view: 'movies' }],
  ['movies', { action: 'releases', movieId: 9 }, 'movie_releases', { movieId: 9 }],

  ['downloads', { action: 'status', packageIds: [1] }, 'download_status', { action: 'status' }],
  ['downloads', { action: 'list_queue', source: 'qbittorrent' }, 'cancel_downloads', { source: 'qbittorrent', action: 'list' }],
  ['downloads', { action: 'list_queue' }, 'cancel_downloads', { source: 'sonarr', action: 'list' }],

  ['media_format', { action: 'analyze', path: 'tv/x.mkv' }, 'inspect_format', { path: 'tv/x.mkv' }],
  ['media_format', { action: 'propose', path: 'tv/x.mkv', job: 'remux' }, 'propose_media_job', { path: 'tv/x.mkv', action: 'remux', profileName: 'mkv_remux' }],
  ['media_format', { action: 'propose', path: 'tv/x.mkv', job: 'subtitle-convert' }, 'propose_media_job', { path: 'tv/x.mkv', action: 'subtitle-convert', profileName: 'srt_subtitles' }],
  ['media_format', { action: 'propose', path: 'tv/x.mkv', job: 'transcode' }, 'propose_media_job', { path: 'tv/x.mkv', action: 'transcode', profileName: 'cpu_hevc_transcode' }],
  ['media_format', { action: 'propose', path: 'tv/x.mkv', job: 'transcode', profileName: 'cpu_av1_transcode' }, 'propose_media_job', { path: 'tv/x.mkv', action: 'transcode', profileName: 'cpu_av1_transcode' }],

  ['maintenance', { action: 'cleanup', dryRun: false, confirmToken: 'tok' }, 'cleanup_server', { dryRun: true }],
  ['maintenance', { action: 'check_jobs', jobId: 'job-1' }, 'check_jobs', { jobId: 'job-1' }],

  ['operations', { action: 'status', planId: 'plan-1' }, 'operation_status', { planId: 'plan-1' }],
];

describe('resolveVirtualCall — routing table', () => {
  it.each(ROUTING_TABLE)('%s %j → %s %j', (virtual, input, tool, args) => {
    expect(resolveVirtualCall(virtual, input)).toEqual({ tool, args });
  });
});

describe('resolveVirtualCall — blocked and unknown actions throw', () => {
  const blocked: Array<[string, string]> = [
    ['library_ops', 'delete'], ['library_ops', 'move'], ['library_ops', 'create'],
    ['series', 'add'], ['series', 'remove'], ['series', 'grab'], ['series', 'import'], ['series', 'rescan'],
    ['movies', 'add'], ['movies', 'remove'], ['movies', 'grab'], ['movies', 'import'], ['movies', 'rescan'],
    ['downloads', 'add'], ['downloads', 'direct'], ['downloads', 'organize'], ['downloads', 'delete_pyload'],
    ['downloads', 'cancel'], ['downloads', 'purge'], ['downloads', 'clean_orphans'],
    ['media_format', 'optimize'], ['media_format', 'fix_subs'],
    ['maintenance', 'apply'],
    ['catalog', 'grab'], ['catalog', 'approve'],
    ['operations', 'approve'], ['operations', 'cancel'],
    ['server_info', 'restart'],
  ];

  it.each(blocked)('%s.%s throws instead of falling through to another tool', (name, action) => {
    expect(() => resolveVirtualCall(name, { ...REPRESENTATIVE_ARGS, action })).toThrow(/Unknown virtual tool/);
  });

  it('throws for removed or unknown virtual tools', () => {
    expect(() => resolveVirtualCall('optimize', { action: 'optimize', mediaPath: 'x' })).toThrow(/Unknown virtual tool: optimize\.optimize/);
    expect(() => resolveVirtualCall(PRESENT_CHOICES_TOOL, { items: [] })).toThrow(/Unknown virtual tool/);
    expect(() => resolveVirtualCall('', { action: 'status' })).toThrow(/Unknown virtual tool/);
  });

  it('throws when the action is missing', () => {
    expect(() => resolveVirtualCall('library_ops', {})).toThrow(/Unknown virtual tool: library_ops\.undefined/);
  });

  it('rejects propose_delete without paths and propose without a valid job', () => {
    expect(() => resolveVirtualCall('library_ops', { action: 'propose_delete' })).toThrow(/requires paths/);
    expect(() => resolveVirtualCall('library_ops', { action: 'propose_delete', paths: [] })).toThrow(/requires paths/);
    expect(() => resolveVirtualCall('library_ops', { action: 'propose_delete', paths: [42] })).toThrow(/requires paths/);
    expect(() => resolveVirtualCall('media_format', { action: 'propose', path: 'x.mkv' })).toThrow(/requires job/);
    expect(() => resolveVirtualCall('media_format', { action: 'propose', path: 'x.mkv', job: 'optimize' })).toThrow(/requires job/);
  });
});

describe('executeVirtualTool', () => {
  it('calls MCP with the resolved tool and args and returns its text', async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const mcpCall: McpCallFn = async (name, args) => { calls.push({ name, args }); return '{"planId":"p1"}'; };

    const out = await executeVirtualTool('catalog', { action: 'propose_download', releaseRef: 'rref_1', mediaRef: 'mref_1' }, mcpCall);

    expect(out).toBe('{"planId":"p1"}');
    expect(calls).toEqual([{ name: 'propose_download', args: { releaseRef: 'rref_1', mediaRef: 'mref_1' } }]);
  });

  it('never invokes MCP for a blocked action', async () => {
    let invoked = 0;
    const mcpCall: McpCallFn = async () => { invoked++; return 'nope'; };

    await expect(executeVirtualTool('movies', { action: 'grab', guid: 'g', indexerId: 1 }, mcpCall)).rejects.toThrow(/Unknown virtual tool/);
    expect(invoked).toBe(0);
  });

  it('exposes the closed default profiles', () => {
    expect(MEDIA_FORMAT_DEFAULT_PROFILES).toEqual({
      remux: 'mkv_remux',
      'subtitle-convert': 'srt_subtitles',
      transcode: 'cpu_hevc_transcode',
    });
  });
});
