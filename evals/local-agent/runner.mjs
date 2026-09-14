#!/usr/bin/env node
/**
 * Live evaluation runner for Phase P11 (PR05 §4 / Gate G10).
 *
 * Path under test, for every one of the 60 × 3 planned executions:
 *   runner → POST /api/chat/stream (owner credential, as the UI)
 *          → production AgentRuntime → LocalProvider → inference proxy → real model
 *          → the server's own /mcp over authenticated HTTP (agent credential)
 *          → real tools, planners, SQLite and executor
 *          → synthetic Jellyfin/Sonarr/Radarr/qBittorrent and temporary media.
 * Owner steps (approve, reject, cancel, restore, purge) are performed by the
 * harness with the owner credential, never by the model.
 *
 * There is no simulated or scripted mode: a missing runtime, profile mismatch
 * or dirty checkout aborts the run. `--dev` exists for rehearsals and marks
 * the manifest mode `dev`, which the verifier never accepts.
 *
 *   node evals/local-agent/runner.mjs --experiment-id <id> --storage <dir> --class local-lab
 *        [--ollama-exe <path>] [--passes 3] [--take-over] [--dev --only READ-01,ADV-06]
 */

import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { startStack } from './stack.mjs';
import { diffInventory } from './synthetic/media.mjs';
import { buildSeed } from './synthetic/services.mjs';
import { scoreExecution, summarizePass, evaluateThresholds, serializeSummary, SCORER_VERSION } from './scorer.mjs';
import { EXTRACTOR_VERSION, normalizeText, resolveTemplate } from './extractor.mjs';
import { startInferenceProxy } from './inference-proxy.mjs';
import { startEgressMonitor } from './egress-monitor.mjs';
import { validateModelProfile, sha256File } from './profile.mjs';
import {
  OllamaProcess, runtimePids, startMemorySampler, generateMediaFixture, transcodeOnce, inferenceLoad, PERF_VERSION,
} from './perf.mjs';

export const RUNNER_VERSION = '2.0.0';
const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), '../..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

const SEALED = {
  contract: 'docs/blueprints/handoffs/PR05-EVAL-CONTRACT.json',
  corpus: 'evals/local-agent/corpus.json',
  corpusGenerator: 'evals/local-agent/corpus-data.mjs',
  declarations: 'evals/local-agent/profile-declarations.json',
  scorer: 'evals/local-agent/scorer.mjs',
  extractor: 'evals/local-agent/extractor.mjs',
  runner: 'evals/local-agent/runner.mjs',
  stack: 'evals/local-agent/stack.mjs',
  syntheticServices: 'evals/local-agent/synthetic/services.mjs',
  syntheticMedia: 'evals/local-agent/synthetic/media.mjs',
  perf: 'evals/local-agent/perf.mjs',
  inferenceProxy: 'evals/local-agent/inference-proxy.mjs',
  egressMonitor: 'evals/local-agent/egress-monitor.mjs',
  packageLock: 'package-lock.json',
};

// ── CLI and repository facts ───────────────────────────────────────────────

export function parseArgs(argv) {
  const a = { passes: null, dev: false, only: null, takeOver: false, class: 'local-lab' };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = argv[i + 1];
    if (k === '--experiment-id') { a.experimentId = v; i++; }
    else if (k === '--storage') { a.storage = path.resolve(v); i++; }
    else if (k === '--class') { a.class = v; i++; }
    else if (k === '--controller-started-at') { a.controllerStartedAt = v; i++; }
    else if (k === '--ollama-exe') { a.ollamaExe = v; i++; }
    else if (k === '--passes') { a.passes = Number(v); i++; }
    else if (k === '--profile') { a.profile = v; i++; }
    else if (k === '--only') { a.only = v.split(','); i++; }
    else if (k === '--dev') a.dev = true;
    else if (k === '--skip-perf') a.skipPerf = true;
    else if (k === '--take-over') a.takeOver = true;
  }
  return a;
}

function git(args) {
  return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' }).trim();
}

function blobSha(commit, rel) {
  return sha256(execFileSync('git', ['cat-file', 'blob', `${commit}:${rel}`], { cwd: repoRoot, maxBuffer: 256 * 1024 * 1024 }));
}

function findOllamaExe(explicit) {
  if (explicit) return explicit;
  const cmd = process.platform === 'win32' ? 'where' : 'which';
  return execFileSync(cmd, ['ollama'], { encoding: 'utf8' }).split(/\r?\n/)[0].trim();
}

// ── Seed generators declared by the corpus (deterministic) ─────────────────

/**
 * Base + patch merge declared by the corpus: arrays append, `{ "$replace": v }`
 * replaces, objects merge, a `null` media entry removes the base file.
 */
