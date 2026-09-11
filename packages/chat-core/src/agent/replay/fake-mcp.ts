/* ─── Fake MCP Server with Call Ledger ───────────────────────────────────────
 * Serves deterministic fixtures and records every dispatched tool call (§2.11).
 * ──────────────────────────────────────────────────────────────────────── */
import type { McpCallFn } from '../../types.js';

export interface LedgerEntry {
  tool: string;
  args: Record<string, unknown>;
  timestamp: number;
}

export class FakeMcp {
  readonly ledger: LedgerEntry[] = [];
  private fixtures: Record<string, string>;

  constructor(initialFixtures: Record<string, string> = {}) {
    this.fixtures = { ...initialFixtures };
  }

  setFixtures(fixtures: Record<string, string>): void {
    this.fixtures = { ...fixtures };
  }

  addFixtures(fixtures: Record<string, string>): void {
    this.fixtures = { ...this.fixtures, ...fixtures };
  }

  get callFn(): McpCallFn {
    return async (toolName: string, args: Record<string, unknown>): Promise<string> => {
      this.ledger.push({
        tool: toolName,
        args: JSON.parse(JSON.stringify(args)),
        timestamp: Date.now(),
      });

      const response = this.fixtures[toolName];
      if (response !== undefined) {
        return response;
      }

      // Check if there is an exact key with arguments: toolName:{"query":"Dark"}
      const fullKey = `${toolName}:${JSON.stringify(args)}`;
      if (this.fixtures[fullKey] !== undefined) {
        return this.fixtures[fullKey];
      }

      throw new Error(`FakeMcp: unexpected tool call '${toolName}' with args: ${JSON.stringify(args)}`);
    };
  }

  clearLedger(): void {
    this.ledger.length = 0;
  }
}
