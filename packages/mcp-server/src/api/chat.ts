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
import type { ChatEvent, ChatStreamRequest } from "@mediabox/contracts";
import { getLoopbackCaller }  from "../chat/loopback-client.js";
import { getChatProvider, chatProviderInfo } from "../chat/provider.js";
import { chatHistory }      from "../chat/store.js";
import { isValidTypedSelection, formatTypedSelection } from "../chat/selection.js";

import { defaultWorkflowStore } from "../operations/default-store.js";

export const chatRouter = Router();

const inFlightTurns = new Set<string>();
const conversationTraces = new Map<string, import("@mediabox/chat-core").AgentTrace>();

// ── POST /stream ──────────────────────────────────────────────────────────────

chatRouter.post("/stream", async (req: Request, res: Response): Promise<void> => {
  const { message: rawMessage, conversationId: cidIn, selection } = (req.body ?? {}) as Partial<ChatStreamRequest>;

  if (selection !== undefined && !isValidTypedSelection(selection)) {
    res.status(400).json({ error: "selection is malformed", code: "ERR_INVALID_SELECTION" });
    return;
  }

  // A card click becomes a deterministic typed turn (CAT-04); free text stays as typed.
  const message = selection ? formatTypedSelection(selection, rawMessage) : rawMessage;

  if (!message?.trim() && !selection) {
    res.status(400).json({ error: "message is required" });
    return;
  }

  const conversationId = cidIn ?? randomUUID();

  // In-flight concurrency lock (§2.9 / AGT-09)
  if (inFlightTurns.has(conversationId)) {
    res.status(409).json({
      error: "A turn is already in flight for this conversation",
      code: "ERR_TURN_IN_FLIGHT",
    });
    return;
  }
  inFlightTurns.add(conversationId);

  // Check LLM is configured before opening the stream
  let provider;
  try {
    provider = getChatProvider();
  } catch (err) {
    inFlightTurns.delete(conversationId);
    res.status(503).json({
      error: "No LLM provider configured. Set OPENROUTER_API_KEY, GOOGLE_AI_API_KEY, or LLM_PROVIDER=local.",
    });
    return;
  }

  // Headers for NDJSON streaming — tell any reverse proxy not to buffer
  res.setHeader("Content-Type", "application/x-ndjson");
  res.setHeader("Transfer-Encoding", "chunked");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  const controller = new AbortController();
  let closed = false;
  res.on("close", () => {
    closed = true;
    controller.abort();
  });

  function emit(event: ChatEvent): void {
    if (!closed) res.write(JSON.stringify(event) + "\n");
  }

  try {
    const mcpCall = await getLoopbackCaller();

    for await (const evt of streamChat({
      message,
      selection,
      conversationId,
      provider,
      mcpCall,
      historyStore: chatHistory,
      workflowStore: defaultWorkflowStore,
      signal: controller.signal,
      locale: req.locale,
      onTrace: (t) => {
        conversationTraces.set(conversationId, t);
        console.error(JSON.stringify({ level: "info", type: "agent_trace", ...t }));
      },
    })) {
      if (closed) break;
      emit(evt);
      if (evt.type === "done" || evt.type === "error" || evt.type === "guard") break;
    }
  } catch (err) {
    emit({
      type: "error",
      message: err instanceof Error ? err.message : String(err),
    });
  } finally {
    inFlightTurns.delete(conversationId);
    res.end();
  }
});

// ── GET /info ─────────────────────────────────────────────────────────────────

chatRouter.get("/info", (_req: Request, res: Response): void => {
  const info = chatProviderInfo();
  if (!info) {
    res.status(503).json({
      error: "No LLM provider configured. Set OPENROUTER_API_KEY, GOOGLE_AI_API_KEY, or LLM_PROVIDER=local in .env.",
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

// ── GET /:id/trace ────────────────────────────────────────────────────────────
// Exposes the latest redacted turn trace for diagnostic/verification (§2.10 / AGT-10).

chatRouter.get("/:id/trace", (req: Request, res: Response): void => {
  const id = String(req.params.id);
  const trace = conversationTraces.get(id);
  if (!trace) {
    res.status(404).json({ error: "No trace available for conversation", code: "ERR_TRACE_NOT_FOUND" });
    return;
  }
  res.json(trace);
});

// ── DELETE /:id ───────────────────────────────────────────────────────────────

chatRouter.delete("/:id", (req: Request, res: Response): void => {
  const id = String(req.params.id);
  chatHistory.delete(id);
  defaultWorkflowStore.delete(id);
  conversationTraces.delete(id);
  res.json({ ok: true });
});

