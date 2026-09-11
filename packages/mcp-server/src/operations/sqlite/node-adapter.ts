import { createRequire } from "node:module";
import type { DatabaseSync } from "node:sqlite";
import type { DatabaseAdapter, RunResult, StatementAdapter } from "./contract.js";

export class NodeSqliteAdapter implements DatabaseAdapter {
  private db: DatabaseSync;

  constructor(location: string = ":memory:") {
    const req = createRequire(import.meta.url);
    const { DatabaseSync: NativeDatabaseSync } = req("node:sqlite");
    this.db = new NativeDatabaseSync(location);
    this.db.exec("PRAGMA foreign_keys = ON;");
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  prepare(sql: string): StatementAdapter {
    const stmt = this.db.prepare(sql);
    return {
      run(...params: unknown[]): RunResult {
        const res = stmt.run(...(params as any[]));
        return {
          changes: Number(res.changes),
          lastInsertRowid: res.lastInsertRowid,
        };
      },
      get<T = unknown>(...params: unknown[]): T | undefined {
        const row = stmt.get(...(params as any[]));
        return (row ?? undefined) as T | undefined;
      },
      all<T = unknown>(...params: unknown[]): T[] {
        return stmt.all(...(params as any[])) as T[];
      },
    };
  }

  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE;");
    try {
      const result = fn();
      this.db.exec("COMMIT;");
      return result;
    } catch (err) {
      try {
        this.db.exec("ROLLBACK;");
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
