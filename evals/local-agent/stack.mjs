/**
 * REAL-PATH evaluation stack bootstrapper.
 *
 * startStack() materialises a temporary media tree, starts the synthetic
 * upstream services, and spawns the PRODUCTION mcp-server
 * (packages/mcp-server/dist/index.js) with a minimal, explicit environment.
 * The returned handle drives the server exactly as the owner UI and the chat
 * UI do: POST /api/chat/stream (owner key), the operations REST API (owner
 * key), and /mcp over authenticated HTTP (agent or owner key).
 *
 * Nothing from the host environment leaks into the server except an allowlist
 * (PATH, SystemRoot, TEMP, TMP, HOME, USERPROFILE, APPDATA, LOCALAPPDATA,
 * ComSpec, PATHEXT, windir, TMPDIR); cloud keys and proxies are only present
 * when the caller passes them in `extraEnv`.
 *
 * The temp root (under os.tmpdir(), its name contains a space and "ñ") holds a
 * marker file; stop() deletes the root only when that marker matches, and
 * never touches anything else (set MEDIABOX_EVAL_KEEP_ROOT=1 or keepRoot to keep it).
 */
import { spawn, execFile } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import crypto from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { startSyntheticServices } from './synthetic/services.mjs';
import { materialize, inventory as inventoryRoots } from './synthetic/media.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, '../..');
export const SERVER_ENTRY = path.join(REPO_ROOT, 'packages', 'mcp-server', 'dist', 'index.js');
export const ROOT_MARKER = '.mediabox-eval-stack-root';
export const ROOT_PREFIX = 'mediabox eval ñ-';
export const TERMINAL_PLAN_STATUSES = Object.freeze([
  'succeeded', 'partial', 'failed', 'unknown_outcome', 'cancelled', 'rejected', 'expired', 'interrupted', 'stale',
]);
const ENV_ALLOWLIST = ['PATH', 'SystemRoot', 'TEMP', 'TMP', 'TMPDIR', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'ComSpec', 'PATHEXT', 'windir'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const randomHex = (n = 16) => crypto.randomBytes(n).toString('hex');

export class HttpError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.body = body;
  }
}

/** Binds 127.0.0.1:0, reads the port and releases it. */
export async function getFreePort(host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.once('error', reject);
    srv.listen(0, host, () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/** Minimal host environment: only the allowlisted variables (case-insensitive on Windows). */
export function baseChildEnv() {
  const env = {};
  for (const name of ENV_ALLOWLIST) {
    const value = process.env[name];
    if (typeof value === 'string' && value.length > 0) env[name] = value;
  }
  return env;
}

function tailFile(file, lines = 60) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    return text.split(/\r?\n/).slice(-lines).join('\n');
  } catch {
    return '(no log)';
  }
}

async function killTree(child, exited, timeoutMs = 10_000) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') {
    await new Promise((resolve) => {
      execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }, () => resolve());
    });
  } else {
    try { process.kill(-child.pid, 'SIGTERM'); } catch { try { child.kill('SIGTERM'); } catch { /* gone */ } }
    const grace = await Promise.race([exited.then(() => true), sleep(3000).then(() => false)]);
    if (!grace) {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* gone */ } }
    }
  }
  await Promise.race([exited, sleep(timeoutMs)]);
}

/**
 * Spawns the production mcp-server with `env` and waits for GET /health.
 * @param {Record<string,string>} env complete child environment (use baseChildEnv() + explicit values)
 * @param {{ stdoutLog: string, stderrLog: string }} logPaths appended to (a header line marks each start)
 * @param {{ entry?: string, cwd?: string, healthTimeoutMs?: number, nodePath?: string, nodeArgs?: string[] }} [opts]
 * @returns {Promise<{ child: import('node:child_process').ChildProcess, pid: number, baseUrl: string,
 *   startupMs: number, exited: Promise<{code:number|null, signal:string|null}>, stop: () => Promise<void> }>}
 */
