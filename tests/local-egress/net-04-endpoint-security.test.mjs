/**
 * NET-04 (PR05 §3.4): a DNS answer that changes, a redirect to an unauthorised
 * destination, an inherited proxy and a cloud endpoint with keys present must
 * deliver zero prompts or secrets to the unauthorised sink. The production
 * policy and transport run inside the real mcp-server image; the sink and the
 * resolver are separate containers, and each case proves its stimulus happened.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import {
  docker, requireDocker, uniqueName, tempDir, hostPath, readLedger, waitFor, buildServerImage, IMAGES, repoRoot,
  ensureImages, acquireSlot, topologySlots, removeTempDir,
} from './lab/docker-lab.mjs';

const LAB = path.join(repoRoot, 'tests/local-egress/lab');
const SUBNET = '172.31.252';
const SINK = `${SUBNET}.10`;
const RUNTIME = `${SUBNET}.20`;
const REDIRECTOR = `${SUBNET}.21`;
const NOTHING = `${SUBNET}.99`;

describe('NET-04: rebinding, redirects, proxies and cloud keys never reach the sink', { timeout: 1_800_000 }, () => {
  const id = uniqueName('mbxn4');
  const net = `${id}-net`;
  const ledgerDir = tempDir('net04');
  const containers = [];
  let image;

  const sinkLedger = () => readLedger(path.join(ledgerDir, 'ledger.jsonl'));
  const runtimeLedger = (name) => readLedger(path.join(ledgerDir, `${name}.jsonl`));

  let release;
  // A request that a Docker port proxy accepted may be pending with no ref'd handle; this keeps
  // the event loop alive so node:test waits for the real answer instead of cancelling the suite.
  let keepAlive;

  before(async () => {
    keepAlive = setInterval(() => {}, 1000);
    requireDocker();
    ensureImages();
    image = buildServerImage();
    // Counted among the concurrent labs so its fixed subnet never races the daemon's address pools.
    release = await acquireSlot('topology', topologySlots());
    docker(['network', 'create', '--subnet', `${SUBNET}.0/24`, net]);
    const run = (name, ip, envs, cmd, img = IMAGES.node) => {
      const args = ['run', '-d', '--name', `${id}-${name}`, '--network', net, '--ip', ip,
        '-v', `${hostPath(ledgerDir)}:/ledger`, '-v', `${hostPath(LAB)}:/lab:ro`];
      for (const [k, v] of Object.entries(envs)) args.push('-e', `${k}=${v}`);
      docker([...args, img, ...cmd]);
      containers.push(`${id}-${name}`);
    };
    run('sink', SINK, { SINK_IP: SINK, REBIND_ANSWERS: `${RUNTIME},${SINK}` }, ['node', '/lab/sink.mjs']);
    run('runtime', RUNTIME, { LEDGER: '/ledger/runtime.jsonl' }, ['node', '/lab/runtime-standin.mjs']);
    run('redirector', REDIRECTOR, { LEDGER: '/ledger/redirector.jsonl', REDIRECT_TO: `http://${SINK}/steal` }, ['node', '/lab/runtime-standin.mjs']);
  });

  after(() => {
    try {
      for (const c of containers) docker(['rm', '-f', c], { allowFail: true });
      docker(['network', 'rm', net], { allowFail: true });
      removeTempDir(ledgerDir);
    } finally {
      release?.();
      clearInterval(keepAlive);
    }
  });

  function client(kase, env, extraArgs = []) {
    const args = ['run', '--rm', '--network', net, '--dns', SINK, '-v', `${hostPath(LAB)}:/lab:ro`, ...extraArgs];
    for (const [k, v] of Object.entries({ LLM_PROVIDER: 'local', ...env })) args.push('-e', `${k}=${v}`);
    const out = docker([...args, image, 'node', '/lab/net04-client.mjs', kase], { allowFail: true, timeoutMs: 120_000 });
    const line = out.stdout.split('\n').reverse().find((l) => l.startsWith('{'));
    assert.ok(line, `client produced no result: ${out.stderr.slice(-500)}`);
    return JSON.parse(line);
  }

  const deliveriesOf = (token) => sinkLedger().filter((e) => (e.text ?? '').includes(token) || (e.qname ?? '').includes(token.toLowerCase()));

  it('sink and resolver are live (positive control)', async () => {
    await waitFor(() => sinkLedger().some((e) => e.event === 'ready'), { what: 'sink ready' });
    const probe = docker(['run', '--rm', '--network', net, IMAGES.busybox, 'sh', '-c', `wget -T 3 -q -O- http://${SINK}/control-n4 && nslookup -timeout=3 control-n4.exfil.test ${SINK}`], { allowFail: true });
    assert.equal(probe.code, 0, probe.stderr);
    assert.ok(deliveriesOf('control-n4').length >= 2, 'the sink must record the control delivery and query');
  });

  it('a changing DNS answer never moves inference traffic to the sink', () => {
    const token = uniqueName('rebind');
    const res = client('rebind', {
      LOCAL_LLM_BASE_URL: 'http://rebind.test:11434',
      INFERENCE_ALLOW_LAN: 'true',
      INFERENCE_ENDPOINT_HOSTS: 'rebind.test',
      PROMPT_CANARY: token,
      ATTEMPTS: '3',
    });
    const answers = sinkLedger().filter((e) => e.proto === 'dns' && e.qname === 'rebind.test');
    assert.ok(answers.length >= 2, `stimulus not applied: the resolver answered rebind.test ${answers.length} time(s)`);
    assert.equal(res.results[0].ok, true, `first request should reach the pinned runtime: ${JSON.stringify(res.results[0])}`);
    for (const r of res.results.slice(1)) {
      assert.equal(r.ok, false, 'a changed answer must be refused');
      assert.match(r.message, /rebinding/i);
    }
    assert.deepEqual(deliveriesOf(token), [], 'zero prompt bytes may reach the sink');
    assert.ok(runtimeLedger('runtime').some((e) => e.path?.startsWith('/v1/chat/completions')), 'the pinned runtime received the first request');
  });

  it('a redirect to an unauthorised host is refused before any byte reaches it', () => {
    const token = uniqueName('redir');
    const before = sinkLedger().filter((e) => e.port === 80 && (e.text ?? '').includes('/steal')).length;
    const res = client('redirect', {
      LOCAL_LLM_BASE_URL: `http://${REDIRECTOR}:11434`,
      INFERENCE_ALLOW_LAN: 'true',
      INFERENCE_ENDPOINT_HOSTS: REDIRECTOR,
      PROMPT_CANARY: token,
    });
    assert.ok(runtimeLedger('redirector').some((e) => e.path?.startsWith('/v1/chat/completions')), 'stimulus not applied: the redirector saw no request');
    assert.equal(res.results[0].ok, false);
    assert.match(res.results[0].message + res.results[0].code, /redirect|ERR_ENDPOINT_POLICY/i);
    assert.equal(sinkLedger().filter((e) => e.port === 80 && (e.text ?? '').includes('/steal')).length, before, 'the redirect target was contacted');
    assert.deepEqual(deliveriesOf(token), []);
  });

  it('an inherited proxy is refused and never contacted', () => {
    const token = uniqueName('proxy');
    const before = sinkLedger().filter((e) => e.port === 3128).length;
    const res = client('proxy', {
      LOCAL_LLM_BASE_URL: `http://${RUNTIME}:11434`,
      INFERENCE_ALLOW_LAN: 'true',
      INFERENCE_ENDPOINT_HOSTS: RUNTIME,
      HTTP_PROXY: `http://${SINK}:3128`,
      HTTPS_PROXY: `http://${SINK}:3128`,
      PROMPT_CANARY: token,
    });
    assert.equal(res.results[0].ok, false);
    assert.match(res.results[0].message, /proxy/i);
    assert.equal(sinkLedger().filter((e) => e.port === 3128).length, before, 'the proxy was contacted');
    assert.deepEqual(deliveriesOf(token), []);
  });

  it('with cloud keys present and the runtime down, nothing goes to cloud hosts (provider)', () => {
    const token = uniqueName('cloud');
    const before = sinkLedger().filter((e) => e.proto === 'tcp' && (e.port === 443 || e.port === 80)).length;
    const res = client('cloud', {
      LOCAL_LLM_BASE_URL: `http://${NOTHING}:11434`,
      INFERENCE_ALLOW_LAN: 'true',
      INFERENCE_ENDPOINT_HOSTS: NOTHING,
      OPENROUTER_API_KEY: `sk-or-v1-${token}`,
      GOOGLE_AI_API_KEY: `AIza${token}`,
      PROMPT_CANARY: token,
    }, ['--add-host', `openrouter.ai:${SINK}`, '--add-host', `generativelanguage.googleapis.com:${SINK}`, '--add-host', `api.openai.com:${SINK}`]);
    assert.equal(res.provider, 'local');
    assert.equal(res.results[0].ok, false);
    assert.equal(sinkLedger().filter((e) => e.proto === 'tcp' && (e.port === 443 || e.port === 80)).length, before, 'a cloud host was contacted');
    assert.deepEqual(deliveriesOf(token), []);
  });

  it('with cloud keys present and the runtime down, the real server answers without fallback', async () => {
    const token = uniqueName('srv');
    const name = `${id}-server`;
    const owner = `owner-${token}`;
    const args = ['run', '-d', '--name', name, '--network', net, '-p', '127.0.0.1::3000', '--dns', SINK,
      '--add-host', `openrouter.ai:${SINK}`, '--add-host', `generativelanguage.googleapis.com:${SINK}`];
    const env = {
      INTERNAL_API_KEY: owner, AGENT_API_KEY: `agent-${token}`, MEDIABOX_INSTALLATION_ID: 'net04',
      LLM_PROVIDER: 'local', LOCAL_LLM_BASE_URL: `http://${NOTHING}:11434`, INFERENCE_ALLOW_LAN: 'true',
      INFERENCE_ENDPOINT_HOSTS: NOTHING, OPENROUTER_API_KEY: `sk-or-v1-${token}`, GOOGLE_AI_API_KEY: `AIza${token}`,
    };
    for (const [k, v] of Object.entries(env)) args.push('-e', `${k}=${v}`);
    docker([...args, image]);
    containers.push(name);
    const port = Number(docker(['port', name, '3000']).stdout.split('\n')[0].split(':').pop());
    await waitFor(async () => (await fetch(`http://127.0.0.1:${port}/health`)).ok, { what: 'server health' });
    const before = sinkLedger().filter((e) => e.proto === 'tcp').length;
    const res = await fetch(`http://127.0.0.1:${port}/api/chat/stream`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${owner}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: `hola ${token}` }),
    });
    const lines = (await res.text()).split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const err = lines.find((e) => e.type === 'error');
    assert.ok(err, `expected an error event, got ${JSON.stringify(lines)}`);
    assert.equal(err.code, 'ERR_PROVIDER_UNAVAILABLE');
    assert.equal(lines.some((e) => e.type === 'done'), false, 'no answer may come from anywhere else');
    assert.equal(sinkLedger().filter((e) => e.proto === 'tcp').length, before, 'the server contacted a cloud host');
    const logs = docker(['logs', name], { allowFail: true });
    const text = `${logs.stdout}${logs.stderr}`;
    assert.equal(text.includes(`sk-or-v1-${token}`), false, 'the OpenRouter key was logged');
    assert.equal(text.includes(`AIza${token}`), false, 'the Google key was logged');
  });
});
