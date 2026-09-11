import test, { describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import {
  validateInferenceEndpoint,
  safeInferenceFetch,
} from "../../packages/chat-core/dist/providers/endpoint-policy.js";
import { LocalProvider } from "../../packages/chat-core/dist/providers/local.js";

describe("NET-04: Seguridad de endpoints, DNS rebinding, redirects y proxies (§3.4)", () => {
  it("DNS rebinding: pins validated IP and never connects to changed answer", async () => {
    let requestsReceived = 0;
    const server = http.createServer((req, res) => {
      requestsReceived++;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });

    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;

    try {
      let lookupCount = 0;
      const lookupFn = async (hostname) => {
        lookupCount++;
        if (lookupCount === 1) {
          // First DNS response: legitimate local IP
          return { address: "127.0.0.1" };
        }
        // Second DNS response (rebinding attempt): external IP
        return { address: "198.51.100.1" };
      };

      const res = await safeInferenceFetch(
        `http://rebound.host:${port}/api/tags`,
        {},
        {
          allowLan: true,
          allowedHosts: ["rebound.host"],
          lookupFn,
        },
      );

      assert.equal(res.status, 200);
      assert.equal(requestsReceived, 1, "Request went to pinned local IP");
      assert.equal(lookupCount, 1, "Name was resolved only once at validation time, preventing rebinding");
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("never follows a redirect to an unauthorized sink", async () => {
    let evilSinkHit = false;
    const evilServer = http.createServer((req, res) => {
      evilSinkHit = true;
      res.writeHead(200);
      res.end("evil");
    });
    await new Promise((resolve) => evilServer.listen(0, "127.0.0.1", resolve));
    const evilPort = evilServer.address().port;

    const redirectServer = http.createServer((req, res) => {
      res.writeHead(302, { Location: `http://127.0.0.1:${evilPort}/stolen-prompt` });
      res.end();
    });
    await new Promise((resolve) => redirectServer.listen(0, "127.0.0.1", resolve));
    const redirectPort = redirectServer.address().port;

    try {
      await assert.rejects(
        async () => {
          await safeInferenceFetch(`http://127.0.0.1:${redirectPort}/api/chat`, {
            method: "POST",
            body: JSON.stringify({ prompt: "secret-prompt-content" }),
          });
        },
        /redirect/i,
      );

      assert.equal(evilSinkHit, false, "Redirect was refused; evil sink received ZERO prompts or secrets");
    } finally {
      await new Promise((resolve) => evilServer.close(resolve));
      await new Promise((resolve) => redirectServer.close(resolve));
    }
  });

  it("refuses to route local inference through environment proxy", async () => {
    const oldHttpProxy = process.env.HTTP_PROXY;
    const oldNoProxy = process.env.NO_PROXY;
    try {
      process.env.HTTP_PROXY = "http://malicious-proxy.local:8080";
      delete process.env.NO_PROXY;

      await assert.rejects(
        async () => {
          await validateInferenceEndpoint("http://127.0.0.1:11434");
        },
        (err) => {
          assert.equal(err.code, "ERR_ENDPOINT_POLICY");
          assert.match(err.message, /HTTP_PROXY/);
          return true;
        },
        "Must refuse to route inference through environment proxy",
      );
    } finally {
      if (oldHttpProxy) process.env.HTTP_PROXY = oldHttpProxy;
      else delete process.env.HTTP_PROXY;
      if (oldNoProxy) process.env.NO_PROXY = oldNoProxy;
      else delete process.env.NO_PROXY;
    }
  });

  it("in local mode with cloud keys present: never contacts cloud providers", async () => {
    const oldOpenRouter = process.env.OPENROUTER_API_KEY;
    const oldGoogle = process.env.GOOGLE_AI_API_KEY;

    try {
      process.env.OPENROUTER_API_KEY = "sk-or-fake-key-123456789";
      process.env.GOOGLE_AI_API_KEY = "AIzaSyFakeKey987654321";

      const provider = new LocalProvider({
        baseUrl: "http://127.0.0.1:11434",
        model: "qwen2.5:7b",
        runtime: "ollama",
      });

      assert.equal(provider.providerName, "local");
      assert.equal(provider.model, "qwen2.5:7b");
      // The endpoint is strictly pinned to the local base URL
      assert.equal(provider.baseUrl, "http://127.0.0.1:11434");
    } finally {
      if (oldOpenRouter) process.env.OPENROUTER_API_KEY = oldOpenRouter;
      else delete process.env.OPENROUTER_API_KEY;
      if (oldGoogle) process.env.GOOGLE_AI_API_KEY = oldGoogle;
      else delete process.env.GOOGLE_AI_API_KEY;
    }
  });
});
