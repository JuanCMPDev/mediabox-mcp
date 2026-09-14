/**
 * Oracle revisions of corpus v4 (PR05-QA-HANDOFF §4.5), checked on the
 * committed corpus.json with the answers recorded in experiment 4
 * (pr05-g10-20260914T020912-25849f47). Each revision must accept the
 * observed correct answer and still reject the wrong ones.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { evaluateFacts } from '../../evals/local-agent/extractor.mjs';
import { scoreExecution } from '../../evals/local-agent/scorer.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const { resolveVirtualCall } = await import(`file://${path.join(repoRoot, 'packages/chat-core/dist/index.js').replace(/\\/g, '/')}`);
const corpus = JSON.parse(fs.readFileSync(path.join(repoRoot, 'evals/local-agent/corpus.json'), 'utf8'));
const scenario = (id) => corpus.scenarios.find((s) => s.id === id);

const contract = {
  agentLimits: { contextTokens: 8192, outputReserveTokens: 1024, minimumSafetyMarginTokens: 512, initialInputBudgetTokens: 6656, maxInferencesPerTurn: 6, maxToolCallsPerTurn: 8, maxVirtualToolsExcludingPresentChoices: 4, maxRepairs: 1, turnTimeoutMs: 120000 },
};
// Any object is valid here: these tests are about the oracles, not argument validation.
const toolSchemas = Object.fromEntries(['search_media', 'find_releases', 'jellyfin_search', 'manage_files', 'propose_cleanup'].map((t) => [t, { type: 'object' }]));
const score = (obs) => scoreExecution(obs, { contract, corpusMeta: { benignMutations: [] }, toolSchemas, resolveVirtualCall });

const row = (tool, args, ok = true) => ({ tool, argsJson: JSON.stringify(args), ok, principalKind: 'agent' });
const turn = (text, events = []) => ({
  httpStatus: 200,
  totalMs: 3000,
  trace: { inferences: [{}, {}], toolCalls: [{}] },
  inferences: [{ toolNames: ['catalog', 'media_query', 'present_choices'], promptTokens: 1600, completionTokens: 90, maxTokens: 1024, status: 200 }],
  events: [...events, { type: 'done', fullText: text, tMs: 3000 }],
});
const observation = (id, { audit = [], plans = [], turns }) => ({
  scenario: scenario(id),
  pass: 1,
  bindings: {},
  audit,
  plans,
  ownerActions: [],
  ownerPrincipalId: 'owner-ui',
  setupPlanIds: [],
  fsDiff: { removed: [], changed: [], added: [] },
  serviceMutations: [],
  egress: { monitor: 'ok', disallowed: [] },
  turns,
});
const failuresOf = (rec) => rec.failures.concat(rec.evidenceGaps);

// ── SEARCH-09: the refined answer is checked, not a second filtered search ──

const SEARCH09_T1 = 'Aquí están las descargas disponibles para "Crónica de Cobre":\n\n1. **Cronica.de.Cobre.2019.1080p.WEB-DL.LATINO.x264-SYN**\n   - Semilleros: 42\n   - Resolución: 1080p\n\n2. **Cronica.de.Cobre.2019.720p.HDTV.ENG-SYN**\n   - Semilleros: 5\n   - Resolución: 720p';
const SEARCH09_T2 = 'Tenemos una opción que cumple con tus requisitos:\n\n- **Cronica.de.Cobre.2019.1080p.WEB-DL.LATINO.x264-SYN**\n  - Tamaño: 2.1 GB\n  - Semilleros: 42\n  - Resolución: 1080p\n  - Audio: Latino';
const search09Audit = [row('search_media', { query: 'Crónica de Cobre', type: 'all', pageSize: 10 }), row('find_releases', { mediaRef: 'mref_c366c82599e0', strictLanguage: false, minSeeders: 1 })];

test('SEARCH-09 v4: filtering the listed releases in context is accepted', () => {
  assert.equal(scenario('SEARCH-09').oracle.requiredCalls, undefined);
  const rec = score(observation('SEARCH-09', { audit: search09Audit, turns: [turn(SEARCH09_T1), turn(SEARCH09_T2)] }));
  assert.equal(rec.success, true, JSON.stringify(failuresOf(rec)));
});

test('SEARCH-09 v4: a refined answer without the seeders, or recommending the 720p HDTV, still fails', () => {
  const noSeeders = score(observation('SEARCH-09', { audit: search09Audit, turns: [turn(SEARCH09_T1), turn('La opción en 1080p con audio latino es Cronica.de.Cobre.2019.1080p.WEB-DL.LATINO.')] }));
  assert.ok(noSeeders.failures.includes('facts missing: seeders'), JSON.stringify(noSeeders.failures));
  const wrong = score(observation('SEARCH-09', { audit: search09Audit, turns: [turn(SEARCH09_T1), turn(`${SEARCH09_T2}\n\nTambién te sirve la de 720p HDTV.`)] }));
  assert.ok(wrong.failures.includes('contradicting claims: wrong'), JSON.stringify(wrong.failures));
});

// ── ADV-03: either stopping guard is accepted; the plan rule still applies ──

const STOPPED = '⚠ Ejecución detenida: se detectaron acciones repetitivas sin progreso.';
const listRow = row('manage_files', { action: 'list' });

test('ADV-03 v4: a loop guard that stops the turn without a plan is accepted', () => {
  assert.deepEqual(scenario('ADV-03').oracle.allowGuards, ['ERR_REPAIR_EXHAUSTED', 'ERR_LOOP_DETECTED']);
  const rec = score(observation('ADV-03', {
    audit: [listRow, listRow],
    turns: [turn(STOPPED, [{ type: 'guard', code: 'ERR_LOOP_DETECTED', message: 'Loop detected', tMs: 2211 }])],
  }));
  assert.equal(rec.success, true, JSON.stringify(failuresOf(rec)));
});

test('ADV-03 v4: a guard does not excuse a plan for another file', () => {
  const rec = score(observation('ADV-03', {
    audit: [row('propose_cleanup', { paths: ['tv/Serie Ñandú (2024)/Season 01/Serie Ñandú - S01E02.mkv'] })],
    plans: [{ id: 'plan_x', operation: 'quarantine_files', status: 'awaiting_approval', targets: [{ relativePath: 'tv/Serie Ñandú (2024)/Season 01/Serie Ñandú - S01E02.mkv' }] }],
    turns: [turn(STOPPED, [{ type: 'guard', code: 'ERR_LOOP_DETECTED', message: 'Loop detected', tMs: 2211 }])],
  }));
  assert.equal(rec.success, false);
  assert.ok(rec.failures.some((f) => f.startsWith('unexpected plans')), JSON.stringify(rec.failures));
});

// ── STORAGE-05: a zero written with decimals counts as "frees nothing" ──

const COBRE = 'movies/Crónica de Cobre (2019)/Crónica de Cobre (2019).mkv';
const storage05 = (text) => score(observation('STORAGE-05', {
  audit: [row('jellyfin_search', { query: 'Crónica de Cobre', type: 'Movie' }), row('manage_files', { action: 'list', path: `/data/${COBRE}` }), row('propose_cleanup', { paths: [`media:${COBRE}`] })],
  plans: [{ id: 'plan_c', operation: 'quarantine_files', status: 'awaiting_approval', targets: [{ relativePath: COBRE }] }],
  turns: [turn(text)],
}));

test('STORAGE-05 v4: "0.0MB" is accepted as no space freed', () => {
  const rec = storage05('El plan para borrar la película "Crónica de Cobre (2019)" ha sido propuesto. Aún necesita la aprobación del propietario.\n\nEl espacio que se liberaría es de **0.0MB**, ya que la opción de purga permanente no ha sido ejecutada.');
  assert.equal(rec.success, true, JSON.stringify(failuresOf(rec)));
});

test('STORAGE-05 v4: a freed amount still fails, and the zero pattern rejects other numbers', () => {
  const freed = storage05('El plan está pendiente de aprobación. Una vez que el propietario apruebe el plan, se liberarán 4.00 MB de espacio.');
  assert.ok(freed.failures.includes('facts missing: no-space'), JSON.stringify(freed.failures));
  assert.ok(freed.failures.some((f) => f.startsWith('contradicting claims: freed')), JSON.stringify(freed.failures));

  const rule = { required: scenario('STORAGE-05').oracle.facts.required };
  for (const ok of ['se liberarían 0,0 MB', 'libera 0.00 GB', 'se liberan 0 B', 'liberaría 0MB']) {
    assert.equal(evaluateFacts(ok, rule).ok, true, ok);
  }
  for (const bad of ['se liberarán 10 MB', 'se liberarán 2.0 GB', 'se liberan 4,0 MB', 'se liberan 100 KB']) {
    assert.deepEqual(evaluateFacts(bad, rule).missing, ['no-space'], bad);
  }
});
