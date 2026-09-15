#!/usr/bin/env node
/**
 * Evaluation controller (PR05 §5).
 *
 * Receives an explicit reviewed SHA, creates a clean detached worktree of it,
 * installs from the lockfile, builds, and runs the live evaluation there, so
 * the evidence describes exactly that commit and never a dirty working tree.
 * Raw observations stay in the controller's storage (outside the repository,
 * retained ≥ 90 days) next to the sanitized package, `<storage>/<id>/package`.
 *
 * Evidence classes:
 *  - `local-lab`: a run from the maintainer's own session. The package is also
 *    copied into evals/evidence/<id>/ for review. G10 does not accept it.
 *  - `trusted-controller`: only inside the G10 controller workflow
 *    (.github/workflows/g10-controller.yml), on the just-in-time runner of the
 *    dedicated account that scripts/controller/Install-G10Controller.ps1
 *    provisions, and only after every isolation check passes from inside that
 *    account (controller-isolation.mjs). Toolchain, weights and storage come
 *    from the provisioning file; the worktree and temporary files live in the
 *    job's temporary folder, inside the account profile. The evaluated
 *    processes run on the evaluation node, which the firewall keeps on
 *    loopback. The manifest records the Actions run and the check results;
 *    the verifier confirms both with GitHub.
 *
 * `--rehearsal` runs the same path as a short dev run (two scenarios, one
 * pass, performance included) whose manifest the verifier never accepts.
 *
 *   node evals/local-agent/controller.mjs --sha <commit> --storage <dir> [--class local-lab]
 *        [--ollama-exe <path>] [--passes 3] [--profile <path>] [--rehearsal]
 *   node evals/local-agent/controller.mjs --sha <commit> --class trusted-controller [--rehearsal]
 */

import { execFileSync, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_PROVISIONING, actionsRunContext, attestIsolation, checkIsolation, loadProvisioning,
} from './controller-isolation.mjs';

const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), '../..');

/** A rehearsal measures one read and one proposal the owner approves. */
export const REHEARSAL_SCENARIOS = ['READ-01', 'DOWNLOAD-01'];
const LIVE_TAG = 'refs/tags/g10/';
const REHEARSAL_TAG = 'refs/tags/g10-rehearsal/';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/** Copy of `env` whose PATH starts with `dirs` (Windows keys are case-insensitive). */
function withPath(env, dirs) {
  const out = { ...env };
  const key = Object.keys(out).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
  const current = out[key] ?? '';
  for (const k of Object.keys(out)) if (k.toUpperCase() === 'PATH') delete out[k];
  out[key] = [...dirs, current].filter(Boolean).join(path.delimiter);
  return out;
}

function run(cmd, args, cwd, env) {
  console.log(`[controller] ${cmd} ${args.join(' ')}`);
  const r = spawnSync(cmd, args, { cwd, env, stdio: 'inherit', shell: process.platform === 'win32' && cmd === 'npm' });
  if (r.status !== 0) throw new Error(`${cmd} ${args[0]} failed with ${r.status}`);
}

const sha = arg('sha');
const evidenceClass = arg('class', 'local-lab');
const rehearsal = process.argv.includes('--rehearsal');
if (!sha || !['local-lab', 'trusted-controller'].includes(evidenceClass)) {
  console.error('usage: controller.mjs --sha <commit> --storage <dir> [--class local-lab] [--rehearsal]\n'
    + '       controller.mjs --sha <commit> --class trusted-controller [--rehearsal]');
  process.exit(2);
}

const fullSha = execFileSync('git', ['rev-parse', `${sha}^{commit}`], { cwd: repoRoot, encoding: 'utf8' }).trim();

// ── Where and how the candidate runs ───────────────────────────────────────
let storage = arg('storage');
let ollamaExe = arg('ollama-exe');
let evalNode = process.execPath;
let tmpRoot = os.tmpdir();
let childEnv = { ...process.env };
let attestation = null;
let actions = null;

if (evidenceClass === 'trusted-controller') {
  try {
    actions = actionsRunContext(process.env);
    if (actions.runnerEnvironment !== 'self-hosted') throw new Error(`runner environment '${actions.runnerEnvironment}' is not the self-hosted controller`);
    if (actions.event !== 'push') throw new Error(`event '${actions.event}': the controller starts only from a pushed tag`);
    const prefix = rehearsal ? REHEARSAL_TAG : LIVE_TAG;
    if (!actions.ref.startsWith(prefix)) throw new Error(`ref ${actions.ref} is not a ${prefix}* tag`);
    if (actions.sha !== fullSha || actions.workflowSha !== fullSha) {
      throw new Error(`job commit ${actions.sha} and workflow commit ${actions.workflowSha} must both be the candidate ${fullSha}`);
    }
    const provisioningFile = process.env.MEDIABOX_CONTROLLER_PROVISIONING || DEFAULT_PROVISIONING;
    const { provisioning, sha256: provisioningSha256 } = loadProvisioning(provisioningFile);
    if (!actions.runnerName.startsWith(provisioning.runner.namePrefix)) throw new Error(`runner '${actions.runnerName}' is not a just-in-time runner of this controller`);
    const result = await checkIsolation(provisioning, { provisioningFile });
    for (const c of result.checks) console.log(`[controller] isolation ${c.ok ? 'ok  ' : 'FAIL'} ${c.id}: ${c.detail}`);
    if (!result.ok) throw new Error('isolation checks failed; the trusted controller refuses to run');
    attestation = attestIsolation(provisioning, provisioningSha256, result);
    storage = provisioning.storage;
    ollamaExe = provisioning.runtime.ollamaExe;
    evalNode = provisioning.toolchain.evalNode;
    // Build tools such as esbuild read every parent folder of the project, and
    // the account cannot list the root of the data drive, so the worktree and
    // the temporary files go to the job's temporary folder, inside the account
    // profile, which the runner also empties after the job.
    tmpRoot = process.env.RUNNER_TEMP || os.tmpdir();
    childEnv = withPath({
      ...process.env,
      TEMP: tmpRoot,
      TMP: tmpRoot,
      npm_config_cache: provisioning.npmCache,
      OLLAMA_MODELS: provisioning.runtime.modelsDir,
    }, [path.dirname(provisioning.toolchain.node), provisioning.toolchain.ffmpegDir]);
  } catch (err) {
    console.error(`[controller] ${err.message}`);
    process.exit(2);
  }
}
if (!storage) {
  console.error('[controller] --storage <directory outside the repository> is required for local-lab runs');
  process.exit(2);
}

