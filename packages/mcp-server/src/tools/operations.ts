import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { OperationStore } from "../operations/store.js";
import { defaultOperationStore } from "../operations/default-store.js";

/**
 * Registers the read-only `operation_status` MCP tool (§4.2 / §4.4 / INV-APPROVAL).
 *
 * Notice:
 * - NO `approve` or `commit` tool is registered. Models cannot approve operations (OP-01).
 * - Only read-only polling/inspection of plan execution is exposed.
 */
export function registerOperationTools(server: McpServer, store: OperationStore = defaultOperationStore): void {
  server.tool(
    "operation_status",
    "Query the status and execution progress of an OperationPlan by its planId.",
    {
      planId: z.string().describe("The unique identifier of the OperationPlan to check"),
    },
    async ({ planId }) => {
      const record = store.getPlan(planId);
      if (!record) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Operation plan '${planId}' not found.`,
            },
          ],
          isError: true,
        };
      }

      const summary = {
        id: record.plan.id,
        operation: record.plan.operation,
        status: record.status,
        statusReason: record.statusReason,
        createdAt: record.plan.createdAt,
        expiresAt: record.plan.expiresAt,
        approvedAt: record.approvedAt,
        approvedBy: record.approvedBy,
        startedAt: record.startedAt,
        finishedAt: record.finishedAt,
        currentStep: record.currentStep,
        totalSteps: record.totalSteps,
        steps: record.steps?.map((s) => ({
          stepNumber: s.stepNumber,
          action: s.action,
          status: s.status,
          error: s.error,
        })),
      };

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(summary, null, 2),
          },
        ],
      };
    }
  );
}
