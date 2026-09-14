/**
 * Synthetic sources for NET-03 (PR05 §3.4): a Torznab indexer (port 9117,
 * Jackett-style /api) and a download origin (port 80, /dl/<name>.torrent).
 * Runs in its own container on the network a test chooses and records every
 * request with the source address it observed, outside every evaluated process:
 * one JSON line per request in /ledger/origin.jsonl (a host directory mounted
 * only into this container).
 */
import http from 'node:http';
import fs from 'node:fs';

const ledgerPath = process.env.LEDGER ?? '/ledger/origin.jsonl';

function log(entry) {
  fs.appendFileSync(ledgerPath, `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`);
}

const src = (req) => String(req.socket.remoteAddress ?? '').replace(/^::ffff:/, '');
const dst = (req) => `${String(req.socket.localAddress ?? '').replace(/^::ffff:/, '')}:${req.socket.localPort}`;

function torznab(req, res) {
  const url = new URL(req.url, 'http://indexer.lab');
  log({ role: 'indexer', src: src(req), dst: dst(req), host: req.headers.host ?? null, method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams) });
  const t = url.searchParams.get('t');
  res.setHeader('content-type', 'application/rss+xml; charset=utf-8');
  if (t === 'caps') {
    res.end('<?xml version="1.0" encoding="UTF-8"?><caps><server title="g09-indexer"/><searching><search available="yes" supportedParams="q"/></searching></caps>');
    return;
  }
  const q = url.searchParams.get('q') ?? '';
  res.end(`<?xml version="1.0" encoding="UTF-8"?><rss version="2.0" xmlns:torznab="http://torznab.com/schemas/2015/feed"><channel><title>g09-indexer</title><item><title>${q.replace(/[<&>]/g, '')}</title><link>http://downloads.lab/dl/${encodeURIComponent(q)}.torrent</link><torznab:attr name="seeders" value="5"/></item></channel></rss>`);
}

function download(req, res) {
  const url = new URL(req.url, 'http://downloads.lab');
  log({ role: 'download', src: src(req), dst: dst(req), host: req.headers.host ?? null, method: req.method, path: url.pathname });
  if (!url.pathname.startsWith('/dl/')) {
    res.writeHead(404);
    res.end();
    return;
  }
  res.writeHead(200, { 'content-type': 'application/x-bittorrent' });
  res.end('d8:announce20:http://tracker.lab/4:infod4:name9:g09-synth6:lengthi1eee');
}

http.createServer(torznab).listen(9117, '0.0.0.0');
http.createServer(download).listen(80, '0.0.0.0', () => log({ role: 'origin', event: 'ready' }));
