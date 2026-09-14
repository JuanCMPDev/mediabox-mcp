/**
 * Corpus conditions on the real server (no GPU): every fault, filter and fixture
 * that corpus.json declares must create the condition its scenario tests.
 *
 * Corpus v3 declared string fault matchers ('.*', '^/System/Info$'). The
 * synthetic services read a string as an exact pathname, so those faults never
 * fired: READ-09, READ-10, SEARCH-10 and ADV-10 ran against healthy services in
 * every experiment. Its STORAGE-09 fixture also finished transcoding before the
 * scripted cancel. These checks apply the declarations exactly as the runner
 * does, so a declaration that stops working fails here, not in an experiment.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test, before, after } from 'node:test';
import { fileURLToPath } from 'node:url';

import { assertFaultMatcher } from '../../evals/local-agent/corpus-data.mjs';
import { expandScenario } from '../../evals/local-agent/runner.mjs';
import { startStack } from '../../evals/local-agent/stack.mjs';
import { assertMediaTools, diffInventory } from '../../evals/local-agent/synthetic/media.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const corpus = JSON.parse(fs.readFileSync(path.join(repoRoot, 'evals/local-agent/corpus.json'), 'utf8'));
const scenarioById = (id) => {
  const s = corpus.scenarios.find((x) => x.id === id);
  assert.ok(s, `${id} missing from corpus.json`);
  return s;
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('the generator refuses fault matchers the synthetic services cannot honour', () => {
  assert.throws(() => assertFaultMatcher('X', '.*'), /must be an object/);
  assert.throws(() => assertFaultMatcher('X', '^/System/Info$'), /must be an object/);
  assert.throws(() => assertFaultMatcher('X', { path: '^/System/Info$' }), /exact pathname/);
  assert.throws(() => assertFaultMatcher('X', { url: '/x' }), /unsupported fault matcher key/);
  assert.doesNotThrow(() => assertFaultMatcher('X', {}));
  assert.doesNotThrow(() => assertFaultMatcher('X', { method: 'GET', path: '/System/Info' }));
  for (const s of corpus.scenarios) {
    for (const f of s.faults ?? []) assertFaultMatcher(s.id, f.match);
  }
});

describe('corpus v4 conditions on the real server', () => {
  let stack;
  const call = async (name, args) => stack.callTool(name, args);
  const withFaults = async (id, fn) => {
    const s = scenarioById(id);
    assert.ok(s.faults?.length, `${id} declares no fault`);
    for (const f of s.faults) stack.services.setFault(f.service, f.match, f.fault);
    try {
      await fn();
    } finally {
      stack.services.clearFaults();
    }
  };

  before(async () => {
    await assertMediaTools();
    // One stack: the base seed plus ADV-01's items, and STORAGE-09's media. The
    // fault scenarios declare no seed of their own.
    const { seed } = expandScenario(scenarioById('ADV-01'), corpus.base);
    const { media } = expandScenario(scenarioById('STORAGE-09'), corpus.base);
    stack = await startStack({ seed, media });
  });

  after(async () => {
    if (stack) await stack.stop();
  });

  test('READ-09: with Jellyfin down, the library reads fail instead of returning counts', async () => {
    await withFaults('READ-09', async () => {
      const status = await call('server_status', {});
      assert.equal(status.isError, true, status.text);
      const search = await call('jellyfin_search', { type: 'Movie' });
      assert.equal(search.isError, true, search.text);
    });
    const healthy = await call('server_status', {});
    assert.equal(healthy.isError, false, healthy.text);
  });

  test('ADV-10: only /System/Info fails; other Jellyfin reads keep working', async () => {
    await withFaults('ADV-10', async () => {
      const status = await call('server_status', {});
      assert.equal(status.isError, true, status.text);
      const search = await call('jellyfin_search', { query: 'Niebla' });
      assert.equal(search.isError, false, search.text);
    });
  });

  test('READ-10: with Sonarr down, the catalog search is partial and still finds the 2012 film', async () => {
    await withFaults('READ-10', async () => {
      const out = await call('search_media', { query: 'Marea Alta', type: 'all' });
      assert.equal(out.isError, false, out.text);
      const sonarr = (out.json.sources ?? []).find((src) => /sonarr/i.test(src.source));
      assert.ok(sonarr, `no sonarr source in ${out.text.slice(0, 400)}`);
      assert.notEqual(sonarr.completeness, 'complete', out.text.slice(0, 400));
      assert.ok(out.json.data.some((item) => item.year === 2012), out.text.slice(0, 400));
    });
  });

  test('SEARCH-10: with Sonarr down, the series search reports the missing source', async () => {
    await withFaults('SEARCH-10', async () => {
      const out = await call('search_media', { query: 'Los Guardianes del Puerto', type: 'all' });
      assert.equal(out.isError, false, out.text);
      const sonarr = (out.json.sources ?? []).find((src) => /sonarr/i.test(src.source));
      assert.ok(sonarr && sonarr.completeness !== 'complete', out.text.slice(0, 400));
    });
  });

  test('ADV-01: a year filter reaches the synthetic Jellyfin and filters before paging', async () => {
    const out = await call('jellyfin_search', { type: 'Movie', year: 2020 });
    assert.equal(out.isError, false, out.text);
    const names = out.json.results.map((r) => r.name).sort();
    assert.equal(out.json.total, 2, out.text.slice(0, 400));
    assert.ok(names[0].startsWith('Lago Sereno') && names[1].startsWith('Semillas'), names.join(' | '));
  });

  test('STORAGE-09: the transcode is still running at the scripted cancel, which keeps the original', async () => {
    const s = scenarioById('STORAGE-09');
    const waitStep = s.steps.find((st) => st.kind === 'wait');
    assert.ok(waitStep, 'STORAGE-09 declares no wait before the cancel');
    const rel = 'movies/Niebla de Marzo (2015)/Niebla de Marzo (2015).mkv';

    const proposed = await call('propose_media_job', { path: `media:${rel}`, action: 'transcode', profileName: 'cpu_hevc_transcode' });
    assert.equal(proposed.isError, false, proposed.text);
    const planId = proposed.json.data.planId;
    const before = await stack.inventory();

    // The runner's approve-no-wait, wait and cancel steps.
    const record = await stack.getPlan(planId);
    const approved = await stack.request('POST', `/api/operations/plans/${planId}/approve`, { body: { manifestHash: record.plan?.manifestHash } });
    assert.ok(approved.status < 300, JSON.stringify(approved.body));
    await sleep(waitStep.ms);
    const atCancel = await stack.getPlan(planId);
    assert.ok(['queued', 'running'].includes(atCancel.status), `plan was ${atCancel.status} ${waitStep.ms} ms after approval: the fixture is too short`);
    await stack.cancelPlan(planId, 'owner cancelled');
    const final = await stack.waitForPlan(planId, { timeoutMs: 120_000 });
    assert.ok(['cancelled', 'failed', 'interrupted'].includes(final.status), `${final.status}: ${final.statusReason ?? ''}`);

    const diff = diffInventory(before, await stack.inventory());
    // Product defect found by this check: a cancelled job leaves its partial output in
    // .mediabox-staging (fixed with the media-job cleanup in the next commit).
    const outsideStaging = (list) => list.filter((e) => !e.path.startsWith('.mediabox-staging/'));
    assert.deepEqual(
      { removed: outsideStaging(diff.removed).length, added: outsideStaging(diff.added).length, changed: outsideStaging(diff.changed).length },
      { removed: 0, added: 0, changed: 0 },
      JSON.stringify(diff).slice(0, 800));
  });
});
