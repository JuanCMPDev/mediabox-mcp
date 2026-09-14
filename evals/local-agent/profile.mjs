#!/usr/bin/env node
/**
 * Model profile collection, validation and sealing (PR05 §4.1).
 *
 * Every field comes from the machine or the runtime at collection time
 * (hardware, OS, driver, runtime binary, model manifest and blobs, template,
 * effective context) or from an explicit declaration made BEFORE measuring
 * (memory reservations, sampling, media workload). No field may be empty; a
 * `not_applicable` value must carry a verifiable reason. Changing any field
 * after the experiment starts requires a new profile id.
 *
 *   node evals/local-agent/profile.mjs collect --id <profileId> --declarations <json> --out <path>
 *   node evals/local-agent/profile.mjs validate <path>
 */

import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PROFILE_SCHEMA_VERSION = 2;
const DIGEST = /^sha256:[a-f0-9]{64}$/;

export function sha256File(file) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(1 << 20);
  try {
    let n;
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) hash.update(buf.subarray(0, n));
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

function ps(command) {
  return execFileSync('powershell', ['-NoProfile', '-Command', command], { encoding: 'utf8' }).trim();
}

/** Parses Ollama's `msg="inference compute"` log lines (key=value pairs). */
export function parseInferenceCompute(logText) {
  const devices = [];
  for (const line of logText.split('\n')) {
    if (!line.includes('msg="inference compute"')) continue;
    const kv = {};
    for (const m of line.matchAll(/(\w+)=("([^"]*)"|\S+)/g)) kv[m[1]] = m[3] ?? m[2];
    devices.push(kv);
  }
  const toBytes = (s) => {
    const m = String(s ?? '').match(/([\d.]+)\s*(GiB|MiB|GB|MB)/);
    if (!m) return null;
    const mult = { GiB: 2 ** 30, MiB: 2 ** 20, GB: 1e9, MB: 1e6 }[m[2]];
    return Math.round(Number(m[1]) * mult);
  };
  return devices
    .map((d) => ({ ...d, totalBytes: toBytes(d.total), availableBytes: toBytes(d.available) }))
    .sort((a, b) => (b.totalBytes ?? 0) - (a.totalBytes ?? 0));
}

function ollamaModelsDir() {
  return process.env.OLLAMA_MODELS || path.join(os.homedir(), '.ollama', 'models');
}

function readModelManifest(model) {
  const [name, tag = 'latest'] = model.split(':');
  const file = path.join(ollamaModelsDir(), 'manifests', 'registry.ollama.ai', 'library', name, tag);
  const bytes = fs.readFileSync(file);
  return { file, manifestDigest: `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`, manifest: JSON.parse(bytes.toString('utf8')) };
}

export function hashDirectory(dir) {
  const lines = [];
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) lines.push(`${sha256File(full)}  ${path.relative(dir, full).replace(/\\/g, '/')}`);
    }
  };
  walk(dir);
  lines.sort();
  return { files: lines.length, sha256: `sha256:${crypto.createHash('sha256').update(lines.join('\n')).digest('hex')}` };
}

export function windowsHardware() {
  const cpu = JSON.parse(ps('Get-CimInstance Win32_Processor | Select-Object Name,NumberOfCores,NumberOfLogicalProcessors | ConvertTo-Json'));
  const physical = Number(ps('(Get-CimInstance Win32_PhysicalMemory | Measure-Object -Property Capacity -Sum).Sum'));
  const osInfo = JSON.parse(ps('Get-CimInstance Win32_OperatingSystem | Select-Object Caption,Version,BuildNumber | ConvertTo-Json'));
  const gpus = JSON.parse(ps('Get-CimInstance Win32_VideoController | Select-Object Name,DriverVersion,PNPDeviceID | ConvertTo-Json'));
  return { cpu, physical, osInfo, gpus: Array.isArray(gpus) ? gpus : [gpus] };
}

/**
 * Compares the machine and the runtime libraries with a sealed profile. A new
 * GPU driver, OS build, CPU, memory size or runtime library set is another
 * profile (PR05 §4.1), so a live run refuses to measure until one is collected.
 * `hardware` and `libraries` can be injected for tests.
 */
