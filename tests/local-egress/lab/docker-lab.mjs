/**
 * Docker helpers for G09 (PR05 §3.4). The suite FAILS when Docker or the
 * capture cannot run: a missing capability never produces a green skip.
 * Images are pinned by digest (resolved with `docker buildx imagetools
 * inspect` on 2026-09-11) and every resource created here is removed in
 * `finally`, only by the name this module generated.
 *
 * node --test runs the G09 files in parallel processes, so two cross-process
 * locks keep the lab predictable: one serialises the image build, the other
 * bounds how many topologies run at once (G09_LAB_SLOTS, default 2) so the
 * daemon's address pools and the runner's memory are never exhausted.
 */
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stringify } from 'yaml';

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

export const IMAGES = {
  busybox: 'busybox@sha256:73aaf090f3d85aa34ee199857f03fa3a95c8ede2ffd4cc2cdb5b94e566b11662',
  node: 'node@sha256:d2166de198f26e17e5a442f537754dd616ab069c47cc57b889310a717e0abbf9',
  socat: 'alpine/socat@sha256:beb4a68d9e4fe6b0f21ea774a0fde6c31f580dde6368939ed70100c5385b015e',
};

export function docker(args, { input, allowFail = false, timeoutMs = 600_000 } = {}) {
  const r = spawnSync('docker', args, { encoding: 'utf8', input, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0 && !allowFail) {
    throw new Error(`docker ${args.slice(0, 3).join(' ')} failed (${r.status}): ${(r.stderr || r.stdout || r.error?.message || '').trim().split('\n').slice(-5).join(' | ')}`);
  }
  return { code: r.status, stdout: (r.stdout ?? '').trim(), stderr: (r.stderr ?? '').trim() };
}

/** Same as docker() but asynchronous, so probes in several namespaces can run at once. */
export function dockerAsync(args, { allowFail = false, timeoutMs = 180_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.on('close', (code) => {
      clearTimeout(timer);
      const out = { code, stdout: stdout.trim(), stderr: stderr.trim() };
      if (code !== 0 && !allowFail) reject(new Error(`docker ${args.slice(0, 3).join(' ')} failed (${code}): ${out.stderr.split('\n').slice(-5).join(' | ')}`));
      else resolve(out);
    });
  });
}

/** Throws, so node:test reports a failure, when Linux containers are unavailable. */
export function requireDocker() {
  let info;
  try {
    info = docker(['info', '--format', '{{.OSType}}']);
  } catch (err) {
    throw new Error(`G09 needs a working Docker daemon with Linux containers and never skips: ${err.message}`);
  }
  if (info.stdout !== 'linux') throw new Error(`G09 needs Linux containers, the daemon reports ${info.stdout}`);
}

/** Pulls every pinned lab image that is not present yet; a failed pull fails the suite. */
export function ensureImages() {
  for (const ref of Object.values(IMAGES)) {
    if (docker(['image', 'inspect', ref], { allowFail: true }).code === 0) continue;
    withSlotSync('pull', 1, () => {
      if (docker(['image', 'inspect', ref], { allowFail: true }).code !== 0) docker(['pull', ref], { timeoutMs: 900_000 });
    });
  }
}

export function uniqueName(prefix) {
  return `${prefix}${crypto.randomBytes(4).toString('hex')}`;
}

/** Temporary directory whose name has spaces and Unicode (NET-06). */
export function tempDir(label) {
  return fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), `mbx g09 ñandú ${label}-`));
}

/** Host path in the form Docker Desktop and Linux accept for bind mounts. */
export function hostPath(p) {
  return p.replace(/\\/g, '/');
}

/**
 * Removes a temporary directory this suite created. Containers run as root, so
 * on Linux some entries may belong to root: those are removed from inside a
 * throwaway container that mounts only this directory. Never used on any path
 * the suite did not create with tempDir().
 */
export function removeTempDir(dir) {
  if (!dir || !path.basename(dir).startsWith('mbx g09 ')) throw new Error(`refusing to remove a directory the suite did not create: ${dir}`);
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    return;
  } catch (err) {
    if (!['EACCES', 'EPERM', 'ENOTEMPTY', 'EBUSY'].includes(err.code)) throw err;
  }
  docker(['run', '--rm', '-v', `${hostPath(dir)}:/d`, IMAGES.busybox, 'sh', '-c', 'rm -rf /d/* /d/.[!.]* 2>/dev/null; true'], { allowFail: true });
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

