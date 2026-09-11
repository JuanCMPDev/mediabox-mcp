/* ─── Mediabox Telegram Bot ──────────────────────────────────────────────────
 *
 * Thin transport layer over @mediabox/chat-core. Connects to mcp-server as an
 * agent using MCP_AGENT_API_KEY.
 *
 * This file owns:
 *   - Telegram-specific setup (grammy, allowlist, commands, typing indicator)
 *   - Remote MCP client connection (to the mcp-server, typically in a sibling
 *     Docker container at http://mcp-server:3000/mcp)
 *
 * Everything else — system prompt, virtual tools, LLM provider selection,
 * tool-calling loop, conversation history — lives in @mediabox/chat-core and
 * is shared with the mcp-server's /api/chat endpoint.
 * ──────────────────────────────────────────────────────────────────────── */
import { Bot, Context } from "grammy";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  runChat,
  createMcpCaller,
  resolveProvider,
  InMemoryHistoryStore,
  InMemoryWorkflowStore,
} from "@mediabox/chat-core";
import type { McpCallFn } from "@mediabox/chat-core";
import { VERSION } from "./version.js";

// =============================================================================
// CONFIG
// =============================================================================
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const MCP_URL        = process.env.MCP_SERVER_URL     || "http://mcp-server:3000/mcp";
const MCP_API_KEY    = process.env.MCP_AGENT_API_KEY  || "";

if (!MCP_API_KEY) {
  console.error("FATAL: MCP_AGENT_API_KEY is required for Telegram bot authentication.");
  process.exit(1);
}

const ALLOWED_USERS  = (process.env.ALLOWED_TELEGRAM_USERS || "")
  .split(",")
  .map(Number)
  .filter(Boolean);

const CONVERSATION_TTL = 2 * 60 * 60 * 1000; // 2 h

// =============================================================================
// CORE — provider + history store (live for the bot's lifetime)
// =============================================================================
// Local inference variables must reach the bot too, or it silently runs on the
// ollama defaults while the owner configured LM Studio or another model (LOC-04).
const provider = resolveProvider({
  OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
  GOOGLE_AI_API_KEY:  process.env.GOOGLE_AI_API_KEY,
  LLM_MODEL:          process.env.LLM_MODEL,
  LLM_PROVIDER:       process.env.LLM_PROVIDER,
  LOCAL_LLM_BASE_URL:       process.env.LOCAL_LLM_BASE_URL,
  LOCAL_LLM_MODEL:          process.env.LOCAL_LLM_MODEL,
  LOCAL_LLM_RUNTIME:        process.env.LOCAL_LLM_RUNTIME,
  LOCAL_LLM_API_KEY:        process.env.LOCAL_LLM_API_KEY,
  LOCAL_LLM_CONTEXT_TOKENS: process.env.LOCAL_LLM_CONTEXT_TOKENS,
  INFERENCE_ALLOW_LAN:      process.env.INFERENCE_ALLOW_LAN,
  INFERENCE_ENDPOINT_HOSTS: process.env.INFERENCE_ENDPOINT_HOSTS,
  LOCAL_BASE_URL:     process.env.LOCAL_BASE_URL,
  LOCAL_MODEL:        process.env.LOCAL_MODEL,
  LOCAL_RUNTIME:      process.env.LOCAL_RUNTIME,
  LOCAL_ALLOW_LAN:    process.env.LOCAL_ALLOW_LAN,
});

const historyStore = new InMemoryHistoryStore(CONVERSATION_TTL);
// The bot keeps its own workflow store so /clear can actually reset the agent state;
// with the runtime's module-level default it was unreachable (INV-PARITY / AGT-06).
const workflowStore = new InMemoryWorkflowStore();

// =============================================================================
// MCP CLIENT — connect to the mcp-server over HTTP with retry
// =============================================================================
let mcpClient: Client | null = null;
let mcpCall: McpCallFn | null = null;

async function connectMCP(): Promise<void> {
  const client = new Client({ name: "telegram-bot", version: VERSION });
  const headers: Record<string, string> = {};
  if (MCP_API_KEY) headers["Authorization"] = `Bearer ${MCP_API_KEY}`;

  const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), {
    requestInit: { headers },
  });
  await client.connect(transport);

  mcpClient = client;
  mcpCall   = createMcpCaller(client);

  transport.onclose = () => {
    console.warn("MCP session closed — will reconnect on next message");
    mcpClient = null;
    mcpCall   = null;
  };
}

async function connectWithRetry(): Promise<void> {
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      await connectMCP();
      console.log(`MCP connected: ${MCP_URL}`);
      return;
    } catch (err) {
      const delay = Math.min(1000 * 2 ** attempt, 30_000);
      console.error(
        `MCP connect ${attempt + 1}/10 failed — retry in ${delay}ms: ${(err as Error).message}`
      );
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  console.error("MCP reconnection exhausted.");
}

