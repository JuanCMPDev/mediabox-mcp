/**
 * Wire-format types for deploy events live in @mediabox/contracts so both the
 * CLI sink, the desktop wizard UI, and any future consumer share one source
 * of truth. Re-exported here for backward compat with consumers that already
 * import from @mediabox/core.
 */
export type { DeployEvent, DeployPhase } from "@mediabox/contracts";
import type { DeployEvent } from "@mediabox/contracts";

/**
 * Simple callback-style event sink. Downstream can wrap into an
 * EventEmitter, async iterator, or JSON-RPC notification stream.
 */
export type EventHandler = (event: DeployEvent) => void;

/** No-op sink — useful for tests and headless invocations. */
export const noopEventHandler: EventHandler = () => {};