function envLine(key, value) {
  const v = String(value);
  if (/[\r\n]/.test(v)) throw new Error(`.env value for ${key} must be a single line`);
  // Single quotes are literal in compose .env files (no interpolation, no escapes).
  return v.includes("'") ? `${key}="${v.replace(/(["\\$])/g, '\\$1')}"` : `${key}='${v}'`;
}

export class ComposeProject {
  constructor({ name, dir, compose, env = {} }) {
    this.name = name;
    this.dir = dir;
    this.write(compose, env);
  }

  write(compose, env) {
    if (compose) {
      this.compose = compose;
      fs.writeFileSync(path.join(this.dir, 'docker-compose.yml'), stringify(compose, { lineWidth: 0 }));
    }
    if (env) {
      this.env = { ...env };
      fs.writeFileSync(path.join(this.dir, '.env'), Object.entries(this.env).map(([k, v]) => envLine(k, v)).join('\n') + '\n');
    }
  }

  run(args, opts) {
    return docker(['compose', '-p', this.name, '--project-directory', this.dir, '-f', path.join(this.dir, 'docker-compose.yml'), ...args], opts);
  }

  up(services = [], extra = []) {
    return this.run(['up', '-d', '--no-build', '--pull', 'never', ...extra, ...services], { timeoutMs: 600_000 });
  }

  down() {
    return this.run(['down', '-v', '--remove-orphans', '--timeout', '2'], { allowFail: true, timeoutMs: 300_000 });
  }

  container(service) {
    return this.run(['ps', '-a', '-q', service]).stdout.split('\n')[0];
  }

  containers() {
    return this.run(['ps', '-a', '--format', '{{.Service}} {{.ID}}']).stdout.split('\n').filter(Boolean).map((l) => {
      const [service, id] = l.split(' ');
      return { service, id };
    });
  }

  port(service, containerPort) {
    const out = this.run(['port', service, String(containerPort)]).stdout;
    return Number(out.split('\n')[0].split(':').pop());
  }

  logs(service) {
    return this.run(['logs', '--no-color', service], { allowFail: true }).stdout;
  }
}

export function containerIp(containerId, network) {
  const out = docker(['inspect', containerId, '--format', `{{json .NetworkSettings.Networks}}`]).stdout;
  const nets = JSON.parse(out);
  const key = Object.keys(nets).find((k) => k === network || k.endsWith(`_${network}`));
  return key ? nets[key].IPAddress : null;
}

/** Every IPv4/IPv6 address the container holds, over all its networks. */
export function containerIps(containerId) {
  const nets = JSON.parse(docker(['inspect', containerId, '--format', `{{json .NetworkSettings.Networks}}`]).stdout);
  return Object.values(nets).flatMap((n) => [n.IPAddress, n.GlobalIPv6Address]).filter(Boolean);
}

export function inspect(containerId) {
  return JSON.parse(docker(['inspect', containerId]).stdout)[0];
}

/** Stdout and stderr of a container, as `docker logs` returns them. */
export function containerLogs(containerId) {
  const r = docker(['logs', containerId], { allowFail: true });
  return `${r.stdout}\n${r.stderr}`;
}

/** Runs `script` in the network namespace of `containerId` (same routes, DNS and firewall). */
export function probeIn(containerId, script, { extraArgs = [] } = {}) {
  return docker(['run', '--rm', '--network', `container:${containerId}`, ...extraArgs, IMAGES.busybox, 'sh', '-c', script], { allowFail: true, timeoutMs: 120_000 });
}

export function probeInAsync(containerId, script, { extraArgs = [] } = {}) {
  return dockerAsync(['run', '--rm', '--network', `container:${containerId}`, ...extraArgs, IMAGES.busybox, 'sh', '-c', script], { allowFail: true, timeoutMs: 180_000 });
}

export function readLedger(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

export async function waitFor(fn, { timeoutMs = 60_000, intervalMs = 250, attemptMs = 10_000, what = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    let timer;
    try {
      // A ref'd per-attempt timer: an attempt that hangs (a request a port proxy accepted but
      // never answers) is retried instead of stalling, and the event loop cannot drain under it.
      last = await Promise.race([
        Promise.resolve().then(fn),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`attempt exceeded ${attemptMs} ms`)), Math.max(1, Math.min(attemptMs, deadline - Date.now())));
        }),
      ]);
      if (last) return last;
    } catch (err) {
      last = err;
    } finally {
      clearTimeout(timer);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`timed out waiting for ${what}${last instanceof Error ? `: ${last.message}` : ''}`);
}