export function checkProfileDrift(profile, { exe, hardware, libraries } = {}) {
  const hw = hardware ?? windowsHardware();
  const cpu = Array.isArray(hw.cpu) ? hw.cpu[0] : hw.cpu;
  const checked = [];
  const mismatches = [];
  const same = (field, actual, expected) => {
    checked.push(field);
    if (String(actual ?? '').trim() !== String(expected ?? '').trim()) mismatches.push(`${field}: the machine has ${actual ?? 'nothing'}, the profile says ${expected}`);
  };
  same('cpu.model', cpu?.Name, profile.cpu?.model);
  same('cpu.cores', cpu?.NumberOfCores, profile.cpu?.cores);
  same('cpu.threads', cpu?.NumberOfLogicalProcessors, profile.cpu?.threads);
  same('ram.physicalBytes', hw.physical, profile.ram?.physicalBytes);
  same('os.name', hw.osInfo?.Caption, profile.os?.name);
  same('os.version', hw.osInfo?.Version, profile.os?.version);
  same('os.build', hw.osInfo?.BuildNumber, profile.os?.build);
  checked.push('gpu.pnpDeviceId');
  const gpu = (hw.gpus ?? []).find((g) => g?.PNPDeviceID === profile.gpu?.pnpDeviceId);
  if (!gpu) mismatches.push(`gpu.pnpDeviceId: ${profile.gpu?.pnpDeviceId} is not present`);
  else {
    same('gpu.name', gpu.Name, profile.gpu?.name);
    same('gpu.driverVersion', gpu.DriverVersion, profile.gpu?.driverVersion);
  }
  if (profile.runtime?.libraries?.sha256) {
    const lib = libraries ?? hashDirectory(path.join(path.dirname(exe), 'lib', 'ollama'));
    same('runtime.libraries.files', lib.files, profile.runtime.libraries.files);
    same('runtime.libraries.sha256', lib.sha256, profile.runtime.libraries.sha256);
  }
  return { ok: mismatches.length === 0, checked, mismatches };
}

/**
 * Collects a profile. `declarations` holds what must be decided before the
 * experiment: reservations, sampling, media workload, exe path, log path.
 */
