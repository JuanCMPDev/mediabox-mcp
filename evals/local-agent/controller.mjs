#!/usr/bin/env node
/**
 * Evaluation controller (PR05 §5).
 *
 * Receives an explicit reviewed SHA, creates a clean detached worktree of it,
 * installs from the lockfile, builds, and runs the live evaluation there, so
 * the evidence describes exactly that commit and never a dirty working tree.
 * Raw observations stay in the controller's storage (outside the repository,
 * retained ≥ 90 days); only the sanitized package is copied into
 * evals/evidence/<experimentId>/ for review.
 *
 * Evidence class: a run on a personal workstation is `local-lab`. Only a
 * disposable, isolated controller without personal data, home network, host
 * sockets or controller keys may emit `trusted-controller`, and G10 accepts
 * nothing else.
 *
 *   node evals/local-agent/controller.mjs --sha <commit> --storage <dir> [--class local-lab]
 *        [--ollama-exe <path>] [--passes 3]
 */

import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), '../..');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

function run(cmd, args, cwd) {
  console.log(`[controller] ${cmd} ${args.join(' ')}`);
  const r = spawnSync(cmd, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' && cmd === 'npm' });
  if (r.status !== 0) throw new Error(`${cmd} ${args[0]} failed with ${r.status}`);
}

const sha = arg('sha');
const storage = arg('storage');
const evidenceClass = arg('class', 'local-lab');
if (!sha || !storage) {
  console.error('usage: controller.mjs --sha <commit> --storage <dir> [--class local-lab]');
  process.exit(2);
}
if (evidenceClass === 'trusted-controller' && !process.env.MEDIABOX_TRUSTED_CONTROLLER) {
  console.error('trusted-controller evidence can only be produced on a controller provisioned for it (MEDIABOX_TRUSTED_CONTROLLER).');
  process.exit(2);
}

const fullSha = execFileSync('git', ['rev-parse', `${sha}^{commit}`], { cwd: repoRoot, encoding: 'utf8' }).trim();
const experimentId = `pr05-g10-${new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)}-${fullSha.slice(0, 8)}`;
const storageDir = path.resolve(storage, experimentId);
fs.mkdirSync(storageDir, { recursive: true });
const worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'mediabox-g10-'));

const startedAt = new Date().toISOString();
let exitCode = 0;
try {
  run('git', ['worktree', 'add', '--detach', worktree, fullSha], repoRoot);
  const dirty = execFileSync('git', ['status', '--porcelain'], { cwd: worktree, encoding: 'utf8' }).trim();
  if (dirty) throw new Error(`worktree is not clean:\n${dirty}`);
  run('npm', ['ci', '--no-audit', '--no-fund'], worktree);
  run('npm', ['run', 'ci:build'], worktree);

  const runnerArgs = [
    path.join(worktree, 'evals/local-agent/runner.mjs'),
    '--experiment-id', experimentId,
    '--storage', storageDir,
    '--class', evidenceClass,
    '--controller-started-at', startedAt,
  ];
  for (const k of ['ollama-exe', 'passes', 'profile']) {
    const v = arg(k);
    if (v) runnerArgs.push(`--${k}`, v);
  }
  const r = spawnSync(process.execPath, runnerArgs, { cwd: worktree, stdio: 'inherit' });
  exitCode = r.status ?? 1;

  const manifest = path.join(storageDir, 'experiment-manifest.json');
  if (!fs.existsSync(manifest)) throw new Error('runner produced no manifest');
  const target = path.join(repoRoot, 'evals/evidence', experimentId);
  fs.mkdirSync(target, { recursive: true });
  fs.copyFileSync(manifest, path.join(target, 'experiment-manifest.json'));
  const { exportEvidence } = await import(`file://${path.join(repoRoot, 'scripts/ci/evidence.mjs').replace(/\\/g, '/')}`);
  exportEvidence(target);
  console.log(`[controller] evidence package: ${target}`);
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
