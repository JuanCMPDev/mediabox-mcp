import type { Principal, PrincipalKind } from "@mediabox/contracts";
import { defaultSessionManager } from "./session.js";

/**
 * Identity of the installation owner. Both the static owner key and delegated
 * `owner-ui` sessions resolve to this id (see SessionManager), so plans that an
 * agent proposes on the owner's behalf can be approved by either.
 */
export const OWNER_PRINCIPAL_ID = "owner-ui";

/** Per-session context threaded into every MCP tool handler (Blueprint 4.1 / 4.4). */
export interface McpToolContext {
  principal: Principal;
  /** Conversation scope. The MCP transport session id once initialised. */
  conversationId: string;
}

export function isOwnerKind(kind: PrincipalKind): boolean {
  return kind === "owner" || kind === "owner-ui";
}

export function isAgentKind(kind: PrincipalKind): boolean {
  return kind === "agent" || kind === "agent-session" || kind === "external-client";
}

/**
 * Owner that must approve a plan proposed by `principal`. Owners propose for
 * themselves; agents and external clients always propose on behalf of the
 * installation owner. The value is hash-covered and re-checked on approval.
 */
export function resolvePlanOwnerId(principal: Principal): string {
  return isOwnerKind(principal.kind) ? principal.id : OWNER_PRINCIPAL_ID;
}

export interface PlanScope {
  installationId: string;
  ownerId: string;
  conversationId: string;
}

export function resolvePlanScope(context: McpToolContext): PlanScope {
  return {
    installationId: context.principal.installationId,
    ownerId: resolvePlanOwnerId(context.principal),
    conversationId: context.conversationId,
  };
}

export function createToolContext(principal: Principal, conversationId?: string): McpToolContext {
  return { principal, conversationId: conversationId ?? principal.sessionId };
}

/**
 * Context used when an MCP server is created without an authenticated
 * transport (unit tests, in-process tooling). It carries agent authority only.
 */
export function defaultToolContext(): McpToolContext {
  const principal: Principal = {
    id: "agent-session",
    installationId: defaultSessionManager.getInstallationId(),
    kind: "agent",
    capabilities: ["mcp:tools:read", "mcp:tools:propose"],
    audience: "mediabox-local",
    sessionId: "agent-static-session",
    expiresAt: Date.now() + 3600_000,
    credentialVersion: defaultSessionManager.getCredentialVersion(),
  };
  return { principal, conversationId: "mcp-default" };
}
