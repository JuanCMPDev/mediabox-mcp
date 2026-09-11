/* ─── Phases and Phased Tool Catalog ─────────────────────────────────────────
 * Maximum 4 virtual tools per phase plus present_choices (§2.3 / AGT-11).
 * Never mutates VIRTUAL_TOOLS in place. Prunes action enums per phase.
 * ──────────────────────────────────────────────────────────────────────── */
import type { Phase } from '@mediabox/contracts';
import type { VirtualToolDef, ChatMessage } from '../types.js';
import { VIRTUAL_TOOLS, PRESENT_CHOICES_TOOL } from '../virtual-tools.js';
import type { WorkflowState } from './workflow.js';

interface PhaseConfig {
  tools: Array<{
    name: string;
    allowedActions?: string[];
  }>;
}

const PHASE_SPECS: Record<Phase, PhaseConfig> = {
  orient: {
    tools: [
      { name: 'server_info', allowedActions: ['status', 'activity'] },
      { name: 'media_query', allowedActions: ['search', 'details'] },
      { name: 'catalog',     allowedActions: ['search', 'details'] },
      { name: 'operations',  allowedActions: ['status'] },
    ],
  },
  discover: {
    tools: [
      { name: 'catalog',      allowedActions: ['search', 'details'] },
      { name: 'media_query',  allowedActions: ['search', 'details'] },
      { name: 'library_ops',  allowedActions: ['list'] },
      { name: 'media_format', allowedActions: ['analyze'] },
    ],
  },
  select: {
    tools: [
      { name: 'catalog',     allowedActions: ['details', 'releases'] },
      { name: 'media_query', allowedActions: ['details'] },
    ],
  },
  propose: {
    tools: [
      { name: 'catalog',      allowedActions: ['propose_download'] },
      { name: 'library_ops',  allowedActions: ['propose_delete'] },
      { name: 'media_format', allowedActions: ['propose'] },
      { name: 'operations',   allowedActions: ['status'] },
    ],
  },
  monitor: {
    tools: [
      { name: 'operations', allowedActions: ['status'] },
      { name: 'catalog',    allowedActions: ['details'] },
    ],
  },
  maintain: {
    tools: [
      { name: 'maintenance',  allowedActions: ['cleanup', 'check_jobs'] },
      { name: 'server_info',  allowedActions: ['status', 'activity'] },
      { name: 'library_ops',  allowedActions: ['list'] },
    ],
  },
};

/**
 * Returns an immutable, filtered set of virtual tools tailored to the phase.
 * Guarantees <= 4 virtual tools + present_choices tool.
 */
export function getPhaseTools(phase: Phase): VirtualToolDef[] {
  const spec = PHASE_SPECS[phase] ?? PHASE_SPECS.orient;
  const result: VirtualToolDef[] = [];

  for (const item of spec.tools) {
    const base = VIRTUAL_TOOLS[item.name];
    if (!base) continue;

    // Deep clone parameters so VIRTUAL_TOOLS is never mutated
    const clonedParams = JSON.parse(JSON.stringify(base.parameters)) as Record<string, any>;

    if (item.allowedActions && clonedParams.properties?.action) {
      clonedParams.properties.action = {
        ...clonedParams.properties.action,
        enum: [...item.allowedActions],
      };
    }

    result.push({
      name: base.name,
      description: base.description,
      parameters: clonedParams,
    });
  }

  // UI tool present_choices is always exposed as companion
  const choiceTool = VIRTUAL_TOOLS[PRESENT_CHOICES_TOOL];
  if (choiceTool) {
    result.push({
      name: choiceTool.name,
      description: choiceTool.description,
      parameters: JSON.parse(JSON.stringify(choiceTool.parameters)),
    });
  }

  return result;
}

/**
 * Heuristic to suggest a phase based on message content and conversation state.
 * Adapts lexical analysis from tool-selector.ts.
 */
export function suggestPhase(
  message: string,
  history: ChatMessage[] = [],
  state?: WorkflowState,
): Phase {
  if (state?.references.releaseRef) {
    return 'propose';
  }
  if (state?.references.mediaRef) {
    return 'select';
  }
  if (state?.proposals.length && state.phase === 'monitor') {
    return 'monitor';
  }

  const text = message.toLowerCase();

  if (/\b(maintenance|mantenimiento|cleanup|limpi\w*|huerfano|orphan)\b/.test(text)) {
    return 'maintain';
  }
  if (/\b(plan|operacion|operation|status|estado)\b/.test(text) && /\b(plan_\w+|id)\b/.test(text)) {
    return 'monitor';
  }
  if (/\b(download|descarg\w*|baj\w*|torrent|movie|pelicula|series?|anime|busc\w*|search|find)\b/.test(text)) {
    return 'discover';
  }
  if (/\b(delete|borr\w*|elimin\w*|transcod\w*|transcode|remux|optim)\b/.test(text)) {
    return 'discover';
  }

  return state?.phase ?? 'orient';
}
