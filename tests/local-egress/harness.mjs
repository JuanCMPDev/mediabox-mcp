import net from "node:net";
import dgram from "node:dgram";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

/**
 * Controlled sink to observe all egress attempts (§3.4 / NET-01).
 * Records every TCP and UDP packet delivered to it.
 */
export async function createControlledSink() {
  const ledger = [];

  // TCP Sink
  const tcpServer = net.createServer((socket) => {
    socket.on("data", (chunk) => {
      ledger.push({
        protocol: "tcp",
        remoteAddress: socket.remoteAddress,
        remotePort: socket.remotePort,
        data: chunk.toString("utf8"),
        timestamp: Date.now(),
      });
      socket.end();
    });
  });

  await new Promise((resolve) => tcpServer.listen(0, "127.0.0.1", resolve));
  const tcpPort = tcpServer.address().port;

  // UDP Sink
  const udpSocket = dgram.createSocket("udp4");
  udpSocket.on("message", (msg, rinfo) => {
    ledger.push({
      protocol: "udp",
      remoteAddress: rinfo.address,
      remotePort: rinfo.port,
      data: msg.toString("utf8"),
      timestamp: Date.now(),
    });
  });

  await new Promise((resolve) => udpSocket.bind(0, "127.0.0.1", resolve));
  const udpPort = udpSocket.address().port;

  return {
    tcpPort,
    udpPort,
    ledger,
    async close() {
      await new Promise((resolve) => tcpServer.close(resolve));
      await new Promise((resolve) => udpSocket.close(resolve));
    },
  };
}

/**
 * Simulates authoritative local resolver for internal names (§3.1, §3.4 / NET-01).
 * Strictly forbids recursion or forwarding of external or secret-exfiltrating QNAMEs.
 */
export function createLocalAuthoritativeResolver(internalMap = {}) {
  const allowed = {
    localhost: "127.0.0.1",
    "mediabox-inference": "127.0.0.1",
    jellyfin: "127.0.0.1",
    ...internalMap,
  };

  const queries = [];

  async function lookup(hostname) {
    const norm = hostname.toLowerCase();
    queries.push({ hostname: norm, timestamp: Date.now() });

    // Exfiltration pattern or external query: zero resolution, error returned
    if (!allowed[norm]) {
      const err = new Error(`ENOTFOUND: external resolution denied in isolated profile for ${hostname}`);
      err.code = "ENOTFOUND";
      throw err;
    }

    return { address: allowed[norm], family: 4 };
  }

  return { lookup, queries };
}

/**
 * Creates temporary directory with spaces and Unicode to verify root isolation (§3.4 / NET-06).
 */
export function createTemporaryIsolationRoot(prefix = "egress-test-ñ") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix} `));
  return {
    dir,
    cleanup() {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {}
    },
  };
}
