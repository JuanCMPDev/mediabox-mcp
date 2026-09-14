/**
 * NET-03 (PR05 §3.4): a synthetic Torznab indexer and a synthetic download
 * origin (lab/origin.mjs, outside every evaluated process) are reachable by the
 * components the profile authorises and never directly from the agent/MCP or
 * runtime namespaces. The evidence is the source address the origin OBSERVED
 * for each request, mapped back to the container that holds it; the compose
 * YAML is never inspected.
 *
 * online-media: the origin sits on the generated mediabox-external-net (aliases
 * indexer.lab / downloads.lab); prowlarr (indexer) and qbittorrent (download)
 * stand-in namespaces must reach it, mcp-server and the runtime must not, by
 * name or by address. offline-library: the origin sits on a lab-only bridge
 * no generated service joins; a lab namespace there proves it is alive and
 * nobody in the topology reaches it.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { uniqueName } from './lab/docker-lab.mjs';
import { startTopology, OFFLINE, ONLINE } from './lab/topology.mjs';

/** Every request the origin saw, with the container that owns its source address. */
function observedFlows(t, services) {
  const owners = new Map();
  for (const s of services) for (const ip of t.ips(s)) owners.set(ip, s);
  return t.originLog().filter((e) => e.role !== 'origin').map((e) => ({
    from: owners.get(e.src) ?? `unknown(${e.src})`,
    src: e.src,
    dst: e.dst,
    host: e.host,
    role: e.role,
    path: e.path,
    q: e.query?.q,
  }));
}

function attempts(originIp, token) {
  return [
    `wget -T 3 -q -O- "http://indexer.lab:9117/api?t=search&q=${token}-name" >/dev/null 2>&1 && echo "REACHED indexer-name" || echo "BLOCKED indexer-name"`,
    `wget -T 3 -q -O- "http://${originIp}:9117/api?t=search&q=${token}-ip" >/dev/null 2>&1 && echo "REACHED indexer-ip" || echo "BLOCKED indexer-ip"`,
    `wget -T 3 -q -O- "http://downloads.lab/dl/${token}-name.torrent" >/dev/null 2>&1 && echo "REACHED download-name" || echo "BLOCKED download-name"`,
    `wget -T 3 -q -O- "http://${originIp}/dl/${token}-ip.torrent" >/dev/null 2>&1 && echo "REACHED download-ip" || echo "BLOCKED download-ip"`,
  ].join('; ');
}

function assertUnreached(t, service, token, out, flows) {
  assert.equal(out.stdout.split('\n').filter((l) => l.startsWith('BLOCKED')).length, 4, `${service}: ${out.stdout} ${out.stderr}`);
  const ips = new Set(t.ips(service));
  const theirs = t.originLog().filter((e) => ips.has(e.src) || JSON.stringify(e).includes(token));
  assert.deepEqual(theirs, [], `${service} reached a source: ${JSON.stringify(theirs)} (all flows: ${JSON.stringify(flows)})`);
}

describe('NET-03 (local-agent-online-media): sources reachable only by authorised components', { timeout: 1_800_000 }, () => {
  let t;
  const everyone = ['prowlarr', 'qbittorrent', 'sonarr', 'radarr', 'jellyfin', 'pyload', 'flaresolverr', 'mcp-server', 'mediabox-inference', 'mediabox-edge'];

  before(async () => {
    t = await startTopology({ profile: ONLINE, label: 'n3onl', withOrigin: true });
  });

  after(async () => {
    await t?.down();
  });

  it('prowlarr reaches the indexer and qbittorrent the download origin; observed source and destination recorded', async (ctx) => {
    const originIp = t.ipOn('lab-origin', 'mediabox-external-net');
    const tokIdx = uniqueName('n3idx');
    const tokDl = uniqueName('n3dl');
    const idx = await t.sh('prowlarr', `wget -T 5 -q -O- "http://indexer.lab:9117/api?t=search&q=${tokIdx}"`);
    assert.equal(idx.code, 0, `prowlarr could not query the indexer: ${idx.stderr}`);
    assert.match(idx.stdout, new RegExp(tokIdx));
    const dl = await t.sh('qbittorrent', `wget -T 5 -q -O- "http://downloads.lab/dl/${tokDl}.torrent"`);
    assert.equal(dl.code, 0, `qbittorrent could not fetch from the origin: ${dl.stderr}`);

    const flows = observedFlows(t, everyone);
    ctx.diagnostic(`observed flows: ${JSON.stringify(flows)}`);
    const idxFlow = flows.find((f) => f.q === tokIdx);
    const dlFlow = flows.find((f) => f.path === `/dl/${tokDl}.torrent`);
    assert.equal(idxFlow?.from, 'prowlarr', `indexer request observed from ${idxFlow?.from}`);
    assert.equal(idxFlow.dst, `${originIp}:9117`);
    assert.equal(dlFlow?.from, 'qbittorrent', `download observed from ${dlFlow?.from}`);
    assert.equal(dlFlow.dst, `${originIp}:80`);
  });

  for (const service of ['mcp-server', 'mediabox-inference']) {
    it(`${service} namespace reaches neither source, by name or by address`, async (ctx) => {
      const originIp = t.ipOn('lab-origin', 'mediabox-external-net');
      const token = uniqueName('n3deny');
      const out = await t.sh(service, attempts(originIp, token));
      ctx.diagnostic(`${service}: ${out.stdout.replace(/\n/g, ' | ')}`);
      assertUnreached(t, service, token, out, observedFlows(t, everyone));
    });
  }
});

describe('NET-03 (offline-library): nobody in the topology reaches the sources', { timeout: 1_800_000 }, () => {
  let t;
  const topology = ['prowlarr', 'qbittorrent', 'sonarr', 'radarr', 'jellyfin', 'pyload', 'flaresolverr', 'mcp-server', 'mediabox-inference', 'mediabox-edge'];

  before(async () => {
    t = await startTopology({ profile: OFFLINE, label: 'n3off', withOrigin: true });
  });

  after(async () => {
    await t?.down();
  });

  it('positive control: a lab namespace on the outside network reaches both sources', async () => {
    const token = uniqueName('n3ctl');
    const out = await t.controlSh(`wget -T 5 -q -O- "http://indexer.lab:9117/api?t=search&q=${token}" && wget -T 5 -q -O- "http://downloads.lab/dl/${token}.torrent" >/dev/null && echo OK`);
    assert.match(out.stdout, /OK/, out.stderr);
    const seen = t.originLog().filter((e) => JSON.stringify(e).includes(token));
    assert.deepEqual(seen.map((e) => e.role).sort(), ['download', 'indexer']);
  });

  for (const service of ['prowlarr', 'qbittorrent', 'mcp-server', 'mediabox-inference']) {
    it(`${service} reaches neither source`, async (ctx) => {
      const originIp = t.ipOn('lab-origin', 'lab-outside');
      const token = uniqueName('n3off');
      const out = await t.sh(service, attempts(originIp, token));
      ctx.diagnostic(`${service}: ${out.stdout.replace(/\n/g, ' | ')}`);
      assertUnreached(t, service, token, out, observedFlows(t, topology));
    });
  }
});
