#!/usr/bin/env node
/**
 * Isolation of the local trusted controller (PR05 §5, revised 2026-09-14).
 *
 * G10 accepts evidence only from the trusted controller. On this project that
 * controller is the maintainer's workstation, used through a dedicated
 * standard Windows account that an administrator provisions once with
 * scripts/controller/Install-G10Controller.ps1. The provisioning file, which
 * only administrators can modify, names the account, its toolchain, the
 * firewall rules and the locations the account must not read.
 *
 * Before a trusted run the controller checks, from inside that account, that
 * the live machine still matches the provisioning:
 *  - it runs as the provisioned account, with no Administrators group and a
 *    medium integrity token, and cannot modify the provisioning file;
 *  - it cannot read the maintainer's profile, the denied data locations or
 *    any drive root other than the system drive (removable media included);
 *  - every firewall profile is on, the provisioned rules exist and block,
 *    the account cannot reach the private gateway, and the evaluation node
 *    reaches loopback but neither a public nor a private address;
 *  - no container engine socket of the host answers.
 * One failed check refuses the run. The results travel in the manifest as
 * controller.isolation, without host paths.
 *
 * This file depends on Node alone, so the installer can copy it next to the
 * account's toolchain and run the same checks as that account:
 *
 *   node controller-isolation.mjs --self-test [--provisioning <file>] [--json]
 */

import { execFileSync, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PROVISIONING_SCHEMA_VERSION = 1;
export const DEFAULT_PROVISIONING = 'C:\\ProgramData\\mediabox-g10\\controller.json';
/** Every check a trusted run must pass; the verifier requires the same list. */
export const ISOLATION_CHECKS = Object.freeze([
  'account', 'not-administrator', 'provisioning-read-only', 'maintainer-profile', 'denied-paths', 'drives',
  'firewall-profiles', 'firewall-rules', 'lan-blocked', 'eval-loopback-only', 'host-sockets',
]);

const ADMINISTRATORS = 'S-1-5-32-544';
const MEDIUM_INTEGRITY = 'S-1-16-8192';
const HIGH_INTEGRITY = /^S-1-16-(12288|16384|20480|28672)$/;
const LOCAL_ACCOUNT_SID = /^S-1-5-21-\d+-\d+-\d+-\d+$/;
const WINDOWS_PATH = /^[A-Za-z]:\\/;
const HOST_PIPES = ['\\\\.\\pipe\\docker_engine', '\\\\.\\pipe\\dockerDesktopLinuxEngine'];

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const samePath = (a, b) => typeof a === 'string' && typeof b === 'string'
  && path.win32.normalize(a).toLowerCase() === path.win32.normalize(b).toLowerCase();

// ── Provisioning file ──────────────────────────────────────────────────────

export function validateProvisioning(p) {
  const errors = [];
  if (p?.schemaVersion !== PROVISIONING_SCHEMA_VERSION) errors.push(`schemaVersion must be ${PROVISIONING_SCHEMA_VERSION}`);
  if (!p?.account?.name) errors.push('account.name is missing');
  if (!LOCAL_ACCOUNT_SID.test(p?.account?.sid ?? '')) errors.push('account.sid is not a local account SID');
  const paths = {
    'maintainer.profile': p?.maintainer?.profile,
    root: p?.root,
    storage: p?.storage,
    tmp: p?.tmp,
    npmCache: p?.npmCache,
    'toolchain.node': p?.toolchain?.node,
    'toolchain.evalNode': p?.toolchain?.evalNode,
    'toolchain.ffmpegDir': p?.toolchain?.ffmpegDir,
    'runtime.ollamaExe': p?.runtime?.ollamaExe,
    'runtime.modelsDir': p?.runtime?.modelsDir,
    'runner.dir': p?.runner?.dir,
  };
  for (const [key, value] of Object.entries(paths)) {
    if (typeof value !== 'string' || !WINDOWS_PATH.test(value)) errors.push(`${key} must be an absolute Windows path`);
  }
  if (!/^[A-Za-z0-9-]+$/.test(p?.firewall?.group ?? '')) errors.push('firewall.group must be a plain name');
  const rules = p?.firewall?.rules;
  if (!Array.isArray(rules) || rules.length === 0) errors.push('firewall.rules is empty');
  else {
    if (rules.some((r) => !r?.name || !['Inbound', 'Outbound'].includes(r.direction))) errors.push('every firewall rule needs a name and a direction');
    if (!rules.some((r) => r.scope === 'account' && r.direction === 'Outbound')) errors.push('firewall.rules has no outbound rule bound to the account');
    if (!rules.some((r) => r.direction === 'Outbound' && samePath(r.program, p?.toolchain?.evalNode))) errors.push('firewall.rules does not confine the evaluation node');
  }
  if (!Array.isArray(p?.deniedPaths) || p.deniedPaths.length === 0) errors.push('deniedPaths is empty');
  else if (p.deniedPaths.some((d) => typeof d !== 'string' || !WINDOWS_PATH.test(d))) errors.push('deniedPaths must hold absolute Windows paths');
  if (!p?.runner?.label || !p?.runner?.namePrefix) errors.push('runner.label and runner.namePrefix are required');
  if (!net.isIP(p?.probes?.publicAddress ?? '') || !Number.isInteger(p?.probes?.publicPort)) errors.push('probes.publicAddress must be an IP and probes.publicPort an integer');
  return errors;
}

export function loadProvisioning(file = DEFAULT_PROVISIONING) {
  const bytes = fs.readFileSync(file);
  const provisioning = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, ''));
  const errors = validateProvisioning(provisioning);
  if (errors.length) throw new Error(`provisioning file ${file} is invalid:\n- ${errors.join('\n- ')}`);
  return { provisioning, sha256: sha256(bytes) };
}