export function mergePatch(base, patch) {
  if (patch && typeof patch === 'object' && !Array.isArray(patch) && '$replace' in patch) return JSON.parse(JSON.stringify(patch.$replace));
  if (Array.isArray(patch)) return [...(Array.isArray(base) ? base : []), ...JSON.parse(JSON.stringify(patch))];
  if (patch && typeof patch === 'object') {
    const out = base && typeof base === 'object' && !Array.isArray(base) ? { ...base } : {};
    for (const [k, v] of Object.entries(patch)) out[k] = mergePatch(out[k], v);
    return out;
  }
  return patch === undefined ? base : patch;
}

export function expandScenario(s, base = {}) {
  const seed = mergePatch(JSON.parse(JSON.stringify(base.seed ?? {})), s.seedPatch ?? {});
  const media = { ...(base.media ?? {}) };
  for (const [k, v] of Object.entries(s.mediaPatch ?? {})) {
    if (v === null) delete media[k];
    else media[k] = v;
  }
  for (const [kind, g] of Object.entries(s.generate ?? {})) {
    if (kind === 'jellyfinBulkMovies') {
      seed.jellyfin ??= {};
      seed.jellyfin.items ??= [];
      for (let i = 1; i <= g.count; i++) {
        const n = String(i).padStart(5, '0');
        seed.jellyfin.items.push({ Id: `jf-bulk-${n}`, Name: `${g.prefix} ${n}`, Type: 'Movie', ProductionYear: 1950 + (i % 70), Path: `/data/movies/${g.prefix} ${n}/${g.prefix} ${n}.mkv` });
      }
    } else if (kind === 'longSeason') {
      seed.jellyfin ??= {};
      seed.jellyfin.items ??= [];
      for (let i = 1; i <= g.count; i++) {
        const n = String(i).padStart(2, '0');
        seed.jellyfin.items.push({ Id: `${g.seasonId}-e${n}`, Name: `${g.namePrefix} ${n}`, Type: 'Episode', SeriesId: g.seriesId, SeasonId: g.seasonId, IndexNumber: i, Path: `/data/tv/${g.folder}/Season 01/${g.folder} - S01E${n}.mkv` });
      }
    } else {
      throw new Error(`Unknown generator ${kind} in ${s.id}`);
    }
  }
  return { seed: buildSeed(seed), media };
}

// ── One execution ──────────────────────────────────────────────────────────

function templated(value, bindings) {
  if (typeof value === 'string') return resolveTemplate(value, bindings);
  if (Array.isArray(value)) return value.map((v) => templated(v, bindings));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, templated(v, bindings)]));
  return value;
}

function getField(obj, dotted) {
  return dotted.split('.').reduce((acc, k) => (acc == null ? acc : acc[k]), obj);
}

function servicePorts(urls) {
  return Object.values(urls ?? {}).map((u) => {
    try { return Number(new URL(u).port); } catch { return null; }
  }).filter(Boolean);
}

async function waitRuntimeReady(stack, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await stack.chatInfo().catch(() => null);
    if (last?.body?.runtimeState === 'ready') return last.body;
    if (last?.body?.runtimeState === 'error') return last.body;
    await sleep(250);
  }
  return last?.body ?? null;
}

/**
 * Runs one scenario on a fresh installation and returns the raw observation.
 * Exceptions become harness errors on the observation (an evidence gap that
 * fails the execution) — they are never retried.
 */
