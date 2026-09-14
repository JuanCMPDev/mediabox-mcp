/**
 * NET-05 (PR05 §3.2 / §3.4): canary secrets of arbitrary formats (Unicode
 * passwords, `sk-or-v1-…`, keys with `/+=~`, a URL with embedded credentials,
 * an inherited Telegram token, the owner and agent keys themselves) are injected
 * into the mcp-server environment of the generated offline-library topology;
 * canaries are also injected into synthetic upstream ERROR bodies, and unique
 * phrases into a chat turn (user message, a tool-call argument the model
 * produces, and the model's reply).
 *
 * Then every surface that is not the conversation itself is scanned for them,
 * literally and in escaped forms (URL-encoded, JSON-escaped, base64, NFD):
 * `docker logs` of every container, GET /api/chat/info, GET /api/chat/:id/trace,
 * the owner dashboard and setup diagnostics, the UI bundle (the shipped dist and
 * a build with the canaries in its environment) and exportable reports under
 * evals/evidence. GET /api/chat/:id/history legitimately holds the conversation
 * and is used only as the positive control; the allowed inference traffic may
 * carry the prompt, and the runtime stand-in's request log (method/path only)
 * is never published as a diagnostic.
 *
 * Each zero is backed by a positive control: the scanner finds every variant,
 * and every canary provably reached its service (keys accepted, faults fired,
 * phrases in the turn and the history).
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { repoRoot, tempDir, removeTempDir } from './lab/docker-lab.mjs';
import { startTopology, hex, OFFLINE } from './lab/topology.mjs';
import { scanText, scanFiles, variants } from './lab/secret-scan.mjs';

const canary = {
  JELLYFIN_API_KEY: `jf.${hex(8)}~/+=`,
  SONARR_API_KEY: `sn_${hex(10)}`,
  RADARR_API_KEY: `rd_${hex(10)}`,
  QBIT_PASSWORD: `p@ss/wörd-${hex(6)}`,
  PYLOAD_PASSWORD: `py!pässw0rd-${hex(6)}`,
  OPENROUTER_API_KEY: `sk-or-v1-${hex(16)}`,
  GOOGLE_AI_API_KEY: `AIza${hex(12)}`,
  LOCAL_LLM_API_KEY: `lk:${hex(12)}`,
  INTERNAL_API_KEY: `owner-${hex(16)}`,
  AGENT_API_KEY: `agent-${hex(16)}`,
  TELEGRAM_BOT_TOKEN: `7${String(Date.now()).slice(-8)}:AAH${hex(14)}`,
};
const urlPassword = `urlpw-${hex(10)}`;
const PROWLARR_URL = `http://mbxuser:${urlPassword}@prowlarr:9696`;
const upstreamError = { activity: `upstream-activity-${hex(8)}`, sessions: `upstream-sessions-${hex(8)}` };
const phrase = { user: `frase-privada-${hex(6)}`, reply: `respuesta-privada-${hex(6)}`, query: `consulta-privada-${hex(6)}` };

const SECRETS = {
  ...canary,
  PROWLARR_URL_PASSWORD: urlPassword,
  UPSTREAM_ERROR_ACTIVITY: upstreamError.activity,
  UPSTREAM_ERROR_SESSIONS: upstreamError.sessions,
  PHRASE_USER: phrase.user,
  PHRASE_REPLY: phrase.reply,
  PHRASE_TOOL_ARGUMENT: phrase.query,
};
const nameOf = new Map(Object.entries(SECRETS).map(([k, v]) => [v, k]));
const values = Object.values(SECRETS);
const findings = (text, where) => scanText(String(text ?? ''), values, where).map((h) => ({ secret: nameOf.get(h.secret), form: h.variant === 'literal' ? 'literal' : 'escaped', where }));
const norm = (ip) => String(ip ?? '').replace(/^::ffff:/, '');

describe('NET-05 (offline-library): canaries never reach logs, diagnostics or reports', { timeout: 1_800_000 }, () => {
  let t;
  let turn;
  const responses = {};

  before(async () => {
    t = await startTopology({
      profile: OFFLINE,
      label: 'n5',
      env: { ...canary, PROWLARR_URL },
      mcpEnvKeys: ['PROWLARR_URL', 'TELEGRAM_BOT_TOKEN'],
      seed: { jellyfin: { items: [{ Type: 'Movie', Name: 'Película Canario', ProductionYear: 2021, Path: '/data/movies/Película Canario (2021)/Película Canario (2021).mkv' }] } },
      faults: [
        { service: 'jellyfin', matcher: { path: '/System/ActivityLog/Entries' }, fault: { status: 500, body: { message: `activity store failed: ${upstreamError.activity}` } } },
        { service: 'jellyfin', matcher: { path: '/Sessions' }, fault: { status: 500, body: { message: `session store failed: ${upstreamError.sessions}` } } },
      ],
      script: [
        [
          { toolCall: { name: 'media_query', arguments: { action: 'search', query: phrase.query } } },
          { toolCall: { name: 'server_info', arguments: { action: 'activity' } } },
        ],
        [{ text: `Hecho. ${phrase.reply}` }],
      ],
    });

    turn = await t.chat(`Por favor revisa esto: ${phrase.user}`);
    const id = encodeURIComponent(turn.conversationId ?? 'none');
    const get = async (p, key = 'owner') => {
      const r = await t.request('GET', p, { key });
      responses[`${key} GET ${p}`] = r;
      return r;
    };
    await get('/api/chat/info');
    await get('/api/chat/info', 'agent');
    await get(`/api/chat/${id}/trace`);
    await get(`/api/chat/${id}/history`);
    for (const p of ['/api/dashboard/health', '/api/dashboard/services', '/api/dashboard/sessions', '/api/dashboard/downloads', '/api/dashboard/library']) await get(p);
    for (const p of ['/api/setup/info', '/api/setup/status']) await get(p);
  });

  after(async () => {
    await t?.down();
  });

  it('positive control: the scanner finds every canary in every escaped form', () => {
    for (const value of values) {
      for (const v of variants(value)) {
        assert.equal(findings(`<<${v}>>`, 'self-test').length > 0, true, `the scanner misses ${nameOf.get(value)} as ${v}`);
      }
    }
  });

  it('positive control: every canary reached its destination (keys accepted, faults fired, phrases in the turn)', () => {
    assert.equal(turn.status, 200, turn.text);
    assert.equal(turn.error, undefined, JSON.stringify(turn.error));
    assert.match(turn.done?.fullText ?? '', new RegExp(phrase.reply));
    const history = responses[`owner GET /api/chat/${encodeURIComponent(turn.conversationId)}/history`];
    assert.equal(history.status, 200);
    assert.ok(history.text.includes(phrase.user) && history.text.includes(phrase.reply), 'the history does not hold the conversation (the phrases never went through)');

    const serverIps = new Set(t.ips('mcp-server'));
    const jf = t.requestLog('jellyfin');
    assert.ok(jf.some((e) => e.path === '/Items' && e.query?.searchTerm === phrase.query && e.status === 200 && serverIps.has(norm(e.remoteAddress))), 'the model\'s tool argument never reached jellyfin with the canary key accepted');
    assert.ok(jf.some((e) => e.path === '/System/ActivityLog/Entries' && e.status === 500), 'the activity error body was never served');
    assert.ok(jf.some((e) => e.path === '/Sessions' && e.status === 500), 'the sessions error body was never served');
    const qb = t.requestLog('qbittorrent');
    assert.ok(qb.some((e) => e.path === '/api/v2/torrents/info' && e.status === 200), 'qBittorrent never accepted the Unicode canary password');
    assert.equal(t.requestLog('runtime').filter((e) => e.path === '/v1/chat/completions').length, 2);
  });

  it('docker logs of every container: zero canaries', () => {
    const logs = t.allLogs();
    assert.ok(logs.some((l) => l.service === 'mcp-server' && l.text.includes('running on port')), 'mcp-server logs were not captured');
    const hits = logs.flatMap((l) => findings(l.text, `docker logs ${l.service}`));
    assert.deepEqual(hits, []);
  });

  it('GET /api/chat/info (owner and agent keys): zero canaries', () => {
    for (const key of ['owner', 'agent']) {
      const r = responses[`${key} GET /api/chat/info`];
      assert.equal(r.status, 200, r.text);
      assert.deepEqual(findings(r.text, `${key} /api/chat/info`), []);
    }
  });

  it('GET /api/chat/:id/trace (owner diagnostics): zero canaries, no prompt or reply', () => {
    const r = responses[`owner GET /api/chat/${encodeURIComponent(turn.conversationId)}/trace`];
    assert.equal(r.status, 200, `no trace for the turn: ${r.text}`);
    assert.ok(Array.isArray(r.body?.toolCalls) && r.body.toolCalls.length >= 1, 'the trace does not describe the turn');
    assert.deepEqual(findings(r.text, '/api/chat/:id/trace'), []);
  });

  it('owner dashboard diagnostics (/api/dashboard/*): zero canaries', () => {
    const hits = Object.entries(responses)
      .filter(([k]) => k.includes('/api/dashboard/'))
      .flatMap(([k, r]) => findings(r.text, `${k} → ${r.status}`));
    assert.deepEqual(hits, []);
  });

  it('owner setup diagnostics (/api/setup/info, /api/setup/status): zero canaries', () => {
    const info = responses['owner GET /api/setup/info'];
    assert.equal(info.status, 200, info.text);
    const hits = Object.entries(responses)
      .filter(([k]) => k.includes('/api/setup/'))
      .flatMap(([k, r]) => findings(r.text, `${k} → ${r.status}`));
    assert.deepEqual(hits, []);
  });
});

describe('NET-05: UI bundle and exportable reports carry no canaries', { timeout: 900_000 }, () => {
  it('the shipped UI bundle (packages/ui/dist) holds none of the canaries', () => {
    const dist = path.join(repoRoot, 'packages', 'ui', 'dist');
    assert.ok(fs.existsSync(path.join(dist, 'index.html')), 'packages/ui/dist is missing: build the workspaces first (npm run ci:build)');
    assert.deepEqual(scanFiles([dist], values), []);
  });

  it('a UI build with the canaries in its build environment embeds none of them', () => {
    const out = tempDir('n5 ui build');
    try {
      const env = { ...process.env };
      for (const [k, v] of Object.entries(SECRETS)) {
        env[k] = v;
        env[`VITE_${k}`] = v;
      }
      env.PROWLARR_URL = PROWLARR_URL;
      const vite = path.join(repoRoot, 'node_modules', 'vite', 'bin', 'vite.js');
      // Same loader as `npm run ci:build` (the product config relies on it for __dirname).
      const r = spawnSync(process.execPath, [vite, 'build', '--outDir', out, '--emptyOutDir', '--logLevel', 'warn'], {
        cwd: path.join(repoRoot, 'packages', 'ui'), env, encoding: 'utf8', timeout: 600_000,
      });
      assert.equal(r.status, 0, `vite build failed: ${r.stderr || r.stdout || r.error?.message}`);
      assert.ok(fs.existsSync(path.join(out, 'index.html')), 'the build produced no bundle');
      const hits = scanFiles([out], values).map((h) => ({ secret: nameOf.get(Buffer.from(h.secret, 'latin1').toString('utf8')) ?? 'unknown', file: path.relative(out, h.where) }));
      assert.deepEqual(hits, [], 'secrets present in the build environment were embedded in the UI bundle');
    } finally {
      removeTempDir(out);
    }
  });

  it('exportable reports under evals/evidence hold none of the canaries', (ctx) => {
    const evidence = path.join(repoRoot, 'evals', 'evidence');
    const files = [];
    const walk = (p) => {
      if (!fs.existsSync(p)) return;
      if (fs.statSync(p).isDirectory()) for (const e of fs.readdirSync(p)) walk(path.join(p, e));
      else files.push(p);
    };
    walk(evidence);
    ctx.diagnostic(`scanned ${files.length} report file(s) under evals/evidence`);
    assert.deepEqual(scanFiles(files, values), []);
  });
});
