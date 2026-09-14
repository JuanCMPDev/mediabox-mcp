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
 *     asks for — G10 accepts only `trusted-controller` evidence;
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

export const VERIFIER_VERSION = '2.0.0';
/** Paths that may change between the evaluated commit and the verified HEAD. */
export const POST_EVIDENCE_ALLOWED = [/^evals\/evidence\//, /^docs\//];
export const EVIDENCE_CLASSES = ['local-lab', 'trusted-controller'];

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
    const c = m.controller ?? {};
    if (c.kind !== 'github-actions' || !c.runId || !c.repository) fail('trusted-controller evidence must reference a verifiable controller run (kind github-actions, repository, runId)');
    else if (!process.env.GITHUB_TOKEN) fail('cannot confirm the controller run without GITHUB_TOKEN');
    else {
      const res = await fetch(`https://api.github.com/repos/${c.repository}/actions/runs/${c.runId}`, { headers: { Authorization: `Bearer ${process.env.GITHUB_TOKEN}`, Accept: 'application/vnd.github+json' } });
      const run = res.ok ? await res.json() : null;
      if (!run) fail(`controller run ${c.runId} not found (${res.status})`);
      else {
        if (run.head_sha !== m.candidate?.headSha) fail(`controller run head ${run.head_sha} != evidence candidate ${m.candidate?.headSha}`);
        if (run.conclusion !== 'success') fail(`controller run conclusion ${run.conclusion}`);
      }
    }
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
