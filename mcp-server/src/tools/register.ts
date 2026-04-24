import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerJellyfinTools } from "./jellyfin.js";
import { registerLibraryTools } from "./library.js";
import { registerSonarrTools } from "./sonarr.js";
import { registerRadarrTools } from "./radarr.js";
import { registerDownloadTools } from "./downloads.js";
import { registerMaintenanceTools } from "./maintenance.js";

export function createMcpServer(): McpServer {
  const server = new McpServer({ name: "mediabox-mcp", version: "2.0.0-beta.0" });
  registerJellyfinTools(server);
  registerLibraryTools(server);
  registerSonarrTools(server);
  registerRadarrTools(server);
  registerDownloadTools(server);
  registerMaintenanceTools(server);
  return server;
}
