import type { AgentErrorCode } from '@mediabox/contracts';

export class AgentError extends Error {
  readonly code: AgentErrorCode;
  readonly retryable: boolean;
  readonly details?: Record<string, unknown>;

  constructor(
    code: AgentErrorCode,
    message: string,
    opts: { retryable?: boolean; details?: Record<string, unknown> } = {},
  ) {
    super(message);
    this.name = 'AgentError';
    this.code = code;
    this.retryable = opts.retryable ?? false;
    this.details = opts.details;
  }
}
