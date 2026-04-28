import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import express, { Request, Response } from "express";
import cors from "cors";
import crypto from "crypto";
import { PORT, PUBLIC_URL } from "./config.js";
import { oauthProvider, authMiddleware } from "./auth.js";
import { createMcpServer } from "./tools/register.js";
import { dashboardRouter } from "./api/dashboard.js";
import { chatRouter }      from "./api/chat.js";
import { setupRouter }     from "./api/setup.js";
import { chatProviderInfo } from "./chat/provider.js";
import { initI18n, localeMiddleware } from "./helpers/i18n.js";
import { VERSION } from "./version.js";

// Initialise i18next so request handlers can call `req.t()` from the very
// first request — top-level await is fine in Node 22.
await initI18n();

const app = express();
app.set("trust proxy", 2);
app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(localeMiddleware);

app.use(mcpAuthRouter({ provider: oauthProvider, issuerUrl: new URL(PUBLIC_URL), scopesSupported: ["mcp:tools"] }));

const transports = new Map<string, StreamableHTTPServerTransport>();

app.all("/mcp", authMiddleware, async (req: Request, res: Response) => {
  const sid = req.headers["mcp-session-id"] as string | undefined;
  let transport: StreamableHTTPServerTransport;
  if (sid && transports.has(sid)) {
    transport = transports.get(sid)!;
  } else if (!sid && req.method === "POST" && isInitializeRequest(req.body)) {
    transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => crypto.randomUUID(), onsessioninitialized: (s) => { transports.set(s, transport); } });
    transport.onclose = () => { const s = transport.sessionId; if (s) transports.delete(s); };
    await createMcpServer().connect(transport);
  } else { res.status(400).json({ jsonrpc: "2.0", error: { code: -32000, message: "No valid session" }, id: null }); return; }
  await transport.handleRequest(req, res, req.body);
});

app.get("/health", (_req, res) => { res.json({ status: "ok", name: "mediabox-mcp", version: VERSION }); });

// Dashboard REST API — consumed by @mediabox/ui
app.use("/api/dashboard", authMiddleware, dashboardRouter);

// Chat API — LLM + MCP tool-calling via NDJSON stream
app.use("/api/chat", authMiddleware, chatRouter);

// Setup API — desktop wizard deploy, NDJSON event stream
app.use("/api/setup", authMiddleware, setupRouter);

if (!process.env.INTERNAL_API_KEY) {
  console.warn("WARNING: INTERNAL_API_KEY is not set — generating ephemeral key. The Telegram bot will lose auth on every restart. Set INTERNAL_API_KEY in your .env file.");
}

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Mediabox MCP v${VERSION} running on port ${PORT}`);
  console.log(`Public URL: ${PUBLIC_URL}`);
  console.log(`Transport: POST ${PUBLIC_URL}/mcp`);
  console.log(`OAuth: ${PUBLIC_URL}/.well-known/oauth-authorization-server`);

  const llm = chatProviderInfo();
  if (llm) {
    console.log(`Chat: ${PUBLIC_URL}/api/chat/stream (${llm.provider}/${llm.model})`);
  } else {
    console.log(`Chat: disabled — set OPENROUTER_API_KEY or GOOGLE_AI_API_KEY to enable`);
  }
});
