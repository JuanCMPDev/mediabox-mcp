/**
 * Frozen corpus checks (PR05 §4.2): 60 fixed IDs in order, the category split,
 * mandatory latency eligibility, an oracle for every scenario, no scripted
 * model output anywhere, and seeds/media that expand without error.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { buildCorpus } from '../../evals/local-agent/corpus-data.mjs';
import { expandScenario } from '../../evals/local-agent/runner.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const committed = JSON.parse(fs.readFileSync(path.join(repoRoot, 'evals/local-agent/corpus.json'), 'utf8'));
const corpus = buildCorpus();

const range = (prefix, n) => Array.from({ length: n }, (_, i) => `${prefix}-${String(i + 1).padStart(2, '0')}`);
const EXPECTED_IDS = [...range('READ', 20), ...range('SEARCH', 10), ...range('DOWNLOAD', 10), ...range('STORAGE', 10), ...range('ADV', 10)];

test('corpus.json is exactly what the generator produces (no hand edits)', () => {
  assert.deepEqual(committed, JSON.parse(JSON.stringify(corpus)));
});

test('60 fixed IDs, unique, in contract order, with the category split 20/10/10/10/10', () => {
  assert.deepEqual(corpus.scenarios.map((s) => s.id), EXPECTED_IDS);
  for (const s of corpus.scenarios) assert.equal(s.category, s.id.split('-')[0]);
});

test('READ-01…20, SEARCH-01…10 and DOWNLOAD-01…05 are warm-eligible before measuring', () => {
  const mandatory = [...range('READ', 20), ...range('SEARCH', 10), ...range('DOWNLOAD', 5)];
  for (const id of mandatory) {
    const s = corpus.scenarios.find((x) => x.id === id);
    assert.equal(s.warmFirstEventEligible, true, `${id} first-event eligibility`);
    assert.equal(s.warmTaskEligible, true, `${id} task eligibility`);
  }
  assert.ok(corpus.scenarios.filter((s) => s.warmTaskEligible).length >= 35);
});

test('every scenario has an oracle that can fail and a user turn', () => {
  for (const s of corpus.scenarios) {
    const o = s.oracle;
    const checks = (o.facts?.required?.length ?? 0) + (o.requiredCalls?.length ?? 0) + (o.plans?.expect?.length ?? 0)
      + (o.effects?.services?.length ?? 0) + (o.turnChecks?.length ?? 0) + (o.requireErrors?.length ?? 0)
      + (o.forbiddenCalls?.length ?? 0) + (o.maxExecutedCalls !== undefined ? 1 : 0) + (o.plans?.allowed?.length ?? 0);
    assert.ok(checks > 0, `${s.id} has no oracle`);
    assert.ok(s.steps.some((st) => ['user', 'select', 'user-selection', 'cancel-turn'].includes(st.kind)), `${s.id} never talks to the agent`);
    assert.equal(o.plans.allowOthers, false, `${s.id} must not tolerate arbitrary plans`);
  }
});

test('no scripted model output exists in the corpus', () => {
  const text = JSON.stringify(corpus);
  for (const marker of ['scriptedProvider', 'tool_call', '"fullText"', 'assistant']) {
    assert.equal(text.includes(marker), false, `corpus contains ${marker}`);
  }
});

test('every scenario expands to a valid seed and media spec', () => {
  for (const s of corpus.scenarios) {
    const { seed, media } = expandScenario(s, corpus.base);
    assert.ok(Array.isArray(seed.jellyfin.items), `${s.id} seed`);
    for (const [rel, spec] of Object.entries(media)) {
      assert.ok(!rel.startsWith('/') && !rel.includes('..'), `${s.id} media path ${rel}`);
      assert.ok(spec && typeof spec === 'object', `${s.id} media spec ${rel}`);
    }
  }
  const big = expandScenario(corpus.scenarios.find((s) => s.id === 'READ-12'), corpus.base);
  assert.equal(big.seed.jellyfin.items.filter((i) => i.Type === 'Movie').length, 10_005);
});
