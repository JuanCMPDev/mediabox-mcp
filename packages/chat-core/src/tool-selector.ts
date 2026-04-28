import type { VirtualToolDef } from './types.js';
import { VIRTUAL_TOOLS } from './virtual-tools.js';

/**
 * Pick the virtual tools relevant to the user's message.
 *
 * The keyword-matcher we used to ship here did more harm than good: it routed
 * "borrar película X" to {movies, files} but skipped {downloads, status},
 * which made the LLM unable to verify the deletion in queues. Modern LLMs
 * (Gemini 2.0 Flash, gpt-4o-mini, gpt-4.1) handle a 9-tool surface fine, so
 * we always expose the full set. The system prompt's ID taxonomy + few-shot
 * examples do the heavy lifting on accuracy now.
 */
export function selectTools(_userMessage: string): VirtualToolDef[] {
  return Object.values(VIRTUAL_TOOLS);
}