// ── GitHub Actions run of the controller ───────────────────────────────────

/** Identity of the Actions job the controller runs in; throws outside Actions. */
export function actionsRunContext(env = process.env) {
  const need = ['GITHUB_ACTIONS', 'GITHUB_REPOSITORY', 'GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT', 'GITHUB_WORKFLOW_REF', 'GITHUB_WORKFLOW_SHA', 'GITHUB_SHA', 'GITHUB_EVENT_NAME', 'GITHUB_REF', 'RUNNER_NAME', 'RUNNER_ENVIRONMENT'];
  const missing = need.filter((k) => !env[k]);
  if (missing.length || env.GITHUB_ACTIONS !== 'true') {
    throw new Error(`trusted-controller evidence is produced only inside the G10 controller workflow (missing ${missing.join(', ') || 'GITHUB_ACTIONS=true'})`);
  }
  const runId = Number(env.GITHUB_RUN_ID);
  const runAttempt = Number(env.GITHUB_RUN_ATTEMPT);
  if (!Number.isSafeInteger(runId) || runId <= 0 || !Number.isSafeInteger(runAttempt) || runAttempt <= 0) {
    throw new Error(`invalid run id ${env.GITHUB_RUN_ID} or attempt ${env.GITHUB_RUN_ATTEMPT}`);
  }
  return {
    repository: env.GITHUB_REPOSITORY,
    runId,
    runAttempt,
    workflowRef: env.GITHUB_WORKFLOW_REF,
    workflowSha: env.GITHUB_WORKFLOW_SHA,
    sha: env.GITHUB_SHA,
    event: env.GITHUB_EVENT_NAME,
    ref: env.GITHUB_REF,
    runnerName: env.RUNNER_NAME,
    runnerEnvironment: env.RUNNER_ENVIRONMENT,
  };
}

// ── Probes of the live machine ─────────────────────────────────────────────

/** SIDs in `whoami` output; names are localized, SIDs are not. */
export function sidsIn(text) {
  return [...String(text).matchAll(/S-1-\d+(?:-\d+)+/g)].map((m) => m[0]);
}

