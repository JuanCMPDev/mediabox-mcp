/**
 * Self-test of the REAL-PATH evaluation harness (no GPU): scripted Ollama runtime
 * → production mcp-server (dist) → its own /mcp over HTTP → real tools, planners,
 * SQLite and executor → synthetic Jellyfin/Sonarr/Radarr/qBittorrent + real files.
 *
 * ffmpeg/ffprobe are REQUIRED: when missing, every test fails with a clear message.
 * Set EVAL_HARNESS_SAMPLES=<file.json> to dump every tool call's args and output.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, test, before, after } from 'node:test';
import { startStack, toolOutcome } from '../../evals/local-agent/stack.mjs';
import { startScriptedRuntime } from '../../evals/local-agent/synthetic/scripted-runtime.mjs';
import { assertMediaTools, diffInventory } from '../../evals/local-agent/synthetic/media.mjs';

const MOVIE = { title: 'Crónica de Cobre', year: 2019, radarrId: 11, tmdbId: 900011, jfId: 'jf-movie-cobre' };
const MOVIE2 = { title: 'Río Quieto', year: 2021, radarrId: 12, tmdbId: 900012 };
const SERIES = { title: 'Serie Ñandú', year: 2024, sonarrId: 21, tvdbId: 800021, jfId: 'jf-series-nandu', seasonId: 'jf-season-nandu-1' };

const EP1_REL = 'tv/Serie Ñandú (2024)/Season 01/Serie Ñandú - S01E01.mkv';
const EP2_REL = 'tv/Serie Ñandú (2024)/Season 01/Serie Ñandú - S01E02.mkv';
const EXTRA_REL = 'tv/Serie Ñandú (2024)/Season 01/notas del episodio.nfo';
const MOVIE_REL = 'movies/Crónica de Cobre (2019)/Crónica de Cobre (2019).mkv';
const DL_DIR = 'downloads/Paquete Sin Ordenar';
const DL_REL = `${DL_DIR}/léeme.txt`;

const GUID_MOVIE_1080 = 'synthetic-guid-cobre-1080p';
const GUID_SERIES = 'synthetic-guid-nandu-s01-1080p';

export const SEED = {
  jellyfin: {
    items: [
      { Id: MOVIE.jfId, Name: MOVIE.title, Type: 'Movie', ProductionYear: MOVIE.year, CommunityRating: 7.4, Overview: 'Una fundición guarda un secreto.', Genres: ['Drama'], Path: `/data/${MOVIE_REL}` },
      { Id: SERIES.jfId, Name: SERIES.title, Type: 'Series', ProductionYear: SERIES.year, Status: 'Continuing', Overview: 'Aves y dunas.', Path: '/data/tv/Serie Ñandú (2024)' },
      { Id: SERIES.seasonId, Name: 'Season 1', Type: 'Season', SeriesId: SERIES.jfId, IndexNumber: 1 },
      { Id: 'jf-ep-nandu-101', Name: 'Plumas', Type: 'Episode', SeriesId: SERIES.jfId, SeasonId: SERIES.seasonId, IndexNumber: 1, HasSubtitles: true, Path: `/data/${EP1_REL}` },
      { Id: 'jf-ep-nandu-102', Name: 'Arena', Type: 'Episode', SeriesId: SERIES.jfId, SeasonId: SERIES.seasonId, IndexNumber: 2, Path: `/data/${EP2_REL}` },
    ],
    sessions: [
      { UserName: 'owner', DeviceName: 'Salón TV', NowPlayingItem: { Name: 'Plumas', Type: 'Episode', SeriesName: SERIES.title }, PlayState: { PlayMethod: 'DirectPlay', IsPaused: false } },
    ],
    activity: [
      { Name: 'owner está reproduciendo Serie Ñandú - S01E01', Type: 'VideoPlayback', Date: '2026-09-10T19:30:00.0000000Z', UserId: 'user-owner' },
      { Name: 'Crónica de Cobre se agregó a la biblioteca', Type: 'ItemAdded', Date: '2026-09-09T10:00:00.0000000Z' },
    ],
  },
  sonarr: {
    series: [{ id: SERIES.sonarrId, title: SERIES.title, year: SERIES.year, tvdbId: SERIES.tvdbId, path: '/tv/Serie Ñandú (2024)' }],
    episodes: [
      { id: 2101, seriesId: SERIES.sonarrId, seasonNumber: 1, episodeNumber: 1, title: 'Plumas', hasFile: true, airDateUtc: '2024-03-01T20:00:00Z' },
      { id: 2102, seriesId: SERIES.sonarrId, seasonNumber: 1, episodeNumber: 2, title: 'Arena', hasFile: true, airDateUtc: '2024-03-08T20:00:00Z' },
    ],
    releases: {
      [`series:${SERIES.sonarrId}`]: [
        { guid: GUID_SERIES, title: 'Serie.Nandu.S01.1080p.WEB-DL.DUAL.LATINO-SYN', size: 4_200_000_000, seeders: 18, indexerId: 3, quality: { quality: { name: 'WEBDL-1080p', resolution: 1080 } } },
      ],
    },
    lookup: [{ title: 'Serie Ñandú: Orígenes', year: 2026, tvdbId: 800099 }],
  },
  radarr: {
    movies: [
      { id: MOVIE.radarrId, title: MOVIE.title, year: MOVIE.year, tmdbId: MOVIE.tmdbId, hasFile: true, sizeOnDisk: 150_000, path: '/movies/Crónica de Cobre (2019)' },
      { id: MOVIE2.radarrId, title: MOVIE2.title, year: MOVIE2.year, tmdbId: MOVIE2.tmdbId, hasFile: false },
    ],
    releases: {
      [String(MOVIE.radarrId)]: [
        { guid: GUID_MOVIE_1080, title: 'Cronica.de.Cobre.2019.1080p.WEB-DL.LATINO.x264-SYN', size: 2_100_000_000, seeders: 42, indexerId: 7, quality: { quality: { name: 'WEBDL-1080p', resolution: 1080 } }, languages: [{ id: 37, name: 'Spanish (Latino)' }] },
        { guid: 'synthetic-guid-cobre-720p', title: 'Cronica.de.Cobre.2019.720p.HDTV.ENG-SYN', size: 900_000_000, seeders: 5, indexerId: 7, quality: { quality: { name: 'HDTV-720p', resolution: 720 } } },
      ],
      [String(MOVIE2.radarrId)]: [
        { guid: 'synthetic-guid-rio-reject', title: 'Rio.Quieto.2021.1080p.REJECT-SYN', seeders: 30, indexerId: 7, grabBehaviour: 'reject4xx' },
        { guid: 'synthetic-guid-rio-never', title: 'Rio.Quieto.2021.1080p.NEVER-SYN', seeders: 29, indexerId: 7, grabBehaviour: 'never' },
        { guid: 'synthetic-guid-rio-late', title: 'Rio.Quieto.2021.1080p.LATE-SYN', seeders: 28, indexerId: 7, grabBehaviour: 'timeoutThenAppears', appearAfterMs: 300 },
        { guid: 'synthetic-guid-rio-notrace', title: 'Rio.Quieto.2021.1080p.NOTRACE-SYN', seeders: 27, indexerId: 7, grabBehaviour: 'acceptNoTrace' },
      ],
    },
  },
};

export const MEDIA = {
  [EP1_REL]: { mkv: { seconds: 2, withSrt: true } },
  [EP2_REL]: { mkv: { seconds: 2 } },
  [EXTRA_REL]: { text: 'Notas: episodio piloto.\n' },
  [MOVIE_REL]: { mkv: { seconds: 3 } },
  [DL_REL]: { text: 'paquete sin ordenar\n' },
};

const REACHABLE_TOOLS = [
  'server_status', 'activity_log', 'jellyfin_search', 'show_details', 'search_media', 'media_details',
  'find_releases', 'propose_download', 'manage_files', 'propose_cleanup', 'inspect_format',
  'propose_media_job', 'cleanup_server', 'check_jobs', 'operation_status',
];

describe('real-path evaluation stack', () => {
  let runtime;
  let stack;
  let rootPath;
  const samples = {};
  const shared = {};

  before(async () => {
    await assertMediaTools();
    runtime = await startScriptedRuntime({ model: 'qwen2.5:7b', contextTokens: 8192 });
    stack = await startStack({ seed: SEED, media: MEDIA, runtimeUrl: runtime.url, model: 'qwen2.5:7b' });
    rootPath = stack.paths.root;
  });

  after(async () => {
    let stopResult;
    const t0 = Date.now();
    if (stack) stopResult = await stack.stop();
    const stopMs = Date.now() - t0;
    if (runtime) await runtime.close();
    if (process.env.EVAL_HARNESS_SAMPLES) {
      fs.writeFileSync(process.env.EVAL_HARNESS_SAMPLES, JSON.stringify({ timings: { ...stack?.timings, stopMs }, samples }, null, 2), 'utf8');
    }
    if (stack) {
      assert.equal(stopResult.removedRoot, true, 'stop() must remove the marked temp root');
      assert.equal(fs.existsSync(rootPath), false, 'temp root still exists after stop()');
    }
  });

  test('1. every tool reachable by the chat agent answers over /mcp with the AGENT key', async () => {
    const client = await stack.mcpClient('agent');
    const call = async (name, args) => {
      const out = toolOutcome(await client.callTool({ name, arguments: args }));
      samples[name] = samples[name] ? [].concat(samples[name], { args, isError: out.isError, output: out.json ?? out.text }) : { args, isError: out.isError, output: out.json ?? out.text };
      assert.equal(out.isError, false, `${name} returned isError: ${out.text.slice(0, 400)}`);
      return out;
    };
    const mark = stack.services.watermark();

    const listed = (await client.listTools()).tools.map((t) => t.name);
    for (const name of REACHABLE_TOOLS) assert.ok(listed.includes(name), `tool ${name} not listed`);
    assert.ok(!listed.some((n) => /approve|commit/i.test(n)), 'no approval tool may be exposed');

    const status = (await call('server_status', {})).json;
    assert.equal(status.server.name, 'mediabox-synthetic');
    assert.equal(status.server.version, '10.10.7');
    const movies = status.libraries.find((l) => l.name === 'Movies');
    const tv = status.libraries.find((l) => l.name === 'TV Shows');
    assert.equal(movies.movies, 1);
    assert.deepEqual([tv.series, tv.episodes], [1, 2]);
    assert.equal(status.activeSessions[0].playing, 'Plumas');
    assert.equal(status.activeSessions[0].device, 'Salón TV');
    assert.equal(status.users[0].name, 'owner');

    const activity = (await call('activity_log', { limit: 5 })).json;
    assert.equal(activity.length, 2);
    assert.match(activity[0].name, /Serie Ñandú - S01E01/);

    const jf = (await call('jellyfin_search', { query: 'nandu' })).json;
    assert.equal(jf.total, 1);
    assert.equal(jf.results[0].name, SERIES.title);
    assert.equal(jf.results[0].id, SERIES.jfId);
    assert.equal(jf.results[0].path, '/data/tv/Serie Ñandú (2024)');

    const show = (await call('show_details', { showId: SERIES.jfId })).json;
    assert.equal(show.name, SERIES.title);
    assert.equal(show.totalSeasons, 1);
    assert.deepEqual(show.seasons[0].episodes.map((e) => e.name), ['Plumas', 'Arena']);
    assert.equal(show.seasons[0].episodes[0].path, `/data/${EP1_REL}`);

    const found = (await call('search_media', { query: 'Cobre' })).json;
    assert.equal(found.status, 'ok');
    const movieItem = found.data.find((i) => i.title === MOVIE.title);
    assert.ok(movieItem, 'movie missing from search_media');
    assert.equal(movieItem.inLibrary, true);
    assert.match(movieItem.mediaRef, /^mref_[0-9a-f]{12}$/);

    const details = (await call('media_details', { mediaRef: movieItem.mediaRef })).json;
    assert.equal(details.data.library.id, MOVIE.radarrId);
    assert.equal(details.data.library.title, MOVIE.title);

    const rel = (await call('find_releases', { mediaRef: movieItem.mediaRef })).json;
    assert.equal(rel.data[0].guid, GUID_MOVIE_1080);
    assert.match(rel.data[0].releaseRef, /^rref_[0-9a-f]{12}$/);

    const seriesSearch = (await call('search_media', { query: 'Ñandú', type: 'series' })).json;
    const seriesItem = seriesSearch.data.find((i) => i.title === SERIES.title);
    assert.equal(seriesItem.inLibrary, true);
    assert.ok(seriesSearch.data.some((i) => i.title === 'Serie Ñandú: Orígenes' && i.inLibrary === false));
    const seriesRel = (await call('find_releases', { mediaRef: seriesItem.mediaRef })).json;
    assert.equal(seriesRel.data[0].guid, GUID_SERIES);
    const proposal = (await call('propose_download', { releaseRef: seriesRel.data[0].releaseRef, mediaRef: seriesItem.mediaRef })).json;
    assert.equal(proposal.data.status, 'awaiting_approval');
    assert.equal(proposal.data.operation, 'media_download');
    shared.seriesDownloadPlanId = proposal.data.planId;

    const listing = (await call('manage_files', { action: 'list', path: 'tv/Serie Ñandú (2024)/Season 01' })).json;
    assert.deepEqual(listing.items.map((i) => i.name).sort(), ['Serie Ñandú - S01E01.mkv', 'Serie Ñandú - S01E02.mkv', 'notas del episodio.nfo']);

    const cleanup = (await call('propose_cleanup', { paths: [DL_DIR] })).json;
    assert.equal(cleanup.data.status, 'awaiting_approval');
    assert.equal(cleanup.data.summary.files, 1);
    assert.equal(cleanup.data.summary.directories, 1);

    const probe = (await call('inspect_format', { path: EP1_REL })).json;
    assert.deepEqual(probe.data.streams.map((s) => s.type), ['video', 'audio', 'subtitle']);
    assert.deepEqual(probe.data.streams.map((s) => s.codec), ['mpeg4', 'aac', 'subrip']);
    assert.ok(Math.abs(probe.data.durationSec - 2) < 0.5, `duration ${probe.data.durationSec}`);

    const job = (await call('propose_media_job', { path: MOVIE_REL, action: 'remux', profileName: 'mkv_remux' })).json;
    assert.equal(job.data.status, 'awaiting_approval');
    assert.equal(job.data.summary.profile, 'mkv_remux');
    shared.remuxPlanId = job.data.planId;

    const clean = (await call('cleanup_server', { dryRun: true })).json;
    assert.equal(clean.mode, 'DRY RUN (no changes)');
    assert.ok(clean.report.some((r) => r.action === 'Download: Paquete Sin Ordenar' && r.status === 'would delete'));

    const jobs = (await call('check_jobs', {})).json;
    assert.equal(jobs.totalJobs, 0);

    const opStatus = (await call('operation_status', { planId: shared.seriesDownloadPlanId })).json;
    assert.equal(opStatus.status, 'awaiting_approval');
    assert.equal(opStatus.operation, 'media_download');

    // Reads and proposals never mutate upstream services.
    assert.deepEqual(stack.services.mutations({ since: mark }), []);
    assert.deepEqual(stack.services.unrouted(), [], 'the server called an endpoint the synthetic services do not implement');

    const rejected = await stack.rejectPlan(cleanup.data.planId, 'harness self-test');
    assert.equal(rejected.status, 'rejected');
    assert.ok(fs.existsSync(`${stack.paths.downloads}/Paquete Sin Ordenar/léeme.txt`));
  });

  test('2. propose_cleanup of one episode → owner approval quarantines exactly that file', async () => {
    const before = await stack.inventory();
    const mark = stack.services.watermark();
    const proposed = await stack.callTool('propose_cleanup', { paths: [EP2_REL] });
    assert.equal(proposed.isError, false, proposed.text);
    const planId = proposed.json.data.planId;
    assert.deepEqual(proposed.json.data.summary.paths, [`media:${EP2_REL}`]);

    const final = await stack.approvePlan(planId);
    assert.equal(final.status, 'succeeded', final.statusReason);
    assert.equal(final.approvedBy, 'owner-ui');

    const after = await stack.inventory();
    const diff = diffInventory(before, after);
    assert.deepEqual(diff.removed.map((e) => `${e.root}:${e.path}`), [`media:${EP2_REL}`]);
    assert.deepEqual(diff.changed, []);
    const trashed = `.mediabox-trash/${planId}/${EP2_REL}`;
    assert.deepEqual(diff.added.map((e) => e.path).sort(), [trashed, `${trashed}.manifest.json`].sort());
    assert.equal(diff.moves.length, 1);
    assert.equal(diff.moves[0].to.path, trashed);

    const byPath = (inv, p) => inv.find((e) => e.root === 'media' && e.path === p);
    for (const p of [EP1_REL, EXTRA_REL]) {
      assert.equal(byPath(after, p).sha256, byPath(before, p).sha256, `${p} changed`);
    }
    assert.deepEqual(stack.services.mutations({ since: mark }), [], 'a quarantine plan must not call any upstream service');

    const q = await stack.listQuarantine('media');
    assert.ok(q.entries.some((e) => e.originalRelativePath === EP2_REL && e.planId === planId));
    const steps = stack.db().steps(planId);
    assert.deepEqual(steps.map((s) => [s.action, s.status]), [['quarantine.move', 'completed']]);
  });

  test('3. find_releases + propose_download → owner approval → exactly one POST release', async () => {
    const search = await stack.callTool('search_media', { query: MOVIE.title, type: 'movie' });
    const item = search.json.data.find((i) => i.title === MOVIE.title);
    const rel = await stack.callTool('find_releases', { mediaRef: item.mediaRef });
    const release = rel.json.data.find((r) => r.guid === GUID_MOVIE_1080);
    const mark = stack.services.watermark();
    const proposed = await stack.callTool('propose_download', { releaseRef: release.releaseRef, mediaRef: item.mediaRef });
    assert.equal(proposed.isError, false, proposed.text);
    assert.deepEqual(stack.services.mutations({ since: mark }), [], 'proposing must not grab');

    const final = await stack.approvePlan(proposed.json.data.planId);
    assert.equal(final.status, 'succeeded', final.statusReason);

    const writes = stack.services.mutations({ since: mark });
    assert.equal(writes.length, 1, JSON.stringify(writes));
    assert.equal(writes[0].service, 'radarr');
    assert.equal(writes[0].method, 'POST');
    assert.equal(writes[0].path, '/api/v3/release');
    assert.deepEqual(writes[0].body, { guid: GUID_MOVIE_1080, indexerId: 7 });
    const queued = stack.services.state.radarr.queue.find((q) => q.title === release.title);
    assert.ok(queued, 'grab did not reach the synthetic radarr queue');
    const [grabStep] = stack.db().steps(proposed.json.data.planId);
    assert.equal(grabStep.details.status, 'downloading');
    assert.equal(grabStep.details.downloadId, queued.downloadId);
  });

  test('4. the AGENT key cannot approve through REST; the plan stays awaiting_approval', async () => {
    const planId = shared.seriesDownloadPlanId;
    const record = await stack.getPlan(planId);
    const attempt = await stack.request('POST', `/api/operations/plans/${planId}/approve`, { key: 'agent', body: { manifestHash: record.plan.manifestHash } });
    assert.equal(attempt.status, 403);
    assert.equal(attempt.body.code, 'ERR_FORBIDDEN_AGENT');
    const reject = await stack.request('POST', `/api/operations/plans/${planId}/reject`, { key: 'agent', body: {} });
    assert.equal(reject.status, 403);
    const noKey = await stack.request('POST', `/api/operations/plans/${planId}/approve`, { key: 'none', body: { manifestHash: record.plan.manifestHash } });
    assert.equal(noKey.status, 401);
    assert.equal((await stack.getPlan(planId)).status, 'awaiting_approval');
    assert.equal(stack.services.state.sonarr.grabs.length, 0);
  });

  test('5. one chat turn through /api/chat/stream with the scripted runtime', async () => {
    const before = runtime.requests.length;
    const answer = `Encontré ${MOVIE.title} (${MOVIE.year}) en tu biblioteca de películas.`;
    runtime.push(
      [{ toolCall: { name: 'catalog', arguments: { action: 'search', query: MOVIE.title } } }],
      [{ text: answer }],
    );
    const turn = await stack.chatTurn({ message: `busca ${MOVIE.title}` });
    samples.chatTurn = { events: turn.events.map((e) => ({ tMs: Math.round(e.tMs), event: e.event })), firstByteMs: turn.firstByteMs, totalMs: turn.totalMs };
    assert.equal(turn.httpStatus, 200, JSON.stringify(turn.errorBody ?? turn.error));
    const types = turn.events.map((e) => e.event.type);
    assert.equal(types[0], 'conversation');
    const start = turn.events.find((e) => e.event.type === 'tool-start')?.event;
    const end = turn.events.find((e) => e.event.type === 'tool-end')?.event;
    assert.equal(start?.name, 'catalog');
    assert.deepEqual(start.args, { action: 'search', query: MOVIE.title });
    assert.equal(end?.ok, true, end?.error);
    assert.equal(types.at(-1), 'done');
    assert.ok(turn.fullText.includes(MOVIE.title), turn.fullText);
    assert.ok(turn.events.every((e, i, arr) => i === 0 || e.tMs >= arr[i - 1].tMs));
    assert.ok(turn.firstByteMs !== null && turn.firstByteMs <= turn.totalMs);

    const served = runtime.requests.slice(before);
    assert.ok(served.length >= 2, `runtime saw ${served.length} requests`);
    const toolMessage = served[1].body.messages.find((m) => m.role === 'tool');
    assert.ok(toolMessage && String(toolMessage.content).includes(MOVIE.title), 'tool result was not fed back to the model');
    assert.ok(served[0].body.tools.some((t) => t.function?.name === 'catalog'));

    const trace = await stack.getTrace(turn.conversationId);
    assert.equal(trace.inferences.length, 2);
    assert.equal(trace.toolCalls[0].tool, 'catalog');
    assert.equal(trace.toolCalls[0].ok, true);
    assert.equal(trace.provider, 'local');
    assert.equal(trace.model, 'qwen2.5:7b');
    samples.chatTrace = trace;
  });

  test('6. a Jellyfin 503 on /System/Info surfaces as a tool error, the server keeps running', async () => {
    const unauth = await fetch(`${stack.services.urls.JELLYFIN_URL}/System/Info`);
    assert.equal(unauth.status, 401, 'synthetic Jellyfin must refuse requests without X-Emby-Token');

    stack.services.setFault('jellyfin', { method: 'GET', path: '/System/Info' }, { status: 503, body: 'Service Unavailable' });
    const failed = await stack.callTool('server_status', {});
    samples.server_status_503 = { isError: failed.isError, output: failed.text };
    assert.equal(failed.isError, true);
    // A sanitized envelope: the service and status, never the upstream body.
    assert.equal(failed.json?.error?.code, 'ERR_UPSTREAM_UNAVAILABLE', failed.text);
    assert.match(failed.json.error.message, /Jellyfin answered HTTP 503/);
    assert.ok(stack.alive, 'server process died');
    assert.equal((await stack.request('GET', '/health', { key: 'none' })).status, 200);

    stack.services.clearFaults('jellyfin');
    const ok = await stack.callTool('server_status', {});
    assert.equal(ok.isError, false, ok.text);
  });

  test('7. an approved remux runs real ffmpeg and keeps the original in quarantine', async () => {
    const before = await stack.inventory();
    const final = await stack.approvePlan(shared.remuxPlanId);
    assert.equal(final.status, 'succeeded', final.statusReason);
    const [step] = stack.db().steps(shared.remuxPlanId);
    assert.equal(step.details.outputRelativePath, MOVIE_REL);
    const after = await stack.inventory();
    const original = before.find((e) => e.root === 'media' && e.path === MOVIE_REL);
    const backup = after.find((e) => e.root === 'media' && e.path === `.mediabox-trash/${step.details.backupEntryPath}`);
    assert.ok(backup, 'original not kept in quarantine');
    assert.equal(backup.sha256, original.sha256);
    assert.ok(after.some((e) => e.root === 'media' && e.path === MOVIE_REL), 'output not published');
  });

  test('8. grab behaviours map to failed / unknown_outcome / reconciled success', async () => {
    const search = await stack.callTool('search_media', { query: MOVIE2.title, type: 'movie' });
    const item = search.json.data.find((i) => i.title === MOVIE2.title);
    const rel = await stack.callTool('find_releases', { mediaRef: item.mediaRef });
    const refOf = (guid) => rel.json.data.find((r) => r.guid === guid).releaseRef;
    const run = async (guid) => {
      const p = await stack.callTool('propose_download', { releaseRef: refOf(guid), mediaRef: item.mediaRef });
      assert.equal(p.isError, false, p.text);
      return stack.approvePlan(p.json.data.planId);
    };
    const rejected = await run('synthetic-guid-rio-reject');
    assert.equal(rejected.status, 'failed', rejected.statusReason);
    assert.match(rejected.statusReason, /rejected the release/);
    const lost = await run('synthetic-guid-rio-never');
    assert.equal(lost.status, 'unknown_outcome', lost.statusReason);
    const late = await run('synthetic-guid-rio-late');
    assert.equal(late.status, 'succeeded', late.statusReason);
    assert.equal(late.steps[0].details.reconciled, true);
    // Accepted but never seen in history/queue: uncertain, never reported as a success.
    const noTrace = await run('synthetic-guid-rio-notrace');
    assert.equal(noTrace.status, 'unknown_outcome', noTrace.statusReason);
    samples.grabOutcomes = {
      reject4xx: { status: rejected.status, statusReason: rejected.statusReason },
      never: { status: lost.status, statusReason: lost.statusReason },
      timeoutThenAppears: { status: late.status, details: late.steps[0].details },
    };
  });

  test('9. restart keeps the SQLite plans and serves MCP again', async () => {
    const plansBefore = await stack.listPlans({ limit: 200 });
    const oldPid = stack.pid;
    const r = await stack.restart();
    assert.notEqual(r.pid, oldPid);
    const plansAfter = await stack.listPlans({ limit: 200 });
    assert.deepEqual(plansAfter.map((p) => [p.id, p.status]).sort(), plansBefore.map((p) => [p.id, p.status]).sort());
    assert.equal((await stack.getPlan(shared.seriesDownloadPlanId)).status, 'awaiting_approval');
    const jobs = await stack.callTool('check_jobs', {});
    assert.equal(jobs.isError, false);
    const ledger = stack.db().auditLedger();
    assert.ok(ledger === null || Array.isArray(ledger));
    samples.restart = { pid: r.pid, startupMs: r.startupMs, auditLedger: ledger === null ? 'absent' : `${ledger.length} rows` };
  });
});
