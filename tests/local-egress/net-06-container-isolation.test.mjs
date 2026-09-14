/**
 * NET-06 (PR05 §3.4): every applicable candidate starts with the correct
 * endpoints and temporary volumes whose names have spaces and Unicode; the test
 * checks its APIs, its references and where its effects land, and inspects it
 * for a Docker socket/pipe, privileges and extra mounts.
 *
 *  - container: the generated offline-library topology with the REAL
 *    mcp-server image (docker inspect from outside, plus a look from inside);
 *  - Node: `node packages/mcp-server/dist/index.js` on the host;
 *  - Bun: `bun build packages/mcp-server/src/index.ts --compile` (as the G08
 *    smoke does) run on the host.
 * The host candidates reproduce the Desktop sidecar's process environment
 * (BIND_HOST=127.0.0.1, PRIVACY_PROFILE forwarded) and verify the endpoint the
 * real process uses through the runtime stand-in's own request log. They do NOT
 * exercise the Tauri webview or the Rust shell. A native process must never
 * report the verified `no-default-route` isolation, whatever profile it was given.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { docker, inspect, repoRoot, tempDir, removeTempDir, waitFor } from './lab/docker-lab.mjs';
import {
  startTopology, callTool, findKey, inventory, diffInventory, httpJson, connectMcp, approvePlan, writeTree, hex,
  modelDigest, MODEL, OFFLINE, SYNTHETIC_DIR,
} from './lab/topology.mjs';

const bytes = (label) => Buffer.from(crypto.createHash('sha256').update(label).digest('hex').repeat(96));
const norm = (ip) => String(ip ?? '').replace(/^::ffff:/, '');
const DEFAULT_DOCKER_CAPS = 0xa80425fbn;

describe('NET-06 container candidate (offline-library, real image)', { timeout: 1_800_000 }, () => {
  let t;
  const DL_TARGET = 'Ñandú temporal/borrar esto.mkv';
  const DL_KEEP = 'Ñandú temporal/conservar.nfo';
  const MOVIE = 'movies/Ñandú Película (2024)/Ñandú Película (2024).mkv';

  before(async () => {
    t = await startTopology({
      profile: OFFLINE,
      label: 'n6',
      media: { [MOVIE]: bytes('movie') },
      downloads: { [DL_TARGET]: bytes('download'), [DL_KEEP]: 'conservar\n' },
      seed: { radarr: { movies: [{ id: 1, title: 'Ñandú Película', year: 2024, tmdbId: 424242, hasFile: true, path: '/movies/Ñandú Película (2024)' }] } },
    });
  });

  after(async () => {
    await t?.down();
  });

  it('docker inspect: only the declared media/downloads mounts, no Docker socket or pipe, no privileges, only the generated internal networks', () => {
    const info = inspect(t.cid('mcp-server'));
    const mounts = info.Mounts.map((m) => ({ type: m.Type, source: String(m.Source), destination: m.Destination }));
    assert.deepEqual(mounts.map((m) => m.destination).sort(), ['/data/anime', '/data/movies', '/data/music', '/data/tv', '/downloads']);
    for (const m of mounts) {
      assert.equal(m.type, 'bind', `${m.destination} is not a bind mount`);
      const expected = path.basename(m.destination === '/downloads' ? t.dirs.project : t.mediaRoot);
      assert.ok(m.source.normalize('NFC').includes(expected.normalize('NFC')), `${m.destination} is mounted from ${m.source}, not from the temporary root ${expected}`);
    }
    assert.doesNotMatch(JSON.stringify([info.Mounts, info.HostConfig.Binds]), /docker\.sock|docker_engine|\/run\/docker|containerd\.sock|podman\.sock/i);
    assert.equal(info.HostConfig.Privileged, false);
    assert.deepEqual(info.HostConfig.CapAdd ?? [], []);
    assert.deepEqual(info.HostConfig.Devices ?? [], []);
    for (const mode of ['NetworkMode', 'PidMode', 'IpcMode', 'UTSMode', 'UsernsMode']) assert.notEqual(info.HostConfig[mode], 'host', `${mode}=host`);
    assert.equal((info.HostConfig.SecurityOpt ?? []).some((o) => /unconfined/.test(o)), false);

    const env = Object.fromEntries(info.Config.Env.map((e) => [e.slice(0, e.indexOf('=')), e.slice(e.indexOf('=') + 1)]));
    assert.deepEqual(Object.keys(env).filter((k) => k.startsWith('DOCKER_')), []);
    assert.equal(env.LOCAL_LLM_BASE_URL, 'http://mediabox-inference:11434');
    assert.equal(env.INFERENCE_ENDPOINT_HOSTS, 'mediabox-inference');
    assert.equal(env.INFERENCE_ALLOW_LAN, 'true');
    assert.equal(env.PRIVACY_PROFILE, 'offline-library');
    assert.equal(env.MEDIA_PATH, '/data');

    const attached = Object.keys(info.NetworkSettings.Networks).sort();
    const declared = t.generated.services['mcp-server'].networks.map((n) => t.networkName(n)).sort();
    assert.deepEqual(attached, declared);
    for (const n of attached) {
      assert.equal(docker(['network', 'inspect', n, '--format', '{{.Internal}}']).stdout, 'true', `${n} is not internal`);
    }
  });

  it('inside the container: no Docker socket, default capabilities only, no DOCKER_* variables', () => {
    const r = t.exec('mcp-server', [
      'for p in /var/run/docker.sock /run/docker.sock /var/run/docker /run/containerd/containerd.sock; do [ -e "$p" ] && echo "PRESENT $p"; done',
      'grep -E "^CapEff:" /proc/1/status',
      'echo "SOCKMOUNTS $(grep -c -E "docker\\.sock|containerd\\.sock|docker_engine" /proc/1/mountinfo)"',
      'echo "DOCKERENV $(env | grep -c "^DOCKER_")"',
    ].join('; '));
    assert.doesNotMatch(r.stdout, /PRESENT/, r.stdout);
    const cap = r.stdout.match(/CapEff:\s*([0-9a-f]+)/i);
    assert.ok(cap, `could not read the capability set: ${r.stdout} ${r.stderr}`);
    assert.equal(BigInt(`0x${cap[1]}`) & ~DEFAULT_DOCKER_CAPS, 0n, `capabilities beyond Docker's default set: ${cap[1]}`);
    assert.match(r.stdout, /SOCKMOUNTS 0/);
    assert.match(r.stdout, /DOCKERENV 0/);
  });

  it('the APIs answer through the edge and report the private runtime endpoint', async () => {
    const health = await httpJson(t.baseUrl, 'GET', '/health');
    assert.equal(health.status, 200);
    assert.equal(health.body?.status, 'ok');
    assert.equal((await t.request('GET', '/api/chat/info', { key: 'none' })).status, 401);
    const info = await t.request('GET', '/api/chat/info');
    assert.equal(info.status, 200, info.text);
    assert.equal(info.body.endpoint, 'http://mediabox-inference:11434');
    assert.equal(info.body.privacyIsolation, 'no-default-route');
    assert.equal(info.body.privacyProfile, 'offline-library');
  });

  it('a mediaRef from search_media is accepted by media_details; a tampered one is refused', async () => {
    const agent = await t.mcp('agent');
    const search = await callTool(agent, 'search_media', { query: 'Ñandú', type: 'movie' });
    assert.equal(search.isError, false, search.text);
    const ref = findKey(search.envelope, 'mediaRef');
    assert.ok(typeof ref === 'string' && ref.length > 10, `no mediaRef in ${search.text.slice(0, 600)}`);

    const details = await callTool(agent, 'media_details', { mediaRef: ref });
    assert.equal(details.isError, false, details.text);
    assert.equal(findKey(details.envelope, 'library')?.title, 'Ñandú Película', details.text.slice(0, 600));

    const tampered = `${ref.slice(0, -4)}${ref.slice(-4) === 'aaaa' ? 'bbbb' : 'aaaa'}`;
    const refused = await callTool(agent, 'media_details', { mediaRef: tampered });
    assert.ok(refused.isError || findKey(refused.envelope, 'error'), `a tampered reference was accepted: ${refused.text.slice(0, 400)}`);

    const serverIps = new Set(t.ips('mcp-server'));
    const radarr = t.requestLog('radarr');
    assert.ok(radarr.some((e) => e.path === '/api/v3/movie/lookup' && serverIps.has(norm(e.remoteAddress))));
    assert.ok(radarr.some((e) => e.path === '/api/v3/movie/1' && e.status === 200), 'media_details never asked radarr for the referenced movie');
  });

  it('the effect of an approved plan lands in the temporary root on the host', async () => {
    const mediaBefore = inventory(t.mediaRoot);
    const before = inventory(t.downloadsRoot);
    const agent = await t.mcp('agent');
    const proposal = await callTool(agent, 'propose_cleanup', { paths: [`downloads/${DL_TARGET}`] });
    assert.equal(proposal.isError, false, proposal.text);
    const planId = findKey(proposal.envelope, 'planId');
    const final = await t.approve(planId);
    assert.equal(final.status, 'succeeded', JSON.stringify(final).slice(0, 1500));
    const after = inventory(t.downloadsRoot);
    const diff = diffInventory(before, after);
    assert.deepEqual(diff.removed, [DL_TARGET]);
    assert.deepEqual(diff.added.sort(), [`.mediabox-trash/${planId}/${DL_TARGET}`, `.mediabox-trash/${planId}/${DL_TARGET}.manifest.json`].sort());
    assert.equal(after.get(`.mediabox-trash/${planId}/${DL_TARGET}`), before.get(DL_TARGET));
    assert.equal(after.get(DL_KEEP), before.get(DL_KEEP));
    assert.deepEqual(diffInventory(mediaBefore, inventory(t.mediaRoot)), { removed: [], added: [], changed: [] });
  });
});

// ── host candidates ────────────────────────────────────────────────────────

const HOST_ENV_ALLOWLIST = ['PATH', 'Path', 'SystemRoot', 'TEMP', 'TMP', 'TMPDIR', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'ComSpec', 'PATHEXT', 'windir'];
const HOST_TARGET = 'películas/Ñandú (2024)/Ñandú (2024).mkv';
const HOST_NEIGHBOUR = 'películas/Ñandú (2024)/Ñandú (2024).es.srt';
const HOST_OTHER = 'series/Serie Ñ/Temporada 1/S01E01.mkv';

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function canConnect(host, port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (ok) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(2000, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

/** Runs bun; on Windows through its .cmd shim (Volta/npm installs), with every argument quoted. */
function runBun(args, opts) {
  if (process.platform !== 'win32') return spawnSync('bun', args, { encoding: 'utf8', ...opts });
  return spawnSync('bun', args.map((a) => `"${a}"`), { encoding: 'utf8', shell: true, ...opts });
}

