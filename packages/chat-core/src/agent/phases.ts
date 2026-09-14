/* ─── Phases and the tool catalog of a request ───────────────────────────────
 * At most 4 virtual tools per catalog plus present_choices (§2.3 / AGT-11).
 * Never mutates VIRTUAL_TOOLS in place; action enums are pruned per request.
 *
 * Deviation from the §2.3 table, recorded in PR05-AGENT-FLOW-HANDOFF.es.md: the
 * catalog follows the intent of the request, and the phase labels its progress.
 * Every read a request needs stays reachable in every phase. A proposal action
 * appears only in `propose`, only for the intent it serves, and only with the
 * verified grounding it needs. Messages without a classified intent keep the
 * phase table.
 * ──────────────────────────────────────────────────────────────────────── */
import type { Phase } from '@mediabox/contracts';
import type { VirtualToolDef } from '../types.js';
import { VIRTUAL_TOOLS, PRESENT_CHOICES_TOOL } from '../virtual-tools.js';
import { hasProposalGrounding, type IntentKind, type WorkflowReferences } from './workflow.js';

interface CatalogEntry {
  name: string;
  allowedActions: readonly string[];
}

/**
 * Actions the agent may never see in any phase, whatever a catalog says:
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

/** The intent each proposal action serves. Any other intent never sees it. */
const PROPOSAL_ACTIONS = new Map<string, IntentKind>([
  ['propose_download', 'download'],
  ['propose_delete', 'delete'],
  ['propose', 'convert'],
]);

const LOCAL_READS = ['search', 'list', 'details'] as const;
const PLAN_STATUS: CatalogEntry = { name: 'operations', allowedActions: ['status'] };

/** Phase table for messages without a classified intent (§2.3). */
const PHASE_SPECS: Record<Phase, CatalogEntry[]> = {
  orient: [
    { name: 'server_info', allowedActions: ['status', 'activity'] },
    { name: 'media_query', allowedActions: LOCAL_READS },
    { name: 'catalog',     allowedActions: ['search', 'details'] },
    PLAN_STATUS,
  ],
  discover: [
    { name: 'catalog',      allowedActions: ['search', 'details'] },
    { name: 'media_query',  allowedActions: LOCAL_READS },
    { name: 'library_ops',  allowedActions: ['list'] },
    { name: 'media_format', allowedActions: ['analyze'] },
  ],
  select: [
    // `search` stays available so a new request is always one call away and the
    // conversation can never be stuck in select (deviation from §2.3, documented).
    { name: 'catalog',     allowedActions: ['search', 'details', 'releases'] },
    { name: 'media_query', allowedActions: LOCAL_READS },
    // A question about a plan must be answerable from any read phase.
    PLAN_STATUS,
  ],
  // Without a proposal intent, `propose` only comes from a state saved before
  // intents chose the catalog: it keeps the reads and offers no proposal.
  propose: [
    { name: 'catalog',     allowedActions: ['search', 'details', 'releases'] },
    { name: 'media_query', allowedActions: LOCAL_READS },
    PLAN_STATUS,
  ],
  monitor: [
    PLAN_STATUS,
    { name: 'catalog', allowedActions: ['search', 'details'] },
  ],
  maintain: [
    { name: 'maintenance', allowedActions: ['cleanup', 'check_jobs'] },
    { name: 'server_info', allowedActions: ['status', 'activity'] },
    { name: 'library_ops', allowedActions: ['list'] },
  ],
};

/** Local reads shared by every read-only intent: queue, status, library, server, owner_only. */
const READ_CATALOG: CatalogEntry[] = [
  { name: 'server_info', allowedActions: ['status', 'activity'] },
  { name: 'media_query', allowedActions: LOCAL_READS },
  { name: 'downloads',   allowedActions: ['status', 'list_queue'] },
  PLAN_STATUS,
];

export interface PhaseToolOptions {
  /** Chooses the catalog and the proposal action of the active request. */
  intentKind?: IntentKind;
  /** References validated for the current principal and TTL by the runtime. */
  references?: WorkflowReferences;
}

