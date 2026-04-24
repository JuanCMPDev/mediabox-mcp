/**
 * Logical phases of a deployment. Consumers (CLI spinner, UI progress bars,
 * Tauri JSON-RPC wire) can group or filter events by prefix:
 *  - "generate:*"   → writing config files
 *  - "deploy:*"     → Docker lifecycle
 *  - "discover:*"   → reading state from running services
 *  - "configure:*"  → configuring services via their APIs
 */
export type DeployPhase =
  | "config:validate"
  | "generate:compose"
  | "generate:env"
  | "generate:qbittorrent"
  | "generate:caddy"
  | "generate:directories"
  | "deploy:prepare-images"
  | "deploy:start"
  | "deploy:health"
  | "discover:api-keys"
  | "configure:jellyfin"
  | "configure:sonarr"
  | "configure:radarr"
  | "configure:prowlarr"
  | "configure:qbittorrent"
  | "configure:flaresolverr"
  | "configure:arr-auth"
  | "configure:jellyfin-libraries"
  | "write:env-update"
  | "deploy:restart";

export type DeployEvent =
  | { kind: "start"; phase: DeployPhase; message: string }
  | { kind: "progress"; phase: DeployPhase; message: string; percent?: number }
  | { kind: "success"; phase: DeployPhase; message: string }
  | { kind: "warn"; phase: DeployPhase; message: string }
  | { kind: "error"; phase: DeployPhase; message: string; cause?: unknown }
  | { kind: "log"; level: "info" | "debug"; message: string };

/**
 * Simple callback-style event sink. Downstream can wrap into an
 * EventEmitter, async iterator, or JSON-RPC notification stream.
 */
export type EventHandler = (event: DeployEvent) => void;

/** No-op sink — useful for tests and headless invocations. */
export const noopEventHandler: EventHandler = () => {};
