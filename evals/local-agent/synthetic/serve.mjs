#!/usr/bin/env node
/**
 * Single-service launcher for containerised suites (node built-ins only; the
 * repository may be mounted read-only).
 *
 *   node serve.mjs --service <jellyfin|sonarr|radarr|qbittorrent|prowlarr|pyload|flaresolverr|runtime>
 *                  [--port <n>] [--host 0.0.0.0] [--advertise-host <name>]
 *                  [--seed <seed.json>] [--script <script.json>] [--log <requests.jsonl>]
 *                  [--model qwen2.5:7b] [--context-tokens 8192] [--no-tools]
 *
 * Credentials: taken from the environment when present (JELLYFIN_API_KEY,
 * SONARR_API_KEY, RADARR_API_KEY, PROWLARR_API_KEY, QBIT_USER, QBIT_PASSWORD,
 * PYLOAD_USER, PYLOAD_PASSWORD) so the mcp-server container can be given the
 * same values; otherwise generated and printed in the ready line.
 *
 * Prints one JSON "ready" line on stdout ({ ready, service, url, port, keys }),
 * appends one JSON line per request to --log ({ service, method, path, query,
 * remoteAddress, status, ts }) and exits cleanly on SIGINT/SIGTERM.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startSyntheticServices, SERVICE_NAMES } from './services.mjs';
import { startScriptedRuntime } from './scripted-runtime.mjs';

const KEY_NAMES = ['JELLYFIN_API_KEY', 'SONARR_API_KEY', 'RADARR_API_KEY', 'PROWLARR_API_KEY', 'QBIT_USER', 'QBIT_PASSWORD', 'PYLOAD_USER', 'PYLOAD_PASSWORD'];

export function parseArgs(argv) {
  const out = { host: '127.0.0.1', port: 0, tools: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`missing value for ${a}`);
      return v;
    };
    switch (a) {
      case '--service': out.service = next(); break;
      case '--port': out.port = Number(next()); break;
      case '--host': out.host = next(); break;
      case '--advertise-host': out.advertiseHost = next(); break;
      case '--seed': out.seed = next(); break;
      case '--script': out.script = next(); break;
      case '--log': out.log = next(); break;
      case '--model': out.model = next(); break;
      case '--context-tokens': out.contextTokens = Number(next()); break;
      case '--no-tools': out.tools = false; break;
      case '--help':
      case '-h': out.help = true; break;
      default: throw new Error(`unknown argument ${a}`);
    }
  }
  return out;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.service) {
    process.stdout.write(`usage: node serve.mjs --service <${[...SERVICE_NAMES, 'runtime'].join('|')}> [--port n] [--host h] [--seed f] [--script f] [--log f]\n`);
    process.exit(args.help ? 0 : 2);
  }
  if (args.log) fs.mkdirSync(path.dirname(path.resolve(args.log)), { recursive: true });
  const logLine = (service) => (entry) => {
    if (!args.log) return;
    const line = { service, method: entry.method, path: entry.path, query: entry.query, remoteAddress: entry.remoteAddress, status: entry.status, ts: entry.ts };
    try { fs.appendFileSync(args.log, `${JSON.stringify(line)}\n`); } catch { /* the log is best effort */ }
  };

  let handle;
  let ready;
  if (args.service === 'runtime') {
    handle = await startScriptedRuntime({
      host: args.host,
      port: args.port,
      advertiseHost: args.advertiseHost,
      model: args.model,
      contextTokens: args.contextTokens,
      supportsTools: args.tools,
      script: args.script ? readJson(args.script) : [],
      onRequest: logLine('runtime'),
    });
    ready = { ready: true, service: 'runtime', url: handle.url, port: handle.port, model: handle.model };
  } else {
    if (!SERVICE_NAMES.includes(args.service)) throw new Error(`unknown service '${args.service}'`);
    const keys = {};
    for (const k of KEY_NAMES) if (process.env[k]) keys[k] = process.env[k];
    handle = await startSyntheticServices(args.seed ? readJson(args.seed) : {}, {
      host: args.host,
      advertiseHost: args.advertiseHost,
      only: [args.service],
      ports: { [args.service]: args.port },
      keys,
      onRequest: logLine(args.service),
    });
    ready = { ready: true, service: args.service, url: handle.url(args.service), port: handle.port(args.service), keys: handle.keys };
  }
  process.stdout.write(`${JSON.stringify(ready)}\n`);

  const shutdown = async () => {
    await handle.close().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

const invokedDirectly = Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((err) => {
    process.stderr.write(`serve.mjs: ${err?.stack ?? err}\n`);
    process.exit(1);
  });
}
