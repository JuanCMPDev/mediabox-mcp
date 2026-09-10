/**
 * Uniform SQLite Database Adapter Interface for Mediabox Operations.
 *
 * Provides a portable interface across `node:sqlite` (Node.js 22+)
 * and `bun:sqlite` (Bun and compiled sidecars).
 */

export interface RunResult {
  changes: number;
  lastInsertRowid: number | bigint;
}

export interface StatementAdapter {
  run(...params: unknown[]): RunResult;
  get<T = unknown>(...params: unknown[]): T | undefined;
  all<T = unknown>(...params: unknown[]): T[];
}

export interface DatabaseAdapter {
  exec(sql: string): void;
  prepare(sql: string): StatementAdapter;
  transaction<T>(fn: () => T): T;
  close(): void;
}
