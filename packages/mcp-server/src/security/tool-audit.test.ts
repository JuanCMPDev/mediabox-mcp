import { describe, it, expect, beforeEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { NodeSqliteAdapter } from "../operations/sqlite/node-adapter.js";
import { initializeOperationsSchema } from "../operations/schema.js";
import { createMcpServer } from "../tools/register.js";
import { createToolContext } from "./context.js";
import { ToolAuditLog } from "./tool-audit.js";
import type { Principal } from "@mediabox/contracts";

const agent: Principal = {
  id: "agent-session",
  installationId: "install_audit",
  kind: "agent",
  capabilities: ["mcp:tools:read", "mcp:tools:propose"],
  audience: "mediabox-local",
  sessionId: "agent-static-session",
  expiresAt: Date.now() + 3_600_000,
  credentialVersion: 1,
};

async function connect(log: ToolAuditLog, conversationId = "conv-audit") {
  const context = createToolContext(agent, conversationId);
  const server = createMcpServer(context, log);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "audit-test", version: "0" });
  await client.connect(clientSide);
  return client;
}

describe("tool audit ledger (P11 §4.3)", () => {
  let db: NodeSqliteAdapter;
  let log: ToolAuditLog;

  beforeEach(() => {
    db = new NodeSqliteAdapter(":memory:");
    initializeOperationsSchema(db);
    log = new ToolAuditLog(db);
  });

  it("migrates an existing v2 database to v3 without touching its tables", () => {
    const legacy = new NodeSqliteAdapter(":memory:");
    legacy.exec("CREATE TABLE operation_plans (id TEXT PRIMARY KEY); PRAGMA user_version = 2;");
    legacy.exec("INSERT INTO operation_plans (id) VALUES ('kept');");
    initializeOperationsSchema(legacy);
    expect(legacy.prepare("PRAGMA user_version;").get<{ user_version: number }>()?.user_version).toBe(3);
    expect(legacy.prepare("SELECT id FROM operation_plans").all()).toEqual([{ id: "kept" }]);
    expect(legacy.prepare("SELECT COUNT(*) AS n FROM tool_audit").get<{ n: number }>()?.n).toBe(0);
  });

  it("records the executed handler with principal, conversation, args and outcome", async () => {
    const client = await connect(log);
    const result = await client.callTool({ name: "operation_status", arguments: { planId: "plan_missing" } });
    expect(result.isError).toBe(true);

    const rows = log.list();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      tool: "operation_status",
      principalId: "agent-session",
      principalKind: "agent",
      conversationId: "conv-audit",
      ok: false,
    });
    expect(JSON.parse(rows[0].argsJson)).toEqual({ planId: "plan_missing" });
    expect(rows[0].errorCode).toBeTruthy();
  });

  it("does not record calls rejected by the input schema: they were never executed", async () => {
    const client = await connect(log);
    const result = await client.callTool({ name: "operation_status", arguments: { planId: 42 } as any });
    expect(result.isError).toBe(true);
    expect(log.list()).toHaveLength(0);
  });

  it("a failing audit write never changes the tool result", async () => {
    const broken = new ToolAuditLog(new NodeSqliteAdapter(":memory:")); // no schema: every insert throws
    const client = await connect(broken);
    const result = await client.callTool({ name: "operation_status", arguments: { planId: "plan_missing" } });
    expect(result.isError).toBe(true);
  });
});
