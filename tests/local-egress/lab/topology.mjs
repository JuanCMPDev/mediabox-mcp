/**
 * G09 lab topology (PR05 §3.1 / §3.4): the compose file the PRODUCT generates
 * for a strict privacy profile, with only what is needed to run it without the
 * real third-party images.
 *
 * Kept exactly as generated: every network definition (names, `internal`,
 * drivers) and every service's network assignment; the mcp-server environment
 * and volumes; the mediabox-edge forwarder (real alpine/socat, pinned by digest
 * as `prepare` would do). The mcp-server image is the REAL one built from
 * packages/mcp-server/Dockerfile.
 *
 * Replaced (documented test overlay):
 *  - jellyfin/sonarr/radarr/qbittorrent/prowlarr/pyload/flaresolverr images →
 *    node:22 running lab/standin.mjs (the real-path synthetic services) on the
 *    port the generator expects, on the generated networks;
 *  - the inference-* services → one `mediabox-inference` service (the host name
 *    the generated LOCAL_LLM_BASE_URL uses) running the scripted Ollama stand-in
 *    on 11434, on the generated inference networks;
 *  - the provisioner (and its provision network) is dropped: `run` never uses it;
 *  - container names get a unique prefix, published ports become
 *    127.0.0.1::<port> and stand-ins lose their ports, so nothing collides with
 *    the host or with a real deployment; stand-ins do not restart.
 * Test-only instrumentation:
 *  - `lab-sink` (lab/sink.mjs): on mediabox-external-net in online-media; in
 *    offline-library on `lab-outside`, a test-only bridge no generated service
 *    joins (the "outside world" positive controls use);
 *  - `lab-origin` (lab/origin.mjs, NET-03) next to the sink;
 *  - `dns: [<sink IP>]` on mcp-server, mediabox-inference and mediabox-edge, so
 *    the sink is the upstream resolver of Docker's embedded DNS and indirect DNS
 *    exfiltration becomes observable in its ledger.
 * Control artifacts (sink ledger, origin log, stand-in request logs) live in
 * host directories mounted only into those lab containers, never into the
 * evaluated mcp-server.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { parse } from 'yaml';
import {
  docker, uniqueName, tempDir, hostPath, IMAGES, repoRoot, ComposeProject, buildServerImage, ensureImages,
  acquireSlot, topologySlots, waitFor, readLedger, removeTempDir, requireDocker, containerIp, containerIps,
  containerLogs, probeInAsync, dockerAsync,
} from './docker-lab.mjs';

const { generateDockerCompose } = await import(pathToFileURL(path.join(repoRoot, 'packages/core/dist/generators/docker-compose.js')).href);
const { baseConfig } = await import(pathToFileURL(path.join(repoRoot, 'packages/core/dist/config/fixtures.js')).href);

export const LAB_DIR = path.join(repoRoot, 'tests', 'local-egress', 'lab');
export const SYNTHETIC_DIR = path.join(repoRoot, 'evals', 'local-agent', 'synthetic');
export const MODEL = 'qwen2.5:7b';
export const OFFLINE = 'offline-library';
export const ONLINE = 'local-agent-online-media';
export const STANDIN_PORTS = Object.freeze({ jellyfin: 8096, sonarr: 8989, radarr: 7878, qbittorrent: 8085, prowlarr: 9696, pyload: 8000, flaresolverr: 8191 });
const INFERENCE_SERVICES = ['inference-cuda', 'inference-rocm', 'inference-vulkan', 'inference-cpu'];
const STANDIN_KEYS = ['JELLYFIN_API_KEY', 'SONARR_API_KEY', 'RADARR_API_KEY', 'PROWLARR_API_KEY', 'QBIT_USER', 'QBIT_PASSWORD', 'PYLOAD_USER', 'PYLOAD_PASSWORD'];
export const TERMINAL_PLAN_STATUSES = ['succeeded', 'partial', 'failed', 'unknown_outcome', 'cancelled', 'rejected', 'expired', 'interrupted', 'stale'];

export const hex = (n = 16) => crypto.randomBytes(n).toString('hex');

/** The digest the scripted runtime reports in /api/tags for `model`. */
export function modelDigest(model = MODEL) {
  return `sha256:${crypto.createHash('sha256').update(model).digest('hex')}`;
}