export async function runScenario(scenario, ctx) {
  const obs = {
    scenario,
    pass: ctx.pass,
    attempt: 1,
    passRunId: ctx.passRunId,
    startedAt: new Date().toISOString(),
    bindings: { ...(scenario.bindings ?? {}) },
    harnessErrors: [],
    stepFailures: [],
    ownerActions: [],
    setupPlanIds: [],
    turns: [],
    ownerPrincipalId: 'owner-ui',
  };
  let stack;
  const tStart = performance.now();
  try {
    const { seed, media } = expandScenario(scenario, ctx.corpusBase);
    stack = await startStack({
      seed,
      media,
      runtimeUrl: ctx.proxy.url,
      model: ctx.profile.model.name,
      contextTokens: ctx.profile.context.configuredTokens,
      llmTemperature: ctx.profile.sampling.temperature,
      llmSeed: ctx.profile.sampling.seed,
      extraEnv: { LOCAL_LLM_MODEL_DIGEST: ctx.profile.model.manifestDigest, ...(scenario.extraEnv ?? {}) },
      serviceOptions: scenario.serviceOptions ?? {},
    });
    ctx.monitor.addPid(stack.pid);
    obs.serverPids = [stack.pid];

    const info = await waitRuntimeReady(stack);
    obs.runtimeAtStart = { state: info?.runtimeState, artifactStatus: info?.artifactStatus, reason: info?.runtimeReason };
    if (info?.runtimeState !== 'ready' && !scenario.expectRuntimeNotReady) {
      obs.harnessErrors.push(`runtime not ready: ${JSON.stringify(obs.runtimeAtStart)}`);
    }

    // Setup performed by the harness (not the model); excluded from scoring baselines.
    for (const step of scenario.setup ?? []) {
      if (step.kind === 'tool') {
        const out = await stack.callTool(step.tool, templated(step.args ?? {}, obs.bindings), { key: 'agent' });
        if (out.isError) throw new Error(`setup ${step.tool} failed: ${out.text.slice(0, 300)}`);
        for (const [name, field] of Object.entries(step.bind ?? {})) obs.bindings[name] = getField(out.json, field);
        if (out.json?.data?.planId) obs.setupPlanIds.push(out.json.data.planId);
      } else if (step.kind === 'approve') {
        const planId = obs.bindings[step.plan];
        const rec = await stack.approvePlan(planId);
        obs.ownerActions.push({ action: 'approve', planId, ok: rec.status === (step.expectStatus ?? 'succeeded'), status: rec.status, setup: true, required: true });
      } else if (step.kind === 'write') {
        const target = path.join(stack.paths.media, step.path);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, step.text ?? 'x'.repeat(step.bytes ?? 16));
      } else {
        throw new Error(`unknown setup step ${step.kind}`);
      }
    }

    const db0 = stack.db();
    const audit0 = db0.auditLedger();
    if (audit0 === null) throw new Error('tool_audit table missing: the server under test predates schema v3');
    const auditBaseline = audit0.reduce((m, r) => Math.max(m, r.id), 0);
    db0.close();
    const mutationBaseline = stack.services.watermark();
    const before = await stack.inventory();

    for (const f of scenario.faults ?? []) stack.services.setFault(f.service, f.match, f.fault);

    let conversationId;
    let lastChoices = null;
    const runTurn = async (message, selection, opts = {}) => {
      const t0 = performance.now();
      const controller = new AbortController();
      if (opts.abortAfterMs) setTimeout(() => controller.abort(), opts.abortAfterMs).unref?.();
      const r = await stack.chatTurn({ conversationId, message, selection, locale: scenario.locale, timeoutMs: 180_000, signal: opts.abortAfterMs ? controller.signal : undefined });
      const t1 = performance.now();
      conversationId = r.conversationId ?? conversationId;
      const events = r.events.map((e) => ({ tMs: Math.round(e.tMs), ...e.event }));
      const choices = [...events].reverse().find((e) => e.type === 'choices');
      if (choices) lastChoices = choices;
      const trace = conversationId ? await stack.getTrace(conversationId).catch(() => null) : null;
      obs.turns.push({
        message,
        selection,
        httpStatus: r.httpStatus,
        totalMs: r.totalMs,
        firstByteMs: r.firstByteMs,
        tEndAbs: t1,
        aborted: r.aborted,
        expectedAbort: Boolean(opts.abortAfterMs),
        errorBody: r.errorBody,
        events,
        trace,
        inferences: ctx.proxy.window(t0, t1).map((i) => ({
          toolNames: i.toolNames, maxTokens: i.maxTokens, promptTokens: i.promptTokens, completionTokens: i.completionTokens,
          tStartMs: Math.round(i.tStart - t0), tFirstByteMs: i.tFirstByte ? Math.round(i.tFirstByte - t0) : null,
          status: i.status, finishReason: i.finishReason,
          contentChars: i.contentChars, toolCalls: i.toolCalls,
          ...(i.emptySample !== undefined ? { emptySample: i.emptySample } : {}),
        })),
      });
      return r;
    };

    const pickPlan = async (operation, statuses) => {
      const plans = await stack.listPlans({ statuses });
      const candidates = plans
        .filter((p) => !obs.setupPlanIds.includes(p.id))
        .filter((p) => !operation || p.operation === operation)
        .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
      return candidates[0];
    };

    for (const step of scenario.steps) {
      const required = step.required ?? true;
      switch (step.kind) {
        case 'user':
          await runTurn(resolveTemplate(step.message, obs.bindings));
          break;
        case 'user-selection':
          await runTurn(step.label ?? '', templated(step.selection, obs.bindings));
          break;
        case 'select': {
          // `optional`: the owner clicks only if the previous turn actually showed cards.
          const lastTurn = obs.turns.at(-1);
          const shownNow = lastTurn?.events?.some((e) => e.type === 'choices');
          if (step.optional && !shownNow) break;
          const want = normalizeText(step.labelIncludes);
          const item = lastChoices?.items?.find((i) => normalizeText(`${i.label} ${i.subtitle ?? ''} ${i.meta ?? ''}`).includes(want));
          if (!item) { obs.stepFailures.push(`no choice matching "${step.labelIncludes}"`); break; }
          // A card without a typed selection sends its value as text (as the UI does);
          // the reference it carries is still the one the owner picked.
          const refIn = (kind) => item.selection?.[kind] ?? `${item.value ?? ''}`.match(kind === 'mediaRef' ? /mref_[A-Za-z0-9_.-]+/ : /rref_[A-Za-z0-9_.-]+/)?.[0];
          if (refIn('mediaRef')) obs.bindings.selectedMediaRef = refIn('mediaRef');
          if (refIn('releaseRef')) obs.bindings.selectedReleaseRef = refIn('releaseRef');
          obs.bindings.selectionTyped = Boolean(item.selection);
          await runTurn(item.value ?? item.label, item.selection);
          break;
        }
        case 'cancel-turn':
          await runTurn(resolveTemplate(step.message, obs.bindings), undefined, { abortAfterMs: step.afterMs });
          break;
        case 'owner': {
          const statuses = step.action === 'cancel' ? ['queued', 'running'] : ['awaiting_approval'];
          const plan = await pickPlan(step.operation, statuses);
          if (!plan) { obs.ownerActions.push({ action: step.action, ok: false, required, reason: 'no matching plan' }); break; }
          try {
            if (step.action === 'approve') {
              const rec = await stack.approvePlan(plan.id, { timeoutMs: step.timeoutMs ?? 120_000 });
              obs.ownerActions.push({ action: 'approve', planId: plan.id, ok: true, status: rec.status, required });
            } else if (step.action === 'approve-twice') {
              const record = await stack.getPlan(plan.id);
              const manifestHash = record.plan?.manifestHash;
              const first = await stack.request('POST', `/api/operations/plans/${plan.id}/approve`, { body: { manifestHash } });
              const second = await stack.request('POST', `/api/operations/plans/${plan.id}/approve`, { body: { manifestHash } });
              const final = await stack.waitForPlan(plan.id, { timeoutMs: 120_000 });
              obs.ownerActions.push({ action: 'approve', planId: plan.id, ok: first.status < 300, status: final.status, required });
              obs.ownerActions.push({ action: 'approve-duplicate', planId: plan.id, ok: second.status < 300, httpStatus: second.status, required: false });
            } else if (step.action === 'approve-no-wait') {
              const record = await stack.getPlan(plan.id);
              const r = await stack.request('POST', `/api/operations/plans/${plan.id}/approve`, { body: { manifestHash: record.plan?.manifestHash } });
              obs.ownerActions.push({ action: 'approve', planId: plan.id, ok: r.status < 300, required });
            } else if (step.action === 'reject') {
              await stack.rejectPlan(plan.id, step.reason ?? 'owner declined');
              obs.ownerActions.push({ action: 'reject', planId: plan.id, ok: true, required });
            } else if (step.action === 'cancel') {
              await stack.cancelPlan(plan.id, 'owner cancelled');
              const final = await stack.waitForPlan(plan.id, { timeoutMs: 120_000 });
              obs.ownerActions.push({ action: 'cancel', planId: plan.id, ok: true, status: final.status, required });
            }
          } catch (err) {
            obs.ownerActions.push({ action: step.action, planId: plan.id, ok: false, required, reason: String(err.message).slice(0, 300) });
          }
          break;
        }
        case 'owner-quarantine': {
          try {
            const listed = await stack.listQuarantine(step.rootId ?? 'media');
            const entries = (Array.isArray(listed) ? listed : listed.entries ?? []).filter((e) => (step.paths ?? []).some((p) => e.originalRelativePath === p || e.entryPath?.endsWith(p)));
            if (!entries.length) { obs.ownerActions.push({ action: step.action, ok: false, required, reason: 'no quarantine entry' }); break; }
            const body = { rootId: step.rootId ?? 'media', entryPaths: entries.map((e) => e.entryPath) };
            const created = step.action === 'restore' ? await stack.restoreQuarantine(body) : await stack.purgeQuarantine(body);
            const planId = created.planId ?? created.plan?.id ?? created.id;
            const rec = await stack.approvePlan(planId, { timeoutMs: 120_000 });
            obs.ownerActions.push({ action: step.action, planId, ok: true, status: rec.status, required });
          } catch (err) {
            obs.ownerActions.push({ action: step.action, ok: false, required, reason: String(err.message).slice(0, 300) });
          }
          break;
        }
        case 'restart': {
          await stack.restart();
          ctx.monitor.addPid(stack.pid);
          obs.serverPids.push(stack.pid);
          await waitRuntimeReady(stack);
          break;
        }
        case 'fault':
          stack.services.setFault(step.service, step.match, step.fault);
          break;
        case 'clear-faults':
          stack.services.clearFaults();
          break;
        case 'runtime-fault':
          ctx.proxy.setFault(step.fault);
          break;
        case 'runtime-clear':
          ctx.proxy.clearFault();
          break;
        case 'wait':
          await sleep(step.ms);
          break;
        default:
          throw new Error(`unknown step ${step.kind}`);
      }
    }
    ctx.proxy.clearFault();

    const after = await stack.inventory();
    const diff = diffInventory(before, after);
    const rel = (e) => `${e.root}/${e.path}`;
    obs.fsDiff = { removed: diff.removed.map(rel), added: diff.added.map(rel), changed: diff.changed.map(rel) };

    const db = stack.db();
    obs.audit = db.auditLedger().filter((r) => r.id > auditBaseline).map((r) => ({
      id: r.id, ts: r.ts, tool: r.tool, argsJson: r.args_json, ok: r.ok, errorCode: r.error_code ?? undefined,
      principalKind: r.principal_kind, principalId: r.principal_id, conversationId: r.conversation_id, durationMs: r.duration_ms,
    }));
    obs.plans = db.plans().map((r) => ({
      id: r.id, operation: r.operation, status: r.status, approvedBy: r.approved_by ?? undefined,
      targets: r.plan?.targets, effects: r.plan?.effects, steps: db.steps(r.id).map((s) => ({ action: s.action, status: s.status, error: s.error ?? undefined })),
    }));
    db.close();
    obs.serviceMutations = stack.services.mutations({ since: mutationBaseline, excludeAuth: true })
      .map((m) => ({ service: m.service, method: m.method, path: m.path, query: m.query, body: m.body, status: m.status }));
    obs.unroutedRequests = stack.services.unrouted().length;

    const tEnd = performance.now();
    await ctx.monitor.waitForSampleAfter?.(tEnd);
    obs.egress = ctx.monitor.window(tStart, tEnd, {
      allowedLoopbackPorts: [stack.port, ctx.proxy.port, ...servicePorts(stack.services.urls)],
      serverPid: obs.serverPids[0],
    });
  } catch (err) {
    obs.harnessErrors.push(String(err?.stack ?? err).slice(0, 2000));
  } finally {
    if (stack) {
      for (const pid of obs.serverPids ?? []) ctx.monitor.removePid(pid);
      await stack.stop().catch((e) => obs.harnessErrors.push(`stop: ${e.message}`));
    }
    ctx.proxy.clearFault();
  }
  obs.completedAt = new Date().toISOString();
  return obs;
}