export function pathState(p) {
  try {
    fs.readdirSync(p);
    return 'readable';
  } catch (err) {
    if (err.code === 'EPERM' || err.code === 'EACCES') return 'denied';
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return 'missing';
    return `error:${err.code}`;
  }
}

function connectOutcome(options, timeoutMs) {
  return new Promise((resolve) => {
    const socket = net.connect(options);
    const done = (value) => { socket.destroy(); resolve(value); };
    socket.setTimeout(timeoutMs, () => done('timeout'));
    socket.once('connect', () => done('connected'));
    socket.once('error', (err) => done(err.code || 'error'));
  });
}

// Runs inside the evaluation node: loopback must connect, public and private
// addresses must be refused by the firewall (EACCES, not a timeout).
const EVAL_NODE_PROBE = "const net=require('net');const p=(h,port)=>new Promise((r)=>{const s=net.connect({host:h,port:Number(port)});const d=(v)=>{s.destroy();r(v)};s.setTimeout(4000,()=>d('timeout'));s.once('connect',()=>d('connected'));s.once('error',(e)=>d(e.code||'error'))});(async()=>{const [lp,ph,pp,lh]=process.argv.slice(1);const o={loopback:await p('127.0.0.1',lp),public:await p(ph,pp),lan:lh?await p(lh,80):'skipped'};process.stdout.write(JSON.stringify(o))})();";

function powershellJson(command) {
  const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8', windowsHide: true }).trim();
  return out ? JSON.parse(out) : null;
}

