import { describe, it, expect } from 'vitest';
import { getPhaseTools } from './phases.js';
import { VIRTUAL_TOOLS } from '../virtual-tools.js';
import type { Phase } from '@mediabox/contracts';

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.5);
}

const PHASES: Phase[] = ['orient', 'discover', 'select', 'propose', 'monitor', 'maintain'];

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
});
