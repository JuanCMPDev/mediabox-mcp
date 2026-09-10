import type { DatabaseAdapter } from "./sqlite/contract.js";
import type { OperationStore } from "./store.js";

export interface ReconcileSummary {
  interruptedPlans: string[];
  recoveredQueuedPlans: string[];
  cleanedLeasesCount: number;
}

/**
 * Reconciles operations state on server startup after a potential crash (§4.2 / OP-04).
 * - Identifies in-flight operations ('running', 'verifying') whose leases expired or were interrupted.
 * - Transitions them to 'interrupted' to prevent unverified duplicate external effects.
 * - Frees orphan leases and restores clean 'queued' operations.
 */
export function reconcilePostCrash(db: DatabaseAdapter, store?: OperationStore): ReconcileSummary {
  const now = Date.now();
  const interruptedPlans: string[] = [];
  const recoveredQueuedPlans: string[] = [];

  return db.transaction(() => {
    // 1. Identify un-finalized running/verifying plans whose process terminated
    const runningRows = db
      .prepare(`
        SELECT id, lease_owner, lease_expires_at
        FROM operation_plans
        WHERE status IN ('running', 'verifying')
      `)
      .all<{ id: string; lease_owner: string | null; lease_expires_at: number | null }>();

    for (const r of runningRows) {
      db.prepare(`
        UPDATE operation_plans
        SET status = 'interrupted',
            status_reason = 'Process restarted during execution; marked interrupted to prevent uncertain duplicate effects',
            finished_at = ?,
            lease_owner = NULL,
            lease_expires_at = NULL
        WHERE id = ?
      `).run(new Date().toISOString(), r.id);

      interruptedPlans.push(r.id);
    }

    // 2. Clear any stuck leases on queued plans so they can be claimed normally
    const queuedRows = db
      .prepare(`
        SELECT id FROM operation_plans
        WHERE status = 'queued' AND lease_owner IS NOT NULL
      `)
      .all<{ id: string }>();

    for (const q of queuedRows) {
      db.prepare(`
        UPDATE operation_plans
        SET lease_owner = NULL, lease_expires_at = NULL
        WHERE id = ?
      `).run(q.id);
      recoveredQueuedPlans.push(q.id);
    }

    // 3. Purge all expired resource leases
    const leaseRes = db
      .prepare(`DELETE FROM operation_leases WHERE expires_at < ?`)
      .run(now);

    return {
      interruptedPlans,
      recoveredQueuedPlans,
      cleanedLeasesCount: leaseRes.changes,
    };
  });
}