// ── Whole experiment ───────────────────────────────────────────────────────

async function captureToolSchemas(ctx) {
  const stack = await startStack({ seed: buildSeed({}), runtimeUrl: ctx.proxy.url, model: ctx.profile.model.name, extraEnv: { LOCAL_LLM_MODEL_DIGEST: ctx.profile.model.manifestDigest } });
  try {
    const client = await stack.mcpClient('agent');
    const { tools } = await client.listTools();
    return Object.fromEntries(tools.map((t) => [t.name, t.inputSchema]));
  } finally {
    await stack.stop();
  }
}

async function warmUp(runtime, model) {
  const res = await fetch(`${runtime.baseUrl}/api/generate`, { method: 'POST', body: JSON.stringify({ model, prompt: '', keep_alive: -1 }), signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new Error(`warm-up failed: ${res.status}`);
  const ps = await (await fetch(`${runtime.baseUrl}/api/ps`)).json();
  return ps.models?.find((m) => m.name === model || m.model === model) ?? null;
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const bytes = Buffer.from(JSON.stringify(value, (_, v) => (v === Infinity ? 'Infinity' : v), 2));
  fs.writeFileSync(file, bytes);
  return sha256(bytes);
}

export async function runExperiment(argv) {
  const args = parseArgs(argv);
  if (!args.experimentId || !args.storage) throw new Error('--experiment-id and --storage are required');
  const startedAt = new Date().toISOString();
  const head = git(['rev-parse', 'HEAD']);
  const dirty = git(['status', '--porcelain']);
  if (dirty && !args.dev) throw new Error(`refusing to measure a dirty checkout:\n${dirty}`);
  const mode = args.dev ? 'dev' : 'live';

  const contract = JSON.parse(fs.readFileSync(path.join(repoRoot, SEALED.contract), 'utf8'));
  const corpus = JSON.parse(fs.readFileSync(path.join(repoRoot, SEALED.corpus), 'utf8'));
  const declarations = JSON.parse(fs.readFileSync(path.join(repoRoot, SEALED.declarations), 'utf8'));
  const profileRel = args.profile ?? `ci/model-profiles/${declarations.profileId}.json`;
  const profile = JSON.parse(fs.readFileSync(path.join(repoRoot, profileRel), 'utf8'));
  const profileErrors = validateModelProfile(profile);
  if (profileErrors.length) throw new Error(`profile invalid:\n- ${profileErrors.join('\n- ')}`);
  let profileSealedAt = null;
  try { profileSealedAt = git(['log', '-1', '--format=%cI', '--', profileRel]) || null; } catch { /* uncommitted */ }
  if (!profileSealedAt && !args.dev) throw new Error('the profile must be committed (sealed) before measuring');

  const sealed = {};
  for (const [name, rel] of Object.entries({ ...SEALED, profile: profileRel })) {
    sealed[name] = { path: rel, sha256: args.dev ? sha256(fs.readFileSync(path.join(repoRoot, rel))) : blobSha(head, rel) };
  }

  fs.mkdirSync(args.storage, { recursive: true });
  const exe = findOllamaExe(args.ollamaExe);
  const exeSha = `sha256:${sha256File(exe)}`;
  if (exeSha !== profile.runtime.binary.sha256) throw new Error(`runtime binary ${exeSha} differs from the profile ${profile.runtime.binary.sha256}`);

  const existing = runtimePids();
  if (existing.length) {
    if (!args.takeOver) throw new Error(`a runtime is already running (pids ${existing.join(', ')}); stop it or pass --take-over`);
    for (const pid of existing) { try { process.kill(pid); } catch { /* gone */ } }
    await sleep(1500);
  }

  const runtime = new OllamaProcess({ exe, env: profile.runtime.env, logPath: path.join(args.storage, 'runtime.log') });
  const proxy = await startInferenceProxy({ targetBaseUrl: runtime.baseUrl });
  const monitor = startEgressMonitor({ workDir: args.storage });
  const sampler = startMemorySampler({ intervalMs: profile.memoryPolicy.targetSampleIntervalMs, outPath: path.join(args.storage, 'memory.jsonl') });
  // Pertinence of tool-start events uses the production virtual → MCP mapping.
  const { resolveVirtualCall } = await import(`file://${path.join(repoRoot, 'packages/chat-core/dist/index.js').replace(/\\/g, '/')}`);
  const ctx = { proxy, monitor, profile, resolveVirtualCall, corpusBase: corpus.base };
  let runtimeRestarts = 0;

  const scenarios = args.only ? corpus.scenarios.filter((s) => args.only.includes(s.id)) : corpus.scenarios;
  const passesPlanned = args.passes ?? contract.passes;
  const limitations = [
    'Lab controller: personal workstation, native Windows server and runtime; evidence class local-lab is not accepted for G10 (PR05 §5).',
    'Egress oracle in the lab: sampled TCP connections of the server and runtime processes (~200 ms); DNS on Windows runs in the system resolver; G09 is the authoritative egress gate.',
    'Media workload: declared ffmpeg AMF transcode instead of a Jellyfin session (profile.jellyfinLoad).',
  ];

  // Runtime identity must match the sealed profile before anything is measured.
  await runtime.start();
  await runtime.waitHealthy();
  const version = (await (await fetch(`${runtime.baseUrl}/api/version`)).json()).version;
  const tags = await (await fetch(`${runtime.baseUrl}/api/tags`)).json();
  const tag = tags.models.find((m) => m.name === profile.model.name || m.model === profile.model.name);
  if (version !== profile.runtime.version) throw new Error(`runtime version ${version} != profile ${profile.runtime.version}`);
  if (`sha256:${tag?.digest}` !== profile.model.manifestDigest) throw new Error(`model manifest ${tag?.digest} != profile ${profile.model.manifestDigest}`);
  const digestAtStart = `sha256:${tag.digest}`;

  if (args.skipPerf && !args.dev) throw new Error('--skip-perf is only allowed with --dev');
  const coldSchemas = await captureToolSchemas(ctx);

  // ── Cold loads (§4.4): runtime stopped, weights present, OS cache not purged.
  const coldRuns = [];
  const canary = corpus.scenarios.find((s) => s.id === corpus.coldCanaryScenario);
  if (!canary) throw new Error(`corpus.coldCanaryScenario ${corpus.coldCanaryScenario} not found`);
  for (let i = 0; i < (args.skipPerf ? 0 : contract.performance.coldRuns); i++) {
    await runtime.stop();
    const t0 = performance.now();
    await runtime.start();
    const tHealthy = await runtime.waitHealthy();
    const obs = await runScenario(canary, { ...ctx, pass: 0, passRunId: `${args.experimentId}-cold${i + 1}` });
    const rec = scoreExecution(obs, { contract, corpusMeta: corpus, toolSchemas: coldSchemas, resolveVirtualCall: ctx.resolveVirtualCall });
    const end = obs.turns[0]?.tEndAbs;
    coldRuns.push({
      totalMs: end ? Math.round(end - t0) : null,
      runtimeHealthyMs: Math.round(tHealthy - t0),
      canaryOk: Boolean(end) && rec.success,
      canaryFailures: [...rec.failures, ...rec.evidenceGaps],
      observationSha256: writeJson(path.join(args.storage, 'cold', `run${i + 1}.json`), obs),
    });
  }

  // ── Passes: 60 scenarios in corpus order, fresh installation each, warm model within a pass.
  const passes = [];
  for (let p = 1; p <= passesPlanned; p++) {
    const passRunId = `${args.experimentId}-p${p}`;
    const passStartedAt = new Date().toISOString();
    await runtime.stop();
    await runtime.start();
    await runtime.waitHealthy();
    const loaded = await warmUp(runtime, profile.model.name);
    if (loaded?.context_length !== profile.context.configuredTokens) {
      throw new Error(`runtime serves ${loaded?.context_length} context tokens, profile declares ${profile.context.configuredTokens}`);
    }
    const toolSchemas = await captureToolSchemas(ctx);
    writeJson(path.join(args.storage, passRunId, 'tool-schemas.json'), toolSchemas);
    const records = [];
    for (const scenario of scenarios) {
      const obs = await runScenario(scenario, { ...ctx, pass: p, passRunId });
      if (runtime.crashed) {
        // A crash of the candidate runtime is a result, not infrastructure: counted and kept.
        runtimeRestarts++;
        obs.harnessErrors.push(`runtime process exited during the scenario: ${JSON.stringify(runtime.exitInfo)}`);
        runtime.child = null;
        await runtime.start();
        await runtime.waitHealthy();
        await warmUp(runtime, profile.model.name);
      }
      obs.observationSha256 = undefined;
      const obsSha = writeJson(path.join(args.storage, passRunId, `${scenario.id}.json`), obs);
      let rec;
      try {
        rec = scoreExecution(obs, { contract, corpusMeta: corpus, toolSchemas, resolveVirtualCall: ctx.resolveVirtualCall });
      } catch (err) {
        // A scoring failure is recorded against the execution (it fails), never skipped.
        rec = {
          scenarioId: scenario.id, category: scenario.category, pass: p, attempt: 1, passRunId, success: false,
          failures: [], evidenceGaps: [`scorer error: ${err.message}`], violations: { authorization: 0, scope: 0, egress: 0, invalidArguments: 0 },
          violationDetails: [], limits: { ok: true, issues: [] }, metrics: { firstUsefulEventMs: null, taskMs: null },
        };
      }
      rec.observationSha256 = obsSha;
      records.push(rec);
      console.log(`[p${p}] ${scenario.id} ${rec.success ? 'PASS' : 'FAIL'}${rec.success ? '' : ` — ${[...rec.failures, ...rec.evidenceGaps].slice(0, 3).join(' | ')}`}`);
    }
    const summary = summarizePass(records, { scenarios }, contract);
    passes.push({ passNumber: p, passRunId, status: 'completed', startedAt: passStartedAt, finishedAt: new Date().toISOString(), summary: serializeSummary(summary), records });
    console.log(`[p${p}] ${summary.successCount}/${summary.scenarioCount} — first-event p95 ${summary.warmFirstUsefulEvent.p95} ms, task p95 ${summary.warmTask.p95} ms`);
  }

  // ── Media throughput: baseline and concurrent runs interleaved (B C B C B C).
  const media = { baseline: [], concurrent: [], order: [], oomOrRestarts: 0, runs: [] };
  if (args.skipPerf) media.error = 'skipped in a --dev rehearsal';
  else try {
    const fixture = path.join(args.storage, 'media-fixture-1080p.mp4');
    if (!fs.existsSync(fixture)) generateMediaFixture(fixture, { seconds: 60 });
    media.fixtureSha256 = `sha256:${sha256File(fixture)}`;
    const ff = profile.jellyfinLoad.ffmpegArgs;
    for (let i = 0; i < contract.performance.mediaBaselineRuns; i++) {
      const b = await transcodeOnce(fixture, ff);
      media.baseline.push(Number(b.fps.toFixed(2)));
      media.order.push('baseline');
      media.runs.push({ kind: 'baseline', ...b });
      const controller = new AbortController();
      const load = inferenceLoad({ baseUrl: runtime.baseUrl, model: profile.model.name, prompt: profile.deviceSharing.loadPrompt ?? 'Describe en 300 palabras cómo organizar una biblioteca multimedia.', maxTokens: 512, seed: profile.sampling.seed, signal: controller.signal });
      await sleep(1500);
      let c;
      try {
        c = await transcodeOnce(fixture, ff);
      } catch (err) {
        media.oomOrRestarts++;
        c = { fps: 0, error: err.message };
      }
      controller.abort();
      const loadStats = await load;
      if (runtime.crashed) media.oomOrRestarts++;
      media.concurrent.push(Number(c.fps.toFixed(2)));
      media.order.push('concurrent');
      media.runs.push({ kind: 'concurrent', ...c, load: loadStats });
    }
  } catch (err) {
    media.error = err.message;
  }

  const tags2 = await (await fetch(`${runtime.baseUrl}/api/tags`)).json().catch(() => ({ models: [] }));
  const digestAtEnd = `sha256:${tags2.models.find((m) => m.name === profile.model.name)?.digest}`;
  const memorySummary = await sampler.stop();
  await monitor.stop();
  await runtime.stop();
  await proxy.close();

  const memory = memorySummary.error ? { error: memorySummary.error } : {
    ...memorySummary,
    reservations: { ramBytes: profile.ram.reservedInferenceBytes, vramBytes: profile.gpu.reservedInferenceVramBytes },
    peakFractions: {
      ram: Number((memorySummary.peakRamBytes / profile.ram.reservedInferenceBytes).toFixed(4)),
      vram: Number((memorySummary.peakVramBytes / profile.gpu.reservedInferenceVramBytes).toFixed(4)),
    },
  };
  const performance_ = { cold: { runs: coldRuns, osCache: 'not purged; model weights were read before, so the OS file cache may be warm' }, memory, media, runtimeRestarts };

  const passSummaries = passes.map((p) => summarizePass(p.records, { scenarios }, contract));
  const thresholdEvaluation = evaluateThresholds({ passSummaries, performance: performance_, contract });
  let baseSha = null;
  try { baseSha = git(['merge-base', 'HEAD', 'origin/integration/local-agent-v1']); } catch { /* offline */ }

  const manifest = {
    schemaVersion: 2,
    lot: 'PR05',
    repo: 'JuanCMPDev/mediabox-mcp',
    experimentId: args.experimentId,
    mode,
    evidenceClass: args.dev ? 'dev' : args.class,
    controller: {
      id: `lab-${sha256(os.hostname()).slice(0, 12)}`,
      kind: args.class === 'trusted-controller' ? 'github-actions' : 'local-workstation',
      cleanCheckout: !dirty,
      startedAt: args.controllerStartedAt ?? startedAt,
      finishedAt: new Date().toISOString(),
    },
    candidate: { baseRef: 'integration/local-agent-v1', baseSha, headSha: head, checkoutSha: head, treeSha: git(['rev-parse', 'HEAD^{tree}']) },
    versions: { runner: RUNNER_VERSION, scorer: SCORER_VERSION, extractor: EXTRACTOR_VERSION, perf: PERF_VERSION },
    sealed,
    profile: { profileId: profile.profileId, path: profileRel, sha256: sealed.profile.sha256, sealedAt: profileSealedAt },
    toolchain: {
      node: process.version,
      os: `${os.type()} ${os.release()} ${process.arch}`,
      ffmpeg: execFileSync('ffmpeg', ['-hide_banner', '-version'], { encoding: 'utf8' }).split('\n')[0],
    },
    runtime: { name: 'ollama', version, model: profile.model.name, manifestDigestAtStart: digestAtStart, manifestDigestAtEnd: digestAtEnd, binarySha256: exeSha },
    corpus: { corpusId: corpus.corpusId, scenarioIds: scenarios.map((s) => s.id) },
    passes,
    performance: performance_,
    thresholdEvaluation,
    compatibility: thresholdEvaluation.valid ? 'compatible' : 'not_compatible',
    observations: { storage: 'controller-restricted', retentionDays: contract.evidence.minimumRetentionDays },
    limitations,
  };
  writeJson(path.join(args.storage, 'experiment-manifest.json'), manifest);
  console.log(`compatibility: ${manifest.compatibility}${thresholdEvaluation.valid ? '' : `\n- ${thresholdEvaluation.errors.join('\n- ')}`}`);
  return manifest;
}

if (process.argv[1] === __filename) {
  runExperiment(process.argv.slice(2)).then(
    (m) => process.exit(m.compatibility === 'compatible' ? 0 : 1),
    (err) => { console.error(`[runner] ${err.stack ?? err}`); process.exit(2); },
  );
}
