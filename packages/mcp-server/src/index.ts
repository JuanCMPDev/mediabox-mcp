import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import express, { Request, Response } from "express";
import cors from "cors";
import crypto from "node:crypto";
import { PORT, PUBLIC_URL, BIND_HOST, ALLOWED_ORIGINS } from "./config.js";
import { authMiddleware, requireOwner } from "./auth.js";
import { defaultSessionManager } from "./security/session.js";
import { createMcpServer } from "./tools/register.js";
import { dashboardRouter } from "./api/dashboard.js";
import { chatRouter }      from "./api/chat.js";
import { setupRouter }     from "./api/setup.js";
import { chatProviderInfo } from "./chat/provider.js";
import { initI18n, localeMiddleware } from "./helpers/i18n.js";
import { buildCorsOriginCallback, buildOriginMiddleware, type OriginPolicy } from "./helpers/origin.js";
import { VERSION } from "./version.js";

// Initialise i18next so request handlers can call `req.t()` from the very
// first request — top-level await is fine in Node 22.
await initI18n();

interface TransportSessionBinding {
  transport: StreamableHTTPServerTransport;
  principalId: string;
  sessionId: string;
  installationId: string;
}

export function createApp() {
  const app = express();
  app.set("trust proxy", 2);

  // Origin allowlist — load-bearing against DNS rebinding from a malicious
  // page. Browsers always send Origin reflecting the URL the user typed
  // (NOT the rebound IP), so a tightly-scoped list is safe and effective.
  // Non-browser callers (Telegram bot, external MCP clients) don't send
  // Origin and pass through unimpeded.
  const originPolicy: OriginPolicy = {
    allowed: ALLOWED_ORIGINS,
    allowLocalhost: true,
    allowTauri: true,
  };
  const requireSafeOrigin = buildOriginMiddleware(originPolicy);

  app.use(cors({ origin: buildCorsOriginCallback(originPolicy), credentials: true }));
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use(localeMiddleware);

  // Explicitly reject unauthenticated public OAuth issuer endpoints (SEC-01)
  app.use([
    "/.well-known/oauth-authorization-server",
    "/.well-known/openid-configuration",
    "/authorize",
    "/token",
    "/register",
  ], (_req: Request, res: Response) => {
    res.status(403).json({
      error: "Forbidden: Public OAuth issuer is disabled under P01 security hardening. Authenticate via explicit principal credentials.",
      code: "ERR_OAUTH_DISABLED",
    });
  });

  const transports = new Map<string, TransportSessionBinding>();

  // ID-04: Invalidate active MCP transports when a session is revoked
  defaultSessionManager.onSessionRevoked((revokedSessionId) => {
    for (const [sId, binding] of transports.entries()) {
      if (binding.sessionId === revokedSessionId) {
        transports.delete(sId);
        try {
          binding.transport.close?.();
        } catch {
          // Ignore close errors during forced session teardown
        }
      }
    }
  });

  app.all("/mcp", requireSafeOrigin, authMiddleware, async (req: Request, res: Response) => {
    const sid = req.headers["mcp-session-id"] as string | undefined;
    const caller = req.principal!;
    let transport: StreamableHTTPServerTransport;

    if (sid && transports.has(sid)) {
      const binding = transports.get(sid)!;

      // ID-02: Prevent session context contamination/hijacking across principals
      if (binding.principalId !== caller.id || binding.installationId !== caller.installationId) {
        res.status(403).json({
          jsonrpc: "2.0",
          error: {
            code: -32001,
            message: "Forbidden: MCP session is bound to a different principal identity",
          },
          id: null,
        });
        return;
      }

      // ID-04: Validate that caller session has not expired or been revoked
      if (caller.sessionId && caller.sessionId !== "owner-master-session" && caller.sessionId !== "agent-static-session") {
        if (!defaultSessionManager.isSessionActive(caller.sessionId)) {
          transports.delete(sid);
          try {
            binding.transport.close?.();
          } catch {
            // Ignore close errors
          }
          res.status(401).json({
            jsonrpc: "2.0",
            error: {
              code: -32002,
              message: "Unauthorized: MCP session credentials have been revoked or expired",
            },
            id: null,
          });
          return;
        }
      }

      transport = binding.transport;
    } else if (!sid && req.method === "POST" && isInitializeRequest(req.body)) {
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
        onsessioninitialized: (s) => {
          transports.set(s, {
            transport,
            principalId: caller.id,
            sessionId: caller.sessionId,
            installationId: caller.installationId,
          });
        },
      });
      transport.onclose = () => {
        const s = transport.sessionId;
        if (s) transports.delete(s);
      };
      await createMcpServer().connect(transport);
    } else {
      res.status(400).json({ jsonrpc: "2.0", error: { code: -32000, message: "No valid session" }, id: null });
      return;
    }
    await transport.handleRequest(req, res, req.body);
  });

  app.get("/health", (_req, res) => { res.json({ status: "ok", name: "mediabox-mcp", version: VERSION }); });

  // Session administration (ID-03 / ID-04) — only owner can issue/revoke delegated credentials
  app.get("/api/auth/sessions", requireSafeOrigin, authMiddleware, requireOwner, (_req: Request, res: Response) => {
    res.json(defaultSessionManager.listActiveSessions());
  });

  app.post("/api/auth/sessions", requireSafeOrigin, authMiddleware, requireOwner, (req: Request, res: Response) => {
    const { kind, capabilities, ttlMs, id, audience } = req.body ?? {};
    const session = defaultSessionManager.createSession({ kind, capabilities, ttlMs, id, audience });
    res.status(201).json(session);
  });

  app.delete("/api/auth/sessions/:id", requireSafeOrigin, authMiddleware, requireOwner, (req: Request, res: Response) => {
    const sessionId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const ok = defaultSessionManager.revokeSession(sessionId);
    if (!ok) {
      res.status(404).json({ error: "Session not found or already revoked", code: "ERR_SESSION_NOT_FOUND" });
      return;
    }
    res.json({ ok: true, revokedSessionId: sessionId });
  });

  app.post("/api/auth/sessions/revoke-all", requireSafeOrigin, authMiddleware, requireOwner, (_req: Request, res: Response) => {
    defaultSessionManager.revokeAllSessions();
    res.json({ ok: true, credentialVersion: defaultSessionManager.getCredentialVersion() });
  });

  // Dashboard REST API — consumed by @mediabox/ui
  app.use("/api/dashboard", requireSafeOrigin, authMiddleware, dashboardRouter);

  // Chat API — LLM + MCP tool-calling via NDJSON stream
  app.use("/api/chat", requireSafeOrigin, authMiddleware, chatRouter);

  // Setup API — desktop wizard deploy, NDJSON event stream (requires Owner identity - SEC-05 / ID-03 / ID-05)
  app.use("/api/setup", requireSafeOrigin, authMiddleware, requireOwner, setupRouter);

  return app;
}

