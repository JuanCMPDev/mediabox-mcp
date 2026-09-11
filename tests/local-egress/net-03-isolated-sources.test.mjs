import test, { describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { validateInferenceEndpoint } from "../../packages/chat-core/dist/providers/endpoint-policy.js";
import { validateUrl, UrlPolicyError } from "../../packages/mcp-server/dist/helpers/url-allowlist.js";

describe("NET-03: Acceso a indexador y fuentes solo por componentes autorizados (§3.4)", () => {
  it("synthetic Torznab and download endpoints accessible by authorized services, inaccessible to agent/runtime", async () => {
    const accessLog = [];

    // 1. Synthetic Torznab server
    const torznabServer = http.createServer((req, res) => {
      const authHeader = req.headers["authorization"] || req.headers["x-api-key"];
      accessLog.push({
        service: "torznab",
        path: req.url,
        auth: authHeader,
        clientIp: req.socket.remoteAddress,
      });

      if (authHeader === "authorized-component-key") {
        res.writeHead(200, { "Content-Type": "application/xml" });
        res.end("<rss version='2.0'><channel><title>Synthetic Torznab</title></channel></rss>");
      } else {
        res.writeHead(403, { "Content-Type": "text/plain" });
        res.end("Forbidden: Direct agent access prohibited");
      }
    });

    await new Promise((resolve) => torznabServer.listen(0, "127.0.0.1", resolve));
    const torznabPort = torznabServer.address().port;

    // 2. Synthetic Download Source
    const downloadServer = http.createServer((req, res) => {
      const authHeader = req.headers["authorization"] || req.headers["x-api-key"];
      accessLog.push({
        service: "download-source",
        path: req.url,
        auth: authHeader,
        clientIp: req.socket.remoteAddress,
      });

      if (authHeader === "authorized-downloader-key") {
        res.writeHead(200, { "Content-Type": "application/octet-stream" });
        res.end("synthetic torrent content 12345");
      } else {
        res.writeHead(403, { "Content-Type": "text/plain" });
        res.end("Forbidden: Direct agent access prohibited");
      }
    });

    await new Promise((resolve) => downloadServer.listen(0, "127.0.0.1", resolve));
    const downloadPort = downloadServer.address().port;

    try {
      // 3. Authorized service accesses Torznab
      const authRes = await fetch(`http://127.0.0.1:${torznabPort}/api?t=search`, {
        headers: { "x-api-key": "authorized-component-key" },
      });
      assert.equal(authRes.status, 200);
      const xml = await authRes.text();
      assert.ok(xml.includes("Synthetic Torznab"));

      // 4. Authorized service accesses Download Source
      const dlRes = await fetch(`http://127.0.0.1:${downloadPort}/torrent/file.torrent`, {
        headers: { "x-api-key": "authorized-downloader-key" },
      });
      assert.equal(dlRes.status, 200);
      const data = await dlRes.text();
      assert.ok(data.includes("synthetic torrent content"));

      // 5. Agent attempt: Agent endpoint policy prevents agent from directing inference traffic to torznab
      await assert.rejects(
        async () => {
          // Agent policy strictly rejects treating torznab or download server as inference backend
          await validateInferenceEndpoint(`http://torznab.external.service:${torznabPort}/v1/models`, {
            allowLan: false,
          });
        },
        (err) => {
          assert.equal(err.code, "ERR_ENDPOINT_POLICY");
          return true;
        },
        "Agent endpoint policy must reject connecting to external service hosts",
      );

      // 6. Direct agent download URL validation blocks private/local IP literal downloads from untrusted user prompt
      assert.throws(
        () => {
          validateUrl(`http://127.0.0.1:${downloadPort}/torrent/file.torrent`);
        },
        UrlPolicyError,
        "Download URL policy must reject local/loopback IP literal injection",
      );

      // 7. Verify observed ledger: exactly 2 authorized requests, zero unauthorized agent accesses
      assert.equal(accessLog.length, 2);
      assert.equal(accessLog[0].auth, "authorized-component-key");
      assert.equal(accessLog[1].auth, "authorized-downloader-key");
    } finally {
      await new Promise((resolve) => torznabServer.close(resolve));
      await new Promise((resolve) => downloadServer.close(resolve));
    }
  });
});
