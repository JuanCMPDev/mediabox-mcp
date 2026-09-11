/* ─── Turn Trace and Secret Redaction ───────────────────────────────────────
 * Structured turn trace with mandatory secret redaction (§2.10 / AGT-10).
 * ──────────────────────────────────────────────────────────────────────── */
import type { Phase } from '@mediabox/contracts';

export interface InferenceTrace {
  step: number;
  estimatedPromptTokens: number;
  realPromptTokens?: number;
  completionTokens?: number;
  ttftMs?: number;
  durationMs: number;
}

export interface ToolCallTrace {
  tool: string;
  ok: boolean;
  durationMs: number;
  errorCode?: string;
}

export interface AgentTrace {
  turnId: string;
  conversationId: string;
  provider: string;
  model: string;
  runtime?: string;
  initialPhase: Phase;
  finalPhase: Phase;
  inferences: InferenceTrace[];
  toolCalls: ToolCallTrace[];
  guardDecisions: string[];
  budgetUsed: { inputEstimated: number; outputReserve: number };
  proposalKeys: string[];
  createdAt: string;
}

const REDACTION_PATTERNS: Array<{ regex: RegExp; replace: string }> = [
  // Bearer tokens
  { regex: /Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, replace: 'Bearer [REDACTED]' },
  // OpenAI / OpenRouter style keys: sk-...
  { regex: /sk-[A-Za-z0-9_-]{16,}/gi, replace: 'sk-[REDACTED]' },
  // Google API keys: AIza...
  { regex: /AIza[0-9A-Za-z-_]{30,}/gi, replace: 'AIza[REDACTED]' },
  // Passwords in JSON: "password": "..."
  { regex: /"(password|internalApiKey|agentApiKey|apiKey|botToken)":\s*"[^"]+"/gi, replace: '"$1": "[REDACTED]"' },
  // Truncate full reference tokens to prefix: mref_1234567890ab -> mref_1234...
  { regex: /(mref|rref)_([0-9a-f]{4})[0-9a-f]{8}/gi, replace: '$1_$2...' },
  // Legacy full references: mref_xxxx...
  { regex: /(mref|rref)_[A-Za-z0-9_-]{10,}\.[0-9a-f]{10,}/gi, replace: '$1_[REDACTED_REF]' },
];

/**
 * Redacts secrets, API keys, passwords and truncates opaque references to safe prefixes (§2.10 / AGT-10).
 */
export function redactSecrets(text: string): string {
  let result = text;
  for (const { regex, replace } of REDACTION_PATTERNS) {
    result = result.replace(regex, replace);
  }
  return result;
}

/** Redacts all string fields in an AgentTrace object recursively */
export function redactTrace(trace: AgentTrace): AgentTrace {
  const serialized = JSON.stringify(trace);
  const redacted = redactSecrets(serialized);
  return JSON.parse(redacted);
}
