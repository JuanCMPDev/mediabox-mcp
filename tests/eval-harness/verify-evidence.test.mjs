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

import { verifyEvidence, blobSha256, verifyControllerRun, TRUSTED_CONTROLLER_POLICY } from '../../scripts/ci/verify-evidence.mjs';

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

// ── Trusted controller run (PR05 §5, revised 2026-09-14) ───────────────────

const REPO = TRUSTED_CONTROLLER_POLICY.repository;
const SUMS = 'a'.repeat(64);
const TAG = 'g10/abcdef12-20260915T000000';
const RUNNER = 'mediabox-g10-20260915T000000';
const CONTROLLER_JOB = TRUSTED_CONTROLLER_POLICY.controllerJob;
const BIND_JOB = 'Bind the evidence package to the candidate';

function trustedController(overrides = {}) {
  return {
    id: 'ctl-test', kind: 'github-actions', cleanCheckout: true,
    repository: REPO, runId: 4242, runAttempt: 1,
    workflowRef: `${REPO}/${TRUSTED_CONTROLLER_POLICY.workflowPath}@refs/tags/${TAG}`,
    workflowSha: head, event: 'push', ref: `refs/tags/${TAG}`,
    runnerName: RUNNER, runnerEnvironment: 'self-hosted',
    isolation: { ok: true, checks: TRUSTED_CONTROLLER_POLICY.isolationChecks.map((id) => ({ id, ok: true, detail: 'ok' })) },
    ...overrides,
  };
}

/** GitHub as it answers for a successful controller run on HEAD. */
function fakeGithub({ run = {}, jobs, statuses, sums = SUMS, experimentId = 'test' } = {}) {
  const base = `/repos/${REPO}`;
  const calls = [];
  const api = async (p) => {
    calls.push(p);
    if (p === `${base}/actions/runs/4242/attempts/1`) {
      return { ok: true, status: 200, body: { id: 4242, run_attempt: 1, status: 'completed', conclusion: 'success', head_sha: head, path: TRUSTED_CONTROLLER_POLICY.workflowPath, event: 'push', head_branch: TAG, repository: { full_name: REPO }, head_repository: { full_name: REPO }, ...run } };
    }
    if (p.startsWith(`${base}/actions/runs/4242/attempts/1/jobs`)) {
      return { ok: true, status: 200, body: { jobs: jobs ?? [
        { name: CONTROLLER_JOB, conclusion: 'success', labels: ['self-hosted', 'Windows', 'X64', 'mediabox-g10'], runner_name: RUNNER },
        { name: BIND_JOB, conclusion: 'success', labels: ['ubuntu-latest'], runner_name: 'GitHub Actions 7' },
      ] } };
    }
    if (p.startsWith(`${base}/commits/${head}/statuses`)) {
      return { ok: true, status: 200, body: statuses ?? [
        { context: 'g10/trusted-controller', state: 'success', description: `SHA256SUMS sha256:${sums} ${experimentId}`, target_url: `https://github.com/${REPO}/actions/runs/4242/attempts/1`, creator: { login: 'github-actions[bot]' } },
      ] };
    }
    return { ok: false, status: 404, body: null };
  };
  api.calls = calls;
  return api;
}

const trustedManifest = (controller = trustedController()) => ({ experimentId: 'test', candidate: { headSha: head }, controller });

test('GitHub confirms a tag-triggered controller run on the self-hosted runner, bound to the package', async () => {
  assert.deepEqual(await verifyControllerRun({ manifest: trustedManifest(), sumsSha256: SUMS, api: fakeGithub() }), []);
});