export async function collectProfile({ id, model, baseUrl, declarations }) {
  if (process.platform !== 'win32') throw new Error('collectProfile currently reads Windows hardware counters; add the Linux reader before using it elsewhere');
  const hw = windowsHardware();
  const version = (await (await fetch(`${baseUrl}/api/version`)).json()).version;
  const tags = await (await fetch(`${baseUrl}/api/tags`)).json();
  const show = await (await fetch(`${baseUrl}/api/show`, { method: 'POST', body: JSON.stringify({ model }) })).json();
  const tagEntry = tags.models.find((m) => m.name === model || m.model === model);
  if (!tagEntry) throw new Error(`model ${model} is not provisioned in the runtime`);

  const { manifestDigest, manifest } = readModelManifest(model);
  if (manifestDigest !== `sha256:${tagEntry.digest}`) throw new Error(`manifest file digest ${manifestDigest} != runtime digest ${tagEntry.digest}`);
  const layer = (suffix) => manifest.layers.find((l) => l.mediaType === `application/vnd.ollama.image.${suffix}`);
  const weights = layer('model');
  const template = layer('template');
  const templateTextDigest = `sha256:${crypto.createHash('sha256').update(show.template ?? '').digest('hex')}`;
  if (template && template.digest !== templateTextDigest) throw new Error(`template layer ${template.digest} != served template ${templateTextDigest}`);
  // Newer models (qwen3.5) carry no template layer: the config blob names a
  // built-in renderer and tool-call parser instead. Both are part of the profile.
  const configPath = path.join(ollamaModelsDir(), 'blobs', manifest.config.digest.replace(':', '-'));
  if (`sha256:${sha256File(configPath)}` !== manifest.config.digest) throw new Error(`config blob hash differs from manifest ${manifest.config.digest}`);
  const modelConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  if (!template && !modelConfig.renderer) throw new Error(`model ${model} has neither a template layer nor a built-in renderer`);
  const weightsPath = path.join(ollamaModelsDir(), 'blobs', weights.digest.replace(':', '-'));
  const weightsActual = `sha256:${sha256File(weightsPath)}`;
  if (weightsActual !== weights.digest) throw new Error(`weights blob hash ${weightsActual} != manifest ${weights.digest}`);

  const exe = declarations.runtimeExe;
  const libDir = path.join(path.dirname(exe), 'lib', 'ollama');
  const log = fs.existsSync(declarations.runtimeLogPath) ? fs.readFileSync(declarations.runtimeLogPath, 'utf8') : '';
  const compute = parseInferenceCompute(log);
  const device = compute[0];
  if (!device) throw new Error('runtime log has no "inference compute" line; start the runtime with logging to declarations.runtimeLogPath');
  const gpu = hw.gpus.find((g) => device.description ? g.Name.replace(/\s+/g, ' ').includes(device.description.replace(/\s+/g, ' ').replace('(TM)', '')) : false)
    ?? hw.gpus.find((g) => /7800|RX|RTX|Arc/i.test(g.Name));

  const parameterCount = show.model_info?.['general.parameter_count'];
  const nativeContext = Object.entries(show.model_info ?? {}).find(([k]) => k.endsWith('.context_length'))?.[1];
  // The served window is read from the loaded model, never copied from the declaration.
  const ps = await (await fetch(`${baseUrl}/api/ps`)).json();
  const servedContext = ps.models?.find((m) => m.name === model || m.model === model)?.context_length;
  if (servedContext !== declarations.contextTokens) {
    throw new Error(`runtime serves ${servedContext ?? 'an unknown'} context window, the declaration says ${declarations.contextTokens}; load the model and fix OLLAMA_CONTEXT_LENGTH`);
  }

  const profile = {
    schemaVersion: PROFILE_SCHEMA_VERSION,
    profileId: id,
    collectedAt: new Date().toISOString(),
    cpu: { model: hw.cpu.Name.trim(), cores: hw.cpu.NumberOfCores, threads: hw.cpu.NumberOfLogicalProcessors },
    ram: {
      physicalBytes: hw.physical,
      usableBytes: os.totalmem(),
      reservedSystemBytes: declarations.reservedSystemRamBytes,
      reservedInferenceBytes: declarations.reservedInferenceRamBytes,
    },
    os: { name: hw.osInfo.Caption.trim(), version: hw.osInfo.Version, build: hw.osInfo.BuildNumber, platform: process.platform, arch: process.arch },
    gpu: {
      name: gpu?.Name?.trim() ?? device.description,
      driverVersion: gpu?.DriverVersion ?? 'unknown',
      pnpDeviceId: gpu?.PNPDeviceID ?? 'unknown',
      vramBytes: device.totalBytes,
      reservedInferenceVramBytes: declarations.reservedInferenceVramBytes,
      backend: { library: device.library, compute: device.compute, runtimeDriver: device.driver ?? 'not_reported', variant: device.variant || 'none' },
    },
    runtime: {
      name: 'ollama',
      version,
      binary: { path: exe.replace(os.homedir(), '~'), sha256: `sha256:${sha256File(exe)}` },
      libraries: fs.existsSync(libDir) ? hashDirectory(libDir) : { status: 'not_applicable', reason: `no ${libDir}` },
      env: declarations.runtimeEnv,
    },
    model: {
      name: model,
      manifestDigest,
      totalParameters: parameterCount,
      activeParameters: parameterCount,
      isMoe: false,
      family: tagEntry.details?.family,
      format: tagEntry.details?.format,
      quantization: tagEntry.details?.quantization_level,
      nativeContextTokens: nativeContext,
      layers: manifest.layers.map((l) => ({ mediaType: l.mediaType, digest: l.digest, size: l.size })),
      weights: { digest: weights.digest, sizeBytes: weights.size, verifiedAgainstBlob: true },
      tokenizer: { status: 'not_applicable', reason: `embedded in the GGUF weights blob ${weights.digest}; no separate tokenizer artifact exists` },
      template: template
        ? { digest: template.digest, verifiedAgainstServedTemplate: true }
        : {
            status: 'not_applicable',
            reason: `no template layer: Ollama renders this model with its built-in renderer '${modelConfig.renderer}', named by the config blob ${manifest.config.digest}`,
            renderer: modelConfig.renderer,
            configDigest: manifest.config.digest,
          },
      capabilities: show.capabilities,
      ...(declarations.sizeTargetDeviation ? { sizeTargetDeviation: declarations.sizeTargetDeviation } : {}),
    },
    parser: {
      effective: modelConfig.parser
        ? `runtime-side: Ollama's built-in '${modelConfig.parser}' parser returns OpenAI tool_calls`
        : 'runtime-side: Ollama renders the model template and returns OpenAI tool_calls',
      clientFallback: 'none: RUNTIME_QUIRKS.ollama.hermesXmlToolCalls = false in packages/chat-core/src/providers/local.ts',
    },
    sampling: declarations.sampling,
    context: { configuredTokens: declarations.contextTokens, runtimeTokens: servedContext, source: 'configured: LOCAL_LLM_CONTEXT_TOKENS + OLLAMA_CONTEXT_LENGTH; runtime: /api/ps context_length of the loaded model' },
    concurrency: { activeConversations: 1, loadedModels: 1, parallelInferences: 1 },
    jellyfinLoad: declarations.jellyfinLoad,
    deviceSharing: declarations.deviceSharing,
    memoryPolicy: declarations.memoryPolicy,
    privacy: declarations.privacy,
  };
  const errors = validateModelProfile(profile);
  if (errors.length) throw new Error(`collected profile is incomplete:\n- ${errors.join('\n- ')}`);
  return profile;
}

