import { describe, it, expect, beforeEach } from "vitest";
import { NodeSqliteAdapter } from "../operations/sqlite/node-adapter.js";
import { initializeOperationsSchema } from "../operations/schema.js";
import { SqliteWorkflowStore } from "./workflow-store.js";
import { createInitialWorkflowState } from "@mediabox/chat-core";

describe("SqliteWorkflowStore (§2.2 / AGT-06)", () => {
  let db: NodeSqliteAdapter;
  let store: SqliteWorkflowStore;

  beforeEach(() => {
    db = new NodeSqliteAdapter(":memory:");
    initializeOperationsSchema(db);
    store = new SqliteWorkflowStore(db);
  });

  it("returns null for non-existent conversation", () => {
    expect(store.get("non_existent")).toBeNull();
  });

  it("persists and retrieves workflow state accurately", () => {
    const state = createInitialWorkflowState("conv_123", "user_1", "inst_1");
    state.phase = "select";
    state.references.mediaRef = "mref_1234567890ab";

    store.set("conv_123", state);

    const retrieved = store.get("conv_123");
    expect(retrieved).toBeDefined();
    expect(retrieved?.conversationId).toBe("conv_123");
    expect(retrieved?.phase).toBe("select");
    expect(retrieved?.references.mediaRef).toBe("mref_1234567890ab");
  });

  it("updates existing workflow state on subsequent sets", () => {
    const state = createInitialWorkflowState("conv_123", "user_1", "inst_1");
    store.set("conv_123", state);

    state.phase = "propose";
    state.references.releaseRef = "rref_aabbccddeeff";
    store.set("conv_123", state);

    const retrieved = store.get("conv_123");
    expect(retrieved?.phase).toBe("propose");
    expect(retrieved?.references.releaseRef).toBe("rref_aabbccddeeff");
  });

  it("deletes workflow state on delete", () => {
    const state = createInitialWorkflowState("conv_123", "user_1", "inst_1");
    store.set("conv_123", state);
    expect(store.get("conv_123")).not.toBeNull();

    store.delete("conv_123");
    expect(store.get("conv_123")).toBeNull();
  });
});
