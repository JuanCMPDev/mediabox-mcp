import type { DatabaseAdapter, RunResult, StatementAdapter } from "./contract.js";

export class BunSqliteAdapter implements DatabaseAdapter {
  private db: any;

  constructor(location: string = ":memory:") {
    // Dynamically acquire Bun's Database to allow typecheck and build in Node environments
    // @ts-ignore
    const { Database } = typeof Bun !== "undefined" ? Bun : require("bun:sqlite");
    this.db = new Database(location);
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