export async function startServerProcess(env, logPaths, opts = {}) {
  const {
    entry = SERVER_ENTRY,
    cwd = REPO_ROOT,
    healthTimeoutMs = 30_000,
    nodePath = process.execPath,
    nodeArgs = [],
  } = opts;
  if (!fs.existsSync(entry)) {
    throw new Error(`mcp-server build not found at ${entry}; build the workspace first (npm run ci:build)`);
  }
  if (!env.PORT) throw new Error('startServerProcess: env.PORT is required (the chat loopback client dials localhost:PORT)');
  const t0 = performance.now();
  await fsp.mkdir(path.dirname(logPaths.stdoutLog), { recursive: true });
  await fsp.mkdir(path.dirname(logPaths.stderrLog), { recursive: true });
  const header = `\n===== mcp-server start ${new Date().toISOString()} port=${env.PORT} =====\n`;
  fs.appendFileSync(logPaths.stdoutLog, header);
  fs.appendFileSync(logPaths.stderrLog, header);
  const outFd = fs.openSync(logPaths.stdoutLog, 'a');
  const errFd = fs.openSync(logPaths.stderrLog, 'a');
  let child;
  try {
    child = spawn(nodePath, [...nodeArgs, entry], {
      cwd,
      env,
      stdio: ['ignore', outFd, errFd],
      windowsHide: true,
      detached: process.platform !== 'win32',
    });
  } finally {
    fs.closeSync(outFd);
    fs.closeSync(errFd);
  }
  let exitInfo = null;
  const exited = new Promise((resolve) => {
    child.once('exit', (code, signal) => {
      exitInfo = { code, signal };
      resolve(exitInfo);
    });
    child.once('error', (err) => {
      exitInfo = { code: null, signal: null, error: err.message };
      resolve(exitInfo);
    });
  });
  const healthHost = !env.BIND_HOST || env.BIND_HOST === '0.0.0.0' || env.BIND_HOST === '::' ? '127.0.0.1' : env.BIND_HOST;
  const baseUrl = `http://${healthHost}:${env.PORT}`;
  const logs = () => `--- stderr (tail) ---\n${tailFile(logPaths.stderrLog)}\n--- stdout (tail) ---\n${tailFile(logPaths.stdoutLog)}`;

  for (;;) {
    if (exitInfo) {
      throw new Error(`mcp-server exited during startup (code=${exitInfo.code} signal=${exitInfo.signal}${exitInfo.error ? ` error=${exitInfo.error}` : ''})\n${logs()}`);
    }
    try {
      const res = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(1000) });
      if (res.ok) {
        const body = await res.json().catch(() => ({}));
        if (body?.status === 'ok') break;
      }
    } catch { /* not listening yet */ }
    if (performance.now() - t0 > healthTimeoutMs) {
      await killTree(child, exited);
      throw new Error(`mcp-server did not become healthy within ${healthTimeoutMs} ms at ${baseUrl}/health\n${logs()}`);
    }
    await sleep(100);
  }
  return {
    child,
    pid: child.pid,
    baseUrl,
    startupMs: Math.round(performance.now() - t0),
    exited,
    stop: () => killTree(child, exited),
  };
}

function splitMediaSpec(media = {}) {
  const mediaSpec = {};
  const downloadsSpec = {};
  for (const [rel, entry] of Object.entries(media)) {
    const unified = rel.replace(/\\/g, '/');
    if (unified === 'downloads' || unified.startsWith('downloads/')) {
      const inner = unified.slice('downloads/'.length);
      if (!inner) continue;
      downloadsSpec[inner] = entry.hardlinkOf?.startsWith('downloads/') ? { ...entry, hardlinkOf: entry.hardlinkOf.slice('downloads/'.length) } : entry;
    } else {
      mediaSpec[unified] = entry;
    }
  }
  return { mediaSpec, downloadsSpec };
}

