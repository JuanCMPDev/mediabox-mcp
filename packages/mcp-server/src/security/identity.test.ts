import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { Server } from "node:http";
import { createApp } from "../index.js";
import { INTERNAL_API_KEY, AGENT_API_KEY } from "../auth.js";
import { defaultSessionManager } from "./session.js";

describe("Gate G02 / Phase P02: Identity & Boundary Verification", () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    process.env.NODE_ENV = "test";
    const app = createApp();
    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", () => {
        const addr = server.address() as any;
        baseUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(() => {
    defaultSessionManager.resetForTesting();
  });

  // ── ID-01: Full Identity × Route × Action Matrix ──────────────────────────
  describe("ID-01: Full identity × route × action policy matrix", () => {
    it("owner has access to setup info, dashboard, sessions and raw env", async () => {
      const headers = {
        Authorization: `Bearer ${INTERNAL_API_KEY}`,
        "Content-Type": "application/json",
      };

      const infoRes = await fetch(`${baseUrl}/api/setup/info`, { headers });
      expect(infoRes.status).toBe(200);

      const statusRes = await fetch(`${baseUrl}/api/setup/status`, { headers });
      expect(statusRes.status).toBe(200);

      const healthRes = await fetch(`${baseUrl}/health`);
      expect(healthRes.status).toBe(200);

      // Session creation is allowed for owner
      const sessRes = await fetch(`${baseUrl}/api/auth/sessions`, {
        method: "POST",
        headers,
        body: JSON.stringify({ kind: "agent-session", ttlMs: 60000 }),
      });
      expect(sessRes.status).toBe(201);
      const sessData = await sessRes.json();
      expect(sessData.sessionId).toBeDefined();
      expect(sessData.token).toBeDefined();
    });

    it("agent is permitted for dashboard and chat, but strictly forbidden for administrative routes", async () => {
      const headers = {
        Authorization: `Bearer ${AGENT_API_KEY}`,
        "Content-Type": "application/json",
      };

      // Dashboard services permitted for read
      const dashRes = await fetch(`${baseUrl}/api/dashboard/services`, { headers });
      expect(dashRes.status).toBe(200);

      // Setup routes strictly forbidden for agent (403 ERR_FORBIDDEN_AGENT)
      const infoRes = await fetch(`${baseUrl}/api/setup/info`, { headers });
      expect(infoRes.status).toBe(403);
      expect(await infoRes.json()).toMatchObject({ code: "ERR_FORBIDDEN_AGENT" });

      const envRawRes = await fetch(`${baseUrl}/api/setup/env-raw`, { headers });
      expect(envRawRes.status).toBe(403);
      expect(await envRawRes.json()).toMatchObject({ code: "ERR_FORBIDDEN_AGENT" });

      const patchEnvRes = await fetch(`${baseUrl}/api/setup/env`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({ SOME_KEY: "value" }),
      });
      expect(patchEnvRes.status).toBe(403);
      expect(await patchEnvRes.json()).toMatchObject({ code: "ERR_FORBIDDEN_AGENT" });

      // Session management forbidden for agent
      const sessRes = await fetch(`${baseUrl}/api/auth/sessions`, {
        method: "POST",
        headers,
        body: JSON.stringify({ kind: "agent-session" }),
      });
      expect(sessRes.status).toBe(403);
      expect(await sessRes.json()).toMatchObject({ code: "ERR_FORBIDDEN_AGENT" });
    });

    it("anonymous requests are rejected across all protected endpoints", async () => {
      const endpoints = [
        "/api/dashboard/services",
        "/api/setup/info",
        "/api/setup/env-raw",
        "/api/auth/sessions",
        "/mcp",
      ];

      for (const endpoint of endpoints) {
        const res = await fetch(`${baseUrl}${endpoint}`);
        expect(res.status).toBe(401);
      }
    });
  });

  // ── ID-02: Session and Principal Context Isolation ────────────────────────
  describe("ID-02: Concurrency & Principal Context Isolation", () => {
    it("interleaving 20 concurrent requests never mixes owner and agent context", async () => {
      const ownerHeaders = { Authorization: `Bearer ${INTERNAL_API_KEY}` };
      const agentHeaders = { Authorization: `Bearer ${AGENT_API_KEY}` };

      const promises: Promise<void>[] = [];

      for (let i = 0; i < 20; i++) {
        const isOwnerTurn = i % 2 === 0;
        promises.push(
          (async () => {
            const res = await fetch(`${baseUrl}/api/setup/info`, {
              headers: isOwnerTurn ? ownerHeaders : agentHeaders,
            });

            if (isOwnerTurn) {
              expect(res.status).toBe(200);
            } else {
              expect(res.status).toBe(403);
              const data = await res.json();
              expect(data.code).toBe("ERR_FORBIDDEN_AGENT");
            }
          })()
        );
      }

      await Promise.all(promises);
    });

    it("mcp session bound to Principal A cannot be accessed or hijacked by Principal B", async () => {
      const ownerHeaders = {
        Authorization: `Bearer ${INTERNAL_API_KEY}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      };
      const agentHeaders = {
        Authorization: `Bearer ${AGENT_API_KEY}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      };

      // 1. Initialize MCP session as Owner
      const initPayload = {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "test-owner-client", version: "1.0.0" },
        },
      };

      const initRes = await fetch(`${baseUrl}/mcp`, {
        method: "POST",
        headers: ownerHeaders,
        body: JSON.stringify(initPayload),
      });
      expect(initRes.status).toBe(200);

      const mcpSessionId = initRes.headers.get("mcp-session-id");
      expect(mcpSessionId).toBeDefined();

      // 2. Caller with Agent credentials attempts to use Owner's mcp-session-id
      const hijackedRes = await fetch(`${baseUrl}/mcp`, {
        method: "POST",
        headers: {
          ...agentHeaders,
          "mcp-session-id": mcpSessionId!,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/list",
          params: {},
        }),
      });

      // Must be rejected with 403 session principal mismatch
      expect(hijackedRes.status).toBe(403);
      const errData = await hijackedRes.json();
      expect(errData.error.code).toBe(-32001);
      expect(errData.error.message).toContain("different principal identity");
    });
  });

  // ── ID-03: Agent Cannot Export Secrets or Claim Authority ─────────────────
  describe("ID-03: Agent boundary against secrets, approvals, and mutations", () => {
    it("agent cannot export raw environment or secrets", async () => {
      const res = await fetch(`${baseUrl}/api/setup/env-raw`, {
        headers: { Authorization: `Bearer ${AGENT_API_KEY}` },
      });
      expect(res.status).toBe(403);
      const data = await res.json();
      expect(data.code).toBe("ERR_FORBIDDEN_AGENT");
    });

    it("agent cannot issue owner credentials or alter session registry", async () => {
      const res = await fetch(`${baseUrl}/api/auth/sessions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${AGENT_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ kind: "owner-ui" }),
      });
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ code: "ERR_FORBIDDEN_AGENT" });
    });

    it("agent cannot trigger stack service restarts or stop commands", async () => {
      const res = await fetch(`${baseUrl}/api/setup/restart-services`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${AGENT_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ services: ["all"] }),
      });
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ code: "ERR_FORBIDDEN_AGENT" });
    });
  });

  // ── ID-04: Expiration and Revocation Invalidate MCP and REST ───────────────
  describe("ID-04: Revocation and Expiration of Delegated Sessions", () => {
    it("expired session token is rejected with 401 ERR_TOKEN_EXPIRED on REST", async () => {
      // Create session expiring in 15ms
      const session = defaultSessionManager.createSession({
        kind: "agent-session",
        ttlMs: 15,
      });

      // Wait 30ms for expiration
      await new Promise((r) => setTimeout(r, 30));

      const res = await fetch(`${baseUrl}/api/dashboard/services`, {
        headers: { Authorization: `Bearer ${session.token}` },
      });
      expect(res.status).toBe(401);
      const data = await res.json();
      expect(data.code).toBe("ERR_TOKEN_EXPIRED");
    });

    it("explicitly revoked session token is rejected with 401 ERR_TOKEN_REVOKED", async () => {
      const session = defaultSessionManager.createSession({
        kind: "agent-session",
        ttlMs: 60000,
      });

      // Valid before revocation
      const validRes = await fetch(`${baseUrl}/api/dashboard/services`, {
        headers: { Authorization: `Bearer ${session.token}` },
      });
      expect(validRes.status).toBe(200);

      // Owner revokes session
      const revokeRes = await fetch(`${baseUrl}/api/auth/sessions/${session.sessionId}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${INTERNAL_API_KEY}` },
      });
      expect(revokeRes.status).toBe(200);

      // Subsequent call rejected
      const revokedRes = await fetch(`${baseUrl}/api/dashboard/services`, {
        headers: { Authorization: `Bearer ${session.token}` },
      });
      expect(revokedRes.status).toBe(401);
      const data = await revokedRes.json();
      expect(data.code).toBe("ERR_TOKEN_REVOKED");
    });

    it("revoking a session invalidates an active live MCP transport immediately", async () => {
      // 1. Create delegated session
      const session = defaultSessionManager.createSession({
        kind: "agent-session",
        ttlMs: 60000,
      });

      const agentHeaders = {
        Authorization: `Bearer ${session.token}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      };

      // 2. Initialize MCP session with delegated token
      const initRes = await fetch(`${baseUrl}/mcp`, {
        method: "POST",
        headers: agentHeaders,
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2024-11-05",
            capabilities: {},
            clientInfo: { name: "test-delegated-agent", version: "1.0.0" },
          },
        }),
      });
      expect(initRes.status).toBe(200);
      const mcpSessionId = initRes.headers.get("mcp-session-id");
      expect(mcpSessionId).toBeDefined();

      // 3. Revoke the agent session
      defaultSessionManager.revokeSession(session.sessionId);

      // 4. Request using the existing mcp-session-id must be immediately rejected (401)
      const afterRevokeRes = await fetch(`${baseUrl}/mcp`, {
        method: "POST",
        headers: {
          ...agentHeaders,
          "mcp-session-id": mcpSessionId!,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/list",
          params: {},
        }),
      });

      expect(afterRevokeRes.status).toBe(401);
      const errData = await afterRevokeRes.json();
      expect(errData.code || errData.error?.code).toBeDefined();
    });
  });

  // ── ID-05: Localhost Visitors Cannot Claim Bootstrap Authority ────────────
  describe("ID-05: Localhost Visitors Cannot Claim Bootstrap Authority", () => {
    it("an unauthenticated localhost request cannot access setup, env, or admin", async () => {
      const localhostHeaders = {
        Origin: "http://localhost:3000",
        Host: "localhost:3000",
        "Content-Type": "application/json",
      };

      const endpoints = [
        { path: "/api/setup/info", method: "GET" },
        { path: "/api/setup/start", method: "POST", body: { config: {} } },
        { path: "/api/setup/env-raw", method: "GET" },
        { path: "/api/auth/sessions", method: "POST", body: {} },
        { path: "/mcp", method: "POST", body: {} },
      ];

      for (const ep of endpoints) {
        const res = await fetch(`${baseUrl}${ep.path}`, {
          method: ep.method,
          headers: localhostHeaders,
          body: ep.body ? JSON.stringify(ep.body) : undefined,
        });

        // Localhost origin does NOT grant bypass (INV-AUTH / ID-05)
        expect(res.status).toBe(401);
        const data = await res.json();
        expect(data.error).toBeDefined();
      }
    });

    it("providing an invalid bearer from localhost still 401s without privilege escalation", async () => {
      const res = await fetch(`${baseUrl}/api/setup/info`, {
        headers: {
          Origin: "http://localhost:3000",
          Authorization: "Bearer invalid-local-guess",
        },
      });
      expect(res.status).toBe(401);
    });
  });
});
