/* ─── SQLite Workflow Store ──────────────────────────────────────────────────
 * Persists agent workflow states to the SQLite database (§2.2 / AGT-06).
 * Table: agent_workflows(conversation_id PK, principal_id, installation_id, state_json, schema_version, updated_at).
 * ──────────────────────────────────────────────────────────────────────── */
import type { WorkflowStore, WorkflowState } from "@mediabox/chat-core";
import { migrateWorkflowState, WORKFLOW_SCHEMA_VERSION } from "@mediabox/chat-core";
import type { DatabaseAdapter } from "../operations/sqlite/contract.js";

export class SqliteWorkflowStore implements WorkflowStore {
  private db: DatabaseAdapter;

  constructor(db: DatabaseAdapter) {
    this.db = db;
  }

  get(conversationId: string): WorkflowState | null {
    const row = this.db
      .prepare(`SELECT state_json, schema_version FROM agent_workflows WHERE conversation_id = ?`)
      .get<{ state_json: string; schema_version: number }>(conversationId);

    if (!row) return null;

    let parsed: unknown;
    try {
      parsed = JSON.parse(row.state_json);
    } catch (err) {
      // §6.11: a corrupt state must not take the chat down, and the plans stay intact.
      console.warn(
        `[workflow-store] ERR_WORKFLOW_CORRUPT: unreadable state for conversation ${conversationId} (${(err as Error).message}); starting a fresh state`
      );
      return null;
    }

    const migrated = migrateWorkflowState(parsed);
    if (!migrated) {
      console.warn(
        `[workflow-store] ERR_WORKFLOW_CORRUPT: discarding state with unsupported schemaVersion ${row.schema_version} for conversation ${conversationId} (supported: ${WORKFLOW_SCHEMA_VERSION})`
      );
      return null;
    }
    if (migrated.migratedFrom) {
      console.warn(
        `[workflow-store] migrated conversation ${conversationId} state from schemaVersion ${migrated.migratedFrom} to ${WORKFLOW_SCHEMA_VERSION}`
      );
    }
    return migrated.state;
  }

  set(conversationId: string, state: WorkflowState): void {
    const now = new Date().toISOString();
    const serialized = JSON.stringify(state);

    this.db
      .prepare(`
        INSERT INTO agent_workflows (conversation_id, principal_id, installation_id, state_json, schema_version, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(conversation_id) DO UPDATE SET
          principal_id = excluded.principal_id,
          installation_id = excluded.installation_id,
          state_json = excluded.state_json,
          schema_version = excluded.schema_version,
          updated_at = excluded.updated_at
      `)
      .run(
        conversationId,
        state.principalId,
        state.installationId,
        serialized,
        state.schemaVersion,
        now,
      );
  }

  delete(conversationId: string): void {
    this.db
      .prepare(`DELETE FROM agent_workflows WHERE conversation_id = ?`)
      .run(conversationId);
  }
}
