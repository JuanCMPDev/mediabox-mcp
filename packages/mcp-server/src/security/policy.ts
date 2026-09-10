import type { Request, Response, NextFunction } from "express";
import type { Principal, PrincipalKind } from "@mediabox/contracts";

export type ActionType = "read" | "propose" | "approve" | "execute" | "admin" | "export_secrets";
export type ResourceType = "setup" | "env" | "dashboard" | "chat" | "mcp" | "operations" | "auth";

export class PolicyViolationError extends Error {
  constructor(
    message: string,
    public readonly code: string = "ERR_FORBIDDEN",
    public readonly statusCode: number = 403
  ) {
    super(message);
    this.name = "PolicyViolationError";
  }
}

/**
 * Canonical capability mapping and policy table (Blueprint §4.1 / ID-01).
 */
export const ROLE_POLICIES: Record<
  PrincipalKind,
  {
    allowedActions: readonly ActionType[];
    allowedResources: readonly ResourceType[];
    prohibitedActions: readonly ActionType[];
  }
> = {
  "owner": {
    allowedActions: ["read", "propose", "approve", "admin", "export_secrets"],
    allowedResources: ["setup", "env", "dashboard", "chat", "mcp", "operations", "auth"],
    prohibitedActions: [],
  },
  "owner-ui": {
    allowedActions: ["read", "propose", "approve", "admin", "export_secrets"],
    allowedResources: ["setup", "env", "dashboard", "chat", "mcp", "operations", "auth"],
    prohibitedActions: [],
  },
  "agent": {
    allowedActions: ["read", "propose"],
    allowedResources: ["dashboard", "chat", "mcp"],
    prohibitedActions: ["approve", "execute", "admin", "export_secrets"],
  },
  "agent-session": {
    allowedActions: ["read", "propose"],
    allowedResources: ["dashboard", "chat", "mcp"],
    prohibitedActions: ["approve", "execute", "admin", "export_secrets"],
  },
  "installer": {
    allowedActions: ["admin", "read"],
    allowedResources: ["setup"],
    prohibitedActions: ["approve", "execute", "export_secrets"],
  },
  "executor": {
    allowedActions: ["execute", "read"],
    allowedResources: ["operations"],
    prohibitedActions: ["approve", "admin", "export_secrets"],
  },
  "external-client": {
    allowedActions: ["read", "propose"],
    allowedResources: ["dashboard", "mcp"],
    prohibitedActions: ["approve", "execute", "admin", "export_secrets"],
  },
};

/**
 * Checks whether a given principal is allowed to perform action on resource.
 */
export function isActionAllowed(principal: Principal, resource: ResourceType, action: ActionType): boolean {
  const policy = ROLE_POLICIES[principal.kind];
  if (!policy) return false;

  if (policy.prohibitedActions.includes(action)) {
    return false;
  }

  if (!policy.allowedResources.includes(resource)) {
    return false;
  }

  if (!policy.allowedActions.includes(action)) {
    return false;
  }

  return true;
}

/**
 * Asserts policy compliance, throwing PolicyViolationError if violated.
 */
export function assertCanAccess(principal: Principal, resource: ResourceType, action: ActionType): void {
  if (principal.kind === "agent-session" || principal.kind === "agent") {
    if (action === "admin" || resource === "setup" || resource === "env" || action === "export_secrets") {
      throw new PolicyViolationError(
        "Forbidden: Agent session is prohibited from administrative or secret access (INV-SEPARATION / SEC-05 / ID-03)",
        "ERR_FORBIDDEN_AGENT",
        403
      );
    }
    if (action === "approve") {
      throw new PolicyViolationError(
        "Forbidden: Agent session cannot approve operation plans (INV-APPROVAL / ID-03)",
        "ERR_FORBIDDEN_AGENT",
        403
      );
    }
    if (action === "execute") {
      throw new PolicyViolationError(
        "Forbidden: Direct mutation execution requires approved plan via human owner (INV-APPROVAL)",
        "ERR_FORBIDDEN_AGENT",
        403
      );
    }
  }

  if (!isActionAllowed(principal, resource, action)) {
    throw new PolicyViolationError(
      `Forbidden: Principal kind '${principal.kind}' not authorized for action '${action}' on '${resource}'`,
      "ERR_FORBIDDEN",
      403
    );
  }
}

/**
 * Express middleware factory enforcing resource and action policy.
 */
export function requirePolicy(resource: ResourceType, action: ActionType) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.principal) {
      res.status(401).json({ error: "Unauthorized: No authenticated principal", code: "ERR_UNAUTHORIZED" });
      return;
    }

    try {
      assertCanAccess(req.principal, resource, action);
      next();
    } catch (err) {
      if (err instanceof PolicyViolationError) {
        res.status(err.statusCode).json({ error: err.message, code: err.code });
        return;
      }
      res.status(403).json({ error: "Forbidden", code: "ERR_FORBIDDEN" });
    }
  };
}
