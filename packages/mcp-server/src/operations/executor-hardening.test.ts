/**
 * Gate G03 additions: the executor fails closed, honours cancellation while a
 * step runs, distinguishes unknown outcomes, verifies before `succeeded`,
 * serialises work per resource, and REST proposals carry the owner identity.
 */
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from "vitest";
import type { Server } from "node:http";
import type { Principal, OperationPlanRecord } from "@mediabox/contracts";
import { NodeSqliteAdapter } from "./sqlite/node-adapter.js";
import { OperationStore } from "./store.js";
import { buildOperationPlan } from "./planner.js";
import { OperationExecutor, UnknownOutcomeError, resourceIdsForPlan } from "./executor.js";
import { OWNER_PRINCIPAL_ID } from "../security/context.js";
import { defaultSessionManager } from "../security/session.js";
import { INTERNAL_API_KEY, AGENT_API_KEY } from "../auth.js";

const owner: Principal = {
  id: OWNER_PRINCIPAL_ID,
  installationId: "install_test",
  kind: "owner-ui",
  capabilities: ["*"],
  audience: "mediabox-local",
  sessionId: "owner_session",
  expiresAt: Date.now() + 3_600_000,
  credentialVersion: 1,
};

function planWith(effects: Array<{ serviceAction: string }>, operation = "test_operation") {
  return buildOperationPlan({
    installationId: "install_test",
    ownerId: OWNER_PRINCIPAL_ID,
    conversationId: "conv",
    operation,
    targets: [{ service: "storage", rootId: "media", relativePath: "tv/x.mkv", observedState: "present" }],
    effects: effects.map((e) => ({ targetIndex: 0, serviceAction: e.serviceAction, irreversibleLoss: false })),
  });
}

describe("Executor hardening", () => {
  let store: OperationStore;

  beforeEach(() => {
    store = new OperationStore(new NodeSqliteAdapter(":memory:"));
  });

  function approved(plan: ReturnType<typeof planWith>) {
    store.createPlan(plan, "awaiting_approval");
    store.approveAndEnqueue(plan.id, owner, plan.manifestHash);
    return plan;
  }

  it("fails closed when a step has no registered handler (nothing is simulated)", async () => {
    const plan = approved(planWith([{ serviceAction: "nobody.registered" }]));
    const executor = new OperationExecutor(store, { workerId: "w1", heartbeatMs: 20 });
    await executor.pollAndExecute();
    const record = store.getPlan(plan.id)!;
    expect(record.status).toBe("failed");
    expect(record.steps![0].status).toBe("failed");
    expect(record.steps![0].error).toContain("ERR_NO_HANDLER");
  });

  it("ends partial when a later step fails after a completed one", async () => {
    const plan = approved(planWith([{ serviceAction: "ok.step" }, { serviceAction: "bad.step" }]));
    const executor = new OperationExecutor(store, { workerId: "w1", heartbeatMs: 20 });
    executor.registerStepHandler("ok.step", async () => ({ done: true }));
    executor.registerStepHandler("bad.step", async () => {
      throw new Error("boom");
    });
    await executor.pollAndExecute();
    const record = store.getPlan(plan.id)!;
    expect(record.status).toBe("partial");
    expect(record.statusReason).toMatch(/boom/);
    expect(record.steps![0].status).toBe("completed");
    expect(record.steps![1].status).toBe("failed");
  });

  it("aborts the running step when cancellation is requested and ends cancelled, never succeeded", async () => {
    const plan = approved(planWith([{ serviceAction: "slow.step" }]));
    const executor = new OperationExecutor(store, { workerId: "w1", heartbeatMs: 20 });
    let sawAbort = false;
    executor.registerStepHandler("slow.step", async (_step, ctx) => {
      await new Promise<void>((_resolve, reject) => {
        ctx.signal.addEventListener("abort", () => {
          sawAbort = true;
          reject(new Error("process killed"));
        });
      });
    });

    const running = executor.pollAndExecute();
    await new Promise((r) => setTimeout(r, 30));
    const requested = store.cancelPlan(plan.id, owner, "user cancelled");
    expect(requested.status).toBe("cancel_requested");
    await running;

    const record = store.getPlan(plan.id)!;
    expect(sawAbort).toBe(true);
    expect(record.status).toBe("cancelled");
    expect(record.steps![0].status).toBe("failed");
    expect(record.statusReason).toMatch(/terminated/);
  });

  it("ends unknown_outcome on UnknownOutcomeError and never re-runs the plan", async () => {
    const plan = approved(planWith([{ serviceAction: "grab.step" }]));
    const executor = new OperationExecutor(store, { workerId: "w1", heartbeatMs: 20 });
    let calls = 0;
    executor.registerStepHandler("grab.step", async () => {
      calls += 1;
      throw new UnknownOutcomeError("timeout after submission", { guid: "g" });
    });
    await executor.pollAndExecute();
    expect(store.getPlan(plan.id)!.status).toBe("unknown_outcome");
    expect(store.getPlan(plan.id)!.steps![0].details).toEqual({ guid: "g" });
    expect(await executor.pollAndExecute()).toBeUndefined();
    expect(calls).toBe(1);
  });

  it("runs the operation verifier in `verifying` and reports partial when verification fails", async () => {
    const good = approved(planWith([{ serviceAction: "ok.step" }], "verified_op"));
    const executor = new OperationExecutor(store, { workerId: "w1", heartbeatMs: 20 });
    executor.registerStepHandler("ok.step", async () => ({ done: true }));
    let verifierSeenStatus: string | undefined;
    executor.registerVerifier("verified_op", async (record, results) => {
      verifierSeenStatus = record.status;
      return results[0]?.done === true ? { ok: true, reason: "checked" } : { ok: false, reason: "missing" };
    });
    await executor.pollAndExecute();
    expect(verifierSeenStatus).toBe("verifying");
    expect(store.getPlan(good.id)!.status).toBe("succeeded");

    const failing = approved(planWith([{ serviceAction: "ok.step" }], "verified_fail"));
    executor.registerVerifier("verified_fail", async () => ({ ok: false, reason: "output missing" }));
    await executor.pollAndExecute();
    const record = store.getPlan(failing.id)!;
    expect(record.status).toBe("partial");
    expect(record.statusReason).toBe("output missing");
  });

  it("requeues a plan whose resource lease is held by another plan", async () => {
    const plan = approved(planWith([{ serviceAction: "ok.step" }]));
    const [resource] = resourceIdsForPlan(store.getPlan(plan.id)!);
    expect(store.acquireResourceLease(resource, "other_plan", 60_000)).toBe(true);

    const executor = new OperationExecutor(store, { workerId: "w1", heartbeatMs: 20 });
    let ran = false;
    executor.registerStepHandler("ok.step", async () => {
      ran = true;
      return {};
    });
    await executor.pollAndExecute();
    expect(ran).toBe(false);
    expect(store.getPlan(plan.id)!.status).toBe("queued");
    expect(store.getPlan(plan.id)!.statusReason).toMatch(/resource lease/);

    store.releaseResourceLease(resource, "other_plan");
    await executor.pollAndExecute();
    expect(ran).toBe(true);
    expect(store.getPlan(plan.id)!.status).toBe("succeeded");
  });

  it("notifies finalized listeners with the terminal record", async () => {
    const plan = approved(planWith([{ serviceAction: "ok.step" }]));
    const executor = new OperationExecutor(store, { workerId: "w1", heartbeatMs: 20 });
    executor.registerStepHandler("ok.step", async () => ({}));
    const seen: string[] = [];
    executor.onPlanFinalized((r) => seen.push(`${r.plan.id}:${r.status}`));
    await executor.pollAndExecute();
    expect(seen).toEqual([`${plan.id}:succeeded`]);
  });
});