/** The compose file the product generates for `profile` with a local Ollama agent. */
export function generatedCompose(profile) {
  const cfg = baseConfig();
  cfg.deployment.privacyProfile = profile;
  cfg.ai = { kind: 'local', runtime: 'ollama', baseUrl: 'http://127.0.0.1:11434', model: MODEL };
  const text = generateDockerCompose(cfg);
  return { text, compose: parse(text) };
}

export const sinkNetworkFor = (profile) => (profile === ONLINE ? 'mediabox-external-net' : 'lab-outside');

const bind = (source, target, readOnly) => ({ type: 'bind', source: hostPath(source), target, read_only: readOnly });
const netNames = (networks) => (Array.isArray(networks) ? networks : Object.keys(networks ?? {}));

/**
 * Overlay of the generated compose (see the header). `attach` adds networks to
 * services and `disableInternal` drops `internal: true`: both exist ONLY for the
 * NET-01 meta-test that disables the isolation rule in a throwaway copy.
 */
export function overlayCompose(generated, o) {
  const { id, serverImage, sinkNetwork, sinkIp, dirs, withOrigin = false, mcpEnvKeys = [], attach = {}, disableInternal = false } = o;
  const gen = structuredClone(generated);
  const known = new Set([...Object.keys(STANDIN_PORTS), 'mcp-server', 'mediabox-edge', 'mediabox-provisioner', ...INFERENCE_SERVICES]);
  const unknown = Object.keys(gen.services).filter((s) => !known.has(s));
  if (unknown.length) throw new Error(`the generated topology has services this overlay does not model: ${unknown.join(', ')}`);
  for (const s of ['mcp-server', 'mediabox-edge', 'inference-cpu']) {
    if (!gen.services[s]) throw new Error(`the generated topology has no ${s} service`);
  }

  const dns = sinkIp ? { dns: [sinkIp] } : {};
  const labMounts = [bind(LAB_DIR, '/lab', true), bind(SYNTHETIC_DIR, '/synthetic', true), bind(dirs.fixtures, '/fixtures', true), bind(dirs.logs, '/logs', false)];
  const services = {};

  for (const [name, port] of Object.entries(STANDIN_PORTS)) {
    const g = gen.services[name];
    services[name] = {
      image: IMAGES.node,
      container_name: `${id}-${name}`,
      networks: [...g.networks, ...(attach[name] ?? [])],
      ...(g.depends_on ? { depends_on: g.depends_on } : {}),
      environment: STANDIN_KEYS.map((k) => `${k}=\${${k}:-}`),
      command: ['node', '/lab/standin.mjs', '--service', name, '--port', String(port), '--seed', '/fixtures/seed.json', '--faults', '/fixtures/faults.json', '--log', `/logs/${name}.jsonl`],
      volumes: labMounts,
      restart: 'no',
    };
  }

  const inference = gen.services['inference-cpu'];
  services['mediabox-inference'] = {
    image: IMAGES.node,
    container_name: `${id}-mediabox-inference`,
    networks: [...inference.networks, ...(attach['mediabox-inference'] ?? [])],
    ...dns,
    command: ['node', '/lab/standin.mjs', '--service', 'runtime', '--port', '11434', '--model', '${RUNTIME_MODEL:-qwen2.5:7b}', '--script', '/fixtures/script.json', '--log', '/logs/runtime.jsonl'],
    volumes: labMounts,
    restart: 'no',
  };

  const mcp = { ...gen.services['mcp-server'] };
  delete mcp.build;
  services['mcp-server'] = {
    ...mcp,
    image: serverImage,
    container_name: `${id}-mcp-server`,
    networks: [...mcp.networks, ...(attach['mcp-server'] ?? [])],
    environment: [...mcp.environment, ...mcpEnvKeys.map((k) => `${k}=\${${k}:-}`)],
    ...dns,
  };

  services['mediabox-edge'] = {
    ...gen.services['mediabox-edge'],
    image: IMAGES.socat,
    container_name: `${id}-mediabox-edge`,
    ports: ['127.0.0.1::3000', '127.0.0.1::8096', '127.0.0.1::8920'],
    ...dns,
  };

  services['lab-sink'] = {
    image: IMAGES.node,
    container_name: `${id}-lab-sink`,
    command: ['node', '/lab/sink.mjs'],
    environment: ['LEDGER=/ledger/ledger.jsonl'],
    volumes: [bind(LAB_DIR, '/lab', true), bind(dirs.ledger, '/ledger', false)],
    networks: [sinkNetwork],
    restart: 'no',
  };
  if (withOrigin) {
    services['lab-origin'] = {
      image: IMAGES.node,
      container_name: `${id}-lab-origin`,
      command: ['node', '/lab/origin.mjs'],
      environment: ['LEDGER=/ledger/origin.jsonl'],
      volumes: [bind(LAB_DIR, '/lab', true), bind(dirs.ledger, '/ledger', false)],
      networks: { [sinkNetwork]: { aliases: ['indexer.lab', 'downloads.lab'] } },
      restart: 'no',
    };
  }

  const used = new Set(Object.values(services).flatMap((s) => netNames(s.networks)));
  const networks = {};
  for (const [name, def] of Object.entries(gen.networks)) {
    if (!used.has(name)) continue; // only the dropped provisioner used mediabox-provision-net
    networks[name] = disableInternal ? { driver: def.driver } : def;
  }
  if (!networks[sinkNetwork]) networks[sinkNetwork] = { driver: 'bridge' };
  return { services, networks };
}

