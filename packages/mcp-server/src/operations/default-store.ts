import path from "node:path";
import { createDatabaseAdapter } from "./sqlite/factory.js";
import { OperationStore } from "./store.js";
import { reconcilePostCrash } from "./reconcile.js";

const dbPath = process.env.OPERATIONS_DB_PATH || (process.env.NODE_ENV === "test" ? ":memory:" : path.resolve(process.cwd(), ".mediabox-operations.db"));
export const defaultDatabaseAdapter = createDatabaseAdapter(dbPath);
export const defaultOperationStore = new OperationStore(defaultDatabaseAdapter);

// Perform startup post-crash reconciliation (§4.2 / OP-04)
reconcilePostCrash(defaultDatabaseAdapter, defaultOperationStore);
