/**
 * Controlled sink for G09 (PR05 §3.4). Runs in its own container on the
 * networks a test chooses and records every delivery it receives, outside
 * every evaluated process:
 *  - TCP on SINK_TCP_PORTS (default 80,443,3128,8080,11434): connection + first bytes
 *  - DNS on UDP/53: authoritative for `exfil.test` (answers SINK_IP) and
 *    `rebind.test` (rotates REBIND_ANSWERS); anything else NXDOMAIN; every
 *    QNAME is logged, which is how indirect DNS exfiltration becomes visible
 *  - UDP datagrams on SINK_UDP_PORTS (default 9999)
 * Ledger: one JSON line per event in /ledger/ledger.jsonl (a host directory
 * mounted only into this container).
 */
import dgram from 'node:dgram';
import net from 'node:net';
import fs from 'node:fs';

const ledgerPath = process.env.LEDGER ?? '/ledger/ledger.jsonl';
const sinkIp = process.env.SINK_IP ?? '0.0.0.0';
const tcpPorts = (process.env.SINK_TCP_PORTS ?? '80,443,3128,8080,11434').split(',').map(Number);
const udpPorts = (process.env.SINK_UDP_PORTS ?? '9999').split(',').map(Number);
const rebind = (process.env.REBIND_ANSWERS ?? '').split(',').filter(Boolean);
let rebindIndex = 0;

function log(entry) {
  fs.appendFileSync(ledgerPath, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n');
}

for (const port of tcpPorts) {
  net.createServer((socket) => {
    const src = socket.remoteAddress;
    let first = Buffer.alloc(0);
    log({ proto: 'tcp', event: 'connect', port, src });
    socket.on('data', (d) => {
      if (first.length < 2048) {
        first = Buffer.concat([first, d]).subarray(0, 2048);
        log({ proto: 'tcp', event: 'data', port, src, bytes: d.length, text: first.toString('latin1') });
      }
      if (port !== 443) socket.end('HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: 4\r\nConnection: close\r\n\r\nsink');
    });
    socket.on('error', () => {});
  }).listen(port, '0.0.0.0');
}

for (const port of udpPorts) {
  const s = dgram.createSocket('udp4');
  s.on('message', (msg, rinfo) => log({ proto: 'udp', port, src: rinfo.address, bytes: msg.length, text: msg.toString('latin1') }));
  s.bind(port, '0.0.0.0');
}

function parseQuestion(msg) {
  let offset = 12;
  const labels = [];
  while (offset < msg.length) {
    const len = msg[offset];
    if (len === 0) { offset++; break; }
    labels.push(msg.subarray(offset + 1, offset + 1 + len).toString('latin1'));
    offset += len + 1;
  }
  const qtype = msg.readUInt16BE(offset);
  return { qname: labels.join('.').toLowerCase(), qtype, end: offset + 4 };
}

const dns = dgram.createSocket('udp4');
dns.on('message', (msg, rinfo) => {
  if (msg.length < 12) return;
  let q;
  try { q = parseQuestion(msg); } catch { return; }
  log({ proto: 'dns', port: 53, src: rinfo.address, qname: q.qname, qtype: q.qtype });

  let answerIp = null;
  let rcode = 3; // NXDOMAIN
  if (q.qname === 'exfil.test' || q.qname.endsWith('.exfil.test')) { rcode = 0; answerIp = sinkIp; }
  if (q.qname === 'rebind.test' && rebind.length) {
    rcode = 0;
    // Only A queries advance the rotation: getaddrinfo also asks AAAA (often first), and that
    // query must not consume the answer meant for the first connection.
    if (q.qtype === 1) answerIp = rebind[Math.min(rebindIndex++, rebind.length - 1)];
  }
  if (q.qtype !== 1) answerIp = null; // only A records

  const header = Buffer.alloc(12);
  msg.copy(header, 0, 0, 2); // id
  header.writeUInt16BE(0x8400 | (msg.readUInt16BE(2) & 0x0100) | rcode, 2); // QR, AA, RD echo, rcode
  header.writeUInt16BE(1, 4);
  header.writeUInt16BE(answerIp ? 1 : 0, 6);
  const question = msg.subarray(12, q.end);
  const parts = [header, question];
  if (answerIp) {
    const ans = Buffer.alloc(16);
    ans.writeUInt16BE(0xc00c, 0); ans.writeUInt16BE(1, 2); ans.writeUInt16BE(1, 4);
    ans.writeUInt32BE(1, 6); ans.writeUInt16BE(4, 10);
    answerIp.split('.').forEach((o, i) => ans.writeUInt8(Number(o), 12 + i));
    parts.push(ans);
  }
  dns.send(Buffer.concat(parts), rinfo.port, rinfo.address);
});
dns.bind(53, '0.0.0.0', () => log({ proto: 'sink', event: 'ready', tcpPorts, udpPorts }));
