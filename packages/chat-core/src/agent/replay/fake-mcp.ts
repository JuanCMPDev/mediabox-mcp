/* ─── Fake MCP Server with Call Ledger ───────────────────────────────────────
 * Serves deterministic fixtures and records every dispatched tool call (§2.11).
 *
 * An unexpected call is recorded as well as thrown: the dispatcher turns the throw
 * into an error result for the model, so the scenario runner needs the record to
 * fail the scenario (§2.11 "cualquier llamada no esperada falla el escenario").
 * ──────────────────────────────────────────────────────────────────────── */
import type { McpCallFn } from '../../types.js';

export interface LedgerEntry {
  tool: string;
  args: Record<string, unknown>;
  /** Sequence number instead of a wall clock, so ledgers are comparable across runs. */
  seq: number;
}

export interface FakeMcpOptions {
  /** Delay before a fixture resolves, to let a cancellation land mid-call. */
  delayMs?: number;
}

export class FakeMcp {
  readonly ledger: LedgerEntry[] = [];
  readonly unexpectedCalls: string[] = [];
  private fixtures: Record<string, string>;
  private delayMs: number;
  private seq = 0;

  constructor(initialFixtures: Record<string, string> = {}, options: FakeMcpOptions = {}) {
    this.fixtures = { ...initialFixtures };
    this.delayMs = options.delayMs ?? 0;
  }

  setFixtures(fixtures: Record<string, string>): void {
    this.fixtures = { ...fixtures };
  }

  addFixtures(fixtures: Record<string, string>): void {
    this.fixtures = { ...this.fixtures, ...fixtures };
  }

  setDelay(delayMs: number): void {
    this.delayMs = delayMs;
  }

  get callFn(): McpCallFn {
    return async (toolName: string, args: Record<string, unknown>, opts): Promise<string> => {
      this.ledger.push({
        tool: toolName,
        args: JSON.parse(JSON.stringify(args)),
        seq: this.seq++,
      });

      if (this.delayMs > 0) {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, this.delayMs);
          opts?.signal?.addEventListener(
            'abort',
            () => {
              clearTimeout(timer);
              reject(new Error('FakeMcp: call aborted by signal'));
            },
            { once: true },
          );
        });
      }

      const response = this.fixtures[toolName];
      if (response !== undefined) return response;

      // Exact key with arguments: toolName:{"query":"Dark"}
      const fullKey = `${toolName}:${JSON.stringify(args)}`;
      if (this.fixtures[fullKey] !== undefined) return this.fixtures[fullKey];

      const description = `${toolName} ${JSON.stringify(args)}`;
      this.unexpectedCalls.push(description);
      throw new Error(`FakeMcp: unexpected tool call '${description}'`);
    };
  }

  clearLedger(): void {
    this.ledger.length = 0;
    this.seq = 0;
  }
}