export function windowsProbes() {
  return {
    systemDrive: process.env.SystemDrive || 'C:',
    identity() {
      const user = sidsIn(execFileSync('whoami', ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true }))[0];
      const groupSids = sidsIn(execFileSync('whoami', ['/groups', '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true }));
      return { sid: user, groupSids };
    },
    pathState,
    driveRoots() {
      const roots = [];
      for (let c = 65; c <= 90; c++) {
        const root = `${String.fromCharCode(c)}:\\`;
        try { fs.statSync(root); roots.push(root); } catch { /* no volume behind this letter */ }
      }
      return roots;
    },
    openForWrite(file) {
      try {
        fs.closeSync(fs.openSync(file, 'r+'));
        return 'writable';
      } catch (err) {
        return err.code === 'EPERM' || err.code === 'EACCES' ? 'denied' : `error:${err.code}`;
      }
    },
    firewallProfiles() {
      return powershellJson("ConvertTo-Json -Compress -InputObject @(Get-NetFirewallProfile | ForEach-Object { [pscustomobject]@{ name = [string]$_.Name; enabled = [string]$_.Enabled } })") ?? [];
    },
    firewallRules(group) {
      if (!/^[A-Za-z0-9-]+$/.test(group)) throw new Error('invalid firewall group');
      return powershellJson(`ConvertTo-Json -Compress -Depth 3 -InputObject @(Get-NetFirewallRule -Group '${group}' -ErrorAction SilentlyContinue | ForEach-Object { $app = $_ | Get-NetFirewallApplicationFilter; $sec = $_ | Get-NetFirewallSecurityFilter; [pscustomobject]@{ name = [string]$_.Name; enabled = [string]$_.Enabled; direction = [string]$_.Direction; action = [string]$_.Action; program = [string]$app.Program; localUser = [string]$sec.LocalUser } })`) ?? [];
    },
    defaultGateway() {
      const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', "Get-NetRoute -DestinationPrefix '0.0.0.0/0' -ErrorAction SilentlyContinue | Sort-Object RouteMetric | Select-Object -First 1 -ExpandProperty NextHop"], { encoding: 'utf8', windowsHide: true }).trim();
      return net.isIPv4(out) && out !== '0.0.0.0' ? out : null;
    },
    tcpConnect(host, port, timeoutMs = 4000) {
      return connectOutcome({ host, port }, timeoutMs);
    },
    pipeConnect(pipePath, timeoutMs = 2000) {
      return connectOutcome({ path: pipePath }, timeoutMs);
    },
    async evalNodeProbe(evalNode, { publicAddress, publicPort, lanAddress }) {
      const server = net.createServer((s) => s.end());
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      try {
        return await new Promise((resolve) => {
          const child = spawn(evalNode, ['-e', EVAL_NODE_PROBE, String(server.address().port), publicAddress, String(publicPort), lanAddress ?? ''], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
          let out = '';
          const timer = setTimeout(() => child.kill(), 20_000);
          child.stdout.on('data', (d) => { out += d; });
          child.on('error', (err) => { clearTimeout(timer); resolve({ loopback: `spawn:${err.code}`, public: 'unknown', lan: 'unknown' }); });
          child.on('close', () => {
            clearTimeout(timer);
            try { resolve(JSON.parse(out)); } catch { resolve({ loopback: 'no-output', public: 'unknown', lan: 'unknown' }); }
          });
        });
      } finally {
        server.close();
      }
    },
  };
}

// ── Checks ─────────────────────────────────────────────────────────────────

/**
 * Runs every isolation check against the live machine (or injected probes).
 * @returns {Promise<{ ok: boolean, checks: Array<{ id: string, ok: boolean, detail: string }> }>}
 */
export async function checkIsolation(prov, { probes = windowsProbes(), provisioningFile = DEFAULT_PROVISIONING } = {}) {
  const checks = [];
  const add = (id, ok, detail) => checks.push({ id, ok: Boolean(ok), detail });
  const provisioningErrors = validateProvisioning(prov);
  if (provisioningErrors.length) {
    add('provisioning', false, provisioningErrors.join('; '));
    return { ok: false, checks };
  }

  let identity = null;
  try { identity = probes.identity(); } catch { /* reported below */ }
  const isAccount = identity?.sid === prov.account.sid;
  add('account', isAccount, !identity ? 'cannot read the current identity' : isAccount ? `runs as the provisioned account ${prov.account.name}` : 'runs as another account, not the provisioned one');

  const groups = identity?.groupSids ?? [];
  const admin = groups.includes(ADMINISTRATORS);
  const high = groups.some((s) => HIGH_INTEGRITY.test(s));
  const medium = groups.includes(MEDIUM_INTEGRITY);
  add('not-administrator', Boolean(identity) && !admin && !high && medium,
    admin ? 'the token carries the Administrators group' : high ? 'the process runs with high integrity' : !medium ? 'no medium integrity label in the token' : 'standard user token with medium integrity');

  const writable = probes.openForWrite(provisioningFile);
  add('provisioning-read-only', writable === 'denied', writable === 'denied' ? 'the account cannot modify the provisioning file' : `the provisioning file is ${writable} for the account`);

  const profile = probes.pathState(prov.maintainer.profile);
  add('maintainer-profile', profile === 'denied', `maintainer profile is ${profile} for the account`);

  const open = prov.deniedPaths.map((p) => [p, probes.pathState(p)]).filter(([, s]) => s !== 'denied' && s !== 'missing');
  add('denied-paths', open.length === 0, open.length ? `not denied: ${open.map(([p, s]) => `${p} (${s})`).join(', ')}` : `${prov.deniedPaths.length} data locations denied`);

  const systemRoot = `${probes.systemDrive.replace(/\\+$/, '')}\\`.toUpperCase();
  const drives = probes.driveRoots().filter((r) => r.toUpperCase() !== systemRoot);
  const listable = drives.filter((r) => probes.pathState(r) !== 'denied');
  add('drives', listable.length === 0, listable.length ? `listable by the account: ${listable.join(', ')} (unplug removable media or deny the drive)` : `${drives.length} non-system drive roots denied`);

  let profiles = [];
  try { profiles = probes.firewallProfiles(); } catch { /* reported below */ }
  const off = profiles.filter((p) => p.enabled !== 'True');
  add('firewall-profiles', profiles.length > 0 && off.length === 0,
    profiles.length === 0 ? 'cannot read the firewall profiles' : off.length ? `disabled profiles: ${off.map((p) => p.name).join(', ')}` : 'every firewall profile is enabled');

  let rules = [];
  try { rules = probes.firewallRules(prov.firewall.group); } catch { /* every rule is then missing */ }
  const problems = [];
  for (const expected of prov.firewall.rules) {
    const rule = rules.find((r) => r.name === expected.name);
    if (!rule) { problems.push(`${expected.name} missing`); continue; }
    if (rule.enabled !== 'True') problems.push(`${expected.name} disabled`);
    if (rule.action !== 'Block') problems.push(`${expected.name} does not block`);
    if (rule.direction !== expected.direction) problems.push(`${expected.name} is ${rule.direction}`);
    if (expected.program && !samePath(rule.program, expected.program)) problems.push(`${expected.name} targets another program`);
    if (expected.scope === 'account' && !String(rule.localUser ?? '').includes(prov.account.sid)) problems.push(`${expected.name} is not bound to the account`);
  }
  add('firewall-rules', problems.length === 0, problems.length ? problems.join('; ') : `${prov.firewall.rules.length} rules present and blocking`);

  let gateway = null;
  try { gateway = probes.defaultGateway(); } catch { /* reported below */ }
  const lan = gateway ? await probes.tcpConnect(gateway, 80) : 'no-gateway';
  add('lan-blocked', lan === 'EACCES', !gateway ? 'no default gateway to probe' : lan === 'EACCES' ? 'the firewall refuses the private gateway to the account' : `the private gateway answered the account with ${lan}`);

  const evalNode = await probes.evalNodeProbe(prov.toolchain.evalNode, { publicAddress: prov.probes.publicAddress, publicPort: prov.probes.publicPort, lanAddress: gateway });
  add('eval-loopback-only', evalNode.loopback === 'connected' && evalNode.public === 'EACCES' && (evalNode.lan === 'EACCES' || (evalNode.lan === 'skipped' && !gateway)),
    `evaluation node: loopback ${evalNode.loopback}, public ${evalNode.public}, private ${evalNode.lan}`);

  const reachable = [];
  for (const pipePath of HOST_PIPES) {
    if (await probes.pipeConnect(pipePath) === 'connected') reachable.push(pipePath);
  }
  add('host-sockets', reachable.length === 0, reachable.length ? `reachable: ${reachable.join(', ')}` : 'no container engine socket answers the account');

  return { ok: checks.every((c) => c.ok), checks };
}

/** What the manifest records about the isolation (no host paths, no SID). */
export function attestIsolation(prov, provisioningSha256, result, now = new Date()) {
  return {
    schemaVersion: 1,
    ok: result.ok,
    provisioningSha256,
    provisionedAt: prov.provisionedAt ?? null,
    accountSidSha256: sha256(prov.account.sid),
    checks: result.checks.map(({ id, ok, detail }) => ({ id, ok, detail })),
    checkedAt: now.toISOString(),
  };
}

// ── Self-test for the installer ────────────────────────────────────────────

const invokedDirectly = process.argv[1]
  && path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();

if (invokedDirectly) {
  if (!process.argv.includes('--self-test')) {
    console.error('usage: controller-isolation.mjs --self-test [--provisioning <file>] [--json]');
    process.exit(2);
  }
  const i = process.argv.indexOf('--provisioning');
  const file = i >= 0 ? process.argv[i + 1] : (process.env.MEDIABOX_CONTROLLER_PROVISIONING || DEFAULT_PROVISIONING);
  try {
    const { provisioning } = loadProvisioning(file);
    const result = await checkIsolation(provisioning, { provisioningFile: file });
    if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
    else for (const c of result.checks) console.log(`${c.ok ? 'ok  ' : 'FAIL'} ${c.id}: ${c.detail}`);
    process.exit(result.ok ? 0 : 1);
  } catch (err) {
    console.error(err.message);
    process.exit(2);
  }
}
