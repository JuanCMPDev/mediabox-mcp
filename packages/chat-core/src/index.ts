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
export { selectTools }                                   from './tool-selector.js';
export { executeVirtualTool, resolveVirtualCall, MEDIA_FORMAT_DEFAULT_PROFILES } from './tool-router.js';
export { boundToolResultText, detectToolFailure, extractToolFailureMessage }     from './result-budget.js';

// Static data
export { VIRTUAL_TOOLS, PRESENT_CHOICES_TOOL }     from './virtual-tools.js';
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

// Agent engine exports (P08)
export {
  AgentRuntime,
  type AgentRuntimeOptions,
  classifyIntent,
  extractSubjects,
  extractEntitledReferences,
  collapseHistoryToolResults,
  getDefaultWorkflowStore,
} from './agent/runtime.js';
export { AgentError } from './agent/errors.js';
export {
  type WorkflowState,
  type WorkflowEvent,
  type WorkflowStore,
  type TokenizerCalibration,
  type CandidateRecord,
  InMemoryWorkflowStore,
  reduce,
  createInitialWorkflowState,
  migrateWorkflowState,
  groundPhase,
  isValidMediaRef,
  isValidReleaseRef,
  WORKFLOW_SCHEMA_VERSION,
  REFERENCE_TTL_MS,
} from './agent/workflow.js';
export { getPhaseTools, ALL_PHASES, FORBIDDEN_ACTIONS } from './agent/phases.js';
export {
  prepareContext,
  compactToolResult,
  digestToolResult,
  wrapToolResult,
  buildStateSummary,
  budgetForContext,
  DEFAULT_BUDGET,
  SYSTEM_PROMPT_TOKEN_CAP,
  TOOL_SCHEMA_TOKEN_CAP,
  STATE_SUMMARY_TOKEN_CAP,
  TOOL_RESULT_TOKEN_CAP,
  type BudgetConfig,
  type TokenEstimator,
} from './agent/budget.js';
export { TokenCounter } from './agent/tokenizer.js';
export { TurnGuards, type GuardConfig, DEFAULT_GUARDS } from './agent/guards.js';
export { dispatchToolCall, validateToolCall } from './agent/dispatch.js';
export { redactTrace, redactSecrets, type AgentTrace } from './agent/trace.js';
export { heuristicPhase } from './tool-selector.js';
export { FakeMcp, type LedgerEntry } from './agent/replay/fake-mcp.js';
export { ScriptedProvider } from './agent/replay/scripted-provider.js';