async function startHostCandidate(kind) {
  const dirs = { media: tempDir(`n6 ${kind} media`), downloads: tempDir(`n6 ${kind} downloads`), state: tempDir(`n6 ${kind} state`) };
  const requests = [];
  const { startScriptedRuntime } = await import(pathToFileURL(path.join(SYNTHETIC_DIR, 'scripted-runtime.mjs')).href);
  const runtime = await startScriptedRuntime({ host: '127.0.0.1', port: 0, model: MODEL, onRequest: (e) => requests.push(e) });
  let child;
  const c = { kind, dirs, runtime, requests };
  c.stop = async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = new Promise((r) => child.once('exit', r));
      child.kill();
      await Promise.race([exited, new Promise((r) => setTimeout(r, 10_000))]);
    }
    await runtime.close().catch(() => {});
    for (const d of Object.values(dirs)) {
      try { removeTempDir(d); } catch (err) { console.error(`[g09] could not remove ${d}: ${err.message}`); }
    }
  };

  try {
    writeTree(dirs.media, { [HOST_TARGET]: bytes(`${kind}-target`), [HOST_NEIGHBOUR]: `1\n00:00:01,000 --> 00:00:02,000\n${kind}\n`, [HOST_OTHER]: bytes(`${kind}-other`) });
    let command;
    let args;
    if (kind === 'node') {
      command = process.execPath;
      args = [path.join(repoRoot, 'packages', 'mcp-server', 'dist', 'index.js')];
      assert.ok(fs.existsSync(args[0]), 'packages/mcp-server/dist is missing: build the workspaces first (npm run ci:build)');
    } else {
      command = path.join(dirs.state, process.platform === 'win32' ? 'mbx-server.exe' : 'mbx-server');
      args = [];
      const built = runBun(['build', path.join(repoRoot, 'packages', 'mcp-server', 'src', 'index.ts'), '--compile', '--outfile', command], { cwd: repoRoot, timeout: 600_000 });
      assert.equal(built.status, 0, `bun build --compile failed (Bun is required, G09 never skips): ${built.stderr || built.stdout || built.error?.message}`);
      assert.ok(fs.existsSync(command), 'bun produced no executable');
    }

    const port = await freePort();
    c.port = port;
    c.baseUrl = `http://127.0.0.1:${port}`;
    c.keys = { owner: `owner-${hex(16)}`, agent: `agent-${hex(16)}` };
    const env = {};
    for (const k of HOST_ENV_ALLOWLIST) if (process.env[k]) env[k] = process.env[k];
    const unreachable = 'http://127.0.0.1:9';
    Object.assign(env, {
      NODE_ENV: 'production',
      PORT: String(port),
      BIND_HOST: '127.0.0.1',
      PUBLIC_URL: c.baseUrl,
      ALLOWED_ORIGINS: '',
      MEDIA_PATH: dirs.media,
      DOWNLOADS_PATH: dirs.downloads,
      OPERATIONS_DB_PATH: path.join(dirs.state, 'operations.db'),
      INTERNAL_API_KEY: c.keys.owner,
      AGENT_API_KEY: c.keys.agent,
      MEDIABOX_INSTALLATION_ID: `g09-${kind}-${hex(4)}`,
      REFERENCE_SECRET: hex(32),
      CURSOR_SECRET: hex(32),
      PRIVACY_PROFILE: 'offline-library',
      LLM_PROVIDER: 'local',
      LOCAL_LLM_BASE_URL: runtime.url,
      LOCAL_LLM_MODEL: MODEL,
      LOCAL_LLM_RUNTIME: 'ollama',
      LOCAL_LLM_MODEL_DIGEST: modelDigest(MODEL),
      BAZARR_ENABLED: 'false',
      JELLYFIN_URL: unreachable,
      SONARR_URL: unreachable,
      RADARR_URL: unreachable,
      PROWLARR_URL: unreachable,
      QBIT_URL: unreachable,
      PYLOAD_URL: unreachable,
      FLARESOLVERR_URL: unreachable,
    });
    const logFile = path.join(dirs.state, 'server.log');
    const fd = fs.openSync(logFile, 'a');
    try {
      child = spawn(command, args, { cwd: repoRoot, env, stdio: ['ignore', fd, fd], windowsHide: true });
    } finally {
      fs.closeSync(fd);
    }
    const tail = () => fs.readFileSync(logFile, 'utf8').slice(-3000);
    await waitFor(async () => {
      if (child.exitCode !== null) throw new Error(`the ${kind} candidate exited (${child.exitCode}): ${tail()}`);
      const r = await fetch(`${c.baseUrl}/health`, { signal: AbortSignal.timeout(1500) });
      return r.ok;
    }, { timeoutMs: 90_000, what: `${kind} candidate /health` }).catch((err) => { throw new Error(`${err.message}\n${tail()}`); });
    await waitFor(async () => {
      const r = await httpJson(c.baseUrl, 'GET', '/api/chat/info', c.keys.owner);
      return r.status === 200 && r.body?.runtimeState && !['starting', 'stopped'].includes(r.body.runtimeState);
    }, { timeoutMs: 60_000, intervalMs: 300, what: `${kind} runtime supervisor to settle` });
    return c;
  } catch (err) {
    await c.stop();
    throw err;
  }
}