test('manifest claims outside the controller policy are refused before asking GitHub', async () => {
  const cases = {
    'belongs to': { repository: 'someone/fork' },
    'runId is missing': { runId: undefined },
    'is not a refs/tags/g10/': { ref: 'refs/heads/main', workflowRef: `${REPO}/${TRUSTED_CONTROLLER_POLICY.workflowPath}@refs/heads/main` },
    'event': { event: 'workflow_dispatch' },
    'workflow commit': { workflowSha: 'f'.repeat(40) },
    'is not self-hosted': { runnerEnvironment: 'github-hosted' },
    "isolation check 'lan-blocked'": { isolation: { ok: true, checks: TRUSTED_CONTROLLER_POLICY.isolationChecks.filter((id) => id !== 'lan-blocked').map((id) => ({ id, ok: true })) } },
    'did not pass': { isolation: { ok: false, checks: [] } },
  };
  for (const [expected, overrides] of Object.entries(cases)) {
    const api = fakeGithub();
    const errors = await verifyControllerRun({ manifest: trustedManifest(trustedController(overrides)), sumsSha256: SUMS, api });
    assert.ok(errors.some((e) => e.includes(expected)), `${expected}: ${errors.join(' | ')}`);
    assert.equal(api.calls.length, 0, `${expected}: no API call for an invalid manifest`);
  }
});

test('a run GitHub describes differently is refused', async () => {
  const cases = {
    'is completed/failure': { run: { conclusion: 'failure' } },
    'controller run head': { run: { head_sha: 'f'.repeat(40) } },
    'controller run workflow': { run: { path: '.github/workflows/ci.yml' } },
    'controller run event': { run: { event: 'pull_request' } },
    'controller run ref': { run: { head_branch: 'g10/other' } },
    'not a run of this repository': { run: { head_repository: { full_name: 'someone/fork' } } },
    'not the self-hosted mediabox-g10 runner': { jobs: [
      { name: CONTROLLER_JOB, conclusion: 'success', labels: ['ubuntu-latest'], runner_name: RUNNER },
      { name: BIND_JOB, conclusion: 'success', labels: ['ubuntu-latest'], runner_name: 'GitHub Actions 7' },
    ] },
    'controller job runner': { jobs: [
      { name: CONTROLLER_JOB, conclusion: 'success', labels: ['self-hosted', 'mediabox-g10'], runner_name: 'someone-else' },
      { name: BIND_JOB, conclusion: 'success', labels: ['ubuntu-latest'], runner_name: 'GitHub Actions 7' },
    ] },
    'jobs not successful': { jobs: [
      { name: CONTROLLER_JOB, conclusion: 'success', labels: ['self-hosted', 'mediabox-g10'], runner_name: RUNNER },
      { name: BIND_JOB, conclusion: 'skipped', labels: ['ubuntu-latest'], runner_name: '' },
    ] },
    'no g10/trusted-controller commit status': { statuses: [] },
    'not this package': { sums: 'b'.repeat(64) },
    'created by': { statuses: [{ context: 'g10/trusted-controller', state: 'success', description: `SHA256SUMS sha256:${SUMS} test`, target_url: `https://github.com/${REPO}/actions/runs/4242/attempts/1`, creator: { login: 'JuanCMPDev' } }] },
  };
  for (const [expected, fake] of Object.entries(cases)) {
    const errors = await verifyControllerRun({ manifest: trustedManifest(), sumsSha256: SUMS, api: fakeGithub(fake) });
    assert.ok(errors.some((e) => e.includes(expected)), `${expected}: ${errors.join(' | ')}`);
  }
});

test('without a token the controller run cannot be confirmed', async () => {
  const errors = await verifyControllerRun({ manifest: trustedManifest(), sumsSha256: SUMS, api: null });
  assert.deepEqual(errors, ['cannot confirm the controller run without GITHUB_TOKEN']);
});

test('trusted-controller evidence confirmed by GitHub satisfies G10, and only for its own package', async () => {
  const dir = writeEvidence(buildManifest({ evidenceClass: 'trusted-controller', controller: trustedController() }));
  const sums = sha256(fs.readFileSync(path.join(dir, 'SHA256SUMS')));
  const res = await verifyEvidence({ evidence: dir, requireClass: 'trusted-controller', api: fakeGithub({ sums }) });
  assert.equal(res.valid, true, res.errors.join('\n'));
  const other = await verifyEvidence({ evidence: dir, requireClass: 'trusted-controller', api: fakeGithub({ sums: 'c'.repeat(64) }) });
  assert.equal(other.valid, false);
  assert.ok(other.errors.some((e) => e.includes('not this package')));
});