// =============================================================================
// LOCKS — prevent concurrent requests from the same chat from racing the history
// =============================================================================
const chatLocks = new Map<number, Promise<void>>();

async function withLock<T>(chatId: number, fn: () => Promise<T>): Promise<T> {
  const prev = chatLocks.get(chatId) ?? Promise.resolve();
  let release!: () => void;
  chatLocks.set(chatId, new Promise<void>((r) => (release = r)));
  await prev;
  try {
    return await fn();
  } finally {
    release();
  }
}

// =============================================================================
// MESSAGE HANDLER
// =============================================================================
async function handleMessage(chatId: number, userMessage: string): Promise<string> {
  if (!mcpCall) {
    await connectWithRetry();
    if (!mcpCall) return "⚠️ Servidor MCP no disponible.";
  }

  try {
    return await runChat({
      message:        userMessage,
      conversationId: `tg:${chatId}`,
      provider,
      mcpCall:        mcpCall!,
      historyStore,
      workflowStore,
      locale:         process.env.MEDIABOX_LOCALE === "en" ? "en" : "es",
    });
  } catch (err) {
    return formatError(err as Error);
  }
}

function formatError(err: Error): string {
  const msg = err.message || "";
  if (msg.includes("timed out"))     return "⚠️ La operación tardó demasiado. Intenta de nuevo.";
  if (msg.includes("ECONNREFUSED"))  return "⚠️ No se puede conectar al servidor.";
  if (msg.includes("429") || msg.includes("rate")) return "⚠️ Demasiadas peticiones. Espera un momento.";
  return `⚠️ Error: ${msg.slice(0, 200)}`;
}

// =============================================================================
// TELEGRAM BOT
// =============================================================================
const bot = new Bot(TELEGRAM_TOKEN);

// Allowlist middleware
bot.use(async (ctx: Context, next) => {
  const uid = ctx.from?.id;
  if (!uid || (ALLOWED_USERS.length && !ALLOWED_USERS.includes(uid))) {
    await ctx.reply("No autorizado.");
    return;
  }
  await next();
});

// Commands
bot.command("start", (ctx) =>
  ctx.reply(
    `Mediabox Media Server Bot\n` +
    `Modelo: ${provider.model} (${provider.providerName})\n\n` +
    `/clear - Reiniciar conversación\n` +
    `/model - Info del modelo`
  )
);

bot.command("clear", (ctx) => {
  historyStore.delete(`tg:${ctx.chat.id}`);
  // Reset clears transcript and workflow state; persisted plans are untouched (AGT-06).
  workflowStore.delete(`tg:${ctx.chat.id}`);
  ctx.reply("Conversación reiniciada.");
});

bot.command("model", (ctx) =>
  ctx.reply(
    `Provider: ${provider.providerName}\n` +
    `Modelo: ${provider.model}\n` +
    `MCP: ${mcpClient ? "connected" : "disconnected"}`
  )
);

// Typing indicator (refreshes every 4 s while processing)
function startTyping(chatId: number): () => void {
  bot.api.sendChatAction(chatId, "typing").catch(() => {});
  const interval = setInterval(() => {
    bot.api.sendChatAction(chatId, "typing").catch(() => {});
  }, 4000);
  return () => clearInterval(interval);
}

// Main message handler
bot.on("message:text", async (ctx) => {
  const chatId = ctx.chat.id;
  await withLock(chatId, async () => {
    const stopTyping = startTyping(chatId);
    try {
      const reply = await handleMessage(chatId, ctx.message.text);
      // Telegram message limit is 4096 chars — split long replies
      for (let i = 0; i < reply.length; i += 4096) {
        await ctx.reply(reply.slice(i, i + 4096));
      }
    } catch (err) {
      console.error(`[Error] ${(err as Error).message}`);
      await ctx.reply(formatError(err as Error));
    } finally {
      stopTyping();
    }
  });
});

// =============================================================================
// STARTUP & SHUTDOWN
// =============================================================================
async function shutdown(sig: string) {
  console.log(`${sig}, shutting down...`);
  try { bot.stop(); } catch {}
  try { if (mcpClient) await mcpClient.close(); } catch {}
  process.exit(0);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT",  () => shutdown("SIGINT"));

async function main() {
  console.log(`Mediabox Telegram Bot | ${provider.providerName}/${provider.model}`);
  console.log(
    `MCP: ${MCP_URL} | Users: ${ALLOWED_USERS.length ? ALLOWED_USERS.join(",") : "all"}`
  );
  await connectWithRetry();
  bot.start({ onStart: (info) => console.log(`Bot: @${info.username}`) });
}

main().catch(console.error);