async function removeRootSafely(root, token) {
  const tmp = path.resolve(os.tmpdir());
  const resolved = path.resolve(root);
  if (path.dirname(resolved) !== tmp || !path.basename(resolved).startsWith(ROOT_PREFIX)) return false;
  let marker;
  try {
    marker = JSON.parse(await fsp.readFile(path.join(resolved, ROOT_MARKER), 'utf8'));
  } catch {
    return false;
  }
  if (marker?.token !== token) return false;
  await fsp.rm(resolved, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  return true;
}

let sdkPromise = null;
async function loadMcpSdk() {
  if (!sdkPromise) {
    sdkPromise = (async () => {
      try {
        const [{ Client }, { StreamableHTTPClientTransport }] = await Promise.all([
          import('@modelcontextprotocol/sdk/client/index.js'),
          import('@modelcontextprotocol/sdk/client/streamableHttp.js'),
        ]);
        return { Client, StreamableHTTPClientTransport };
      } catch {
        const req = createRequire(path.join(REPO_ROOT, 'packages', 'mcp-server', 'package.json'));
        const [{ Client }, { StreamableHTTPClientTransport }] = await Promise.all([
          import(pathToFileURL(req.resolve('@modelcontextprotocol/sdk/client/index.js')).href),
          import(pathToFileURL(req.resolve('@modelcontextprotocol/sdk/client/streamableHttp.js')).href),
        ]);
        return { Client, StreamableHTTPClientTransport };
      }
    })();
  }
  return sdkPromise;
}

/** Flattens an MCP CallToolResult: text, parsed JSON (when the text is JSON), isError. */
export function toolOutcome(result) {
  const text = (Array.isArray(result?.content) ? result.content : [])
    .filter((c) => c?.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text)
    .join('\n');
  let json;
  try { json = JSON.parse(text); } catch { json = undefined; }
  return { isError: result?.isError === true, text, json, structured: result?.structuredContent, raw: result };
}

/**
 * @param {{
 *   seed?: object, media?: Record<string, object>, runtimeUrl?: string, model?: string,
 *   runtime?: string, contextTokens?: number, llmTemperature?: number, llmSeed?: number,
 *   extraEnv?: Record<string,string>, logDir?: string,
 *   serviceOptions?: object, healthTimeoutMs?: number, keepRoot?: boolean
 * }} [options]
 */
export async function startStack(options = {}) {
  const {
    seed = {},
    media = {},
    runtimeUrl,
    model = 'qwen2.5:7b',
    runtime = 'ollama',
    contextTokens = 8192,
    llmTemperature,
    llmSeed,
    extraEnv = {},
    logDir,
    serviceOptions = {},
    healthTimeoutMs = 30_000,
    keepRoot = process.env.MEDIABOX_EVAL_KEEP_ROOT === '1',
  } = options;

  const timings = {};
  const tStart = performance.now();
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), ROOT_PREFIX));
  const token = randomHex(16);
  await fsp.writeFile(path.join(root, ROOT_MARKER), JSON.stringify({ token, createdAt: new Date().toISOString(), pid: process.pid, purpose: 'mediabox real-path eval stack' }), 'utf8');

  const logsDir = logDir ? path.resolve(logDir) : path.join(root, 'logs');
  const paths = {
    root,
    media: path.join(root, 'media'),
    downloads: path.join(root, 'downloads'),
    db: path.join(root, 'state', 'operations.db'),
    stdoutLog: path.join(logsDir, 'mcp-server.stdout.log'),
    stderrLog: path.join(logsDir, 'mcp-server.stderr.log'),
  };

  let services;
  let proc;
  try {
    await fsp.mkdir(path.join(root, 'state'), { recursive: true });
    await fsp.mkdir(logsDir, { recursive: true });
    const { mediaSpec, downloadsSpec } = splitMediaSpec(media);
    let t = performance.now();
    await materialize(paths.media, mediaSpec);
    await materialize(paths.downloads, downloadsSpec);
    timings.materializeMs = Math.round(performance.now() - t);

    t = performance.now();
    services = await startSyntheticServices(seed, serviceOptions);
    timings.servicesMs = Math.round(performance.now() - t);

    const port = await getFreePort();
    const keys = {
      owner: `owner-${randomHex(24)}`,
      agent: `agent-${randomHex(24)}`,
      installationId: `eval-${randomHex(6)}`,
      referenceSecret: randomHex(32),
      cursorSecret: randomHex(32),
    };
    const env = {
      ...baseChildEnv(),
      NODE_ENV: 'production',
      PORT: String(port),
      BIND_HOST: '127.0.0.1',
      PUBLIC_URL: `http://127.0.0.1:${port}`,
      ALLOWED_ORIGINS: '',
      MEDIA_PATH: paths.media,
      DOWNLOADS_PATH: paths.downloads,
      OPERATIONS_DB_PATH: paths.db,
      INTERNAL_API_KEY: keys.owner,
      AGENT_API_KEY: keys.agent,
      MEDIABOX_INSTALLATION_ID: keys.installationId,
      REFERENCE_SECRET: keys.referenceSecret,
      CURSOR_SECRET: keys.cursorSecret,
      ...services.urls,
      ...services.keys,
      BAZARR_ENABLED: 'false',
      ...(runtimeUrl
        ? {
            LLM_PROVIDER: 'local',
            LOCAL_LLM_BASE_URL: runtimeUrl,
            LOCAL_LLM_MODEL: model,
            LOCAL_LLM_RUNTIME: runtime,
            LOCAL_LLM_CONTEXT_TOKENS: String(contextTokens),
            ...(llmTemperature !== undefined ? { LOCAL_LLM_TEMPERATURE: String(llmTemperature) } : {}),
            ...(llmSeed !== undefined ? { LOCAL_LLM_SEED: String(llmSeed) } : {}),
          }
        : {}),
      ...extraEnv,
    };
    for (const [k, v] of Object.entries(env)) {
      if (v === undefined || v === null) delete env[k];
      else env[k] = String(v);
    }

    t = performance.now();
    proc = await startServerProcess(env, paths, { healthTimeoutMs });
    timings.serverMs = Math.round(performance.now() - t);
    timings.totalMs = Math.round(performance.now() - tStart);

    return createHandle({ root, token, paths, services, env, keys, port, proc, keepRoot, healthTimeoutMs, timings });
  } catch (err) {
    await proc?.stop().catch(() => {});
    await services?.close().catch(() => {});
    if (!keepRoot) await removeRootSafely(root, token).catch(() => {});
    throw err;
  }
}