for (const kind of ['node', 'bun']) {
  describe(`NET-06 ${kind} candidate on the host (temporary roots with spaces and Unicode)`, { timeout: 900_000 }, () => {
    let c;

    before(async () => {
      c = await startHostCandidate(kind);
    });

    after(async () => {
      await c?.stop();
    });

    it('answers /health on its loopback bind', async () => {
      const r = await httpJson(c.baseUrl, 'GET', '/health');
      assert.equal(r.status, 200);
      assert.equal(r.body?.status, 'ok');
    });

    it('the listener is loopback-only: every non-loopback local address is refused', async (ctx) => {
      const addresses = Object.values(os.networkInterfaces()).flat().filter((a) => a && a.family === 'IPv4' && !a.internal).map((a) => a.address);
      assert.ok(addresses.length > 0, 'the host has no non-loopback IPv4 address, so the loopback-only bind cannot be verified here (this is a failure, not a skip)');
      ctx.diagnostic(`non-loopback addresses tried: ${addresses.join(', ')}`);
      assert.equal(await canConnect('127.0.0.1', c.port), true, 'the loopback listener itself is not reachable');
      for (const address of addresses) {
        assert.equal(await canConnect(address, c.port), false, `the ${kind} candidate accepted a connection on ${address}:${c.port}`);
      }
    });

    it('GET /api/chat/info reports the configured runtime endpoint and never the verified isolation label', async () => {
      const r = await httpJson(c.baseUrl, 'GET', '/api/chat/info', c.keys.owner);
      assert.equal(r.status, 200, r.text);
      assert.equal(r.body.endpoint, c.runtime.url.replace(/\/+$/, ''));
      assert.equal(r.body.privacyProfile, 'offline-library');
      assert.equal(r.body.artifactStatus, 'verified');
      assert.notEqual(r.body.privacyIsolation, 'no-default-route', 'a native process must not claim verified containment');
      if (process.platform !== 'linux') assert.equal(r.body.privacyIsolation, 'unverified-native');
    });

    it('the process really uses that endpoint (the runtime saw its probes from loopback)', () => {
      const probes = c.requests.filter((e) => ['/api/version', '/api/tags'].includes(e.path));
      assert.ok(probes.some((e) => e.path === '/api/version') && probes.some((e) => e.path === '/api/tags'), `the runtime saw ${JSON.stringify(c.requests.map((e) => e.path))}`);
      assert.ok(probes.every((e) => norm(e.remoteAddress) === '127.0.0.1'), `probes from ${probes.map((e) => e.remoteAddress)}`);
    });

    it('an approved propose_cleanup moves the file inside the temporary root and nothing else', async () => {
      const before = inventory(c.dirs.media);
      const agent = await connectMcp(c.baseUrl, c.keys.agent);
      try {
        const proposal = await callTool(agent, 'propose_cleanup', { paths: [HOST_TARGET] });
        assert.equal(proposal.isError, false, proposal.text);
        const planId = findKey(proposal.envelope, 'planId');
        assert.ok(planId, proposal.text.slice(0, 500));
        const final = await approvePlan(c.baseUrl, c.keys.owner, planId);
        assert.equal(final.status, 'succeeded', JSON.stringify(final).slice(0, 1500));
        const after = inventory(c.dirs.media);
        const diff = diffInventory(before, after);
        assert.deepEqual(diff.removed, [HOST_TARGET]);
        assert.deepEqual(diff.added.sort(), [`.mediabox-trash/${planId}/${HOST_TARGET}`, `.mediabox-trash/${planId}/${HOST_TARGET}.manifest.json`].sort());
        assert.deepEqual(diff.changed, []);
        assert.equal(after.get(`.mediabox-trash/${planId}/${HOST_TARGET}`), before.get(HOST_TARGET));
      } finally {
        await agent.close().catch(() => {});
      }
    });
  });
}
