// ── Public API of @mediabox/chat-core ────────────────────────────────────────

// Core engine
export { streamChat, runChat }  from './engine.js';

// MCP caller factory
export { createMcpCaller }      from './mcp-client.js';

// Provider resolution
export { resolveProvider }      from './providers/select.js';
export type { StreamProvider }  from './providers/types.js';

// History utilities
export {
  InMemoryHistoryStore,
  trimHistory,
  estimateTokens,
  toGeminiTools,
  toOpenAITools,
  buildOpenRouterMessages,
  buildGeminiHistory,
} from './history.js';

// Tool selection / routing
export { selectTools }          from './tool-selector.js';
export { executeVirtualTool }   from './tool-router.js';

// Static data
export { VIRTUAL_TOOLS } from './virtual-tools.js';
export { SYSTEM_PROMPT, buildSystemPrompt }        from './prompt.js';
export type { PromptLocale }                       from './prompt.js';

// Types
export type {
  ChatMessage,
  VirtualToolDef,
  McpCallFn,
  HistoryStore,
  ToolCallInfo,
  ToolResultInfo,
  StreamChatOptions,
} from './types.js';