export const app = createApp();

if (process.env.NODE_ENV !== "test") {
  if (!process.env.INTERNAL_API_KEY) {
    console.warn("WARNING: INTERNAL_API_KEY is not set — generating ephemeral key. The Telegram bot will lose auth on every restart. Set INTERNAL_API_KEY in your .env file.");
  }

  app.listen(PORT, BIND_HOST, () => {
    // The substring "running on port" is the readiness signal the Tauri
    // sidecar (sidecar.rs) and the UI poll (ui/src/lib/runtime-config.ts)
    // watch for to flip RuntimeConfig.ready = true. Don't change it without
    // updating both consumers.
    console.log(`Mediabox MCP v${VERSION} running on port ${PORT} (bind ${BIND_HOST})`);
    console.log(`Public URL: ${PUBLIC_URL}`);
    console.log(`Transport: POST ${PUBLIC_URL}/mcp`);
    console.log(`OAuth: Disabled under P01 hardening (explicit bearer authentication required)`);
    if (ALLOWED_ORIGINS.length > 0) {
      console.log(`Origin allowlist: ${ALLOWED_ORIGINS.join(", ")} (+ localhost, tauri webview)`);
    }

    const llm = chatProviderInfo();
    if (llm) {
      console.log(`Chat: ${PUBLIC_URL}/api/chat/stream (${llm.provider}/${llm.model})`);
    } else {
      console.log(`Chat: disabled — set OPENROUTER_API_KEY or GOOGLE_AI_API_KEY to enable`);
    }
  });
}
