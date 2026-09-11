/* ─── Phases and Phased Tool Catalog ─────────────────────────────────────────
 * Maximum 4 virtual tools per phase plus present_choices (§2.3 / AGT-11).
 * Never mutates VIRTUAL_TOOLS in place. Prunes action enums per phase.
 * ──────────────────────────────────────────────────────────────────────── */
import type { Phase } from '@mediabox/contracts';
import type { VirtualToolDef } from '../types.js';
import { VIRTUAL_TOOLS, PRESENT_CHOICES_TOOL } from '../virtual-tools.js';
import type { WorkflowIntent } from './workflow.js';

interface PhaseConfig {
  tools: Array<{
    name: string;
    allowedActions?: string[];
    /** Only exposed when the workflow intent is one of these (§2.3 "según intención"). */
    intents?: Array<WorkflowIntent['kind']>;
  }>;
}

/**
 * Actions the agent may never see in any phase, whatever a phase config says:
 * approval, cancellation and administration stay outside the model's reach (§2.3).
 */
export const FORBIDDEN_ACTIONS = new Set([
  'approve',
  'approve_plan',
  'cancel',
  'cancel_plan',
  'cancel_job',
  'purge',
  'admin',
  'quarantine_admin',
  'restore',
  'delete',
  'execute',
]);

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
      // `search` stays available so a new request is always one call away and the
      // conversation can never be stuck in select (deviation from §2.3, documented).
      { name: 'catalog',     allowedActions: ['search', 'details', 'releases'] },
      { name: 'media_query', allowedActions: ['search', 'details'] },
      // A question about a plan must be answerable from any read phase.
      { name: 'operations',  allowedActions: ['status'] },
    ],
  },
  propose: {
    tools: [
      { name: 'catalog',      allowedActions: ['propose_download'], intents: ['download', 'other', 'status'] },
      { name: 'library_ops',  allowedActions: ['propose_delete'],   intents: ['delete', 'other'] },
      { name: 'media_format', allowedActions: ['propose'],          intents: ['convert', 'inspect', 'other'] },
      { name: 'operations',   allowedActions: ['status'] },
    ],
  },
  monitor: {
    tools: [
      { name: 'operations', allowedActions: ['status'] },
      { name: 'catalog',    allowedActions: ['search', 'details'] },
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

export interface PhaseToolOptions {
  /** Narrows the propose catalog to the tool that matches the active intent. */
  intentKind?: WorkflowIntent['kind'];
}

/**
 * Returns an immutable, filtered set of virtual tools tailored to the phase.
 * Guarantees <= 4 virtual tools + present_choices tool.
 */
export function getPhaseTools(phase: Phase, opts: PhaseToolOptions = {}): VirtualToolDef[] {
  const spec = PHASE_SPECS[phase] ?? PHASE_SPECS.orient;
  const result: VirtualToolDef[] = [];

  for (const item of spec.tools) {
    if (item.intents && opts.intentKind && !item.intents.includes(opts.intentKind)) continue;

    const base = VIRTUAL_TOOLS[item.name];
    if (!base) continue;

    // Deep clone parameters so VIRTUAL_TOOLS is never mutated
    const clonedParams = JSON.parse(JSON.stringify(base.parameters)) as Record<string, any>;

    if (clonedParams.properties?.action) {
      const declared = item.allowedActions ?? (clonedParams.properties.action.enum as string[] | undefined) ?? [];
      const permitted = declared.filter(action => !FORBIDDEN_ACTIONS.has(action));
      if (permitted.length === 0) continue;
      clonedParams.properties.action = {
        ...clonedParams.properties.action,
        enum: permitted,
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

/** Every phase the state machine can reach — used by tests and diagnostics. */
export const ALL_PHASES: Phase[] = ['orient', 'discover', 'select', 'propose', 'monitor', 'maintain'];
