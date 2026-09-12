/**
 * ci:verify-evidence (PR05 §5): the verifier accepts only live evidence bound
 * to a real candidate commit, recomputes results from the per-execution
 * records, and refuses lab evidence where the gate requires the trusted
 * controller. Manifests are built here against HEAD's own blobs.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { verifyEvidence, blobSha256 } from '../../scripts/ci/verify-evidence.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const git = (...a) => execFileSync('git', a, { cwd: repoRoot, encoding: 'utf8' }).trim();
const head = git('rev-parse', 'HEAD');
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');

const corpus = JSON.parse(fs.readFileSync(path.join(repoRoot, 'evals/local-agent/corpus.json'), 'utf8'));
const contract = JSON.parse(fs.readFileSync(path.join(repoRoot, 'docs/blueprints/handoffs/PR05-EVAL-CONTRACT.json'), 'utf8'));
const declarations = JSON.parse(fs.readFileSync(path.join(repoRoot, 'evals/local-agent/profile-declarations.json'), 'utf8'));
const profilePath = `ci/model-profiles/${declarations.profileId}.json`;

const SEALED = {
  contract: 'docs/blueprints/handoffs/PR05-EVAL-CONTRACT.json',
  corpus: 'evals/local-agent/corpus.json',
  scorer: 'evals/local-agent/scorer.mjs',
  extractor: 'evals/local-agent/extractor.mjs',
  runner: 'evals/local-agent/runner.mjs',
  stack: 'evals/local-agent/stack.mjs',
  syntheticServices: 'evals/local-agent/synthetic/services.mjs',
  perf: 'evals/local-agent/perf.mjs',
  packageLock: 'package-lock.json',
  profile: profilePath,
};

function record(s, pass) {
  return {
    scenarioId: s.id, category: s.category, pass, attempt: 1, success: true, failures: [], evidenceGaps: [],
    violations: { authorization: 0, scope: 0, egress: 0, invalidArguments: 0 }, violationDetails: [],
    limits: { ok: true, issues: [] }, metrics: { firstUsefulEventMs: 1500, taskMs: 6000 },
  };
}

function buildManifest(overrides = {}) {
  const sealed = Object.fromEntries(Object.entries(SEALED).map(([k, p]) => [k, { path: p, sha256: blobSha256(head, p) }]));
  const passes = [1, 2, 3].map((n) => {
    const records = corpus.scenarios.map((s) => record(s, n));
    return {
      passNumber: n, passRunId: `t-p${n}`, status: 'completed', startedAt: `2099-01-0${n}T00:00:00.000Z`,
      records,
      summary: { successCount: 60, violations: { authorization: 0, scope: 0, egress: 0, invalidArguments: 0 } },
    };
  });
  return {
    schemaVersion: 2, lot: 'PR05', repo: 'JuanCMPDev/mediabox-mcp', experimentId: 'test', mode: 'live', evidenceClass: 'local-lab',
    controller: { id: 'lab-test', kind: 'local-workstation', cleanCheckout: true },
    candidate: { headSha: head, checkoutSha: head, treeSha: git('rev-parse', 'HEAD^{tree}') },
    sealed,
    profile: { profileId: declarations.profileId, sealedAt: '2000-01-01T00:00:00.000Z' },
    corpus: { corpusId: corpus.corpusId, scenarioIds: corpus.scenarios.map((s) => s.id) },
    passes,
    performance: {
      cold: { runs: [1, 2, 3].map(() => ({ totalMs: 20_000, canaryOk: true })) },
      memory: { maxSampleIntervalMs: 180, peakFractions: { ram: 0.2, vram: 0.45 } },
      media: { baseline: [1000, 1010, 990], concurrent: [960, 955, 970], oomOrRestarts: 0 },
      runtimeRestarts: 0,
    },
    compatibility: 'compatible',
    ...overrides,
  };
}

function writeEvidence(manifest) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'g10-evidence-'));
  const bytes = Buffer.from(JSON.stringify(manifest, null, 2));
  fs.writeFileSync(path.join(dir, 'experiment-manifest.json'), bytes);
  fs.writeFileSync(path.join(dir, 'SHA256SUMS'), `${sha256(bytes)}  experiment-manifest.json\n`);
  return dir;
}

test('consistent lab evidence verifies as local-lab and is refused where trusted-controller is required', async () => {
  const dir = writeEvidence(buildManifest());
  const lab = await verifyEvidence({ evidence: dir, requireClass: 'local-lab' });
  assert.equal(lab.valid, true, lab.errors.join('\n'));
  const gate = await verifyEvidence({ evidence: dir, requireClass: 'trusted-controller' });
  assert.equal(gate.valid, false);
  assert.ok(gate.errors.some((e) => e.includes("'local-lab' is not accepted")));
});

test('simulated, scripted or dev evidence never counts', async () => {
  for (const mode of ['simulated', 'scripted', 'dev']) {
    const res = await verifyEvidence({ evidence: writeEvidence(buildManifest({ mode })), requireClass: 'local-lab' });
    assert.equal(res.valid, false, mode);
    assert.ok(res.errors.some((e) => e.includes('only live runs')));
  }
});

test('recorded summaries are recomputed from the records', async () => {
  const m = buildManifest();
  m.passes[0].records[3] = { ...m.passes[0].records[3], success: false, failures: ['facts missing: x'] };
  const res = await verifyEvidence({ evidence: writeEvidence(m), requireClass: 'local-lab' });
  assert.equal(res.valid, false);
  assert.ok(res.errors.some((e) => e.includes('recorded success 60 != recomputed 59')));
});

test('a violation hidden in one record fails the thresholds', async () => {
  const m = buildManifest();
  m.passes[1].records[10] = { ...m.passes[1].records[10], violations: { authorization: 1, scope: 0, egress: 0, invalidArguments: 0 } };
  m.passes[1].summary.violations.authorization = 1;
  const res = await verifyEvidence({ evidence: writeEvidence(m), requireClass: 'local-lab' });
  assert.equal(res.valid, false);
  assert.ok(res.notes.some((n) => n.includes('authorization violations')) || res.errors.some((e) => e.includes('compatib')));
});

test('dropped or reordered executions, reruns and missing performance evidence are refused', async () => {
  const dropped = buildManifest();
  dropped.passes[2].records = dropped.passes[2].records.slice(0, 59);
  assert.equal((await verifyEvidence({ evidence: writeEvidence(dropped), requireClass: 'local-lab' })).valid, false);

  const rerun = buildManifest();
  rerun.passes[0].records[0] = { ...rerun.passes[0].records[0], attempt: 2 };
  assert.ok((await verifyEvidence({ evidence: writeEvidence(rerun), requireClass: 'local-lab' })).errors.some((e) => e.includes('reruns')));

  const noPerf = buildManifest({ performance: { runtimeRestarts: 0 } });
  const res = await verifyEvidence({ evidence: writeEvidence(noPerf), requireClass: 'local-lab' });
  assert.equal(res.valid, false);
});

test('tampered sealed hashes, unknown candidates and broken checksums are refused', async () => {
  const tampered = buildManifest();
  tampered.sealed.scorer = { ...tampered.sealed.scorer, sha256: '0'.repeat(64) };
  assert.ok((await verifyEvidence({ evidence: writeEvidence(tampered), requireClass: 'local-lab' })).errors.some((e) => e.includes('sealed scorer')));

  const ghost = buildManifest({ candidate: { headSha: 'f'.repeat(40), checkoutSha: 'f'.repeat(40), treeSha: 'x' } });
  assert.equal((await verifyEvidence({ evidence: writeEvidence(ghost), requireClass: 'local-lab' })).valid, false);

  const dir = writeEvidence(buildManifest());
  fs.appendFileSync(path.join(dir, 'experiment-manifest.json'), '\n');
  assert.ok((await verifyEvidence({ evidence: dir, requireClass: 'local-lab' })).errors.some((e) => e.includes('checksum mismatch')));
});

test('a profile sealed after the first pass is refused', async () => {
  const late = buildManifest({ profile: { profileId: declarations.profileId, sealedAt: '2100-01-01T00:00:00.000Z' } });
  assert.ok((await verifyEvidence({ evidence: writeEvidence(late), requireClass: 'local-lab' })).errors.some((e) => e.includes('sealed')));
});

test('no evidence at all keeps G10 pending instead of passing', async () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'g10-empty-'));
  const res = await verifyEvidence({ evidence: empty });
  assert.equal(res.valid, false);
  assert.ok(res.errors[0].includes('G10 stays pending'));
});
