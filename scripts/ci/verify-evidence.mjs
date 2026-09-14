#!/usr/bin/env node
/**
 * ci:verify-evidence — Gate G10 verifier (PR05 §5).
 *
 * The report of a PR never validates itself. This verifier:
 *  1. binds the evidence to a real candidate commit: the manifest's checkout
 *     SHA must be an ancestor of HEAD and nothing but evidence/docs may have
 *     changed since; every sealed input is re-hashed from that commit's blobs;
 *  2. rejects anything that is not a live run of a real model (no simulated,
 *     scripted or replay evidence), and requires the evidence class the gate
 *     asks for — G10 accepts only `trusted-controller` evidence, and only when
 *     GitHub confirms its controller run: a tag-triggered run of the controller
 *     workflow of this repository on the candidate, its controller job on the
 *     self-hosted controller runner, every job successful, and a commit status
 *     from the GitHub-hosted bind job carrying this package's SHA256SUMS digest
 *     (TRUSTED_CONTROLLER_POLICY);
 *  3. recomputes every pass summary, percentile and threshold from the
 *     per-execution records instead of trusting recorded summaries, checks
 *     completeness (60 IDs per pass, fixed order, attempts retained) and the
 *     performance controls;
 *  4. checks SHA256SUMS and, when the controller's raw observations are
 *     available, re-hashes and re-scores every execution from them.
 *
 *   node scripts/ci/verify-evidence.mjs [--evidence <dir>] [--require-class trusted-controller|local-lab]
 *                                        [--observations <dir>] [--json]
 */

import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), '../..');