/**
 * The catalog of a request. Each proposal flow keeps its prerequisites reachable:
 * - storage: resolve the entity, list its files, propose exact listed paths;
 * - formats: resolve the file, analyze it, propose a job for the analyzed path;
 * - downloads: search, read releases, propose one returned release.
 */
function catalogFor(phase: Phase, intentKind: IntentKind | undefined): CatalogEntry[] {
  if (phase === 'maintain' || intentKind === 'maintenance') return PHASE_SPECS.maintain;
  const proposing = phase === 'propose';
  switch (intentKind) {
    case 'delete':
      return [
        { name: 'media_query', allowedActions: LOCAL_READS },
        { name: 'library_ops', allowedActions: proposing ? ['list', 'propose_delete'] : ['list'] },
        PLAN_STATUS,
      ];
    case 'convert':
    case 'inspect':
      return [
        { name: 'media_query',  allowedActions: LOCAL_READS },
        { name: 'library_ops',  allowedActions: ['list'] },
        { name: 'media_format', allowedActions: proposing && intentKind === 'convert' ? ['analyze', 'propose'] : ['analyze'] },
        PLAN_STATUS,
      ];
    case 'download':
      return [
        { name: 'catalog',     allowedActions: proposing ? ['search', 'details', 'releases', 'propose_download'] : ['search', 'details', 'releases'] },
        { name: 'media_query', allowedActions: LOCAL_READS },
        PLAN_STATUS,
      ];
    case 'queue':
    case 'status':
    case 'library':
    case 'server':
    case 'owner_only':
      return READ_CATALOG;
    default:
      return PHASE_SPECS[phase] ?? PHASE_SPECS.orient;
  }
}

/** Descriptions and action enums must advertise the same capabilities. */
const ACTION_DESCRIPTIONS: Record<string, Record<string, string>> = {
  server_info: { status: 'server health, library totals, disks and active sessions', activity: 'playback history' },
  media_query: { search: 'find local titles by title', list: 'list local items by type/year', details: 'seasons and episodes of a returned showId' },
  catalog: { search: 'find catalog titles', details: 'read media details', releases: 'find the releases of a mediaRef', propose_download: 'propose a returned release for owner approval' },
  library_ops: { list: 'list a folder with the exact path of each file', propose_delete: 'propose quarantine of exact listed files for owner approval' },
  media_format: { analyze: 'read the streams of one exact file', propose: 'propose a job for an analyzed file, for owner approval' },
  downloads: { status: 'read current download queues', list_queue: 'read queue rows by source and page' },
  operations: { status: 'read the state and steps of a plan by planId' },
  maintenance: { cleanup: 'preview cleanup', check_jobs: 'read a background job' },
};

/**
 * Returns an immutable, filtered set of virtual tools for the request.
 * Guarantees <= 4 virtual tools + present_choices tool.
 */
export function getPhaseTools(phase: Phase, opts: PhaseToolOptions = {}): VirtualToolDef[] {
  const result: VirtualToolDef[] = [];

  for (const item of catalogFor(phase, opts.intentKind)) {
    const base = VIRTUAL_TOOLS[item.name];
    if (!base) continue;

    // Deep clone parameters so VIRTUAL_TOOLS is never mutated
    const parameters = JSON.parse(JSON.stringify(base.parameters)) as Record<string, any>;
    let description = base.description;
    if (parameters.properties?.action) {
      const permitted = item.allowedActions.filter(action => {
        if (FORBIDDEN_ACTIONS.has(action)) return false;
        const serves = PROPOSAL_ACTIONS.get(action);
        // Defense in depth: the reducer reaches `propose` only with grounding.
        return !serves || (opts.intentKind === serves && hasProposalGrounding(serves, opts.references ?? {}));
      });
      if (permitted.length === 0) continue;
      parameters.properties.action = { ...parameters.properties.action, enum: permitted };
      description = `${permitted.map(action => `${action}=${ACTION_DESCRIPTIONS[item.name]?.[action] ?? action}`).join('; ')}.`;
    }

    result.push({ name: base.name, description, parameters });
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
