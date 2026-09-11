/**
 * Gate G04 / Phase P04: filesystem safety (DEL-01 .. DEL-08).
 *
 * Every test runs against its own mkdtemp root; the process-wide RootFs
 * singleton is re-registered per test so handlers and planners operate on the
 * sandbox and never on configured media paths.
 */
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Server } from "node:http";
import type { Principal, OperationPlan, OperationPlanRecord } from "@mediabox/contracts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { RootFs, RootFsError, defaultRootFs, normalizeRelativePath } from "./rootfs.js";
import { mapNamespace, PathMappingUnknownError } from "./namespace-map.js";
import {
  quarantineFile,
  listQuarantine,
  QuarantineError,
  QUARANTINE_DIR_NAME,
} from "./quarantine.js";
import { createDeletePlan, DeletePlannerError } from "../operations/planners/delete.js";
import { createQuarantinePurgePlan, createQuarantineRestorePlan } from "../operations/planners/quarantine-admin.js";
import { NodeSqliteAdapter } from "../operations/sqlite/node-adapter.js";
import { OperationStore } from "../operations/store.js";
import { OperationExecutor } from "../operations/executor.js";
import { registerStepHandlers } from "../operations/handlers.js";
import { OWNER_PRINCIPAL_ID, type PlanScope } from "../security/context.js";
import { defaultSessionManager } from "../security/session.js";
import { INTERNAL_API_KEY, AGENT_API_KEY } from "../auth.js";
import { defaultOperationStore } from "../operations/default-store.js";

const scope: PlanScope = { installationId: "install_test", ownerId: OWNER_PRINCIPAL_ID, conversationId: "conv_test" };

const owner: Principal = {
  id: OWNER_PRINCIPAL_ID,
  installationId: "install_test",
  kind: "owner-ui",
  capabilities: ["*"],
  audience: "mediabox-local",
  sessionId: "owner_session_test",
  expiresAt: Date.now() + 3_600_000,
  credentialVersion: 1,
};

let base: string;
let root: string;

async function write(rel: string, content = "x"): Promise<string> {
  const abs = path.join(root, ...rel.split("/"));
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content);
  return abs;
}

async function exists(rel: string): Promise<boolean> {
  try {
    await fs.lstat(path.join(root, ...rel.split("/")));
    return true;
  } catch {
    return false;
  }
}

async function makeDirLink(target: string, linkPath: string): Promise<boolean> {
  try {
    await fs.symlink(target, linkPath, process.platform === "win32" ? "junction" : "dir");
    return true;
  } catch {
    return false;
  }
}

function newStoreAndExecutor() {
  const store = new OperationStore(new NodeSqliteAdapter(":memory:"));
  const executor = new OperationExecutor(store, { workerId: "g04_worker", heartbeatMs: 20 });
  registerStepHandlers(executor);
  return { store, executor };
}

async function runPlan(store: OperationStore, executor: OperationExecutor, plan: OperationPlan): Promise<OperationPlanRecord> {
  store.createPlan(plan, "awaiting_approval");
  store.approveAndEnqueue(plan.id, owner, plan.manifestHash);
  await executor.pollAndExecute();
  return store.getPlan(plan.id)!;
}

beforeEach(async () => {
  base = await fs.mkdtemp(path.join(os.tmpdir(), "mbx-g04-"));
  root = path.join(base, "media");
  await fs.mkdir(root, { recursive: true });
  defaultRootFs.resetForTesting();
  defaultRootFs.registerRoot("media", root);
  defaultRootFs.registerRoot("downloads", path.join(base, "downloads"));
  await fs.mkdir(path.join(base, "downloads"), { recursive: true });
});

