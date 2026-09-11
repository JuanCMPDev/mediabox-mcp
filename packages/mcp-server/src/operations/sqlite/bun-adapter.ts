import type { DatabaseAdapter, RunResult, StatementAdapter } from "./contract.js";

export class BunSqliteAdapter implements DatabaseAdapter {
  private db: any;

  constructor(location: string = ":memory:") {
    // Dynamically acquire Bun's Database to allow typecheck and build in Node environments
    // In Bun, Database is exported from "bun:sqlite"
    let DatabaseClass: any;
    try {
      // @ts-ignore
      DatabaseClass = typeof require === "function" ? require("bun:sqlite")?.Database : undefined;
    } catch {}
    if (!DatabaseClass) {
      try {
        const { createRequire } = require("node:module");
        DatabaseClass = createRequire(import.meta.url)("bun:sqlite")?.Database;
      } catch (err) {
        throw new Error(`bun:sqlite is not available: ${err}`);
      }
    }
    this.db = new DatabaseClass(location);
    this.db.run("PRAGMA foreign_keys = ON;");
  }

  exec(sql: string): void {
    this.db.run(sql);
  }

  prepare(sql: string): StatementAdapter {
    const stmt = this.db.prepare(sql);
    return {
      run(...params: unknown[]): RunResult {
        const res = stmt.run(...params);
        return {
          changes: Number(res.changes || 0),
          lastInsertRowid: res.lastInsertRowid ?? 0,
        };
      },
      get<T = unknown>(...params: unknown[]): T | undefined {
        const row = stmt.get(...params);
        return (row === null ? undefined : row) as T | undefined;
      },
      all<T = unknown>(...params: unknown[]): T[] {
        return stmt.all(...params) as T[];
      },
    };
  }

  transaction<T>(fn: () => T): T {
    this.db.run("BEGIN IMMEDIATE;");
    try {
      const result = fn();
      this.db.run("COMMIT;");
      return result;
    } catch (err) {
      try {
        this.db.run("ROLLBACK;");
      } catch {
        // preserve original error
      }
      throw err;
    }
  }

  close(): void {
    this.db.close();
  }
}