/** Mandatory fields must be present and non-empty; not_applicable needs a reason. */
export function validateModelProfile(profile) {
  const errors = [];
  const visit = (value, where) => {
    if (value === null || value === undefined || value === '') { errors.push(`${where} is empty`); return; }
    if (typeof value === 'number' && !Number.isFinite(value)) { errors.push(`${where} is not a finite number`); return; }
    if (Array.isArray(value)) { if (value.length === 0 && !where.endsWith('unsupported')) errors.push(`${where} is an empty list`); value.forEach((v, i) => visit(v, `${where}[${i}]`)); return; }
    if (typeof value === 'object') {
      if (value.status === 'not_applicable' && !value.reason) errors.push(`${where} is not_applicable without a reason`);
      for (const [k, v] of Object.entries(value)) visit(v, `${where}.${k}`);
    }
  };
  const required = ['schemaVersion', 'profileId', 'collectedAt', 'cpu', 'ram', 'os', 'gpu', 'runtime', 'model', 'parser', 'sampling', 'context', 'concurrency', 'jellyfinLoad', 'deviceSharing', 'memoryPolicy'];
  for (const key of required) if (!(key in (profile ?? {}))) errors.push(`${key} is missing`);
  visit(profile, 'profile');
  if (profile?.schemaVersion !== PROFILE_SCHEMA_VERSION) errors.push(`schemaVersion must be ${PROFILE_SCHEMA_VERSION}`);
  if (profile?.model?.manifestDigest && !DIGEST.test(profile.model.manifestDigest)) errors.push('model.manifestDigest is not sha256:<64 hex>');
  for (const [i, l] of (profile?.model?.layers ?? []).entries()) if (!DIGEST.test(l.digest)) errors.push(`model.layers[${i}].digest is not a sha256 digest`);
  if (profile?.runtime?.binary?.sha256 && !DIGEST.test(profile.runtime.binary.sha256)) errors.push('runtime.binary.sha256 is not a sha256 digest');
  // PR05 §4.1 sets ≤9B total parameters as the initial target. A model above it
  // must carry a written deviation, declared before measuring (profile-declarations.json).
  const deviation = profile?.model?.sizeTargetDeviation?.reason;
  if (profile?.model?.totalParameters > 9e9 && !(typeof deviation === 'string' && deviation.trim().length >= 40)) {
    errors.push('model exceeds the 9B total-parameter target of the first profile and declares no model.sizeTargetDeviation.reason');
  }
  const emptyHash = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
  if (JSON.stringify(profile ?? {}).includes(emptyHash)) errors.push('profile contains the SHA-256 of an empty input: a digest was not measured');
  return errors;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [cmd, ...rest] = process.argv.slice(2);
  const arg = (name) => { const i = rest.indexOf(`--${name}`); return i >= 0 ? rest[i + 1] : undefined; };
  if (cmd === 'validate') {
    const file = rest[0];
    const errors = validateModelProfile(JSON.parse(fs.readFileSync(file, 'utf8')));
    if (errors.length) { console.error(`Profile invalid:\n- ${errors.join('\n- ')}`); process.exit(1); }
    console.log(`Profile valid: ${file}`);
  } else if (cmd === 'collect') {
    // The runtime is started here with the declared environment so its own log
    // (written by Node, never re-wrapped by a shell) records the compute device.
    const { OllamaProcess } = await import('./perf.mjs');
    const declarations = JSON.parse(fs.readFileSync(arg('declarations') ?? path.join(path.dirname(fileURLToPath(import.meta.url)), 'profile-declarations.json'), 'utf8'));
    const exe = arg('ollama-exe') ?? execFileSync(process.platform === 'win32' ? 'where' : 'which', ['ollama'], { encoding: 'utf8' }).split(/\r?\n/)[0].trim();
    const logPath = path.join(os.tmpdir(), `mediabox-profile-runtime-${Date.now()}.log`);
    const runtime = new OllamaProcess({ exe, env: declarations.runtimeEnv, logPath });
    await runtime.start();
    try {
      await runtime.waitHealthy();
      await fetch(`${runtime.baseUrl}/api/generate`, { method: 'POST', body: JSON.stringify({ model: declarations.model, prompt: '', keep_alive: '1m' }) });
      const profile = await collectProfile({
        id: arg('id') ?? declarations.profileId,
        model: declarations.model,
        baseUrl: runtime.baseUrl,
        declarations: { ...declarations, runtimeExe: exe, runtimeLogPath: logPath },
      });
      const out = arg('out') ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '../../ci/model-profiles', `${profile.profileId}.json`);
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, JSON.stringify(profile, null, 2) + '\n');
      console.log(`Profile written: ${out}`);
    } finally {
      await runtime.stop();
    }
  } else {
    console.error('usage: profile.mjs collect [--id <id>] [--declarations <json>] [--out <path>] [--ollama-exe <path>] | validate <path>');
    process.exit(2);
  }
}
