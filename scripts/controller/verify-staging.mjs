#!/usr/bin/env node
/**
 * Verifies the staged files of the local trusted controller (PR05 §5) against
 * the sealed profile before the installer grants them to the dedicated
 * account: the runtime binary and its library set, the model manifest and
 * every blob it names, the two copies of the toolchain node, npm, ffmpeg and
 * the Actions runner.
 *
 *   node scripts/controller/verify-staging.mjs --root E:\mediabox-g10 [--profile <path>] [--json]
 */

import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { hashDirectory, sha256File } from '../../evals/local-agent/profile.mjs';

const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), '../..');
/** The Node release of CI and of experiments 1 to 9. */
export const NODE_VERSION = 'v22.19.0';

export function verifyStaging({ root, profile }) {
  const checks = [];
  const add = (id, ok, detail) => checks.push({ id, ok: Boolean(ok), detail });
  const exists = (p) => fs.existsSync(p);

  const exe = path.join(root, 'ollama', 'ollama.exe');
  if (!exists(exe)) add('runtime.binary', false, 'ollama.exe missing');
  else {
    const digest = `sha256:${sha256File(exe)}`;
    add('runtime.binary', digest === profile.runtime.binary.sha256, digest === profile.runtime.binary.sha256 ? 'ollama.exe matches the profile' : `ollama.exe is ${digest}`);
  }
  const lib = path.join(root, 'ollama', 'lib', 'ollama');
  if (!exists(lib)) add('runtime.libraries', false, 'lib/ollama missing');
  else {
    const d = hashDirectory(lib);
    const ok = d.sha256 === profile.runtime.libraries.sha256 && d.files === profile.runtime.libraries.files;
    add('runtime.libraries', ok, ok ? `${d.files} library files match the profile` : `${d.files} files, ${d.sha256}`);
  }

  const [name, tag = 'latest'] = profile.model.name.split(':');
  const manifestFile = path.join(root, 'models', 'manifests', 'registry.ollama.ai', 'library', name, tag);
  if (!exists(manifestFile)) add('model.manifest', false, `${profile.model.name} manifest missing`);
  else {
    const bytes = fs.readFileSync(manifestFile);
    const digest = `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
    add('model.manifest', digest === profile.model.manifestDigest, digest === profile.model.manifestDigest ? `${profile.model.name} manifest matches the profile` : `manifest is ${digest}`);
    const manifest = JSON.parse(bytes.toString('utf8'));
    const digests = [manifest.config, ...manifest.layers].map((l) => l.digest);
    const bad = digests.filter((d) => {
      const file = path.join(root, 'models', 'blobs', d.replace(':', '-'));
      return !exists(file) || `sha256:${sha256File(file)}` !== d;
    });
    add('model.blobs', bad.length === 0, bad.length ? `bad or missing blobs: ${bad.map((d) => d.slice(7, 19)).join(', ')}` : `${digests.length} blobs verified`);
  }

  const nodes = ['node', 'node-eval'].map((d) => path.join(root, 'toolchain', d, 'node.exe'));
  const versions = nodes.map((n) => (exists(n) ? execFileSync(n, ['--version'], { encoding: 'utf8' }).trim() : 'missing'));
  add('toolchain.node', versions.every((v) => v === NODE_VERSION), `node ${versions.join(' / ')} (expected ${NODE_VERSION})`);
  const sameBinary = nodes.every(exists) && sha256File(nodes[0]) === sha256File(nodes[1]);
  add('toolchain.eval-node', sameBinary, sameBinary ? 'the evaluation node is the toolchain node binary' : 'the evaluation node differs from the toolchain node');
  const npm = path.join(root, 'toolchain', 'node', 'node_modules', 'npm', 'bin', 'npm-cli.js');
  add('toolchain.npm', exists(npm), exists(npm) ? 'npm next to the toolchain node' : 'npm missing');
  const ffmpeg = path.join(root, 'toolchain', 'ffmpeg', 'ffmpeg.exe');
  const ffprobe = path.join(root, 'toolchain', 'ffmpeg', 'ffprobe.exe');
  const ffmpegVersion = exists(ffmpeg) ? execFileSync(ffmpeg, ['-hide_banner', '-version'], { encoding: 'utf8' }).split(/\r?\n/)[0] : 'ffmpeg missing';
  add('toolchain.ffmpeg', exists(ffmpeg) && exists(ffprobe), exists(ffprobe) ? ffmpegVersion : `${ffmpegVersion}; ffprobe missing`);
  const listener = path.join(root, 'runner', 'bin', 'Runner.Listener.exe');
  add('runner', exists(listener), exists(listener) ? 'Actions runner present' : 'Actions runner missing');
  return { ok: checks.every((c) => c.ok), checks };
}

if (process.argv[1] && path.resolve(process.argv[1]).toLowerCase() === __filename.toLowerCase()) {
  const arg = (name) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : undefined; };
  const root = arg('root');
  if (!root) {
    console.error('usage: verify-staging.mjs --root <dir> [--profile <path>] [--json]');
    process.exit(2);
  }
  const declarations = JSON.parse(fs.readFileSync(path.join(repoRoot, 'evals/local-agent/profile-declarations.json'), 'utf8'));
  const profilePath = arg('profile') ?? path.join(repoRoot, 'ci/model-profiles', `${declarations.profileId}.json`);
  const result = verifyStaging({ root: path.resolve(root), profile: JSON.parse(fs.readFileSync(profilePath, 'utf8')) });
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else for (const c of result.checks) console.log(`${c.ok ? 'ok  ' : 'FAIL'} ${c.id}: ${c.detail}`);
  process.exit(result.ok ? 0 : 1);
}
