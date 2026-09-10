/**
 * P01 Security Containment
 *
 * Denies all legacy destructive / mutating media operations by default until
 * the transactional OperationPlan planner and executor (P03/P04) are active.
 *
 * Invariant INV-APPROVAL & Criteria SEC-03 / SEC-04.
 */

export class MutationContainedError extends Error {
  readonly code = "OPERATION_MUTATION_CONTAINED";
  readonly securityGate = "SEC-03";
  readonly operation: string;

  constructor(operation: string, reason?: string) {
    const msg = `[SEC-03] Operation "${operation}" is blocked under P01 security containment: ${
      reason || "Legacy mutating operations are disabled awaiting verified OperationPlan execution (P03/P04)."
    }`;
    super(msg);
    this.name = "MutationContainedError";
    this.operation = operation;
  }
}

/**
 * Asserts that a mutating operation is allowed. Under P01, this always throws.
 */
export function assertMutationAllowed(operation: string, reason?: string): void {
  throw new MutationContainedError(operation, reason);
}

/**
 * Formats a contained mutation rejection as a structured MCP textResult payload.
 */
export function containedMutationResult(operation: string, reason?: string) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({
          error: "OPERATION_MUTATION_CONTAINED",
          code: "SEC-03",
          operation,
          status: "blocked",
          message: `Operation "${operation}" is blocked under P01 security containment. Legacy mutating operations cannot modify or delete data without an approved OperationPlan.`,
          details: reason,
        }),
      },
    ],
    isError: true,
  };
}
