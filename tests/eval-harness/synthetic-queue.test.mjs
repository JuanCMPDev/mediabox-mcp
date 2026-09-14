/**
 * The synthetic qBittorrent honours WebUI paging (sort, reverse, offset, limit),
 * so download_queue reads the same pages in the lab as against a real client.
 * Without it, page 2 of the queue would repeat page 1 during G10.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startSyntheticServices } from '../../evals/local-agent/synthetic/services.mjs';

async function torrentNames(services, query) {
  const base = services.url('qbittorrent');
  const login = await fetch(`${base}/api/v2/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username: services.keys.QBIT_USER, password: services.keys.QBIT_PASSWORD }),
  });
  assert.equal(await login.text(), 'Ok.');
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const res = await fetch(`${base}/api/v2/torrents/info${query ? `?${query}` : ''}`, { headers: { cookie } });
  assert.equal(res.status, 200);
  return (await res.json()).map((t) => t.name);
}

test('synthetic qBittorrent pages torrents/info like the WebUI API', async () => {
  const torrents = Array.from({ length: 7 }, (_, i) => ({ name: `Torrent ${i}`, added_on: 1_700_000_000 + i }));
  const services = await startSyntheticServices({ qbittorrent: { torrents } });
  try {
    const all = torrents.map((t) => t.name);
    assert.deepEqual(await torrentNames(services, ''), all);
    // The exact request download_queue sends: one lookahead row beyond the page.
    assert.deepEqual(await torrentNames(services, 'filter=all&sort=added_on&reverse=false&offset=0&limit=6'), all.slice(0, 6));
    assert.deepEqual(await torrentNames(services, 'filter=all&sort=added_on&reverse=false&offset=5&limit=6'), all.slice(5));
    assert.deepEqual(await torrentNames(services, 'sort=added_on&reverse=true&limit=2'), ['Torrent 6', 'Torrent 5']);
    assert.deepEqual(await torrentNames(services, 'offset=-2'), ['Torrent 5', 'Torrent 6']);
    assert.deepEqual(await torrentNames(services, 'offset=9&limit=5'), []);
  } finally {
    await services.close();
  }
});