describe("REST proposals carry the owner identity (OP-05 / finding 1)", () => {
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

  const body = {
    operation: "rest_test",
    targets: [{ service: "storage", rootId: "media", relativePath: "tv/never-executed.mkv", observedState: "present" }],
    effects: [{ targetIndex: 0, serviceAction: "no.handler.on.purpose", irreversibleLoss: false }],
  };

  it("an agent proposal is stored with the installation owner and a delegated owner-ui session approves it", async () => {
    const proposed = await fetch(`${baseUrl}/api/operations/plans`, {
      method: "POST",
      headers: { Authorization: `Bearer ${AGENT_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ ...body, ownerId: "attacker" }),
    });
    expect(proposed.status).toBe(201);
    const record = (await proposed.json()) as OperationPlanRecord;
    expect(record.status).toBe("awaiting_approval");
    expect(record.plan.ownerId).toBe(OWNER_PRINCIPAL_ID);
    expect(record.plan.installationId).toBe(defaultSessionManager.getInstallationId());

    const session = await fetch(`${baseUrl}/api/auth/sessions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${INTERNAL_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "owner-ui", ttlMs: 60_000 }),
    });
    const { token } = (await session.json()) as { token: string };
    const approve = await fetch(`${baseUrl}/api/operations/plans/${record.plan.id}/approve`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ manifestHash: record.plan.manifestHash }),
    });
    expect(approve.status).toBe(200);
  });

  it("a pre-hashed plan with a foreign scope is rejected before storage", async () => {
    const plan = buildOperationPlan({
      installationId: "another-installation",
      ownerId: OWNER_PRINCIPAL_ID,
      conversationId: "c",
      operation: body.operation,
      targets: body.targets,
      effects: body.effects,
    });
    const res = await fetch(`${baseUrl}/api/operations/plans`, {
      method: "POST",
      headers: { Authorization: `Bearer ${AGENT_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify(plan),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).code).toBe("ERR_PLAN_SCOPE_MISMATCH");
  });

  it("lists plans filtered by a status set", async () => {
    const res = await fetch(`${baseUrl}/api/operations/plans?statuses=awaiting_approval,queued,running&limit=5`, {
      headers: { Authorization: `Bearer ${INTERNAL_API_KEY}` },
    });
    expect(res.status).toBe(200);
    const { plans } = (await res.json()) as { plans: Array<{ status: string }> };
    expect(plans.every((p) => ["awaiting_approval", "queued", "running"].includes(p.status))).toBe(true);
  });
});