function createHandle(ctx) {
  const { root, token, paths, services, env, keys, port, keepRoot, healthTimeoutMs, timings } = ctx;
  let proc = ctx.proc;
  const baseUrl = `http://127.0.0.1:${port}`;
  const clients = new Map();
  const extraClients = new Set();
  const dbHandles = new Set();
  let stopped = false;

  const resolveKey = (key) => (key === undefined || key === 'owner' ? keys.owner : key === 'agent' ? keys.agent : key === 'none' ? null : key);

  async function request(method, urlPath, { key = 'owner', body, headers = {}, timeoutMs = 30_000 } = {}) {
    const bearer = resolveKey(key);
    const res = await fetch(`${baseUrl}${urlPath}`, {
      method,
      headers: {
        ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...headers,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const textBody = await res.text();
    let parsed;
    try { parsed = textBody ? JSON.parse(textBody) : undefined; } catch { parsed = textBody; }
    return { status: res.status, body: parsed, headers: Object.fromEntries(res.headers) };
  }

  async function ownerJson(method, urlPath, body) {
    const r = await request(method, urlPath, { body });
    if (r.status < 200 || r.status >= 300) {
      throw new HttpError(`${method} ${urlPath} → ${r.status}: ${typeof r.body === 'string' ? r.body : JSON.stringify(r.body)}`, r.status, r.body);
    }
    return r.body;
  }

  async function getPlan(id) {
    const r = await request('GET', `/api/operations/plans/${encodeURIComponent(id)}`);
    if (r.status === 404) return null;
    if (r.status !== 200) throw new HttpError(`GET plan ${id} → ${r.status}`, r.status, r.body);
    return r.body;
  }

  async function waitForPlan(id, { statuses = TERMINAL_PLAN_STATUSES, timeoutMs = 60_000, pollMs = 100 } = {}) {
    const t0 = Date.now();
    let last;
    for (;;) {
      last = await getPlan(id);
      if (last && statuses.includes(last.status)) return last;
      if (Date.now() - t0 > timeoutMs) {
        throw new Error(`plan ${id} did not reach ${statuses.join('|')} within ${timeoutMs} ms (last status: ${last?.status ?? 'missing'})`);
      }
      await sleep(pollMs);
    }
  }

  async function mcpClient(key = 'agent', { name = 'eval-harness' } = {}) {
    const { Client, StreamableHTTPClientTransport } = await loadMcpSdk();
    const bearer = resolveKey(key);
    const client = new Client({ name, version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
      requestInit: { headers: bearer ? { Authorization: `Bearer ${bearer}` } : {} },
    });
    await client.connect(transport);
    extraClients.add(client);
    return client;
  }

  async function cachedClient(key) {
    const k = resolveKey(key);
    if (!clients.has(k)) clients.set(k, mcpClient(key, { name: `eval-harness-${key === 'owner' ? 'owner' : 'agent'}` }));
    return clients.get(k);
  }

  async function closeClients() {
    const all = [...extraClients];
    extraClients.clear();
    clients.clear();
    await Promise.all(all.map((c) => c.close().catch(() => {})));
  }

  function openDb() {
    const req = createRequire(import.meta.url);
    const { DatabaseSync } = req('node:sqlite');
    const conn = new DatabaseSync(paths.db, { readOnly: true });
    try { conn.exec('PRAGMA busy_timeout = 3000;'); } catch { /* read-only pragma refusal is harmless */ }
    dbHandles.add(conn);
    const has = (table) => Boolean(conn.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
    const parse = (s) => { try { return s ? JSON.parse(s) : undefined; } catch { return s; } };
    const planRow = (r) => ({ ...r, plan: parse(r.plan_json) });
    return {
      schemaVersion: () => conn.prepare('PRAGMA user_version;').get().user_version,
      hasTable: has,
      plans: () => conn.prepare('SELECT * FROM operation_plans ORDER BY created_at, id').all().map(planRow),
      plan: (id) => {
        const r = conn.prepare('SELECT * FROM operation_plans WHERE id = ?').get(id);
        return r ? planRow(r) : null;
      },
      steps: (planId) => conn.prepare('SELECT * FROM operation_steps WHERE plan_id = ? ORDER BY step_number').all(planId)
        .map((s) => ({ ...s, details: parse(s.details_json) })),
      /** tool_audit rows (schema v3), or null when the table does not exist yet. */
      auditLedger: () => (has('tool_audit')
        ? conn.prepare('SELECT * FROM tool_audit ORDER BY id').all().map((r) => ({ ...r, args: parse(r.args_json), ok: r.ok === null ? null : Boolean(r.ok) }))
        : null),
      workflows: () => (has('agent_workflows')
        ? conn.prepare('SELECT * FROM agent_workflows').all().map((r) => ({ ...r, state: parse(r.state_json) }))
        : null),
      query: (sql, ...params) => conn.prepare(sql).all(...params),
      close: () => {
        if (dbHandles.delete(conn)) conn.close();
      },
    };
  }

  return {
    baseUrl,
    port,
    keys: { owner: keys.owner, agent: keys.agent, installationId: keys.installationId },
    paths: { ...paths },
    services,
    get pid() { return proc?.pid; },
    get alive() { return Boolean(proc && proc.child.exitCode === null && proc.child.signalCode === null); },
    /** Child environment (contains the generated secrets; do not publish). */
    env: Object.freeze({ ...env }),
    timings,

    request,

    /**
     * One chat turn through POST /api/chat/stream.
     * @returns {Promise<{ httpStatus: number|null, events: Array<{tMs:number, wall:number, event:object}>,
     *   firstByteMs: number|null, totalMs: number, conversationId: string|undefined, fullText: string|null,
     *   aborted: boolean, error?: string, errorBody?: unknown, parseErrors: string[] }>}
     */
    async chatTurn({ conversationId, message, selection, signal, timeoutMs = 180_000, key = 'owner', locale } = {}) {
      const t0 = performance.now();
      const timeout = AbortSignal.timeout(timeoutMs);
      const composite = signal ? AbortSignal.any([signal, timeout]) : timeout;
      const events = [];
      const parseErrors = [];
      let firstByteMs = null;
      let httpStatus = null;
      let errorBody;
      let error;
      const bearer = resolveKey(key);
      const push = (line) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        try {
          events.push({ tMs: performance.now() - t0, wall: Date.now(), event: JSON.parse(trimmed) });
        } catch {
          parseErrors.push(trimmed);
        }
      };
      try {
        const res = await fetch(`${baseUrl}/api/chat/stream`, {
          method: 'POST',
          headers: {
            ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
            'content-type': 'application/json',
            ...(locale ? { 'accept-language': locale } : {}),
          },
          body: JSON.stringify({ message, conversationId, selection }),
          signal: composite,
        });
        httpStatus = res.status;
        if (!res.ok) {
          const t = await res.text();
          try { errorBody = JSON.parse(t); } catch { errorBody = t; }
        } else {
          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          let buf = '';
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (firstByteMs === null) firstByteMs = performance.now() - t0;
            buf += decoder.decode(value, { stream: true });
            let idx;
            while ((idx = buf.indexOf('\n')) >= 0) {
              push(buf.slice(0, idx));
              buf = buf.slice(idx + 1);
            }
          }
          buf += decoder.decode();
          push(buf);
        }
      } catch (err) {
        error = err?.message ?? String(err);
      }
      const done = [...events].reverse().find((e) => e.event.type === 'done');
      return {
        httpStatus,
        events,
        firstByteMs,
        totalMs: performance.now() - t0,
        conversationId: events.find((e) => e.event.type === 'conversation')?.event.id ?? conversationId,
        fullText: done ? done.event.fullText : null,
        aborted: composite.aborted,
        ...(error ? { error } : {}),
        ...(errorBody !== undefined ? { errorBody } : {}),
        parseErrors,
      };
    },

    async getTrace(conversationId) {
      const r = await request('GET', `/api/chat/${encodeURIComponent(conversationId)}/trace`);
      if (r.status === 404) return null;
      if (r.status !== 200) throw new HttpError(`GET trace → ${r.status}`, r.status, r.body);
      return r.body;
    },
    async getHistory(conversationId) {
      return ownerJson('GET', `/api/chat/${encodeURIComponent(conversationId)}/history`);
    },
    async chatInfo() {
      return request('GET', '/api/chat/info');
    },

    /** @param {{ status?: string, statuses?: string[]|string, conversationId?: string, limit?: number, offset?: number }} [query] */
    async listPlans(query = {}) {
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(query)) {
        if (v === undefined || v === null) continue;
        qs.set(k, Array.isArray(v) ? v.join(',') : String(v));
      }
      const body = await ownerJson('GET', `/api/operations/plans${qs.size ? `?${qs}` : ''}`);
      return body.plans;
    },
    getPlan,
    waitForPlan,
    /** GET plan → POST approve {manifestHash} → poll to a terminal status; returns the final record. */
    async approvePlan(id, { timeoutMs = 60_000, pollMs = 100 } = {}) {
      const record = await getPlan(id);
      if (!record) throw new Error(`plan ${id} not found`);
      const manifestHash = record.plan?.manifestHash ?? record.manifestHash;
      await ownerJson('POST', `/api/operations/plans/${encodeURIComponent(id)}/approve`, { manifestHash });
      return waitForPlan(id, { timeoutMs, pollMs });
    },
    rejectPlan: (id, reason) => ownerJson('POST', `/api/operations/plans/${encodeURIComponent(id)}/reject`, reason ? { reason } : {}),
    cancelPlan: (id, reason) => ownerJson('POST', `/api/operations/plans/${encodeURIComponent(id)}/cancel`, reason ? { reason } : {}),
    listQuarantine: (rootId) => ownerJson('GET', `/api/operations/quarantine${rootId ? `?rootId=${encodeURIComponent(rootId)}` : ''}`),
    /** body: { rootId, entryPaths[] } → a restore plan awaiting approval. */
    restoreQuarantine: (body) => ownerJson('POST', '/api/operations/quarantine/restore', body),
    /** body: { rootId, entryPaths[] } → a purge plan awaiting approval. */
    purgeQuarantine: (body) => ownerJson('POST', '/api/operations/quarantine/purge', body),

    /** A new connected MCP SDK Client (key: "agent" | "owner" | literal bearer). Closed by stop()/restart(). */
    mcpClient,
    /** Calls one MCP tool through a cached client for `key`; returns { isError, text, json, structured, raw }. */
    async callTool(name, args = {}, { key = 'agent' } = {}) {
      const client = await cachedClient(key);
      return toolOutcome(await client.callTool({ name, arguments: args }));
    },

    /** Read-only view of OPERATIONS_DB_PATH (node:sqlite). */
    db: openDb,
    inventory: () => inventoryRoots({ media: paths.media, downloads: paths.downloads }),
    logTail: (lines = 80) => ({ stdout: tailFile(paths.stdoutLog, lines), stderr: tailFile(paths.stderrLog, lines) }),

    /** Stops the server process only (services, DB and files stay). */
    async stopServer() {
      await closeClients();
      await proc?.stop();
    },
    /** Restarts the server with the same env/DB/files; resolves when healthy. */
    async restart({ timeoutMs = healthTimeoutMs } = {}) {
      if (stopped) throw new Error('stack already stopped');
      await closeClients();
      await proc?.stop();
      const t = performance.now();
      proc = await startServerProcess(env, paths, { healthTimeoutMs: timeoutMs });
      timings.lastRestartMs = Math.round(performance.now() - t);
      return { pid: proc.pid, startupMs: proc.startupMs };
    },
    /** Kills the process tree, closes services, removes the temp root when its marker matches. */
    async stop() {
      if (stopped) return { removedRoot: false };
      stopped = true;
      await closeClients();
      for (const conn of dbHandles) { try { conn.close(); } catch { /* already closed */ } }
      dbHandles.clear();
      await proc?.stop();
      await services.close();
      const removedRoot = keepRoot ? false : await removeRootSafely(root, token);
      return { removedRoot };
    },
  };
}
