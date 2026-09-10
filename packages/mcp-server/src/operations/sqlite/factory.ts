import type { DatabaseAdapter } from "./contract.js";
import { NodeSqliteAdapter } from "./node-adapter.js";
import { BunSqliteAdapter } from "./bun-adapter.js";

export type SqliteRuntime = "node" | "bun";

export function detectSqliteRuntime(): SqliteRuntime {
  // @ts-ignore
  if (typeof Bun !== "undefined" || (typeof process !== "undefined" && process.versions?.bun)) {
    return "bun";
  }
  return "node";
}

export function createDatabaseAdapter(
  location: string = ":memory:",
  forceRuntime?: SqliteRuntime
): DatabaseAdapter {
  const runtime = forceRuntime || detectSqliteRuntime();
  if (runtime === "bun") {
    return new BunSqliteAdapter(location);
  }
  return new NodeSqliteAdapter(location);
}
