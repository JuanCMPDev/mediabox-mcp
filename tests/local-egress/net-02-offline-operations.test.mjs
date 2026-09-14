/**
 * NET-02 (PR05 §3.4): with egress denied (offline-library, the generated
 * topology) the library is still usable: the agent key queries it through the
 * owner edge, a scripted local model drives the real chat → MCP → service path,
 * an agent-proposed maintenance plan is approved by the synthetic owner and its
 * exact effect is checked on the host temporary roots (names with spaces and
 * Unicode). A missing or different model artifact fails closed before the agent
 * runs, without asking the runtime to pull and without any delivery outside.
 *
 * Declared artifacts: the REAL mcp-server image built from this tree, the
 * scripted Ollama stand-in serving qwen2.5:7b with the digest pinned in
 * LOCAL_LLM_MODEL_DIGEST, and the real-path synthetic services.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { startTopology, callTool, findKey, inventory, diffInventory, OFFLINE, MODEL, modelDigest } from './lab/topology.mjs';

const MOVIE_DIR = 'movies/Ñandú Película (2024)';
const TARGET = `${MOVIE_DIR}/Ñandú Película (2024).mkv`;
const SUBTITLE = `${MOVIE_DIR}/Ñandú Película (2024).es.srt`;
const OTHER = 'movies/Otra Película (1999)/Otra Película (1999).mkv';
const EPISODE = 'tv/Serie Ñ (2020)/Season 01/Serie Ñ - S01E01.mkv';
const DL_TARGET = 'descargas ñ/basura temporal.mkv';
const DL_KEEP = 'descargas ñ/guardar.nfo';

const bytes = (label) => Buffer.from(crypto.createHash('sha256').update(label).digest('hex').repeat(128));
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const norm = (ip) => String(ip ?? '').replace(/^::ffff:/, '');

describe('NET-02 (offline-library): local operations with egress denied', { timeout: 1_800_000 }, () => {
  let t;

  before(async () => {
    t = await startTopology({
      profile: OFFLINE,
      label: 'n2',
      media: {
        [TARGET]: bytes('target'),
        [SUBTITLE]: '1\n00:00:01,000 --> 00:00:02,000\nHola, ñandú\n',
        [OTHER]: bytes('other'),
        [EPISODE]: bytes('episode'),
      },
      downloads: { [DL_TARGET]: bytes('download'), [DL_KEEP]: 'guardar\n' },
      seed: {
        jellyfin: {
          items: [
            { Type: 'Movie', Name: 'Ñandú Película', ProductionYear: 2024, Path: `/data/${TARGET}` },
            { Type: 'Movie', Name: 'Otra Película', ProductionYear: 1999, Path: `/data/${OTHER}` },
          ],
        },
      },
      script: [
        [{ toolCall: { name: 'media_query', arguments: { action: 'search', query: 'Ñandú' } } }],
        [{ text: 'Sí: tienes «Ñandú Película» (2024) en la biblioteca.' }],
      ],
    });
  });

  after(async () => {
    await t?.down();
  });

  const nothingLeft = () => t.ledger().filter((e) => e.event !== 'ready');

  it('the agent key queries the library through the edge while nothing leaves the topology', async () => {
    const agent = await t.mcp('agent');
    const search = await callTool(agent, 'jellyfin_search', { query: 'Ñandú' });
    assert.equal(search.isError, false, search.text);
    const hit = search.json?.results?.find((r) => r.name === 'Ñandú Película');
    assert.ok(hit, `the seeded movie was not found: ${search.text.slice(0, 500)}`);
    assert.equal(hit.path, `/data/${TARGET}`);

    const list = await callTool(agent, 'manage_files', { action: 'list', path: MOVIE_DIR });
    assert.equal(list.isError, false, list.text);
    const names = (list.json?.items ?? []).map((i) => i.name).sort();
    assert.deepEqual(names, ['Ñandú Película (2024).es.srt', 'Ñandú Película (2024).mkv']);

    const serverIps = new Set(t.ips('mcp-server'));
    const seen = t.requestLog('jellyfin').filter((e) => e.path === '/Items' && e.query?.searchTerm === 'Ñandú');
    assert.ok(seen.length > 0, 'the jellyfin stand-in never saw the search');
    assert.ok(seen.every((e) => serverIps.has(norm(e.remoteAddress))), `the search came from ${seen.map((e) => e.remoteAddress)}`);
    assert.deepEqual(nothingLeft(), []);
  });

  it('a chat turn with the scripted local model runs the real tool path offline', async () => {
    const turn = await t.chat('¿Tengo Ñandú en la biblioteca?');
    assert.equal(turn.status, 200, turn.text);
    assert.equal(turn.error, undefined, `the turn failed: ${JSON.stringify(turn.error)}`);
    const start = turn.events.find((e) => e.type === 'tool-start');
    const end = turn.events.find((e) => e.type === 'tool-end');
    assert.ok(start && ['media_query', 'jellyfin_search'].includes(start.name), `no library tool call: ${turn.text.slice(0, 800)}`);
    assert.equal(end?.ok, true, `the tool call failed: ${JSON.stringify(end)}`);
    assert.match(turn.done?.fullText ?? '', /Ñandú Película/);

    const serverIps = new Set(t.ips('mcp-server'));
    const completions = t.requestLog('runtime').filter((e) => e.path === '/v1/chat/completions');
    assert.equal(completions.length, 2, `expected two inferences, saw ${completions.length}`);
    assert.ok(completions.every((e) => serverIps.has(norm(e.remoteAddress))));
    assert.deepEqual(nothingLeft(), []);
  });

  it('GET /api/chat/info from inside reports the verified strict profile and its private endpoint', async () => {
    const info = await t.request('GET', '/api/chat/info');
    assert.equal(info.status, 200, info.text);
    assert.equal(info.body.privacyProfile, 'offline-library');
    assert.equal(info.body.privacyIsolation, 'no-default-route');
    assert.equal(info.body.artifactStatus, 'verified');
    assert.equal(info.body.runtimeState, 'ready');
    assert.equal(info.body.endpoint, 'http://mediabox-inference:11434');
    assert.equal(info.body.endpointPolicy, 'lan-allowlist');
  });

  it('owner-approved cleanup of a library file moves exactly that file into its root quarantine on the host', async () => {
    const mediaBefore = inventory(t.mediaRoot);
    const downloadsBefore = inventory(t.downloadsRoot);
    const agent = await t.mcp('agent');
    const proposal = await callTool(agent, 'propose_cleanup', { paths: [`/data/${TARGET}`] });
    assert.equal(proposal.isError, false, proposal.text);
    const planId = findKey(proposal.envelope, 'planId');
    assert.ok(planId, `no plan id: ${proposal.text.slice(0, 500)}`);

    const final = await t.approve(planId);
    const mediaAfter = inventory(t.mediaRoot);
    const diff = diffInventory(mediaBefore, mediaAfter);
    assert.equal(final.status, 'succeeded', `the approved plan did not succeed: ${JSON.stringify(final).slice(0, 2000)}`);
    // /data/movies is its own bind mount: the quarantine lives on that same filesystem,
    // at the mount's top directory, so the move is a rename and never a copy+delete.
    const entry = `movies/.mediabox-trash/${planId}/${TARGET}`;
    assert.deepEqual(diff.removed, [TARGET]);
    assert.deepEqual(diff.added.sort(), [entry, `${entry}.manifest.json`].sort());
    assert.deepEqual(diff.changed, []);
    assert.equal(mediaAfter.get(entry), mediaBefore.get(TARGET), 'the quarantined bytes differ');
    assert.deepEqual(diffInventory(downloadsBefore, inventory(t.downloadsRoot)), { removed: [], added: [], changed: [] });
    assert.deepEqual(nothingLeft(), []);
  });

  it('owner-approved cleanup in the downloads root moves exactly that file; the agent cannot approve it', async () => {
    const mediaBefore = inventory(t.mediaRoot);
    const before = inventory(t.downloadsRoot);
    const agent = await t.mcp('agent');
    const proposal = await callTool(agent, 'propose_cleanup', { paths: [`downloads/${DL_TARGET}`] });
    assert.equal(proposal.isError, false, proposal.text);
    const planId = findKey(proposal.envelope, 'planId');
    assert.ok(planId, `no plan id: ${proposal.text.slice(0, 500)}`);

    const plan = await t.request('GET', `/api/operations/plans/${planId}`);
    const byAgent = await t.request('POST', `/api/operations/plans/${planId}/approve`, { key: 'agent', body: { manifestHash: plan.body?.plan?.manifestHash } });
    assert.equal(byAgent.status, 403, `the agent key approved a plan: ${byAgent.text}`);

    const final = await t.approve(planId);
    assert.equal(final.status, 'succeeded', JSON.stringify(final).slice(0, 2000));
    const after = inventory(t.downloadsRoot);
    const diff = diffInventory(before, after);
    assert.deepEqual(diff.removed, [DL_TARGET]);
    assert.deepEqual(diff.added.sort(), [`.mediabox-trash/${planId}/${DL_TARGET}`, `.mediabox-trash/${planId}/${DL_TARGET}.manifest.json`].sort());
    assert.deepEqual(diff.changed, []);
    assert.equal(after.get(`.mediabox-trash/${planId}/${DL_TARGET}`), sha(bytes('download')));
    assert.equal(after.get(DL_KEEP), before.get(DL_KEEP));
    // Paths the plan did not name keep their bytes, wherever they are.
    const mediaNow = inventory(t.mediaRoot);
    for (const [rel, hash] of mediaBefore) assert.equal(mediaNow.get(rel), hash, `${rel} changed`);
    assert.deepEqual(nothingLeft(), []);
  });

  it('an initial download that never happened fails closed: no pull, no network, ERR_ARTIFACT_MISSING', async () => {
    const mark = t.requestLog('runtime').length;
    await t.recreate(['mediabox-inference', 'mcp-server'], { RUNTIME_MODEL: 'llama3.2:1b' });
    const info = await t.request('GET', '/api/chat/info');
    assert.equal(info.body?.artifactStatus, 'missing', info.text);
    assert.equal(info.body?.runtimeState, 'error', info.text);

    const turn = await t.chat('hola');
    assert.equal(turn.error?.code, 'ERR_ARTIFACT_MISSING', turn.text);
    assert.equal(turn.done, undefined, 'the agent answered without its pinned model');

    // `run` may only read the runtime's health, inventory and model metadata; it never pulls,
    // creates, copies or deletes a model and never runs an inference without the pinned artifact.
    const calls = t.requestLog('runtime').slice(mark);
    assert.ok(calls.some((e) => e.path === '/api/tags'), 'the server never checked the runtime inventory');
    const readOnly = new Set(['GET /', 'GET /api/version', 'GET /api/tags', 'GET /api/ps', 'POST /api/show', 'GET /v1/models']);
    const unexpected = calls.filter((e) => !readOnly.has(`${e.method} ${e.path}`));
    assert.deepEqual(unexpected, [], 'the server asked the runtime to fetch, change or run a model it could not verify');
    const serverIps = new Set(t.ips('mcp-server'));
    assert.ok(calls.every((e) => serverIps.has(norm(e.remoteAddress))));
    assert.deepEqual(nothingLeft(), [], 'something was delivered outside the topology');
  });

  it('a different model digest pinned by prepare fails closed with ERR_ARTIFACT_MISMATCH', async () => {
    const mark = t.requestLog('runtime').length;
    await t.recreate(['mediabox-inference', 'mcp-server'], { RUNTIME_MODEL: MODEL, LOCAL_LLM_MODEL_DIGEST: modelDigest('another-model:1b') });
    const info = await t.request('GET', '/api/chat/info');
    assert.equal(info.body?.artifactStatus, 'mismatch', info.text);

    const turn = await t.chat('hola');
    assert.equal(turn.error?.code, 'ERR_ARTIFACT_MISMATCH', turn.text);
    const inferences = t.requestLog('runtime').slice(mark).filter((e) => e.path === '/v1/chat/completions');
    assert.deepEqual(inferences, [], 'the unverified model was used');
    assert.deepEqual(nothingLeft(), []);
  });
});
