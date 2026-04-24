/* ─── /api/chat — Native MCP Chat Interface (Phase 2.3) ─────────────────────
 *
 * Endpoints:
 *   POST   /api/chat/stream          — send a message, receive NDJSON stream
 *   GET    /api/chat/info            — active LLM provider + model
 *   GET    /api/chat/:id/history     — rehidrate conversation after page reload
 *   DELETE /api/chat/:id             — clear a conversation
 *
 * All routes are protected by authMiddleware (INTERNAL_API_KEY bearer).
 * ──────────────────────────────────────────────────────────────────────── */
import { Router, type Request, type Response } from "express";
import { randomUUID } from "crypto";
import { streamChat }       from "@mediabox/chat-core";
import type { ChatEvent }   from "@mediabox/contracts";
import { getLoopbackCaller }  from "../chat/loopback-client.js";
import { getChatProvider, chatProviderInfo } from "../chat/provider.js";
import { chatHistory }      from "../chat/store.js";

export const chatRouter = Router();

// ── POST /stream ──────────────────────────────────────────────────────────────

chatRouter.post("/stream", async (req: Request, res: Response): Promise<void> => {
  const { message, conversationId: cidIn } = (req.body ?? {}) as {
    message?: string;
    conversationId?: string;
  };

  if (!message?.trim()) {
    res.status(400).json({ error: "message is required" });
    return;
  }

  // Check LLM is configured before opening the stream
  let provider;
  try {
    provider = getChatProvider();
  } catch (err) {
    res.status(503).json({
      error: "No LLM provider configured. Set OPENROUTER_API_KEY or GOOGLE_AI_API_KEY.",
    });
    return;
  }

  // Headers for NDJSON streaming — tell any reverse proxy not to buffer
  res.setHeader("Content-Type", "application/x-ndjson");
  res.setHeader("Transfer-Encoding", "chunked");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  const conversationId = cidIn ?? randomUUID();
  let closed = false;
  req.on("close", () => { closed = true; });

  function emit(event: ChatEvent): void {
    if (!closed) res.write(JSON.stringify(event) + "\n");
  }

  try {
    const mcpCall = await getLoopbackCaller();

    for await (const evt of streamChat({
      message,
      conversationId,
      provider,
      mcpCall,
      historyStore: chatHistory,
    })) {
      if (closed) break;
      emit(evt);
      if (evt.type === "done" || evt.type === "error") break;
    }
  } catch (err) {
    emit({
      type: "error",
      message: err instanceof Error ? err.message : String(err),
    });
  } finally {
    res.end();
  }
});

// ── GET /info ─────────────────────────────────────────────────────────────────

chatRouter.get("/info", (_req: Request, res: Response): void => {
  const info = chatProviderInfo();
  if (!info) {
    res.status(503).json({
      error: "No LLM provider configured. Set OPENROUTER_API_KEY or GOOGLE_AI_API_KEY in .env.",
    });
    return;
  }
  res.json(info);
});

// ── GET /:id/history ──────────────────────────────────────────────────────────
// Returns the display-friendly history for conversation rehidration.
// Returns [] (not 404) if the conversation has expired or never existed.

chatRouter.get("/:id/history", (req: Request, res: Response): void => {
  const id = String(req.params.id);
  const entries = chatHistory.toDisplayEntries(id);
  res.json(entries);
});

// ── DELETE /:id ───────────────────────────────────────────────────────────────

chatRouter.delete("/:id", (req: Request, res: Response): void => {
  const id = String(req.params.id);
  chatHistory.delete(id);
  res.json({ ok: true });
});