// ── MCP client (the SDK the server itself ships) ───────────────────────────

let sdk;
async function loadSdk() {
  if (!sdk) {
    const req = createRequire(path.join(repoRoot, 'packages', 'mcp-server', 'package.json'));
    const [{ Client }, { StreamableHTTPClientTransport }] = await Promise.all([
      import(pathToFileURL(req.resolve('@modelcontextprotocol/sdk/client/index.js')).href),
      import(pathToFileURL(req.resolve('@modelcontextprotocol/sdk/client/streamableHttp.js')).href),
    ]);
    sdk = { Client, StreamableHTTPClientTransport };
  }
  return sdk;
}

export async function connectMcp(baseUrl, bearer) {
  const { Client, StreamableHTTPClientTransport } = await loadSdk();
  const client = new Client({ name: 'g09-lab', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${bearer}` } },
  }));
  return client;
}

/** Text, parsed JSON (plain result or ToolEnvelope) and isError of a CallToolResult. */
export function toolOutcome(result) {
  const text = (Array.isArray(result?.content) ? result.content : [])
    .filter((c) => c?.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text)
    .join('\n');
  let json;
  try { json = JSON.parse(text); } catch { json = undefined; }
  const envelope = result?.structuredContent ?? json;
  return { isError: result?.isError === true, text, json, envelope, raw: result };
}

export async function callTool(client, name, args = {}) {
  return toolOutcome(await client.callTool({ name, arguments: args }));
}

/** Depth-first search for the first value under `key` anywhere in `value`. */
export function findKey(value, key) {
  if (!value || typeof value !== 'object') return undefined;
  if (Object.prototype.hasOwnProperty.call(value, key)) return value[key];
  for (const v of Object.values(value)) {
    const hit = findKey(v, key);
    if (hit !== undefined) return hit;
  }
  return undefined;
}

// ── HTTP helpers shared by the container and host candidates ───────────────

export async function httpJson(baseUrl, method, urlPath, bearer, body, { timeoutMs = 30_000 } = {}) {
  const res = await fetch(`${baseUrl}${urlPath}`, {
    method,
    headers: { ...(bearer ? { authorization: `Bearer ${bearer}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let parsed;
  try { parsed = text ? JSON.parse(text) : undefined; } catch { parsed = undefined; }
  return { status: res.status, body: parsed, text };
}

/** One chat turn through POST /api/chat/stream (NDJSON). */
export async function chatTurn(baseUrl, bearer, message, { conversationId, timeoutMs = 120_000 } = {}) {
  const res = await fetch(`${baseUrl}/api/chat/stream`, {
    method: 'POST',
    headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
    body: JSON.stringify({ message, conversationId }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  const events = text.split('\n').filter((l) => l.trim()).map((l) => {
    try { return JSON.parse(l); } catch { return { type: 'unparsed', raw: l }; }
  });
  return {
    status: res.status,
    text,
    events,
    conversationId: events.find((e) => e.type === 'conversation')?.id ?? conversationId,
    done: events.find((e) => e.type === 'done'),
    error: events.find((e) => e.type === 'error'),
  };
}

export async function waitPlan(baseUrl, ownerKey, planId, { timeoutMs = 60_000 } = {}) {
  let last;
  await waitFor(async () => {
    last = await httpJson(baseUrl, 'GET', `/api/operations/plans/${encodeURIComponent(planId)}`, ownerKey);
    return last.status === 200 && TERMINAL_PLAN_STATUSES.includes(last.body?.status);
  }, { timeoutMs, intervalMs: 200, what: `plan ${planId} to finish` });
  return last.body;
}

/** GET plan → POST approve {manifestHash} with the owner key → wait for a terminal status. */
export async function approvePlan(baseUrl, ownerKey, planId) {
  const record = await httpJson(baseUrl, 'GET', `/api/operations/plans/${encodeURIComponent(planId)}`, ownerKey);
  if (record.status !== 200) throw new Error(`GET plan ${planId} → ${record.status} ${record.text.slice(0, 300)}`);
  const manifestHash = record.body?.plan?.manifestHash ?? record.body?.manifestHash;
  const approved = await httpJson(baseUrl, 'POST', `/api/operations/plans/${encodeURIComponent(planId)}/approve`, ownerKey, { manifestHash });
  if (approved.status < 200 || approved.status >= 300) throw new Error(`approve ${planId} → ${approved.status} ${approved.text.slice(0, 300)}`);
  return waitPlan(baseUrl, ownerKey, planId);
}

// ── host file helpers ──────────────────────────────────────────────────────

export function writeTree(root, files) {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, ...rel.split('/'));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
}

/** rel path → sha256 of every regular file under `root` (links are not followed). */
export function inventory(root) {
  const out = new Map();
  const walk = (dir, rel) => {
    for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
      const childRel = rel ? `${rel}/${d.name}` : d.name;
      const abs = path.join(dir, d.name);
      if (d.isDirectory()) walk(abs, childRel);
      else if (d.isFile()) out.set(childRel, crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex'));
      else out.set(childRel, `special:${d.isSymbolicLink() ? 'link' : 'other'}`);
    }
  };
  walk(root, '');
  return out;
}

export function diffInventory(before, after) {
  const removed = [...before.keys()].filter((k) => !after.has(k));
  const added = [...after.keys()].filter((k) => !before.has(k));
  const changed = [...before.keys()].filter((k) => after.has(k) && after.get(k) !== before.get(k));
  return { removed, added, changed };
}

// ── egress oracle helpers ──────────────────────────────────────────────────

export function parseProbe(stdout) {
  const results = {};
  for (const line of String(stdout).split('\n')) {
    const m = line.trim().match(/^RESULT (\S+) (\S+)$/);
    if (m) results[m[1]] = m[2];
  }
  return results;
}

/** Which delivery kinds the sink ledger attributes to `token` (the verdict comes from here). */
export function deliveriesOf(ledger, token) {
  const tok = token.toLowerCase();
  const kinds = new Set();
  const entries = [];
  for (const e of ledger) {
    const text = e.text ?? '';
    const qname = e.qname ?? '';
    let kind = null;
    if (e.proto === 'tcp' && text.includes(`/${token}`)) kind = `tcp-sink-${e.port}`;
    else if (e.proto === 'udp' && text.includes(token)) kind = 'udp-sink';
    else if (e.proto === 'dns' && qname.includes(tok)) kind = qname.startsWith('direct-') ? 'dns-direct' : qname.startsWith('indirect-') ? 'dns-indirect' : 'dns';
    else if (text.includes(token) || qname.includes(tok)) kind = 'other';
    if (kind) {
      kinds.add(kind);
      entries.push(e);
    }
  }
  return { kinds: [...kinds].sort(), entries };
}

// ── the topology ───────────────────────────────────────────────────────────

/**
 * Starts the overlay for `profile`. Options: label (lowercase, unique per
 * file), seed/script/faults (stand-in fixtures), media/downloads (host files
 * relative to the media root and to ./downloads), env (extra .env values),
 * mcpEnvKeys (extra mcp-server variables taken from .env), withOrigin,
 * only (services to start, meta-test copies), attach/disableInternal (meta).
 */
export async function startTopology(opts) {
  const {
    profile, label, seed = {}, script = [], faults = [], media = {}, downloads = {}, env: envOverrides = {},
    mcpEnvKeys = [], withOrigin = false, only = null, attach = {}, disableInternal = false,
  } = opts;
  requireDocker();
  ensureImages();
  const serverImage = buildServerImage();
  const release = await acquireSlot('topology', topologySlots());
  const id = uniqueName(`mbx${label}`);
  const dirs = {};
  let project;
  const clients = new Set();
  const cids = new Map();

  const t = {
    id, profile, serverImage, dirs, clients,
    sinkNetwork: sinkNetworkFor(profile),
    generated: generatedCompose(profile).compose,
  };

  t.cid = (service) => {
    if (!cids.has(service)) {
      const cid = project.container(service);
      if (!cid) throw new Error(`no container for service ${service}`);
      cids.set(service, cid);
    }
    return cids.get(service);
  };
  t.ips = (service) => containerIps(t.cid(service));
  t.ipOn = (service, network) => containerIp(t.cid(service), network);
  t.networkName = (network) => `${id}_${network}`;
  t.ledger = () => readLedger(path.join(dirs.ledger, 'ledger.jsonl'));
  t.originLog = () => readLedger(path.join(dirs.ledger, 'origin.jsonl'));
  t.requestLog = (service) => readLedger(path.join(dirs.logs, `${service}.jsonl`));
  t.waitStandins = async (services) => {
    for (const s of services) {
      await waitFor(() => containerLogs(t.cid(s)).includes('"ready":true'), { timeoutMs: 90_000, what: `${s} stand-in ready` });
    }
  };
  t.waitServer = async () => {
    await waitFor(async () => (await fetch(`${t.baseUrl}/health`, { signal: AbortSignal.timeout(2000) })).ok, { timeoutMs: 120_000, what: 'mcp-server /health through the edge' });
    await waitFor(async () => {
      const r = await httpJson(t.baseUrl, 'GET', '/api/chat/info', t.keys.owner);
      return r.status === 200 && r.body?.runtimeState && !['starting', 'stopped'].includes(r.body.runtimeState);
    }, { timeoutMs: 90_000, intervalMs: 500, what: 'the runtime supervisor to settle' });
  };
  /** probe.sh in the network namespace of `service` (same routes, resolver and firewall). */
  t.probe = async (service, token) => {
    const r = await probeInAsync(t.cid(service), `sh /lab/probe.sh ${token} ${t.sinkIp}`, { extraArgs: ['-v', `${hostPath(LAB_DIR)}:/lab:ro`] });
    return { ...r, results: parseProbe(r.stdout) };
  };
  /** probe.sh from an authorised namespace: a lab container on the sink's network, sink as resolver. */
  t.controlProbe = async (token) => {
    const r = await dockerAsync(['run', '--rm', '--network', t.networkName(t.sinkNetwork), '--dns', t.sinkIp, '-v', `${hostPath(LAB_DIR)}:/lab:ro`, IMAGES.busybox, 'sh', '/lab/probe.sh', token, t.sinkIp], { allowFail: true });
    return { ...r, results: parseProbe(r.stdout) };
  };
  t.controlSh = (script) => dockerAsync(['run', '--rm', '--network', t.networkName(t.sinkNetwork), IMAGES.busybox, 'sh', '-c', script], { allowFail: true });
  t.sh = (service, script) => probeInAsync(t.cid(service), script);
  t.exec = (service, script) => docker(['exec', t.cid(service), 'sh', '-c', script], { allowFail: true });
  t.request = (method, urlPath, { key = 'owner', body } = {}) => httpJson(t.baseUrl, method, urlPath, key === 'none' ? null : (t.keys[key] ?? key), body);
  t.chat = (message, o = {}) => chatTurn(t.baseUrl, t.keys.owner, message, o);
  t.mcp = async (key = 'agent') => {
    const c = await connectMcp(t.baseUrl, t.keys[key] ?? key);
    clients.add(c);
    return c;
  };
  t.approve = (planId) => approvePlan(t.baseUrl, t.keys.owner, planId);
  /** Rewrites .env with `envPatch` and recreates `services` (backends first, then the server). */
  t.recreate = async (services, envPatch = {}) => {
    for (const c of clients) await c.close().catch(() => {});
    clients.clear();
    project.write(null, { ...project.env, ...envPatch });
    t.env = project.env;
    const backends = services.filter((s) => s in STANDIN_PORTS || s === 'mediabox-inference');
    const product = services.filter((s) => !backends.includes(s));
    for (const s of services) cids.delete(s);
    if (backends.length) {
      project.up(backends, ['--no-deps', '--force-recreate']);
      await t.waitStandins(backends);
    }
    if (product.length) {
      project.up(product, ['--no-deps', '--force-recreate']);
      if (product.includes('mcp-server') && t.baseUrl) await t.waitServer();
    }
  };
  /** docker logs (stdout + stderr) of every container of the project. */
  t.allLogs = () => project.containers().map(({ service, id: cid }) => ({ service, text: containerLogs(cid) }));

  t.down = async () => {
    for (const c of clients) await c.close().catch(() => {});
    clients.clear();
    if (process.env.G09_KEEP_LAB === '1') {
      console.error(`[g09] G09_KEEP_LAB=1: keeping compose project ${id} in ${dirs.project}`);
      release();
      return;
    }
    try {
      project?.down();
      const left = docker(['ps', '-a', '-q', '--filter', `label=com.docker.compose.project=${id}`], { allowFail: true }).stdout.split('\n').filter(Boolean);
      for (const c of left) docker(['rm', '-f', c], { allowFail: true });
      for (const d of Object.values(dirs)) {
        try { removeTempDir(d); } catch (err) { console.error(`[g09] could not remove ${d}: ${err.message}`); }
      }
    } finally {
      release();
    }
  };

  try {
    for (const k of ['project', 'media', 'ledger', 'logs', 'fixtures']) dirs[k] = tempDir(`${label} ${k}`);
    t.mediaRoot = dirs.media;
    t.downloadsRoot = path.join(dirs.project, 'downloads');
    for (const sub of ['movies', 'tv', 'music', 'anime']) fs.mkdirSync(path.join(t.mediaRoot, sub), { recursive: true });
    fs.mkdirSync(t.downloadsRoot, { recursive: true });
    writeTree(t.mediaRoot, media);
    writeTree(t.downloadsRoot, downloads);
    fs.writeFileSync(path.join(dirs.fixtures, 'seed.json'), JSON.stringify(seed));
    fs.writeFileSync(path.join(dirs.fixtures, 'script.json'), JSON.stringify(script));
    fs.writeFileSync(path.join(dirs.fixtures, 'faults.json'), JSON.stringify(faults));

    const env = {
      TZ: 'UTC',
      MOVIES_PATH: hostPath(path.join(t.mediaRoot, 'movies')),
      TV_PATH: hostPath(path.join(t.mediaRoot, 'tv')),
      MUSIC_PATH: hostPath(path.join(t.mediaRoot, 'music')),
      ANIME_PATH: hostPath(path.join(t.mediaRoot, 'anime')),
      MCP_PUBLIC_URL: 'http://127.0.0.1:3000',
      INTERNAL_API_KEY: `owner-${hex(24)}`,
      AGENT_API_KEY: `agent-${hex(24)}`,
      MEDIABOX_INSTALLATION_ID: `g09-${id}`,
      JELLYFIN_API_KEY: `jf-${hex(12)}`,
      SONARR_API_KEY: hex(16),
      RADARR_API_KEY: hex(16),
      QBIT_USER: 'admin',
      QBIT_PASSWORD: `qb-${hex(8)}`,
      PYLOAD_USER: 'pyload',
      PYLOAD_PASSWORD: `py-${hex(8)}`,
      LLM_PROVIDER: 'local',
      LOCAL_LLM_RUNTIME: 'ollama',
      LOCAL_LLM_MODEL: MODEL,
      LOCAL_LLM_MODEL_DIGEST: modelDigest(MODEL),
      RUNTIME_MODEL: MODEL,
      ...envOverrides,
    };
    t.keys = { owner: env.INTERNAL_API_KEY, agent: env.AGENT_API_KEY };
    t.env = env;

    const compose = (sinkIp) => overlayCompose(t.generated, { id, serverImage, sinkNetwork: t.sinkNetwork, sinkIp, dirs, withOrigin, mcpEnvKeys, attach, disableInternal });
    project = new ComposeProject({ name: id, dir: dirs.project, compose: compose(undefined), env });
    t.project = project;

    // Phase 1: the capture (sink, origin) comes up first; its address becomes the upstream resolver.
    project.up(['lab-sink', ...(withOrigin ? ['lab-origin'] : [])], ['--no-deps']);
    t.sinkIp = containerIp(project.container('lab-sink'), t.sinkNetwork);
    if (!t.sinkIp) throw new Error('the sink has no address on its network');
    await waitFor(() => t.ledger().some((e) => e.event === 'ready'), { what: 'sink ready' });
    if (withOrigin) await waitFor(() => t.originLog().some((e) => e.event === 'ready'), { what: 'origin ready' });
    project.write(compose(t.sinkIp), null);
    t.compose = project.compose;

    // Phase 2: stand-ins and the runtime, so the server's first runtime probe finds it.
    const wanted = only ?? [...Object.keys(STANDIN_PORTS), 'mediabox-inference', 'mcp-server', 'mediabox-edge'];
    const backends = wanted.filter((s) => s in STANDIN_PORTS || s === 'mediabox-inference');
    if (backends.length) {
      project.up(backends, ['--no-deps']);
      await t.waitStandins(backends);
    }
    // Phase 3: the evaluated server and the owner edge.
    const product = wanted.filter((s) => s === 'mcp-server' || s === 'mediabox-edge');
    if (product.length) project.up(product, ['--no-deps']);
    if (product.includes('mediabox-edge')) {
      t.edgePort = project.port('mediabox-edge', 3000);
      t.baseUrl = `http://127.0.0.1:${t.edgePort}`;
      await t.waitServer();
    } else if (product.includes('mcp-server')) {
      await waitFor(() => docker(['inspect', t.cid('mcp-server'), '--format', '{{.State.Running}}']).stdout === 'true', { what: 'mcp-server running' });
    }
    return t;
  } catch (err) {
    const logs = project ? project.run(['logs', '--no-color', '--tail', '40'], { allowFail: true }).stdout : '';
    await t.down().catch(() => {});
    throw new Error(`${err.message}${logs ? `\n--- compose logs (tail) ---\n${logs.slice(-6000)}` : ''}`);
  }
}
