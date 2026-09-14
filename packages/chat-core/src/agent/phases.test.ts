import { describe, it, expect } from 'vitest';
import { FORBIDDEN_ACTIONS, getPhaseTools } from './phases.js';
import type { WorkflowIntent, WorkflowReferences } from './workflow.js';
import { VIRTUAL_TOOLS } from '../virtual-tools.js';
import type { Phase } from '@mediabox/contracts';

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.5);
}

const PHASES: Phase[] = ['orient', 'discover', 'select', 'propose', 'monitor', 'maintain'];
const INTENTS: Array<WorkflowIntent['kind']> = [
  'download', 'delete', 'convert', 'inspect', 'maintenance', 'status', 'queue', 'library', 'server', 'owner_only', 'other',
];

function actions(phase: Phase, intentKind: WorkflowIntent['kind'], tool: string, references: WorkflowReferences = {}): string[] {
  return (getPhaseTools(phase, { intentKind, references }).find(t => t.name === tool)?.parameters as any)?.properties.action.enum ?? [];
}

describe('Phased Tool Catalog & Schema Bounds (§2.3 / AGT-11)', () => {
  for (const phase of PHASES) {
    it(`phase '${phase}' exposes at most 4 virtual tools plus present_choices`, () => {
      const tools = getPhaseTools(phase);
      const regularTools = tools.filter(t => t.name !== 'present_choices');
      expect(regularTools.length).toBeLessThanOrEqual(4);
      expect(tools.some(t => t.name === 'present_choices')).toBe(true);
    });

    it(`phase '${phase}' total tool schema tokens <= 1200 tokens`, () => {
      const tools = getPhaseTools(phase);
      const serialized = JSON.stringify(tools);
      const tokens = estimateTokens(serialized);
      expect(tokens).toBeLessThanOrEqual(1200);
    });
  }

  it('prunes action enums per phase without mutating VIRTUAL_TOOLS', () => {
    const originalEnum = [...(VIRTUAL_TOOLS.library_ops.parameters as any).properties.action.enum];
    expect(originalEnum).toContain('propose_delete');

    // Discover phase only allows 'list' for library_ops
    const discoverTools = getPhaseTools('discover');
    const libOpsDiscover = discoverTools.find(t => t.name === 'library_ops');
    expect(libOpsDiscover).toBeDefined();
    expect((libOpsDiscover!.parameters as any).properties.action.enum).toEqual(['list']);

    // Original VIRTUAL_TOOLS must be unchanged!
    expect((VIRTUAL_TOOLS.library_ops.parameters as any).properties.action.enum).toEqual(originalEnum);
  });

  it('preserves bounds and owner-only actions for every intent and grounding state', () => {
    const referenceSets: WorkflowReferences[] = [{}, { mediaRef: 'mref_item', releaseRef: 'rref_release', paths: ['films/Arrival.mkv'], inspectedPaths: ['films/Arrival.mkv'] }];
    for (const phase of PHASES) {
      for (const intentKind of INTENTS) {
        for (const references of referenceSets) {
          const tools = getPhaseTools(phase, { intentKind, references });
          expect(tools.filter(t => t.name !== 'present_choices').length, `${phase}/${intentKind}`).toBeLessThanOrEqual(4);
          expect(estimateTokens(JSON.stringify(tools)), `${phase}/${intentKind}`).toBeLessThanOrEqual(1200);
          const offered = tools.flatMap(t => (t.parameters as any).properties.action?.enum ?? []);
          expect(offered.filter(action => FORBIDDEN_ACTIONS.has(action))).toEqual([]);
        }
      }
    }
  });

  it('keeps local search and listing reachable through the entire storage request', () => {
    for (const phase of ['orient', 'discover', 'select', 'propose', 'monitor'] as const) {
      expect(actions(phase, 'delete', 'media_query')).toContain('search');
      expect(actions(phase, 'delete', 'library_ops')).toContain('list');
      expect(actions(phase, 'convert', 'library_ops')).toContain('list');
      expect(actions(phase, 'convert', 'media_format')).toContain('analyze');
    }
  });

  it('offers deletion only after listing, and conversion only after a successful analysis', () => {
    expect(actions('propose', 'delete', 'library_ops')).toEqual(['list']);
    expect(actions('propose', 'delete', 'library_ops', { paths: ['films/Arrival.mkv'] })).toEqual(['list', 'propose_delete']);
    expect(actions('propose', 'convert', 'media_format', { paths: ['films/Arrival.mkv'] })).toEqual(['analyze']);
    expect(actions('propose', 'convert', 'media_format', { inspectedPaths: ['films/Arrival.mkv'] })).toEqual(['analyze', 'propose']);
    expect(actions('propose', 'download', 'catalog')).not.toContain('propose_download');
    expect(actions('propose', 'download', 'catalog', { releaseRef: 'rref_release' })).toContain('propose_download');
    expect(actions('propose', 'download', 'catalog', { releaseRef: 'untrusted prose' })).not.toContain('propose_download');
  });

  it('never turns inspection, browsing or status into a proposal', () => {
    const references = { releaseRef: 'rref_release', paths: ['films/Arrival.mkv'], inspectedPaths: ['films/Arrival.mkv'] };
    for (const intentKind of ['inspect', 'library', 'queue', 'status', 'server', 'owner_only', 'maintenance', 'other'] as const) {
      const tools = getPhaseTools('propose', { intentKind, references });
      const offered: string[] = tools.flatMap(t => (t.parameters as any).properties.action?.enum ?? []);
      expect(offered.filter(a => ['propose_download', 'propose_delete', 'propose'].includes(a))).toEqual([]);
      for (const tool of tools) expect(tool.description).not.toMatch(/propose|approve|purge|restore/);
    }
  });

  it('gives every read-only intent the same local reads in every phase but maintain', () => {
    for (const intentKind of ['queue', 'status', 'library', 'server', 'owner_only'] as const) {
      for (const phase of ['orient', 'discover', 'select', 'propose', 'monitor'] as const) {
        expect(getPhaseTools(phase, { intentKind }).map(t => t.name), `${phase}/${intentKind}`)
          .toEqual(['server_info', 'media_query', 'downloads', 'operations', 'present_choices']);
      }
    }
    expect(getPhaseTools('orient', { intentKind: 'maintenance' }).map(t => t.name))
      .toEqual(['maintenance', 'server_info', 'library_ops', 'present_choices']);
  });

  it('never offers a proposal outside propose, even with grounding', () => {
    const references = { releaseRef: 'rref_release', paths: ['films/Arrival.mkv'], inspectedPaths: ['films/Arrival.mkv'] };
    for (const phase of ['orient', 'discover', 'select', 'monitor', 'maintain'] as const) {
      for (const intentKind of ['download', 'delete', 'convert'] as const) {
        const offered = getPhaseTools(phase, { intentKind, references }).flatMap(t => (t.parameters as any).properties.action?.enum ?? []);
        expect(offered.filter((action: string) => action.startsWith('propose')), `${phase}/${intentKind}`).toEqual([]);
      }
    }
  });

  it('makes queue reads and library filtering reachable after an earlier proposal', () => {
    for (const phase of ['orient', 'select', 'propose', 'monitor'] as const) {
      expect(actions(phase, 'queue', 'downloads')).toEqual(['status', 'list_queue']);
      expect(actions(phase, 'library', 'media_query')).toContain('list');
    }
  });
});
