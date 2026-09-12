#!/usr/bin/env node
/**
 * Stand-in launcher for the G09 overlay (PR05 §3.4). Runs ONE synthetic media
 * service or the scripted Ollama-compatible runtime from the real-path eval
 * harness (evals/local-agent/synthetic, mounted read-only at /synthetic) in the
 * place of a third-party image, on the port the generated topology expects.
 *
 *   node standin.mjs --service <jellyfin|sonarr|radarr|qbittorrent|prowlarr|pyload|flaresolverr|runtime>
 *                    --port <n> [--seed f.json] [--script f.json] [--model name]
 *                    [--log requests.jsonl] [--faults faults.json]
 *
 * Unlike serve.mjs it never prints credentials: the ready line is only
 * {"ready":true,"service","port"}, so NET-05 can scan every container's logs.
 * Credentials come from the environment (the same .env the mcp-server reads).
 * --faults is a JSON array of { service?, matcher: { method?, path }, fault }
 * applied with setFault() (fault injection of error bodies for NET-05).
 * Every request is appended to --log as { service, method, path, query,
 * remoteAddress, status, ts } (no headers, no bodies).
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const SYNTHETIC = process.env.SYNTHETIC_DIR ?? '/synthetic';
const KEY_NAMES = ['JELLYFIN_API_KEY', 'SONARR_API_KEY', 'RADARR_API_KEY', 'PROWLARR_API_KEY', 'QBIT_USER', 'QBIT_PASSWORD', 'PYLOAD_USER', 'PYLOAD_PASSWORD'];

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    const value = argv[i + 1];
    if (!key?.startsWith('--') || value === undefined) throw new Error(`bad argument ${key}`);
    out[key.slice(2)] = value;
  }
  if (!out.service || !out.port) throw new Error('--service and --port are required');
  return out;
}

const readJson = (file) => (file && fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : undefined);

const args = parseArgs(process.argv.slice(2));
if (args.log) fs.mkdirSync(path.dirname(args.log), { recursive: true });
const log = (entry) => {
  if (!args.log) return;
  const line = { service: args.service, method: entry.method, path: entry.path, query: entry.query, remoteAddress: entry.remoteAddress, status: entry.status, ts: entry.ts };
  try { fs.appendFileSync(args.log, `${JSON.stringify(line)}\n`); } catch { /* best effort */ }
};

let handle;
if (args.service === 'runtime') {
  const { startScriptedRuntime } = await import(pathToFileURL(path.join(SYNTHETIC, 'scripted-runtime.mjs')).href);
  handle = await startScriptedRuntime({
    host: '0.0.0.0',
    port: Number(args.port),
    model: args.model || 'qwen2.5:7b',
    script: readJson(args.script) ?? [],
    onRequest: log,
  });
} else {
  const { startSyntheticServices } = await import(pathToFileURL(path.join(SYNTHETIC, 'services.mjs')).href);
  const keys = {};
  for (const k of KEY_NAMES) if (process.env[k]) keys[k] = process.env[k];
  handle = await startSyntheticServices(readJson(args.seed) ?? {}, {
    host: '0.0.0.0',
    only: [args.service],
    ports: { [args.service]: Number(args.port) },
    keys,
    onRequest: log,
  });
  for (const f of readJson(args.faults) ?? []) {
    if ((f.service ?? args.service) !== args.service) continue;
    handle.setFault(args.service, f.matcher, f.fault);
  }
}

process.stdout.write(`${JSON.stringify({ ready: true, service: args.service, port: Number(args.port) })}\n`);

const shutdown = async () => {
  await handle.close().catch(() => {});
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
