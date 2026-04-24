import type { VirtualToolDef } from './types.js';
import { VIRTUAL_TOOLS, TOOL_GROUPS, KEYWORD_MAP } from './virtual-tools.js';

/**
 * Pick the virtual tools relevant to the user's message using keyword matching.
 * Falls back to all 8 tools if no keyword matches (safe but noisier for the LLM).
 * Always includes 'status' tools so the LLM can verify mutations.
 */
export function selectTools(userMessage: string): VirtualToolDef[] {
  const msg = userMessage.toLowerCase();
  const groups = new Set<string>();

  for (const [keyword, groupNames] of Object.entries(KEYWORD_MAP)) {
    if (msg.includes(keyword)) groupNames.forEach(g => groups.add(g));
  }

  if (groups.size === 0) return Object.values(VIRTUAL_TOOLS); // fallback: all

  groups.add('status'); // always include for post-mutation verification

  const selected = new Set<string>();
  for (const g of groups) {
    (TOOL_GROUPS[g] ?? []).forEach(t => selected.add(t));
  }

  return Object.values(VIRTUAL_TOOLS).filter(t => selected.has(t.name));
}