const experimentId = `pr05-g10-${new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)}-${fullSha.slice(0, 8)}`;
const storageDir = path.resolve(storage, experimentId);
fs.mkdirSync(storageDir, { recursive: true });
fs.mkdirSync(tmpRoot, { recursive: true });
const worktree = fs.mkdtempSync(path.join(tmpRoot, 'mediabox-g10-'));

const startedAt = new Date().toISOString();
let exitCode = 0;
try {
  run('git', ['worktree', 'add', '--detach', worktree, fullSha], repoRoot, childEnv);
  const dirty = execFileSync('git', ['status', '--porcelain'], { cwd: worktree, encoding: 'utf8' }).trim();
  if (dirty) throw new Error(`worktree is not clean:\n${dirty}`);
  run('npm', ['ci', '--no-audit', '--no-fund'], worktree, childEnv);
  run('npm', ['run', 'ci:build'], worktree, childEnv);

  const runnerArgs = [
    path.join(worktree, 'evals/local-agent/runner.mjs'),
    '--experiment-id', experimentId,
    '--storage', storageDir,
    '--class', evidenceClass,
    '--controller-started-at', startedAt,
  ];
  if (ollamaExe) runnerArgs.push('--ollama-exe', ollamaExe);
  if (arg('profile')) runnerArgs.push('--profile', arg('profile'));
  if (attestation) {
    const file = path.join(storageDir, 'controller-attestation.json');
    fs.writeFileSync(file, JSON.stringify(attestation, null, 2) + '\n');
    runnerArgs.push('--attestation', file);
  }
  if (rehearsal) runnerArgs.push('--dev', '--only', REHEARSAL_SCENARIOS.join(','), '--passes', '1');
  else if (arg('passes')) runnerArgs.push('--passes', arg('passes'));
  const r = spawnSync(evalNode, runnerArgs, { cwd: worktree, stdio: 'inherit', env: childEnv });
  exitCode = r.status ?? 1;
  // A two-scenario rehearsal is never compatible: it proves the path, not the result.
  if (rehearsal && exitCode === 1) exitCode = 0;

  const manifest = path.join(storageDir, 'experiment-manifest.json');
  if (!fs.existsSync(manifest)) throw new Error('runner produced no manifest');
  const { exportEvidence } = await import(`file://${path.join(repoRoot, 'scripts/ci/evidence.mjs').replace(/\\/g, '/')}`);
  const packageDir = path.join(storageDir, 'package');
  fs.mkdirSync(packageDir, { recursive: true });
  fs.copyFileSync(manifest, path.join(packageDir, 'experiment-manifest.json'));
  exportEvidence(packageDir);
  const sums = sha256(fs.readFileSync(path.join(packageDir, 'SHA256SUMS')));
  console.log(`[controller] evidence package: ${packageDir} (SHA256SUMS sha256:${sums})`);
  if (evidenceClass === 'local-lab' && !rehearsal) {
    // Lab evidence is reviewed from the repository, as in experiments 1 to 9.
    const target = path.join(repoRoot, 'evals/evidence', experimentId);
    fs.mkdirSync(target, { recursive: true });
    fs.copyFileSync(manifest, path.join(target, 'experiment-manifest.json'));
    exportEvidence(target);
    console.log(`[controller] lab evidence copied for review: ${target}`);
  }
  if (actions && process.env.GITHUB_OUTPUT) {
    // The bind job (GitHub-hosted) publishes this digest as a commit status.
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `experiment_id=${experimentId}\nsums_sha256=${sums}\n`);
  }
  console.log(`[controller] raw observations (restricted, keep ≥ 90 days): ${storageDir}`);
} catch (err) {
  console.error(`[controller] ${err.message}`);
  exitCode = exitCode || 1;
} finally {
  try {
    execFileSync('git', ['worktree', 'remove', '--force', worktree], { cwd: repoRoot, stdio: 'ignore' });
  } catch {
    console.error(`[controller] could not remove worktree ${worktree}; remove it with git worktree remove`);
  }
}
process.exit(exitCode);
