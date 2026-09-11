import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from "vitest";
import type { Server } from "node:http";
import { NodeSqliteAdapter } from "./sqlite/node-adapter.js";
import { OperationStore } from "./store.js";
import { buildOperationPlan } from "./planner.js";
import { computePlanManifestHash } from "./canonical-hash.js";
import { reconcilePostCrash } from "./reconcile.js";
import { OperationExecutor } from "./executor.js";
import { createApp } from "../index.js";
import { createMcpServer } from "../tools/register.js";
import { INTERNAL_API_KEY, AGENT_API_KEY } from "../auth.js";
import type { Principal } from "@mediabox/contracts";

describe("Gate G03 / Phase P03: Operation Plans, Approval & Executor (OP-01 to OP-07)", () => {
  let db: NodeSqliteAdapter;
  let store: OperationStore;

  const ownerPrincipal: Principal = {
    id: "owner_1",
    installationId: "install_test",
    kind: "owner-ui",
    capabilities: ["read", "propose", "approve", "admin", "export_secrets"],
    audience: "mediabox-app",
    sessionId: "owner_session_1",
    expiresAt: Date.now() + 3600000,
    credentialVersion: 1,
  };

  const agentPrincipal: Principal = {
    id: "agent_1",
    installationId: "install_test",
    kind: "agent-session",
    capabilities: ["read", "propose"],
    audience: "mediabox-agent",
    sessionId: "agent_session_1",
    expiresAt: Date.now() + 3600000,
    credentialVersion: 1,
  };

  const otherOwnerPrincipal: Principal = {
    id: "owner_2",
    installationId: "install_test",
    kind: "owner-ui",
    capabilities: ["read", "propose", "approve"],
    audience: "mediabox-app",
    sessionId: "owner_session_2",
    expiresAt: Date.now() + 3600000,
    credentialVersion: 1,
  };

  beforeEach(() => {
    db = new NodeSqliteAdapter(":memory:");
    store = new OperationStore(db);
  });

  afterEach(() => {
    db.close();
  });

  // ──────────────────────────────────────────────────────────────────────────
  // OP-01: Agent cannot approve or simulate 'yes' to authorize work
  // ──────────────────────────────────────────────────────────────────────────
  describe("OP-01: Approval containment and agent model separation", () => {
    it("strictly forbids agent-session from approving an operation plan", async () => {
      const plan = buildOperationPlan({
        installationId: "install_test",
        ownerId: "owner_1",
        conversationId: "conv_1",
        operation: "delete_episode",
        targets: [
          {
            service: "sonarr",
            rootId: "tv",
            relativePath: "Breaking Bad/Season 1/S01E01.mkv",
            observedState: "present",
          },
        ],
        effects: [
          {
            serviceAction: "file.delete",
            irreversibleLoss: true,
          },
        ],
      });

      store.createPlan(plan, "awaiting_approval");

      // Attempt approval using agent principal
      expect(() => {
        store.approveAndEnqueue(plan.id, agentPrincipal, plan.manifestHash);
      }).toThrowError(/Principal kind 'agent-session' cannot approve plans/);

      // Verify the plan remains unapproved
      const record = store.getPlan(plan.id);
      expect(record?.status).toBe("awaiting_approval");
      expect(record?.approvedAt).toBeUndefined();
    });

    it("verifies MCP server contains NO approve or commit tool for the model", async () => {
      const mcp = createMcpServer();
      // Inspect registered tools
      // @ts-ignore
      const tools = Object.keys((mcp as any)._registeredTools || {});
      expect(tools).not.toContain("approve");
      expect(tools).not.toContain("commit");
      expect(tools).not.toContain("operation_approve");
      expect(tools).toContain("operation_status");
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // OP-02: Double click / replay produces exactly one operation
  // ──────────────────────────────────────────────────────────────────────────
  describe("OP-02: Idempotent approval and replay protection", () => {
    it("returns existing operation on second approval without duplicating or re-queueing", () => {
      const plan = buildOperationPlan({
        installationId: "install_test",
        ownerId: "owner_1",
        conversationId: "conv_1",
        operation: "cleanup_media",
        targets: [
          {
            service: "filesystem",
            rootId: "downloads",
            relativePath: "sample.iso",
            observedState: "abandoned",
          },
        ],
        effects: [
          {
            serviceAction: "quarantine.move",
            irreversibleLoss: false,
          },
        ],
      });

      store.createPlan(plan, "awaiting_approval");

      // First click
      const firstApproval = store.approveAndEnqueue(plan.id, ownerPrincipal, plan.manifestHash);
      expect(firstApproval.status).toBe("queued");
      expect(firstApproval.approvedAt).toBeDefined();

      // Second click (duplicate / replay / double-click)
      const secondApproval = store.approveAndEnqueue(plan.id, ownerPrincipal, plan.manifestHash);
      expect(secondApproval.status).toBe("queued");
      expect(secondApproval.approvedAt).toBe(firstApproval.approvedAt);
      expect(secondApproval.queuedAt).toBe(firstApproval.queuedAt);

      // Verify queue has only 1 work item to claim
      const claimed = store.claimNextQueuedPlan("worker_1");
      expect(claimed?.plan.id).toBe(plan.id);

      // Subsequent claim finds nothing else queued
      const secondClaim = store.claimNextQueuedPlan("worker_1");
      expect(secondClaim).toBeUndefined();
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // OP-03: Tampering with target, destination, profile, or hash requires new plan
  // ──────────────────────────────────────────────────────────────────────────
  describe("OP-03: Canonical hash verification and tamper rejection", () => {
    it("rejects approval when the provided manifestHash differs from the stored plan", () => {
      const plan = buildOperationPlan({
        installationId: "install_test",
        ownerId: "owner_1",
        conversationId: "conv_1",
        operation: "transcode_video",
        targets: [
          {
            service: "library",
            rootId: "movies",
            relativePath: "Movie (2020)/movie.mkv",
            observedState: "ready",
          },
        ],
        effects: [
          {
            serviceAction: "ffmpeg.transcode",
            tracksProfile: "1080p_h264_aac",
            irreversibleLoss: false,
          },
        ],
      });

      store.createPlan(plan, "awaiting_approval");

      // Attempt approval with tampered hash
      expect(() => {
        store.approveAndEnqueue(plan.id, ownerPrincipal, "tampered_sha256_hash_12345");
      }).toThrowError(/Manifest hash mismatch/);

      // Verify plan was not modified or queued
      const record = store.getPlan(plan.id);
      expect(record?.status).toBe("awaiting_approval");
    });

    it("detects modification of target destination and alters canonical hash", () => {
      const baseInput = {
        installationId: "install_test",
        ownerId: "owner_1",
        conversationId: "conv_1",
        operation: "move_file",
        targets: [
          {
            service: "filesystem",
            rootId: "tv",
            relativePath: "show/ep1.mkv",
            observedState: "present",
          },
        ],
        effects: [
          {
            serviceAction: "file.move",
            destination: "/valid/target/ep1.mkv",
            irreversibleLoss: false,
          },
        ],
      };

      const plan1 = buildOperationPlan(baseInput);

      // Modified destination
      const modifiedInput = {
        ...baseInput,
        effects: [
          {
            serviceAction: "file.move",
            destination: "/attacker/target/escaped.mkv",
            irreversibleLoss: false,
          },
        ],
      };

      const plan2 = buildOperationPlan(modifiedInput);

      expect(plan1.manifestHash).not.toBe(plan2.manifestHash);
      expect(computePlanManifestHash(plan1)).toBe(plan1.manifestHash);
      expect(computePlanManifestHash(plan2)).toBe(plan2.manifestHash);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // OP-04: Post-crash reconciliation preserves state and prevents duplicate effects
  // ──────────────────────────────────────────────────────────────────────────
  describe("OP-04: Crash reconciliation and lease recovery", () => {
    it("marks running plans with dead processes as interrupted and cleans up orphan leases", () => {
      const plan = buildOperationPlan({
        installationId: "install_test",
        ownerId: "owner_1",
        conversationId: "conv_1",
        operation: "delete_batch",
        targets: [
          {
            service: "sonarr",
            rootId: "tv",
            relativePath: "Show/Season 1",
            observedState: "present",
          },
        ],
        effects: [
          { serviceAction: "file.delete", irreversibleLoss: true },
        ],
      });

      store.createPlan(plan, "awaiting_approval");
      store.approveAndEnqueue(plan.id, ownerPrincipal, plan.manifestHash);

      // Worker claims the plan and starts execution
      const claimed = store.claimNextQueuedPlan("dead_worker_pid_9999", 5000);
      expect(claimed?.status).toBe("running");
      expect(claimed?.leaseOwner).toBe("dead_worker_pid_9999");

      // Acquire an entity resource lease
      store.acquireResourceLease("root:tv", "dead_worker_pid_9999", -1000); // already expired

      // Crash occurs! Server restarts and runs startup reconciliation
      const summary = reconcilePostCrash(db, store);

      expect(summary.interruptedPlans).toContain(plan.id);
      expect(summary.cleanedLeasesCount).toBeGreaterThanOrEqual(1);

      // Verify the interrupted plan state
      const reconciledRecord = store.getPlan(plan.id);
      expect(reconciledRecord?.status).toBe("interrupted");
      expect(reconciledRecord?.leaseOwner).toBeUndefined();
      expect(reconciledRecord?.statusReason).toContain("Process restarted during execution");

      // Verify it cannot be claimed again as queued without human re-evaluation
      const newClaim = store.claimNextQueuedPlan("new_worker_pid_1000");
      expect(newClaim).toBeUndefined();
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // OP-05: Tenant & Owner scoping prevents unauthorized approval
  // ──────────────────────────────────────────────────────────────────────────
  describe("OP-05: Scope and owner boundary verification", () => {
    it("rejects approval when attempted by a different owner principal", () => {
      const plan = buildOperationPlan({
        installationId: "install_test",
        ownerId: "owner_1",
        conversationId: "conv_1",
        operation: "purge_quarantine",
        targets: [],
        effects: [{ serviceAction: "purge", irreversibleLoss: true }],
      });

      store.createPlan(plan, "awaiting_approval");

      // Attempt approval by owner_2 for owner_1's plan
      expect(() => {
        store.approveAndEnqueue(plan.id, otherOwnerPrincipal, plan.manifestHash);
      }).toThrowError(/Plan does not belong to the approving owner/);

      const record = store.getPlan(plan.id);
      expect(record?.status).toBe("awaiting_approval");
    });

    it("rejects approval when installationId does not match", () => {
      const plan = buildOperationPlan({
        installationId: "alien_installation_id",
        ownerId: "owner_1",
        conversationId: "conv_1",
        operation: "purge_quarantine",
        targets: [],
        effects: [{ serviceAction: "purge", irreversibleLoss: true }],
      });

      store.createPlan(plan, "awaiting_approval");

      expect(() => {
        store.approveAndEnqueue(plan.id, ownerPrincipal, plan.manifestHash);
      }).toThrowError(/installationId does not match/);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // OP-06: SQLite schema, migration and transaction semantics
  // ──────────────────────────────────────────────────────────────────────────
  describe("OP-06: Database migrations and transaction rollback", () => {
    it("enforces schema versioning and enables foreign key integrity", () => {
      const versionRow = db.prepare("PRAGMA user_version;").get<{ user_version: number }>();
      expect(versionRow?.user_version).toBe(1);

      const fkRow = db.prepare("PRAGMA foreign_keys;").get<{ foreign_keys: number }>();
      expect(fkRow?.foreign_keys).toBe(1);
    });

    it("rolls back atomic changes when an error occurs inside a transaction", () => {
      const plan = buildOperationPlan({
        installationId: "install_test",
        ownerId: "owner_1",
        conversationId: "conv_1",
        operation: "test_rollback",
        targets: [],
        effects: [{ serviceAction: "act", irreversibleLoss: false }],
      });

      store.createPlan(plan, "awaiting_approval");

      expect(() => {
        db.transaction(() => {
          db.prepare("UPDATE operation_plans SET status = 'queued' WHERE id = ?").run(plan.id);
          throw new Error("Simulated unexpected crash during step persistence");
        });
      }).toThrowError(/Simulated unexpected crash/);

      // Verify transaction was rolled back cleanly
      const record = store.getPlan(plan.id);
      expect(record?.status).toBe("awaiting_approval");
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // OP-07: Plan expiration, cancellation, and execution lifecycle
  // ──────────────────────────────────────────────────────────────────────────
  describe("OP-07: Expiration, cancellation, and execution progress", () => {
    it("expires unapproved plan after 5-minute TTL and rejects approval", () => {
      // Build plan with 1ms TTL (already expired)
      const plan = buildOperationPlan({
        installationId: "install_test",
        ownerId: "owner_1",
        conversationId: "conv_1",
        operation: "expired_action",
        targets: [],
        effects: [{ serviceAction: "test", irreversibleLoss: false }],
        ttlMs: -1000, // expired 1 sec ago
      });

      store.createPlan(plan, "planned");

      // Dynamic expiration check
      const record = store.getPlan(plan.id);
      expect(record?.status).toBe("expired");

      // Attempting to approve an expired plan throws PlanExpiredError (410)
      expect(() => {
        store.approveAndEnqueue(plan.id, ownerPrincipal, plan.manifestHash);
      }).toThrowError(/Plan has expired and cannot be approved/);
    });

    it("allows owner to cancel an unapproved or queued plan", () => {
      const plan = buildOperationPlan({
        installationId: "install_test",
        ownerId: "owner_1",
        conversationId: "conv_1",
        operation: "cancel_me",
        targets: [],
        effects: [{ serviceAction: "test", irreversibleLoss: false }],
      });

      store.createPlan(plan, "awaiting_approval");
      const cancelled = store.cancelPlan(plan.id, ownerPrincipal, "Owner changed mind");

      expect(cancelled.status).toBe("cancelled");
      expect(cancelled.statusReason).toBe("Owner changed mind");
    });

    it("executes steps via OperationExecutor and records atomic progress to succeeded", async () => {
      const plan = buildOperationPlan({
        installationId: "install_test",
        ownerId: "owner_1",
        conversationId: "conv_1",
        operation: "full_flow",
        targets: [
          {
            service: "filesystem",
            rootId: "movies",
            relativePath: "movie.mkv",
            observedState: "present",
          },
        ],
        effects: [
          { serviceAction: "inspect", irreversibleLoss: false },
          { serviceAction: "remux", irreversibleLoss: false },
        ],
      });

      store.createPlan(plan, "awaiting_approval");
      store.approveAndEnqueue(plan.id, ownerPrincipal, plan.manifestHash);

      const executor = new OperationExecutor(store, { workerId: "test_worker_1" });

      // Every step needs a registered handler: unknown actions fail closed (executor-hardening.test.ts).
      executor.registerStepHandler("inspect", async () => ({ inspected: true }));
      let remuxExecuted = false;
      executor.registerStepHandler("remux", async (step) => {
        remuxExecuted = true;
        return { bytesProcessed: 1048576 };
      });

      // Poll and execute
      await executor.pollAndExecute();

      expect(remuxExecuted).toBe(true);

      const finished = store.getPlan(plan.id);
      expect(finished?.status).toBe("succeeded");
      expect(finished?.currentStep).toBe(2);
      expect(finished?.totalSteps).toBe(2);
      expect(finished?.steps?.[0].status).toBe("completed");
      expect(finished?.steps?.[1].status).toBe("completed");
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // HTTP REST API Integration
  // ──────────────────────────────────────────────────────────────────────────
  describe("HTTP REST API: /api/operations", () => {
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

    it("POST /api/operations/plans permits agent to propose a plan", async () => {
      const res = await fetch(`${baseUrl}/api/operations/plans`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${AGENT_API_KEY}`,
        },
        body: JSON.stringify({
          operation: "propose_cleanup",
          targets: [
            {
              service: "sonarr",
              rootId: "tv",
              relativePath: "Sample/sample.mkv",
              observedState: "sample",
            },
          ],
          effects: [
            {
              serviceAction: "file.delete",
              irreversibleLoss: true,
            },
          ],
        }),
      });

      expect(res.status).toBe(201);
      const data = (await res.json()) as any;
      expect(data.plan.operation).toBe("propose_cleanup");
      expect(data.status).toBe("awaiting_approval");
    });

    it("POST /api/operations/plans/:id/approve rejects agent with 403 ERR_FORBIDDEN_AGENT", async () => {
      // First create a plan as agent
      const createRes = await fetch(`${baseUrl}/api/operations/plans`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${AGENT_API_KEY}`,
        },
        body: JSON.stringify({
          operation: "propose_delete",
          targets: [],
          effects: [{ serviceAction: "delete", irreversibleLoss: true }],
        }),
      });

      const createData = (await createRes.json()) as any;
      const planId = createData.plan.id;
      const manifestHash = createData.plan.manifestHash;

      // Agent tries to approve
      const approveRes = await fetch(`${baseUrl}/api/operations/plans/${planId}/approve`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${AGENT_API_KEY}`,
        },
        body: JSON.stringify({ manifestHash }),
      });

      expect(approveRes.status).toBe(403);
      const approveData = (await approveRes.json()) as any;
      expect(approveData.code).toBe("ERR_FORBIDDEN_AGENT");
    });

    it("POST /api/operations/plans/:id/approve succeeds for owner-ui with correct hash", async () => {
      // Create plan
      const createRes = await fetch(`${baseUrl}/api/operations/plans`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${INTERNAL_API_KEY}`,
        },
        body: JSON.stringify({
          operation: "owner_action",
          targets: [],
          effects: [{ serviceAction: "action", irreversibleLoss: false }],
        }),
      });

      const createData = (await createRes.json()) as any;
      const planId = createData.plan.id;
      const manifestHash = createData.plan.manifestHash;

      // Owner approves
      const approveRes = await fetch(`${baseUrl}/api/operations/plans/${planId}/approve`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${INTERNAL_API_KEY}`,
        },
        body: JSON.stringify({ manifestHash }),
      });

      expect(approveRes.status).toBe(200);
      const approveData = (await approveRes.json()) as any;
      expect(approveData.status).toBe("queued");
      expect(approveData.approvedAt).toBeDefined();
    });
  });
});