// ── cross-process slots ───────────────────────────────────────────────────

const LOCK_ROOT = path.join(os.tmpdir(), 'mediabox-g09-locks');
const heldLocks = new Set();
process.on('exit', () => {
  for (const dir of heldLocks) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

function tryTake(name, slots) {
  fs.mkdirSync(LOCK_ROOT, { recursive: true });
  for (let i = 0; i < slots; i++) {
    const dir = path.join(LOCK_ROOT, `${name}-${i}`);
    try {
      fs.mkdirSync(dir);
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      let owner = null;
      try { owner = JSON.parse(fs.readFileSync(path.join(dir, 'owner.json'), 'utf8')); } catch { /* being written */ }
      const st = fs.statSync(dir, { throwIfNoEntry: false });
      const stale = owner ? !pidAlive(owner.pid) : Boolean(st && Date.now() - st.mtimeMs > 120_000);
      if (stale) fs.rmSync(dir, { recursive: true, force: true });
      continue;
    }
    fs.writeFileSync(path.join(dir, 'owner.json'), JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
    heldLocks.add(dir);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      heldLocks.delete(dir);
      fs.rmSync(dir, { recursive: true, force: true });
    };
  }
  return null;
}

/** Waits for one of `slots` cross-process slots called `name`; resolves to a release function. */
export async function acquireSlot(name, slots = 1, { timeoutMs = 3_600_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const release = tryTake(name, slots);
    if (release) return release;
    if (Date.now() > deadline) throw new Error(`timed out waiting for the G09 lab slot "${name}"`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

function withSlotSync(name, slots, fn, { timeoutMs = 3_600_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  const pause = new Int32Array(new SharedArrayBuffer(4));
  let release;
  while (!(release = tryTake(name, slots))) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for the G09 lab slot "${name}"`);
    Atomics.wait(pause, 0, 0, 500);
  }
  try {
    return fn();
  } finally {
    release();
  }
}

export const topologySlots = () => Math.max(1, Number(process.env.G09_LAB_SLOTS) || 2);

// ── the real server image ─────────────────────────────────────────────────

const BUILD_INPUTS = ['packages/mcp-server/Dockerfile', 'package.json', 'package-lock.json', 'tsconfig.base.json'];
const BUILD_WORKSPACES = ['contracts', 'core', 'chat-core', 'mcp-server'];

function walkFiles(rel, out) {
  const abs = path.join(repoRoot, rel);
  for (const d of fs.readdirSync(abs, { withFileTypes: true })) {
    const child = `${rel}/${d.name}`;
    if (d.isDirectory()) walkFiles(child, out);
    else if (d.isFile()) out.push(child);
  }
}

/** Hash of exactly what packages/mcp-server/Dockerfile copies into the image. */
function buildInputsHash() {
  const files = [...BUILD_INPUTS];
  for (const ws of BUILD_WORKSPACES) {
    files.push(`packages/${ws}/package.json`, `packages/${ws}/tsconfig.json`);
    walkFiles(`packages/${ws}/src`, files);
  }
  const h = crypto.createHash('sha256');
  for (const f of files.sort()) {
    h.update(f).update('\0').update(fs.readFileSync(path.join(repoRoot, f))).update('\0');
  }
  return h.digest('hex').slice(0, 16);
}

/**
 * Builds the real mcp-server image from packages/mcp-server/Dockerfile. The tag
 * is the hash of the build inputs, so an unchanged tree reuses the image and
 * any source edit (committed or not) produces a new one.
 */
export function buildServerImage() {
  const tag = `mediabox-mcp:g09-${buildInputsHash()}`;
  if (docker(['image', 'inspect', tag], { allowFail: true }).code === 0) return tag;
  return withSlotSync('build', 1, () => {
    if (docker(['image', 'inspect', tag], { allowFail: true }).code !== 0) {
      docker(['build', '-f', 'packages/mcp-server/Dockerfile', '-t', tag, repoRoot], { timeoutMs: 1_800_000 });
    }
    return tag;
  });
}

export function gitHead() {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}
