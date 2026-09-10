import { Router } from "express";
import type { OperationStore } from "../operations/store.js";
import {
  OperationStoreError,
  ManifestHashMismatchError,
  PlanExpiredError,
  ForbiddenScopeError,
} from "../operations/store.js";
import { requirePolicy } from "../security/policy.js";
import { buildOperationPlan } from "../operations/planner.js";
import type { OperationPlan } from "@mediabox/contracts";

export function createOperationsRouter(store: OperationStore): Router {
  const router = Router();

  /**
   * POST /api/operations/plans
   * Proposes/registers a new plan. Permitted for agent-session and owner-ui.
   */
  router.post("/plans", requirePolicy("operations", "propose"), (req, res) => {
    try {
      const principal = req.principal!;
      const body = req.body;

      if (!body.operation || !Array.isArray(body.targets) || !Array.isArray(body.effects)) {
        res.status(400).json({
          error: "Invalid plan payload: operation, targets, and effects are required",
          code: "ERR_INVALID_PLAN_PAYLOAD",
        });
        return;
      }

      let plan: OperationPlan;
      if (body.manifestHash) {
        // Plan already built and hashed by client/caller
        plan = body as OperationPlan;
      } else {
        // Build plan and calculate canonical hash
        plan = buildOperationPlan({
          installationId: principal.installationId,
          ownerId: principal.kind === "owner-ui" || principal.kind === "owner" ? principal.id : body.ownerId || principal.id,
          conversationId: body.conversationId || `conv_${Date.now()}`,
          operation: body.operation,
          targets: body.targets,
          effects: body.effects,
          preconditions: body.preconditions,
          recovery: body.recovery,
          ttlMs: body.ttlMs,
        });
      }

      const record = store.createPlan(plan, "awaiting_approval");
      res.status(201).json(record);
    } catch (err: any) {
      if (err instanceof OperationStoreError) {
        res.status(err.status).json({ error: err.message, code: err.code });
        return;
      }
      res.status(500).json({ error: err?.message || "Internal server error", code: "ERR_INTERNAL" });
    }
  });

  /**
   * GET /api/operations/plans
   * Lists operation summaries with optional filtering.
   */
  router.get("/plans", requirePolicy("operations", "read"), (req, res) => {
    try {
      const conversationId = typeof req.query.conversationId === "string" ? req.query.conversationId : undefined;
      const status = typeof req.query.status === "string" ? (req.query.status as any) : undefined;
      const limit = req.query.limit ? parseInt(String(req.query.limit), 10) : undefined;
      const offset = req.query.offset ? parseInt(String(req.query.offset), 10) : undefined;

      const plans = store.listPlans({ conversationId, status, limit, offset });
      res.json({ plans });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || "Internal server error", code: "ERR_INTERNAL" });
    }
  });

  /**
   * GET /api/operations/plans/:id
   * Retrieves full details and execution progress of a plan.
   */
  router.get("/plans/:id", requirePolicy("operations", "read"), (req, res) => {
    try {
      const planId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
      const plan = store.getPlan(planId);
      if (!plan) {
        res.status(404).json({ error: "Operation plan not found", code: "ERR_PLAN_NOT_FOUND" });
        return;
      }
      res.json(plan);
    } catch (err: any) {
      res.status(500).json({ error: err?.message || "Internal server error", code: "ERR_INTERNAL" });
    }
  });

  /**
   * POST /api/operations/plans/:id/approve
   * Approves and atomically enqueues a plan (§4.2 / INV-APPROVAL).
   * Strictly restricted to owner-ui!
   */
  router.post("/plans/:id/approve", requirePolicy("operations", "approve"), (req, res) => {
    try {
      const principal = req.principal!;
      const planId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
      const { manifestHash } = req.body || {};

      if (!manifestHash) {
        res.status(400).json({
          error: "manifestHash is required for operation approval",
          code: "ERR_MANIFEST_HASH_REQUIRED",
        });
        return;
      }

      const record = store.approveAndEnqueue(planId, principal, manifestHash);
      res.json(record);
    } catch (err: any) {
      if (err instanceof OperationStoreError) {
        res.status(err.status).json({ error: err.message, code: err.code });
        return;
      }
      res.status(500).json({ error: err?.message || "Internal server error", code: "ERR_INTERNAL" });
    }
  });

  /**
   * POST /api/operations/plans/:id/reject
   * Rejects an unapproved plan. Restricted to owner-ui.
   */
  router.post("/plans/:id/reject", requirePolicy("operations", "approve"), (req, res) => {
    try {
      const principal = req.principal!;
      const planId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
      const reason = req.body?.reason || "Rejected by owner";
      const record = store.rejectPlan(planId, principal, reason);
      res.json(record);
    } catch (err: any) {
      if (err instanceof OperationStoreError) {
        res.status(err.status).json({ error: err.message, code: err.code });
        return;
      }
      res.status(500).json({ error: err?.message || "Internal server error", code: "ERR_INTERNAL" });
    }
  });

  /**
   * POST /api/operations/plans/:id/cancel
   * Cancels a pending, queued, or running plan. Restricted to owner-ui.
   */
  router.post("/plans/:id/cancel", requirePolicy("operations", "approve"), (req, res) => {
    try {
      const principal = req.principal!;
      const planId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
      const reason = req.body?.reason || "Cancelled by owner";
      const record = store.cancelPlan(planId, principal, reason);
      res.json(record);
    } catch (err: any) {
      if (err instanceof OperationStoreError) {
        res.status(err.status).json({ error: err.message, code: err.code });
        return;
      }
      res.status(500).json({ error: err?.message || "Internal server error", code: "ERR_INTERNAL" });
    }
  });

  return router;
}