afterEach(async () => {
  defaultRootFs.resetForTesting();
  await fs.rm(base, { recursive: true, force: true });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("DEL-02: RootFs confinement", () => {
  it("rejects the root itself, traversal, absolute and device paths", async () => {
    expect(() => normalizeRelativePath("")).toThrow(RootFsError);
    expect(() => normalizeRelativePath("../etc/passwd")).toThrowError(/traversal/);
    expect(() => normalizeRelativePath("tv/../../etc")).toThrowError(/traversal/);
    expect(() => normalizeRelativePath("/etc/passwd")).toThrowError(/Absolute/);
    expect(() => normalizeRelativePath("C:\\Windows")).toThrowError(/Absolute/);
    expect(() => normalizeRelativePath("tv/nul")).toThrowError(/Reserved/);
    await expect(defaultRootFs.resolveWithinRoot("media", "")).rejects.toMatchObject({ code: "ERR_PATH_IS_ROOT" });
    await expect(defaultRootFs.resolveWithinRoot("media", "./")).rejects.toMatchObject({ code: "ERR_PATH_INVALID" });
  });

  it("refuses a junction/symlink pointing at a sibling directory that shares the root's name prefix", async () => {
    const other = path.join(base, "media-other");
    await fs.mkdir(other, { recursive: true });
    await fs.writeFile(path.join(other, "secret.txt"), "secret");
    const created = await makeDirLink(other, path.join(root, "j"));
    expect(created).toBe(true);

    await expect(defaultRootFs.resolveWithinRoot("media", "j/secret.txt")).rejects.toMatchObject({ code: "ERR_PATH_IS_LINK" });
    await expect(defaultRootFs.resolveWithinRoot("media", "j")).rejects.toMatchObject({ code: "ERR_PATH_IS_LINK" });
    // A link is never quarantined either.
    await expect(quarantineFile("media", "j/secret.txt", { planId: "p" })).rejects.toMatchObject({ code: "ERR_PATH_IS_LINK" });
  });

  it("accepts legitimate files when the root was registered through a non-canonical spelling (8.3 names, ..)", async () => {
    await write("tv/Show/ep1.mkv");
    const alias = path.join(root, "..", path.basename(root));
    const rfs = new RootFs();
    rfs.registerRoot("alias", alias);
    const resolved = await rfs.resolveWithinRoot("alias", "tv/Show/ep1.mkv", { mustExist: true, expectKind: "file" });
    expect(resolved.exists).toBe(true);
    expect(resolved.kind).toBe("file");
    expect(resolved.relativePath).toBe("tv/Show/ep1.mkv");
    // os.tmpdir() spelling (short path on Windows) must work as well.
    const resolvedDefault = await defaultRootFs.resolveWithinRoot("media", "tv\\Show\\ep1.mkv", { mustExist: true });
    expect(resolvedDefault.relativePath).toBe("tv/Show/ep1.mkv");
  });

  it("refuses a filesystem root as a RootFs root", () => {
    const rfs = new RootFs();
    expect(() => rfs.registerRoot("bad", path.parse(process.cwd()).root)).toThrowError(/filesystem root/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("DEL-04: namespace mapping", () => {
  it("maps container paths to roots and refuses unknown mounts instead of treating them as absent", () => {
    expect(mapNamespace("/tv/Show/ep.mkv")).toEqual({ rootId: "media", relativePath: "tv/Show/ep.mkv" });
    expect(mapNamespace("/data/movies/Film/f.mkv")).toEqual({ rootId: "media", relativePath: "movies/Film/f.mkv" });
    expect(mapNamespace("/downloads/pkg/file.mkv")).toEqual({ rootId: "downloads", relativePath: "pkg/file.mkv" });
    expect(mapNamespace("downloads/file.mkv")).toEqual({ rootId: "downloads", relativePath: "file.mkv" });
    expect(mapNamespace("anime/Show")).toEqual({ rootId: "media", relativePath: "anime/Show" });
    expect(() => mapNamespace("/etc/passwd")).toThrow(PathMappingUnknownError);
    expect(() => mapNamespace("/nas/library/x.mkv")).toThrow(PathMappingUnknownError);
    expect(() => mapNamespace("")).toThrow(PathMappingUnknownError);
    expect(() => mapNamespace("/")).toThrow(PathMappingUnknownError);
  });

  it("the delete planner fails closed on unknown mappings, links and internal directories", async () => {
    await expect(createDeletePlan({ logicalPaths: ["/nas/x.mkv"], scope })).rejects.toThrow(PathMappingUnknownError);

    await write("tv/Linked/ep1.mkv");
    const other = path.join(base, "elsewhere");
    await fs.mkdir(other);
    expect(await makeDirLink(other, path.join(root, "tv", "Linked", "link"))).toBe(true);
    await expect(createDeletePlan({ logicalPaths: ["tv/Linked"], scope })).rejects.toMatchObject({ code: "ERR_LINK_IN_TARGET" });

    await fs.mkdir(path.join(root, QUARANTINE_DIR_NAME), { recursive: true });
    await expect(createDeletePlan({ logicalPaths: [QUARANTINE_DIR_NAME], scope })).rejects.toBeInstanceOf(DeletePlannerError);
    await expect(createDeletePlan({ logicalPaths: ["tv/missing.mkv"], scope })).rejects.toMatchObject({ code: "ERR_PATH_NOT_FOUND" });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("DEL-01 / DEL-03: exact scope and quarantine", () => {
  it("quarantines one file and preserves its siblings (DEL-01)", async () => {
    await write("movies/Film (2019)/film.mkv", "main");
    await write("movies/Film (2019)/film-extra.mkv", "extra");
    const { store, executor } = newStoreAndExecutor();

    const { plan, summary } = await createDeletePlan({ logicalPaths: ["movies/Film (2019)/film.mkv"], scope });
    expect(summary.files).toBe(1);
    expect(summary.reclaimableBytes).toBe(0);
    expect(plan.effects).toHaveLength(1);
    expect(plan.effects[0].serviceAction).toBe("quarantine.move");
    expect(plan.targets[0].fileIdentity?.kind).toBe("file");

    const record = await runPlan(store, executor, plan);
    expect(record.status).toBe("succeeded");
    expect(await exists("movies/Film (2019)/film.mkv")).toBe(false);
    expect(await exists("movies/Film (2019)/film-extra.mkv")).toBe(true);
    expect(await exists(`${QUARANTINE_DIR_NAME}/${plan.id}/movies/Film (2019)/film.mkv`)).toBe(true);
    expect(await exists(`${QUARANTINE_DIR_NAME}/${plan.id}/movies/Film (2019)/film.mkv.manifest.json`)).toBe(true);
  });

  it("expands a directory into concrete files and removes only the directories it emptied", async () => {
    await write("tv/Show/Season 01/e1.mkv");
    await write("tv/Show/Season 01/e2.mkv");
    await write("tv/Show/poster.jpg");
    const { store, executor } = newStoreAndExecutor();

    const { plan, summary } = await createDeletePlan({ logicalPaths: ["tv/Show"], scope });
    expect(summary.files).toBe(3);
    expect(summary.directories).toBe(2);
    const moves = plan.effects.filter((e) => e.serviceAction === "quarantine.move");
    const rmdirs = plan.effects.filter((e) => e.serviceAction === "quarantine.remove_empty_dir");
    expect(moves).toHaveLength(3);
    expect(rmdirs.map((e) => plan.targets[e.targetIndex!].relativePath)).toEqual(["tv/Show/Season 01", "tv/Show"]);

    const record = await runPlan(store, executor, plan);
    expect(record.status).toBe("succeeded");
    expect(await exists("tv/Show")).toBe(false);
    const entries = await listQuarantine("media");
    expect(entries.map((e) => e.originalRelativePath).sort()).toEqual(["tv/Show/Season 01/e1.mkv", "tv/Show/Season 01/e2.mkv", "tv/Show/poster.jpg"]);
  });

  it("never touches files created after the preview and keeps their directory (DEL-03)", async () => {
    await write("tv/Show/e1.mkv");
    const { store, executor } = newStoreAndExecutor();
    const { plan } = await createDeletePlan({ logicalPaths: ["tv/Show"], scope });
    await write("tv/Show/NEW-after-preview.mkv", "new");

    const record = await runPlan(store, executor, plan);
    expect(record.status).toBe("succeeded");
    expect(await exists("tv/Show/NEW-after-preview.mkv")).toBe(true);
    expect(await exists("tv/Show/e1.mkv")).toBe(false);
    const rmdirStep = record.steps!.find((s) => s.action === "quarantine.remove_empty_dir")!;
    expect(rmdirStep.status).toBe("completed");
    expect(rmdirStep.details?.removed).toBe(false);
  });

  it("refuses to move a file whose identity changed since the plan (DEL-03 / INV-TARGET)", async () => {
    const abs = await write("tv/Show/e1.mkv", "original");
    const { store, executor } = newStoreAndExecutor();
    const { plan } = await createDeletePlan({ logicalPaths: ["tv/Show/e1.mkv"], scope });
    await fs.appendFile(abs, "-changed");

    const record = await runPlan(store, executor, plan);
    expect(record.status).toBe("failed");
    expect(record.steps![0].error).toMatch(/identity/i);
    expect(await fs.readFile(abs, "utf8")).toBe("original-changed");
    expect(await listQuarantine("media")).toHaveLength(0);
  });

  it("caps the selection and de-duplicates overlapping paths", async () => {
    await write("tv/Dup/e1.mkv");
    const { plan, summary } = await createDeletePlan({ logicalPaths: ["tv/Dup", "tv/Dup/e1.mkv", "tv/Dup"], scope });
    expect(summary.files).toBe(1);
    expect(plan.effects.filter((e) => e.serviceAction === "quarantine.move")).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("DEL-06 / DEL-07: reclaimable space, restore and purge", () => {
  it("reports zero reclaimable bytes for hard-linked files and purge frees nothing (DEL-06)", async () => {
    const abs = await write("movies/A/a.mkv", "0123456789");
    const linkAbs = path.join(root, "movies", "B", "b.mkv");
    await fs.mkdir(path.dirname(linkAbs), { recursive: true });
    await fs.link(abs, linkAbs);

    const { store, executor } = newStoreAndExecutor();
    const { plan, summary } = await createDeletePlan({ logicalPaths: ["movies/A/a.mkv"], scope });
    expect(summary.hardLinkedFiles).toBe(1);
    expect(summary.selectedBytes).toBe(10);
    expect(plan.effects[0].requiredResources).toMatchObject({ selectedBytes: 10, reclaimableBytes: 0 });
    expect(plan.targets[0].fileIdentity?.nlink).toBe(2);

    const record = await runPlan(store, executor, plan);
    expect(record.status).toBe("succeeded");
    const [entry] = await listQuarantine("media");
    expect(entry.reclaimableOnPurgeBytes).toBe(0);

    const purge = await createQuarantinePurgePlan({ rootId: "media", entryPaths: [entry.entryPath], scope });
    expect(purge.summary.reclaimableBytes).toBe(0);
    expect(purge.plan.effects[0].irreversibleLoss).toBe(true);
    const purged = await runPlan(store, executor, purge.plan);
    expect(purged.status).toBe("succeeded");
    expect(purged.steps![0].details?.freedBytes).toBe(0);
    expect(await fs.readFile(linkAbs, "utf8")).toBe("0123456789");
    expect(await listQuarantine("media")).toHaveLength(0);
  });

  it("restore never overwrites a newer file and succeeds once the path is free (DEL-07)", async () => {
    await write("tv/R/e1.mkv", "old");
    const { store, executor } = newStoreAndExecutor();
    const { plan } = await createDeletePlan({ logicalPaths: ["tv/R/e1.mkv"], scope });
    await runPlan(store, executor, plan);
    const [entry] = await listQuarantine("media");

    await write("tv/R/e1.mkv", "newer");
    const blocked = await createQuarantineRestorePlan({ rootId: "media", entryPaths: [entry.entryPath], scope });
    const blockedRecord = await runPlan(store, executor, blocked.plan);
    expect(blockedRecord.status).toBe("failed");
    expect(blockedRecord.steps![0].error).toMatch(/now exists/);
    expect(await fs.readFile(path.join(root, "tv", "R", "e1.mkv"), "utf8")).toBe("newer");
    expect(await listQuarantine("media")).toHaveLength(1);

    await fs.rm(path.join(root, "tv", "R", "e1.mkv"));
    const restore = await createQuarantineRestorePlan({ rootId: "media", entryPaths: [entry.entryPath], scope });
    const restored = await runPlan(store, executor, restore.plan);
    expect(restored.status).toBe("succeeded");
    expect(await fs.readFile(path.join(root, "tv", "R", "e1.mkv"), "utf8")).toBe("old");
    expect(await listQuarantine("media")).toHaveLength(0);
  });

  it("quarantine entries are never purged by TTL and a purge needs an approved plan of its own (DEL-07)", async () => {
    await write("tv/T/e1.mkv");
    const { store, executor } = newStoreAndExecutor();
    const { plan } = await createDeletePlan({ logicalPaths: ["tv/T/e1.mkv"], scope });
    await runPlan(store, executor, plan);
    const [entry] = await listQuarantine("media");
    expect(new Date(entry.expiresAt).getTime()).toBeGreaterThan(Date.now() + 6 * 24 * 3600 * 1000);

    // An unapproved purge plan changes nothing.
    const purge = await createQuarantinePurgePlan({ rootId: "media", entryPaths: [entry.entryPath], scope });
    store.createPlan(purge.plan, "awaiting_approval");
    await executor.pollAndExecute();
    expect(await listQuarantine("media")).toHaveLength(1);
    expect(store.getPlan(purge.plan.id)!.status).toBe("awaiting_approval");
    await expect(quarantineFile("media", `${QUARANTINE_DIR_NAME}/${entry.entryPath}`)).rejects.toBeInstanceOf(QuarantineError);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("DEL-08: MCP proposal, REST approval and the single executor share one plan", () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    process.env.NODE_ENV = "test";
    const { createApp } = await import("../index.js");
    const app = createApp();
    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", () => {
        baseUrl = `http://127.0.0.1:${(server.address() as any).port}`;
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  async function waitForTerminal(planId: string, headers: Record<string, string>, timeoutMs = 15_000) {
    const terminal = new Set(["succeeded", "failed", "partial", "unknown_outcome", "cancelled", "interrupted", "expired", "rejected"]);
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const res = await fetch(`${baseUrl}/api/operations/plans/${planId}`, { headers });
      const record = (await res.json()) as OperationPlanRecord;
      if (terminal.has(record.status)) return record;
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error(`Plan ${planId} did not reach a terminal state in time`);
  }

  it("agent proposes over MCP with its own identity, owner approves over REST, the global executor quarantines", async () => {
    await write("tv/E2E/e1.mkv", "payload");
    await write("tv/E2E/e2.mkv", "sibling");

    const client = new Client({ name: "g04-agent", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${AGENT_API_KEY}` } },
    });
    await client.connect(transport);
    const result = (await client.callTool({ name: "propose_cleanup", arguments: { paths: ["tv/E2E/e1.mkv"] } })) as any;
    await client.close();

    expect(result.isError).toBeFalsy();
    const envelope = result.structuredContent as { status: string; data: { planId: string; status: string; manifestHash: string; summary: { files: number } } };
    expect(envelope.status).toBe("ok");
    expect(envelope.data.status).toBe("awaiting_approval");
    expect(envelope.data.summary.files).toBe(1);
    expect(JSON.parse(result.content[0].text)).toEqual(envelope);

    const ownerHeaders = { Authorization: `Bearer ${INTERNAL_API_KEY}`, "Content-Type": "application/json" };
    const stored = defaultOperationStore.getPlan(envelope.data.planId)!;
    expect(stored.plan.installationId).toBe(defaultSessionManager.getInstallationId());
    expect(stored.plan.ownerId).toBe(OWNER_PRINCIPAL_ID);

    const listed = await fetch(`${baseUrl}/api/operations/plans?statuses=awaiting_approval,queued`, { headers: ownerHeaders });
    expect(listed.status).toBe(200);
    expect(((await listed.json()) as any).plans.some((p: any) => p.id === envelope.data.planId)).toBe(true);

    const approve = await fetch(`${baseUrl}/api/operations/plans/${envelope.data.planId}/approve`, {
      method: "POST",
      headers: ownerHeaders,
      body: JSON.stringify({ manifestHash: envelope.data.manifestHash }),
    });
    expect(approve.status).toBe(200);
    expect(((await approve.json()) as OperationPlanRecord).status).toBe("queued");

    const finished = await waitForTerminal(envelope.data.planId, ownerHeaders);
    expect(finished.status).toBe("succeeded");
    expect(await exists("tv/E2E/e1.mkv")).toBe(false);
    expect(await exists("tv/E2E/e2.mkv")).toBe(true);
    expect(await exists(`${QUARANTINE_DIR_NAME}/${envelope.data.planId}/tv/E2E/e1.mkv`)).toBe(true);
  });

  it("a delegated owner-ui session can approve an agent proposal; the agent cannot", async () => {
    await write("tv/E2E2/e1.mkv");
    const client = new Client({ name: "g04-agent", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${AGENT_API_KEY}` } },
    });
    await client.connect(transport);
    const result = (await client.callTool({ name: "propose_cleanup", arguments: { paths: ["tv/E2E2/e1.mkv"] } })) as any;
    await client.close();
    const { planId, manifestHash } = result.structuredContent.data;

    const agentApprove = await fetch(`${baseUrl}/api/operations/plans/${planId}/approve`, {
      method: "POST",
      headers: { Authorization: `Bearer ${AGENT_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ manifestHash }),
    });
    expect(agentApprove.status).toBe(403);

    const session = await fetch(`${baseUrl}/api/auth/sessions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${INTERNAL_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "owner-ui", ttlMs: 60_000 }),
    });
    expect(session.status).toBe(201);
    const { token } = (await session.json()) as { token: string };

    const ownerUiApprove = await fetch(`${baseUrl}/api/operations/plans/${planId}/approve`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ manifestHash }),
    });
    expect(ownerUiApprove.status).toBe(200);
    const finished = await waitForTerminal(planId, { Authorization: `Bearer ${token}` });
    expect(finished.status).toBe("succeeded");
  });
});