export const VERIFIER_VERSION = '2.1.0';
/** Paths that may change between the evaluated commit and the verified HEAD. */
export const POST_EVIDENCE_ALLOWED = [/^evals\/evidence\//, /^docs\//];
export const EVIDENCE_CLASSES = ['local-lab', 'trusted-controller'];

/**
 * Where trusted-controller evidence must come from (PR05 §5, revised
 * 2026-09-14). It lives here, not in the controller, so that a change to the
 * controller cannot relax what the verifier asks for. The isolation checks
 * mirror controller-isolation.mjs; a test keeps both lists equal.
 */
export const TRUSTED_CONTROLLER_POLICY = Object.freeze({
  repository: 'JuanCMPDev/mediabox-mcp',
  workflowPath: '.github/workflows/g10-controller.yml',
  event: 'push',
  tagPrefix: 'g10/',
  controllerJob: 'G10 trusted controller',
  runnerLabel: 'mediabox-g10',
  statusContext: 'g10/trusted-controller',
  statusCreator: 'github-actions[bot]',
  isolationChecks: Object.freeze([
    'account', 'not-administrator', 'provisioning-read-only', 'maintainer-profile', 'denied-paths', 'drives',
    'firewall-profiles', 'firewall-rules', 'lan-blocked', 'eval-loopback-only', 'host-sockets',
  ]),
});

/** Minimal GitHub REST client: `api(path)` resolves to `{ ok, status, body }`. */
export function githubApi(token) {
  return async (apiPath) => {
    const res = await fetch(`https://api.github.com${apiPath}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
    });
    return { ok: res.ok, status: res.status, body: res.ok ? await res.json() : null };
  };
}

/**
 * Confirms with GitHub the run that produced trusted-controller evidence.
 * Returns the list of problems; an empty list means the run is confirmed.
 */
export async function verifyControllerRun({ manifest, sumsSha256, api, policy = TRUSTED_CONTROLLER_POLICY }) {
  const errors = [];
  const fail = (msg) => { errors.push(msg); };
  const c = manifest.controller ?? {};
  const headSha = manifest.candidate?.headSha;

  // What the manifest says about its run.
  if (c.kind !== 'github-actions') fail(`controller kind '${c.kind}' is not github-actions`);
  if (c.repository !== policy.repository) fail(`controller run belongs to '${c.repository}', not ${policy.repository}`);
  if (!Number.isSafeInteger(c.runId) || c.runId <= 0) fail('controller runId is missing');
  if (!Number.isSafeInteger(c.runAttempt) || c.runAttempt <= 0) fail('controller runAttempt is missing');
  const tagRef = `refs/tags/${policy.tagPrefix}`;
  const refOk = typeof c.ref === 'string' && c.ref.startsWith(tagRef);
  if (!refOk) fail(`controller ref '${c.ref}' is not a ${tagRef}* tag`);
  if (c.event !== policy.event) fail(`controller event '${c.event}' is not ${policy.event}`);
  if (c.workflowRef !== `${policy.repository}/${policy.workflowPath}@${c.ref}`) fail(`controller workflow '${c.workflowRef}' is not ${policy.workflowPath} at ${c.ref}`);
  if (!headSha || c.workflowSha !== headSha) fail(`controller workflow commit ${c.workflowSha} is not the candidate ${headSha}`);
  if (!c.runnerName) fail('controller runner name is missing');
  if (c.runnerEnvironment !== 'self-hosted') fail(`controller runner environment '${c.runnerEnvironment}' is not self-hosted`);
  const isolation = c.isolation;
  if (!isolation || isolation.ok !== true) fail('controller isolation checks are missing or did not pass');
  else {
    for (const id of policy.isolationChecks) {
      if (!isolation.checks?.some((x) => x.id === id && x.ok === true)) fail(`controller isolation check '${id}' is missing or failed`);
    }
  }
  if (!/^[0-9a-f]{64}$/.test(sumsSha256 ?? '')) fail('SHA256SUMS digest unavailable');
  if (errors.length) return errors;
  if (!api) return ['cannot confirm the controller run without GITHUB_TOKEN'];

  // What GitHub says about that run.
  const base = `/repos/${policy.repository}`;
  const attempt = await api(`${base}/actions/runs/${c.runId}/attempts/${c.runAttempt}`);
  if (!attempt.ok || !attempt.body) return [`controller run ${c.runId} attempt ${c.runAttempt} not found (${attempt.status})`];
  const run = attempt.body;
  if (run.status !== 'completed' || run.conclusion !== 'success') fail(`controller run ${c.runId} attempt ${c.runAttempt} is ${run.status}/${run.conclusion}`);
  if (run.head_sha !== headSha) fail(`controller run head ${run.head_sha} != evidence candidate ${headSha}`);
  if (String(run.path ?? '').split('@')[0] !== policy.workflowPath) fail(`controller run workflow ${run.path} is not ${policy.workflowPath}`);
  if (run.event !== policy.event) fail(`controller run event ${run.event} is not ${policy.event}`);
  if (run.head_branch !== c.ref.slice('refs/tags/'.length)) fail(`controller run ref ${run.head_branch} != manifest ${c.ref}`);
  if (run.repository?.full_name !== policy.repository || (run.head_repository && run.head_repository.full_name !== policy.repository)) {
    fail('controller run is not a run of this repository');
  }

  const jobsRes = await api(`${base}/actions/runs/${c.runId}/attempts/${c.runAttempt}/jobs?per_page=100`);
  const jobs = jobsRes.ok ? jobsRes.body?.jobs ?? [] : [];
  const job = jobs.find((j) => j.name === policy.controllerJob);
  if (!job) fail(`controller run has no '${policy.controllerJob}' job`);
  else {
    const labels = (job.labels ?? []).map((l) => String(l).toLowerCase());
    if (!labels.includes('self-hosted') || !labels.includes(policy.runnerLabel)) fail(`controller job ran on [${(job.labels ?? []).join(', ')}], not the self-hosted ${policy.runnerLabel} runner`);
    if (job.runner_name !== c.runnerName) fail(`controller job runner ${job.runner_name} != manifest ${c.runnerName}`);
  }
  const unsuccessful = jobs.filter((j) => j.conclusion !== 'success');
  if (unsuccessful.length) fail(`controller run jobs not successful: ${unsuccessful.map((j) => `${j.name}=${j.conclusion}`).join(', ')}`);

  // The GitHub-hosted bind job published the package digest on the candidate.
  const statusesRes = await api(`${base}/commits/${headSha}/statuses?per_page=100`);
  const statuses = statusesRes.ok ? statusesRes.body ?? [] : [];
  const expected = `SHA256SUMS sha256:${sumsSha256} ${manifest.experimentId}`;
  const runUrl = `/${policy.repository}/actions/runs/${c.runId}/attempts/${c.runAttempt}`;
  const binding = statuses.find((s) => s.context === policy.statusContext && String(s.target_url ?? '').endsWith(runUrl));
  if (!binding) fail(`no ${policy.statusContext} commit status from run ${c.runId} attempt ${c.runAttempt} on the candidate`);
  else {
    if (binding.description !== expected) fail(`the ${policy.statusContext} status binds '${binding.description}', not this package ('${expected}')`);
    if (binding.state !== 'success') fail(`the ${policy.statusContext} status is ${binding.state}`);
    if (binding.creator?.login !== policy.statusCreator) fail(`the ${policy.statusContext} status was created by ${binding.creator?.login}, not ${policy.statusCreator}`);
  }
  return errors;
}

export function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function git(args, opts = {}) {
  return execFileSync('git', args, { cwd: repoRoot, encoding: opts.encoding ?? 'utf8', maxBuffer: 256 * 1024 * 1024 });
}

/** Hash of a file as stored in a commit (independent of CRLF checkout settings). */
export function blobSha256(commit, relPath) {
  const bytes = execFileSync('git', ['cat-file', 'blob', `${commit}:${relPath}`], { cwd: repoRoot, maxBuffer: 256 * 1024 * 1024 });
  return sha256(bytes);
}

export function blobText(commit, relPath) {
  return git(['cat-file', 'blob', `${commit}:${relPath}`]);
}

export function parseArgs(argv) {
  const args = { evidence: null, requireClass: 'trusted-controller', observations: null, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--evidence') args.evidence = path.resolve(argv[++i]);
    else if (a === '--require-class') args.requireClass = argv[++i];
    else if (a === '--observations') args.observations = path.resolve(argv[++i]);
    else if (a === '--json') args.json = true;
  }
  return args;
}

function resolveEvidenceDir(explicit) {
  if (explicit) return explicit;
  const pointer = path.join(repoRoot, 'evals/evidence/current.json');
  if (!fs.existsSync(pointer)) return null;
  const { experimentId } = JSON.parse(fs.readFileSync(pointer, 'utf8'));
  return path.join(repoRoot, 'evals/evidence', experimentId);
}

async function importAt(commit, relPath, scratch) {
  // Scorer and corpus are taken from the evaluated commit, not from HEAD.
  const target = path.join(scratch, relPath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, blobText(commit, relPath));
  return target;
}

export async function verifyEvidence(options = {}) {
  const opts = { ...parseArgs([]), ...options };
  const errors = [];
  const notes = [];
  const fail = (msg) => { errors.push(msg); };

  const dir = resolveEvidenceDir(opts.evidence);
  if (!dir || !fs.existsSync(path.join(dir, 'experiment-manifest.json'))) {
    return { valid: false, errors: ['No G10 evidence: evals/evidence/current.json or the experiment manifest is missing. G10 stays pending (no skip counts as a pass).'], notes };
  }
  const manifestPath = path.join(dir, 'experiment-manifest.json');
  const manifestBytes = fs.readFileSync(manifestPath);
  const m = JSON.parse(manifestBytes.toString('utf8'));

  // ── 1. Kind of evidence ─────────────────────────────────────────────────
  if (m.schemaVersion !== 2) fail(`manifest schemaVersion ${m.schemaVersion} is not 2`);
  if (m.lot !== 'PR05') fail(`manifest lot ${m.lot} is not PR05`);
  if (m.mode !== 'live') fail(`evidence mode '${m.mode}': only live runs of a real model count for G10`);
  if (!EVIDENCE_CLASSES.includes(m.evidenceClass)) fail(`unknown evidence class '${m.evidenceClass}'`);
  if (opts.requireClass && m.evidenceClass !== opts.requireClass) {
    const order = EVIDENCE_CLASSES.indexOf(m.evidenceClass) - EVIDENCE_CLASSES.indexOf(opts.requireClass);
    if (order < 0) fail(`evidence class '${m.evidenceClass}' is not accepted where '${opts.requireClass}' is required (G10 needs an isolated, trusted controller; see PR05 §5)`);
  }
  if (m.evidenceClass === 'trusted-controller') {
    // The digest of SHA256SUMS covers the manifest and the report; the bind
    // job of the controller run published it on the candidate commit.
    const sumsFile = path.join(dir, 'SHA256SUMS');
    const sumsSha256 = fs.existsSync(sumsFile) ? sha256(fs.readFileSync(sumsFile)) : null;
    const api = opts.api ?? (process.env.GITHUB_TOKEN ? githubApi(process.env.GITHUB_TOKEN) : null);
    for (const problem of await verifyControllerRun({ manifest: m, sumsSha256, api, policy: opts.policy ?? TRUSTED_CONTROLLER_POLICY })) fail(problem);
  }

  // ── 2. Candidate binding ────────────────────────────────────────────────
  const cand = m.candidate ?? {};
  const head = git(['rev-parse', 'HEAD']).trim();
  let candidateOk = false;
  try {
    git(['cat-file', '-e', `${cand.headSha}^{commit}`]);
    candidateOk = true;
  } catch {
    fail(`candidate commit ${cand.headSha} does not exist in this repository`);
  }
  if (candidateOk) {
    try {
      git(['merge-base', '--is-ancestor', cand.headSha, head]);
    } catch {
      fail(`candidate ${cand.headSha} is not an ancestor of HEAD ${head}`);
    }
    const tree = git(['rev-parse', `${cand.headSha}^{tree}`]).trim();
    if (tree !== cand.treeSha) fail(`candidate tree ${tree} != recorded ${cand.treeSha}`);
    if (cand.checkoutSha !== cand.headSha) fail('the controller must evaluate a clean checkout of the candidate commit');
    const changed = git(['diff', '--name-only', cand.headSha, head]).split('\n').filter(Boolean);
    const outside = changed.filter((f) => !POST_EVIDENCE_ALLOWED.some((re) => re.test(f)));
    if (outside.length) fail(`code changed after the evaluated commit, the evidence is stale: ${outside.slice(0, 10).join(', ')}${outside.length > 10 ? ' …' : ''}`);
    if (m.controller?.cleanCheckout !== true) fail('controller did not record a clean checkout');

    for (const [name, entry] of Object.entries(m.sealed ?? {})) {
      try {
        const actual = blobSha256(cand.headSha, entry.path);
        if (actual !== entry.sha256) fail(`sealed ${name} (${entry.path}) hash ${actual} != recorded ${entry.sha256}`);
      } catch {
        fail(`sealed ${name} (${entry.path}) is not in the candidate commit`);
      }
    }
    for (const required of ['contract', 'corpus', 'profile', 'scorer', 'extractor', 'runner', 'stack', 'syntheticServices', 'perf', 'packageLock']) {
      if (!m.sealed?.[required]) fail(`sealed input '${required}' is not recorded`);
    }
  }

  // ── 3. Profile frozen before measuring ──────────────────────────────────
  const firstPassStart = (m.passes ?? []).map((p) => p.startedAt).filter(Boolean).sort()[0];
  if (!m.profile?.sealedAt || !firstPassStart || !(m.profile.sealedAt < firstPassStart)) {
    fail('profile must be sealed (committed) before the first pass starts');
  }

  if (errors.length && !candidateOk) return { valid: false, errors, notes };

  // ── 4. Recompute results from the candidate's own scorer and corpus ─────
  const scratch = fs.mkdtempSync(path.join(fs.realpathSync(process.env.TEMP || process.env.TMPDIR || '/tmp'), 'g10-verify-'));
  let scorer;
  let corpus;
  let contract;
  try {
    for (const rel of ['evals/local-agent/extractor.mjs', 'evals/local-agent/scorer.mjs']) await importAt(cand.headSha, rel, scratch);
    // The scorer resolves ajv relative to the repository; point it at this checkout.
    fs.mkdirSync(path.join(scratch, 'packages/chat-core'), { recursive: true });
    fs.copyFileSync(path.join(repoRoot, 'packages/chat-core/package.json'), path.join(scratch, 'packages/chat-core/package.json'));
    fs.symlinkSync(path.join(repoRoot, 'node_modules'), path.join(scratch, 'node_modules'), 'junction');
    scorer = await import(`file://${path.join(scratch, 'evals/local-agent/scorer.mjs').replace(/\\/g, '/')}`);
    corpus = JSON.parse(blobText(cand.headSha, m.sealed.corpus.path));
    contract = JSON.parse(blobText(cand.headSha, m.sealed.contract.path));
  } catch (err) {
    fs.rmSync(scratch, { recursive: true, force: true });
    fail(`cannot load the candidate's scorer/corpus/contract: ${err.message}`);
    return { valid: false, errors, notes };
  }

  const ids = corpus.scenarios.map((s) => s.id);
  if (JSON.stringify(ids) !== JSON.stringify(m.corpus?.scenarioIds)) fail('recorded scenario order differs from the sealed corpus');

  const completed = (m.passes ?? []).filter((p) => p.status === 'completed');
  const invalidated = (m.passes ?? []).filter((p) => p.status === 'invalidated');
  for (const p of invalidated) {
    if (!p.invalidationReason || !p.evidenceOfInfrastructureFault) fail(`invalidated pass ${p.passRunId} lacks a reason and independent evidence`);
    if (!Array.isArray(p.records)) fail(`invalidated pass ${p.passRunId} dropped its records (all attempts must be kept)`);
  }
  if (completed.length !== contract.passes) fail(`${completed.length} completed passes, contract requires ${contract.passes}`);

  const recomputed = [];
  for (const p of completed) {
    const recIds = (p.records ?? []).map((r) => r.scenarioId);
    if (JSON.stringify(recIds) !== JSON.stringify(ids)) fail(`pass ${p.passNumber}: records are not exactly the 60 scenarios in corpus order`);
    if ((p.records ?? []).some((r) => (r.attempt ?? 1) !== 1)) fail(`pass ${p.passNumber}: individual reruns are not allowed`);
    const summary = scorer.summarizePass(p.records ?? [], corpus, contract);
    recomputed.push(summary);
    const recorded = p.summary ?? {};
    if (recorded.successCount !== summary.successCount) fail(`pass ${p.passNumber}: recorded success ${recorded.successCount} != recomputed ${summary.successCount}`);
    for (const k of ['authorization', 'scope', 'egress', 'invalidArguments']) {
      if (recorded.violations?.[k] !== summary.violations[k]) fail(`pass ${p.passNumber}: recorded ${k} violations differ from records`);
    }
  }
  const planned = completed.reduce((acc, p) => acc + (p.records?.length ?? 0), 0);
  if (planned !== contract.plannedExecutions) fail(`${planned} counted executions, contract plans ${contract.plannedExecutions}`);

  const thresholds = scorer.evaluateThresholds({ passSummaries: recomputed, performance: m.performance, contract });
  const compatible = thresholds.valid;
  if (m.compatibility !== (compatible ? 'compatible' : 'not_compatible')) fail(`manifest claims '${m.compatibility}' but the records give '${compatible ? 'compatible' : 'not_compatible'}'`);
  if (!compatible) {
    fail('profile is not compatible with the frozen thresholds (G10 cannot close with this evidence)');
    notes.push(...thresholds.errors.map((e) => `threshold: ${e}`));
  }

  // ── 5. Checksums and raw observations ───────────────────────────────────
  const sumsPath = path.join(dir, 'SHA256SUMS');
  if (!fs.existsSync(sumsPath)) fail('SHA256SUMS missing');
  else {
    for (const line of fs.readFileSync(sumsPath, 'utf8').split('\n').filter(Boolean)) {
      const [hash, rel] = line.split(/\s+/, 2);
      const file = path.join(dir, rel);
      if (!fs.existsSync(file)) fail(`SHA256SUMS lists missing ${rel}`);
      else if (sha256(fs.readFileSync(file)) !== hash) fail(`checksum mismatch for ${rel}`);
    }
    const listed = fs.readFileSync(sumsPath, 'utf8');
    if (!listed.includes('experiment-manifest.json')) fail('SHA256SUMS does not cover the manifest');
  }

  if (opts.observations) {
    const { resolveVirtualCall } = await import(`file://${path.join(repoRoot, 'packages/chat-core/dist/index.js').replace(/\\/g, '/')}`);
    let rescored = 0;
    for (const p of completed) {
      const schemasFile = path.join(opts.observations, p.passRunId, 'tool-schemas.json');
      const toolSchemas = fs.existsSync(schemasFile) ? JSON.parse(fs.readFileSync(schemasFile, 'utf8')) : null;
      for (const rec of p.records ?? []) {
        const file = path.join(opts.observations, p.passRunId, `${rec.scenarioId}.json`);
        if (!fs.existsSync(file)) { fail(`raw observation missing: ${p.passRunId}/${rec.scenarioId}`); continue; }
        const bytes = fs.readFileSync(file);
        if (sha256(bytes) !== rec.observationSha256) { fail(`raw observation hash mismatch: ${p.passRunId}/${rec.scenarioId}`); continue; }
        const obs = JSON.parse(bytes.toString('utf8'));
        const again = scorer.scoreExecution(obs, { contract, corpusMeta: corpus, toolSchemas, resolveVirtualCall });
        if (again.success !== rec.success || JSON.stringify(again.violations) !== JSON.stringify(rec.violations)) {
          fail(`re-scoring ${p.passRunId}/${rec.scenarioId} gives a different result`);
        }
        rescored++;
      }
    }
    notes.push(`re-scored ${rescored} executions from raw observations`);
  } else {
    notes.push('raw observations not provided: records verified for consistency, not re-scored');
  }

  fs.rmSync(scratch, { recursive: true, force: true });
  return { valid: errors.length === 0, errors, notes, compatible, evidenceClass: m.evidenceClass, candidate: cand.headSha };
}

if (process.argv[1] === __filename) {
  const opts = parseArgs(process.argv.slice(2));
  const result = await verifyEvidence(opts);
  if (opts.json) console.log(JSON.stringify(result, null, 2));
  else {
    console.log('=== Gate G10: model-quality evidence verification ===');
    for (const n of result.notes ?? []) console.log(`  · ${n}`);
    if (result.valid) console.log(`✓ G10 evidence verified for ${result.candidate} (${result.evidenceClass})`);
    else {
      console.error('✗ G10 evidence NOT accepted:');
      for (const e of result.errors) console.error(`  - ${e}`);
    }
  }
  process.exit(result.valid ? 0 : 1);
}
