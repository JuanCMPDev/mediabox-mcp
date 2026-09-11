import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerJellyfinTools } from "./jellyfin.js";
import { registerLibraryTools } from "./library.js";
import { registerSonarrTools } from "./sonarr.js";
import { registerRadarrTools } from "./radarr.js";
import { registerDownloadTools } from "./downloads.js";
import { registerMaintenanceTools } from "./maintenance.js";
import { registerOperationTools } from "./operations.js";
import { registerCatalogTools } from "./catalog.js";
import { defaultOperationStore } from "../operations/default-store.js";
import { defaultToolContext, type McpToolContext } from "../security/context.js";
import { VERSION } from "../version.js";

/**
 * Creates an MCP server bound to one authenticated session. The context carries
 * the caller's principal (installation, owner) and conversation so proposals
 * and opaque references are scoped to the real identity (Blueprint 4.1 / 4.4).
 */
export function createMcpServer(context: McpToolContext = defaultToolContext()): McpServer {
  const server = new McpServer({ name: "mediabox-mcp", version: VERSION });
  registerJellyfinTools(server);
  registerLibraryTools(server, context);
  registerSonarrTools(server);
  registerRadarrTools(server);
  registerDownloadTools(server);
  registerMaintenanceTools(server, context);
  registerOperationTools(server, defaultOperationStore);
  registerCatalogTools(server, context);
  return server;
}
