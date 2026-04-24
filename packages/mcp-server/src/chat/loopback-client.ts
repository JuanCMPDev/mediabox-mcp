/* ─── Loopback MCP client ────────────────────────────────────────────────────
 * Connects back to THIS server's /mcp endpoint so the chat engine can call
 * MCP tools without going through a separate process.
 *
 * Why loopback instead of calling tool handlers directly:
 *   - No coupling between chat-core and the server's internal modules
 *   - Preserves the full MCP session lifecycle (auth, schema, versioning)
 *   - Identical code path as the Telegram bot — battle-tested
 *
 * Lifecycle: lazy-init on first chat request. Auto-reconnects if session drops.
 * ──────────────────────────────────────────────────────────────────────── */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createMcpCaller } from "@mediabox/chat-core";
import type { McpCallFn } from "@mediabox/chat-core";
import { PORT } from "../config.js";
import { INTERNAL_API_KEY } from "../auth.js";
import { VERSION } from "../version.js";

let _caller: McpCallFn | null = null;
let _connecting: Promise<McpCallFn> | null = null;

const MAX_RETRIES = 10;
const BASE_DELAY_MS = 500;

export async function getLoopbackCaller(): Promise<McpCallFn> {
  if (_caller) return _caller;
  if (_connecting) return _connecting;

  _connecting = connectWithRetry().then(caller => {
    _caller = caller;
    _connecting = null;
    return caller;
  });

  return _connecting;
}

async function connectWithRetry(): Promise<McpCallFn> {
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      return await connect();
    } catch (err) {
      const delay = Math.min(BASE_DELAY_MS * 2 ** attempt, 10_000);
      console.warn(`[chat-loopback] connect attempt ${attempt + 1}/${MAX_RETRIES} failed — retry in ${delay}ms: ${(err as Error).message}`);
      await sleep(delay);
    }
  }
  throw new Error("chat-loopback: could not connect to local MCP endpoint after max retries");
}

async function connect(): Promise<McpCallFn> {
  const client = new Client({ name: "chat-loopback", version: VERSION });
  const transport = new StreamableHTTPClientTransport(
    new URL(`http://localhost:${PORT}/mcp`),
    { requestInit: { headers: { Authorization: `Bearer ${INTERNAL_API_KEY}` } } },
  );
  await client.connect(transport);

  // If the MCP session drops, invalidate the caller so it reconnects on next request
  transport.onclose = () => {
    console.warn("[chat-loopback] session closed — will reconnect on next request");
    _caller = null;
  };

  console.log("[chat-loopback] connected to local MCP endpoint");
  return createMcpCaller(client);
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
