/**
 * Local trusted controller (PR05 §5, revised 2026-09-14): the provisioning
 * file is validated before anything is probed, every isolation check fails
 * closed, trusted runs exist only inside an Actions job, and the verifier asks
 * for exactly the checks the controller runs.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  ISOLATION_CHECKS, actionsRunContext, attestIsolation, checkIsolation, sidsIn, validateProvisioning,
} from '../../evals/local-agent/controller-isolation.mjs';
import { TRUSTED_CONTROLLER_POLICY } from '../../scripts/ci/verify-evidence.mjs';

const SID = 'S-1-5-21-1111111111-2222222222-3333333333-1005';
const MAINTAINER_SID = 'S-1-5-21-1111111111-2222222222-3333333333-1001';
const root = 'E:\\mediabox-g10';
const evalNode = `${root}\\toolchain\\node-eval\\node.exe`;

function provisioning(overrides = {}) {
  return {
    schemaVersion: 1,
    provisionedAt: '2026-09-15T00:00:00.000Z',
    account: { name: 'mediabox-g10', sid: SID },
    maintainer: { profile: 'C:\\Users\\maintainer' },
    root,
    storage: `${root}\\storage`,
    tmp: `${root}\\tmp`,
    npmCache: `${root}\\npm-cache`,
    toolchain: { node: `${root}\\toolchain\\node\\node.exe`, evalNode, ffmpegDir: `${root}\\toolchain\\ffmpeg` },
    runtime: { ollamaExe: `${root}\\ollama\\ollama.exe`, modelsDir: `${root}\\models` },
    firewall: {
      group: 'mediabox-g10',
      rules: [
        { name: 'mediabox-g10-account-private', direction: 'Outbound', scope: 'account', program: null },
        { name: 'mediabox-g10-out-node-eval', direction: 'Outbound', scope: 'program', program: evalNode },
      ],
    },
    deniedPaths: ['D:\\', 'E:\\', 'C:\\development', 'C:\\Users\\Public'],
    runner: { label: 'mediabox-g10', namePrefix: 'mediabox-g10-', dir: `${root}\\runner` },
    probes: { publicAddress: '1.1.1.1', publicPort: 443 },
    ...overrides,
  };
}

const RULES = [
  { name: 'mediabox-g10-account-private', enabled: 'True', direction: 'Outbound', action: 'Block', program: 'Any', localUser: `D:(A;;CC;;;${SID})` },
  { name: 'mediabox-g10-out-node-eval', enabled: 'True', direction: 'Outbound', action: 'Block', program: evalNode.toUpperCase(), localUser: 'Any' },
];

function probes(overrides = {}) {
  const states = { 'C:\\Users\\maintainer': 'denied', 'C:\\Users\\Public': 'missing' };
  return {
    systemDrive: 'C:',
    identity: () => ({ sid: SID, groupSids: ['S-1-1-0', 'S-1-5-32-545', 'S-1-5-11', 'S-1-16-8192'] }),
    pathState: (p) => states[p] ?? 'denied',
    driveRoots: () => ['C:\\', 'D:\\', 'E:\\'],
    openForWrite: () => 'denied',
    firewallProfiles: () => ['Domain', 'Private', 'Public'].map((name) => ({ name, enabled: 'True' })),
    firewallRules: () => RULES,
    defaultGateway: () => '192.168.1.1',
    tcpConnect: async () => 'EACCES',
    evalNodeProbe: async () => ({ loopback: 'connected', public: 'EACCES', lan: 'EACCES' }),
    pipeConnect: async () => 'ENOENT',
    ...overrides,
  };
}

const failed = (result) => result.checks.filter((c) => !c.ok).map((c) => c.id);
const run = (probeOverrides, provOverrides) => checkIsolation(provisioning(provOverrides), { probes: probes(probeOverrides) });

test('a provisioned machine passes every isolation check, in the declared order', async () => {
  const result = await run();
  assert.deepEqual(failed(result), []);
  assert.deepEqual(result.checks.map((c) => c.id), [...ISOLATION_CHECKS]);
  assert.equal(result.ok, true);
});

test('the verifier requires exactly the checks the controller runs', () => {
  assert.deepEqual([...TRUSTED_CONTROLLER_POLICY.isolationChecks], [...ISOLATION_CHECKS]);
});

test("the maintainer's own session never passes as the controller", async () => {
  const result = await run({
    identity: () => ({ sid: MAINTAINER_SID, groupSids: ['S-1-5-32-544', 'S-1-16-8192'] }),
    pathState: () => 'readable',
    openForWrite: () => 'writable',
  });
  for (const id of ['account', 'not-administrator', 'provisioning-read-only', 'maintainer-profile', 'denied-paths', 'drives']) {
    assert.ok(failed(result).includes(id), id);
  }
  assert.equal(result.ok, false);
});

test('a high-integrity token fails even without the Administrators group', async () => {
  const result = await run({ identity: () => ({ sid: SID, groupSids: ['S-1-5-32-545', 'S-1-16-12288'] }) });
  assert.deepEqual(failed(result), ['not-administrator']);
});

test('removable media or any drive the account can list refuses the run', async () => {
  const result = await run({
    driveRoots: () => ['C:\\', 'D:\\', 'E:\\', 'F:\\'],
    pathState: (p) => (p === 'F:\\' ? 'readable' : p === 'C:\\Users\\Public' ? 'missing' : 'denied'),
  });
  assert.deepEqual(failed(result), ['drives']);
  assert.match(result.checks.find((c) => c.id === 'drives').detail, /F:\\/);
});

test('a denied path the account can read, or cannot be probed, fails', async () => {
  assert.deepEqual(failed(await run({ pathState: (p) => (p === 'C:\\development' ? 'readable' : 'denied') })), ['denied-paths']);
  assert.deepEqual(failed(await run({ pathState: (p) => (p === 'D:\\' ? 'error:EBUSY' : 'denied') })), ['denied-paths', 'drives']);
});

test('firewall problems fail closed', async () => {
  assert.deepEqual(failed(await run({ firewallProfiles: () => [{ name: 'Public', enabled: 'False' }] })), ['firewall-profiles']);
  assert.deepEqual(failed(await run({ firewallProfiles: () => { throw new Error('denied'); } })), ['firewall-profiles']);
  for (const rules of [
    [RULES[0]],
    [RULES[0], { ...RULES[1], enabled: 'False' }],
    [RULES[0], { ...RULES[1], action: 'Allow' }],
    [RULES[0], { ...RULES[1], program: 'C:\\other\\node.exe' }],
    [{ ...RULES[0], localUser: 'Any' }, RULES[1]],
  ]) {
    assert.deepEqual(failed(await run({ firewallRules: () => rules })), ['firewall-rules'], JSON.stringify(rules));
  }
  assert.deepEqual(failed(await run({ firewallRules: () => { throw new Error('denied'); } })), ['firewall-rules']);
});

test('network paths must be refused by the firewall, not merely left unanswered', async () => {
  for (const outcome of ['ECONNREFUSED', 'timeout', 'connected']) {
    assert.deepEqual(failed(await run({ tcpConnect: async () => outcome })), ['lan-blocked'], outcome);
  }
  const noGateway = await run({ defaultGateway: () => null, evalNodeProbe: async () => ({ loopback: 'connected', public: 'EACCES', lan: 'skipped' }) });
  assert.deepEqual(failed(noGateway), ['lan-blocked']);
  for (const probe of [
    { loopback: 'connected', public: 'connected', lan: 'EACCES' },
    { loopback: 'connected', public: 'timeout', lan: 'EACCES' },
    { loopback: 'connected', public: 'EACCES', lan: 'ECONNREFUSED' },
    { loopback: 'connected', public: 'EACCES', lan: 'skipped' },
    { loopback: 'EACCES', public: 'EACCES', lan: 'EACCES' },
  ]) {
    assert.deepEqual(failed(await run({ evalNodeProbe: async () => probe })), ['eval-loopback-only'], JSON.stringify(probe));
  }
});

test('a container engine socket that answers the account fails', async () => {
  assert.deepEqual(failed(await run({ pipeConnect: async (p) => (p.endsWith('docker_engine') ? 'connected' : 'ENOENT') })), ['host-sockets']);
});

test('an invalid provisioning file refuses before probing anything', async () => {
  const touched = [];
  const spy = new Proxy(probes(), { get: (target, key) => { touched.push(key); return target[key]; } });
  const result = await checkIsolation(provisioning({ deniedPaths: [] }), { probes: spy });
  assert.equal(result.ok, false);
  assert.deepEqual(result.checks.map((c) => c.id), ['provisioning']);
  assert.deepEqual(touched, []);

  const cases = [
    [{ account: { name: 'x', sid: 'S-1-5-32-544' } }, 'account.sid'],
    [{ storage: 'relative\\storage' }, 'storage must be an absolute Windows path'],
    [{ firewall: { group: 'mediabox-g10', rules: [RULES[1]].map((r) => ({ ...r, scope: 'program', program: evalNode })) } }, 'no outbound rule bound to the account'],
    [{ firewall: { group: 'mediabox-g10', rules: [{ name: 'a', direction: 'Outbound', scope: 'account', program: null }] } }, 'does not confine the evaluation node'],
    [{ probes: { publicAddress: 'example.com', publicPort: 443 } }, 'probes.publicAddress'],
  ];
  for (const [overrides, expected] of cases) {
    assert.ok(validateProvisioning(provisioning(overrides)).some((e) => e.includes(expected)), expected);
  }
});

test('SIDs are read from localized whoami output', () => {
  const groups = '"Todos","Grupo conocido","S-1-1-0","Grupo obligatorio, Habilitado de manera predeterminada, Grupo habilitado"\r\n'
    + '"BUILTIN\\Administradores","Alias","S-1-5-32-544","Grupo usado solo para denegar"\r\n'
    + '"Etiqueta obligatoria\\Nivel obligatorio medio","Etiqueta","S-1-16-8192",""\r\n';
  assert.deepEqual(sidsIn(groups), ['S-1-1-0', 'S-1-5-32-544', 'S-1-16-8192']);
  assert.deepEqual(sidsIn(`"nova01\\mediabox-g10","${SID}"`), [SID]);
});

test('trusted runs exist only inside a complete Actions job', () => {
  assert.throws(() => actionsRunContext({}), /only inside the G10 controller workflow/);
  const env = {
    GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'JuanCMPDev/mediabox-mcp', GITHUB_RUN_ID: '4242', GITHUB_RUN_ATTEMPT: '1',
    GITHUB_WORKFLOW_REF: 'JuanCMPDev/mediabox-mcp/.github/workflows/g10-controller.yml@refs/tags/g10/x', GITHUB_WORKFLOW_SHA: 'a'.repeat(40),
    GITHUB_SHA: 'a'.repeat(40), GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/tags/g10/x', RUNNER_NAME: 'mediabox-g10-1', RUNNER_ENVIRONMENT: 'self-hosted',
  };
  assert.deepEqual(actionsRunContext(env), {
    repository: 'JuanCMPDev/mediabox-mcp', runId: 4242, runAttempt: 1, workflowRef: env.GITHUB_WORKFLOW_REF, workflowSha: env.GITHUB_WORKFLOW_SHA,
    sha: env.GITHUB_SHA, event: 'push', ref: 'refs/tags/g10/x', runnerName: 'mediabox-g10-1', runnerEnvironment: 'self-hosted',
  });
  assert.throws(() => actionsRunContext({ ...env, GITHUB_ACTIONS: 'false' }));
  assert.throws(() => actionsRunContext({ ...env, GITHUB_RUN_ID: 'abc' }), /invalid run id/);
  assert.throws(() => actionsRunContext({ ...env, RUNNER_NAME: '' }), /RUNNER_NAME/);
});

test('the attestation keeps the results and leaves out the account SID', async () => {
  const result = await run();
  const attestation = attestIsolation(provisioning(), 'f'.repeat(64), result, new Date('2026-09-15T00:00:00Z'));
  assert.equal(attestation.ok, true);
  assert.equal(attestation.checks.length, ISOLATION_CHECKS.length);
  assert.equal(attestation.provisioningSha256, 'f'.repeat(64));
  assert.ok(!JSON.stringify(attestation).includes(SID));
  assert.match(attestation.accountSidSha256, /^[0-9a-f]{64}$/);
});
