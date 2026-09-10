import type { DatabaseAdapter } from "./sqlite/contract.js";

export const CURRENT_SCHEMA_VERSION = 1;

export function initializeOperationsSchema(db: DatabaseAdapter): void {
  // Enforce foreign keys
  db.exec("PRAGMA foreign_keys = ON;");

  const row = db.prepare("PRAGMA user_version;").get<{ user_version: number }>();
  const currentVersion = row?.user_version ?? 0;

  if (currentVersion < 1) {
    db.transaction(() => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS operation_plans (
          id TEXT PRIMARY KEY,
          schema_version INTEGER NOT NULL,
          installation_id TEXT NOT NULL,
          owner_id TEXT NOT NULL,
          conversation_id TEXT NOT NULL,
          operation TEXT NOT NULL,
          manifest_version INTEGER NOT NULL,
          manifest_hash TEXT NOT NULL,
          created_at TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          policy_version TEXT NOT NULL,
          snapshot_id TEXT NOT NULL,
          plan_json TEXT NOT NULL,
          status TEXT NOT NULL,
          status_reason TEXT,
          approved_at TEXT,
          approved_by TEXT,
          queued_at TEXT,
          started_at TEXT,
          finished_at TEXT,
          current_step INTEGER DEFAULT 0,
          total_steps INTEGER DEFAULT 0,
          lease_owner TEXT,
          lease_expires_at INTEGER
        );

        CREATE INDEX IF NOT EXISTS idx_operation_plans_status ON operation_plans(status);
        CREATE INDEX IF NOT EXISTS idx_operation_plans_conversation ON operation_plans(conversation_id);
        CREATE INDEX IF NOT EXISTS idx_operation_plans_expires ON operation_plans(expires_at);

        CREATE TABLE IF NOT EXISTS operation_steps (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          plan_id TEXT NOT NULL REFERENCES operation_plans(id) ON DELETE CASCADE,
          step_number INTEGER NOT NULL,
          action TEXT NOT NULL,
          status TEXT NOT NULL,
          started_at TEXT,
          completed_at TEXT,
          error TEXT,
          details_json TEXT,
          UNIQUE(plan_id, step_number)
        );

        CREATE TABLE IF NOT EXISTS operation_leases (
          resource_id TEXT PRIMARY KEY,
          lease_owner TEXT NOT NULL,
          acquired_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL
        );

        PRAGMA user_version = 1;
      `);
    });
  }
}
