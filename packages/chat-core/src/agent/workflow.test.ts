import { describe, expect, it } from 'vitest';
import {
  REFERENCE_LIMITS,
  canonicalPathKey,
  createInitialWorkflowState,
  groundPhase,
  hasFreshGrounding,
  hasProposalGrounding,
  migrateWorkflowState,
  reduce,
  type WorkflowIntent,
  type WorkflowReferences,
  type WorkflowState,
} from './workflow.js';
import { validateProposalGrounding } from './dispatch.js';

const clock = () => '2026-09-12T12:00:00.000Z';
const paths = ['films/Arrival.mkv'];

function seed(kind: WorkflowIntent['kind'], overrides: Partial<WorkflowState> = {}): WorkflowState {
  return {
    ...createInitialWorkflowState('workflow-flow', 'owner', 'installation', clock),
    intent: { kind, summary: 'Arrival', subjects: ['arrival'] },
    phase: 'discover',
    ...overrides,
  };
}

function result(state: WorkflowState, tool: string, references: Partial<WorkflowReferences>): WorkflowState {
  return reduce(state, { type: 'tool_result', tool, references, argsHash: tool, resultDigest: 'result' }, clock);
}

function say(state: WorkflowState, kind: WorkflowIntent['kind'], subjects: string[] = [], text = 'Continue'): WorkflowState {
  return reduce(state, { type: 'user_message', text, intent: { kind, summary: text, subjects }, suggestedPhase: 'discover' }, clock);
}

function planned(state: WorkflowState, planId: string, targets?: string[]): WorkflowState {
  return reduce(state, {
    type: 'proposal_created', planId, operation: 'operation', status: 'awaiting_approval',
    manifestHash: 'hash', proposalKey: planId, ...(targets ? { targets } : {}),
  }, clock);
}

describe('Intent and prerequisite based workflow', () => {
  it('resolves media and then lists before enabling deletion', () => {
    const selected = result(seed('delete'), 'media_query', { mediaRef: 'mref_arrival' });
    expect(selected.phase).toBe('select');
    expect(hasProposalGrounding('delete', selected.references)).toBe(false);
    const listed = result(selected, 'library_ops', { paths });
    expect(listed.phase).toBe('propose');
    expect(listed.references.paths).toEqual(paths);
  });

  it('requires analysis after listing before enabling conversion', () => {
    const selected = result(seed('convert'), 'media_query', { mediaRef: 'mref_arrival' });
    const listed = result(selected, 'library_ops', { paths });
    expect(listed.phase).toBe('select');
    expect(groundPhase('propose', listed)).toBe('select');
    const analyzed = result(listed, 'media_format', { paths, inspectedPaths: paths });
    expect(analyzed.phase).toBe('propose');
    expect(hasProposalGrounding('convert', analyzed.references)).toBe(true);
  });

  it('keeps inspection read-only, then permits an explicit same-subject conversion', () => {
    const inspected = result(seed('inspect'), 'media_format', { paths, inspectedPaths: paths });
    expect(inspected.phase).not.toBe('propose');
    expect(groundPhase('propose', inspected)).toBe('select');
    const convert = reduce(inspected, {
      type: 'user_message', text: 'Now convert it',
      intent: { kind: 'convert', summary: 'Now convert it', subjects: [] },
      suggestedPhase: 'discover',
    }, clock);
    expect(convert.phase).toBe('propose');
    expect(convert.references.inspectedPaths).toEqual(paths);
  });

  it.each(['queue', 'library', 'status', 'server', 'owner_only'] as const)('returns to reads for %s without needing a new title', (kind) => {
    const next = reduce(seed('convert', { phase: 'propose', references: { paths, inspectedPaths: paths } }), {
      type: 'user_message', text: 'Read state',
      intent: { kind, summary: 'Read state', subjects: [] },
      suggestedPhase: 'discover',
    }, clock);
    expect(next.phase).toBe('orient');
    expect(hasProposalGrounding(kind, next.references)).toBe(false);
  });

  it('removes proposal access when the same request becomes an inspection', () => {
    const next = reduce(seed('convert', { phase: 'propose', references: { paths, inspectedPaths: paths } }), {
      type: 'user_message', text: 'Only inspect Arrival',
      intent: { kind: 'inspect', summary: 'Only inspect Arrival', subjects: ['arrival'] },
      suggestedPhase: 'discover',
    }, clock);
    expect(next.phase).toBe('select');
    expect(next.references.inspectedPaths).toEqual(paths);
  });

  it('does not treat a file path in user prose as grounding', () => {
    const next = reduce(seed('convert'), {
      type: 'user_message', text: 'Convert films/Arrival.mkv',
      intent: { kind: 'convert', summary: 'Convert films/Arrival.mkv', subjects: ['arrival'] },
      suggestedPhase: 'propose',
    }, clock);
    expect(next.phase).toBe('discover');
    expect(next.references).toEqual({});
  });

  it('invalidates paths and inspections on a new subject', () => {
    const next = reduce(seed('convert', { phase: 'propose', references: { paths, inspectedPaths: paths } }), {
      type: 'user_message', text: 'Convert Amelie',
      intent: { kind: 'convert', summary: 'Convert Amelie', subjects: ['amelie'] },
      suggestedPhase: 'propose',
    }, clock);
    expect(next.phase).toBe('discover');
    expect(next.references).toEqual({});
  });

  it('invalidates derived grounding when another media entity is resolved or selected', () => {
    const state = seed('convert', {
      phase: 'propose',
      references: { mediaRef: 'mref_arrival', releaseRef: 'rref_arrival', paths, inspectedPaths: paths },
    });
    for (const changed of [
      result(state, 'catalog', { mediaRef: 'mref_amelie' }),
      reduce(state, { type: 'typed_selection', selection: { type: 'select_media' as any, value: 'Amelie', mediaRef: 'mref_amelie' } }, clock),
    ]) {
      expect(changed.references.mediaRef).toBe('mref_amelie');
      expect(changed.references.releaseRef).toBeUndefined();
      expect(changed.references.paths).toBeUndefined();
      expect(changed.references.inspectedPaths).toBeUndefined();
      expect(changed.phase).toBe('select');
    }
  });

  it('keeps each analysis per file: a listed but unanalyzed file cannot be proposed', () => {
    const changed = result(seed('convert', { phase: 'propose', references: { paths, inspectedPaths: paths } }), 'library_ops', { paths: ['films/Amelie.mkv'] });
    expect(changed.references.inspectedPaths).toEqual(paths);
    expect(changed.references.paths).toEqual([...paths, 'films/Amelie.mkv']);
    expect(changed.phase).toBe('propose');
    expect(validateProposalGrounding('media_format', { action: 'propose', path: 'films/Amelie.mkv' }, changed.references, clock()).valid).toBe(false);
    expect(validateProposalGrounding('media_format', { action: 'propose', path: 'media:films/Arrival.mkv' }, changed.references, clock()).valid).toBe(true);
  });

  it('drops expired analysis before a read result can renew its TTL', () => {
    const expired = seed('convert', {
      phase: 'propose',
      references: { paths, inspectedPaths: paths, expiresAt: '2026-09-12T11:00:00.000Z' },
    });
    const listed = result(expired, 'library_ops', { paths });
    expect(listed.phase).toBe('select');
    expect(listed.references.inspectedPaths).toBeUndefined();
    expect(hasProposalGrounding('convert', listed.references)).toBe(false);
  });

  it('keeps old v2 states compatible but requires a fresh analysis', () => {
    const migrated = migrateWorkflowState(seed('convert', { phase: 'propose', references: { paths } }));
    expect(migrated?.state.schemaVersion).toBe(2);
    expect(groundPhase('propose', migrated!.state)).toBe('select');
    expect(hasProposalGrounding('convert', migrated!.state.references)).toBe(false);
  });

  it('recognizes a verified release selection as a request to propose its download', () => {
    const selected = reduce(seed('other'), {
      type: 'typed_selection',
      selection: { type: 'select_release', value: 'Chosen release', mediaRef: 'mref_arrival', releaseRef: 'rref_arrival' },
    }, clock);
    expect(selected.intent?.kind).toBe('download');
    expect(selected.phase).toBe('propose');
    expect(selected.references.releaseRefs).toEqual(['rref_arrival']);
  });

  it('keeps a created plan in monitoring when its request is refined', () => {
    const monitoring = seed('download', {
      phase: 'monitor',
      references: { mediaRef: 'mref_arrival', releaseRef: 'rref_arrival' },
      proposals: [{ planId: 'plan_arrival', operation: 'media_download', status: 'awaiting_approval', manifestHash: 'hash', proposalKey: 'key' }],
    });
    const refined = reduce(monitoring, {
      type: 'user_message', text: 'Download the 1080p version',
      intent: { kind: 'download', summary: 'Download the 1080p version', subjects: [] },
      suggestedPhase: 'propose',
    }, clock);
    expect(refined.phase).toBe('monitor');
    expect(result(refined, 'catalog', { releaseRef: 'rref_arrival' }).phase).toBe('monitor');
    expect(refined.proposals).toEqual(monitoring.proposals);
  });
});

describe('Observed references and plans', () => {
  it('maps every path form the tools use to one comparison key', () => {
    const key = 'media:tv/Show (2020)/S01E01.mkv';
    for (const form of [
      'tv/Show (2020)/S01E01.mkv',
      'media:tv/Show (2020)/S01E01.mkv',
      '/data/tv/Show (2020)/S01E01.mkv',
      '/tv/Show (2020)/S01E01.mkv',
      'tv\\Show (2020)\\S01E01.mkv',
      ' media:/tv//Show (2020)/./S01E01.mkv ',
    ]) {
      expect(canonicalPathKey(form), form).toBe(key);
    }
    expect(canonicalPathKey('downloads/x.mkv')).toBe('downloads:x.mkv');
    expect(canonicalPathKey('/downloads/x.mkv')).toBe('downloads:x.mkv');
    expect(canonicalPathKey('/srv/other/x.mkv')).toBe('literal:/srv/other/x.mkv');
    expect(canonicalPathKey('C:/media/x.mkv')).toMatch(/^literal:/);
    expect(canonicalPathKey('tv/Ñandú.mkv')).toBe(canonicalPathKey('tv/N\u0303andu\u0301.mkv'));
  });

  it('accumulates observed references, newest last and bounded', () => {
    let state = result(seed('download'), 'catalog', { releaseRefs: ['rref_a', 'rref_b'], releaseRef: 'rref_a' });
    state = result(state, 'catalog', { releaseRefs: ['rref_c', 'rref_a'] });
    expect(state.references.releaseRefs).toEqual(['rref_b', 'rref_c', 'rref_a']);
    expect(state.references.releaseRef).toBe('rref_c');

    const many = Array.from({ length: REFERENCE_LIMITS.paths + 5 }, (_, i) => `tv/Show/E${i}.mkv`);
    const listed = result(seed('delete'), 'library_ops', { paths: many });
    expect(listed.references.paths).toHaveLength(REFERENCE_LIMITS.paths);
    expect(listed.references.paths?.at(-1)).toBe(many.at(-1));
    const again = result(listed, 'library_ops', { paths: [`media:${many.at(-1)}`] });
    expect(again.references.paths).toHaveLength(REFERENCE_LIMITS.paths);
    expect(again.references.paths?.at(-1)).toBe(`media:${many.at(-1)}`);
  });

  it('after a plan, a restated request proposes only a target no plan covers yet', () => {
    const episodes = ['tv/Show/S01E01.mkv', 'tv/Show/S01E02.mkv'];
    const both = planned(result(seed('delete'), 'library_ops', { paths: episodes }), 'plan_e01', [canonicalPathKey(episodes[0])]);
    expect(both.phase).toBe('monitor');
    expect(both.proposalTargets).toEqual({ plan_e01: ['media:tv/Show/S01E01.mkv'] });
    expect(hasFreshGrounding('delete', both)).toBe(true);
    expect(say(both, 'delete').phase).toBe('propose');

    const one = planned(result(seed('delete'), 'library_ops', { paths: [episodes[0]] }), 'plan_e01', [canonicalPathKey(episodes[0])]);
    expect(hasFreshGrounding('delete', one)).toBe(false);
    expect(say(one, 'delete').phase).toBe('monitor');
  });

  it('in monitor, only a newly observed and unproposed target offers another proposal', () => {
    const analyzed = result(seed('convert'), 'media_format', { paths, inspectedPaths: paths });
    const monitoring = planned(analyzed, 'plan_arrival', paths.map(canonicalPathKey));
    expect(result(monitoring, 'media_format', { paths, inspectedPaths: paths }).phase).toBe('monitor');
    expect(result(monitoring, 'library_ops', { paths: ['films/Amelie.mkv'] }).phase).toBe('monitor');
    expect(result(monitoring, 'media_format', { paths: ['films/Amelie.mkv'], inspectedPaths: ['films/Amelie.mkv'] }).phase).toBe('propose');
  });

  it('a plan without recorded targets needs a new observation before another proposal', () => {
    const legacy = seed('delete', {
      phase: 'monitor',
      references: { paths },
      proposals: [{ planId: 'plan_old', operation: 'quarantine_files', status: 'awaiting_approval', manifestHash: 'h', proposalKey: 'k' }],
    });
    expect(hasFreshGrounding('delete', legacy)).toBe(false);
    expect(say(legacy, 'delete').phase).toBe('monitor');
    expect(result(legacy, 'library_ops', { paths: ['films/Other.mkv'] }).phase).toBe('propose');
    expect(planned(legacy, 'plan_new').proposalTargets).toEqual({});
  });

  it('a read without subject words keeps the interrupted request resumable', () => {
    const grounded = seed('download', { phase: 'select', references: { mediaRef: 'mref_arrival', releaseRef: 'rref_arrival' } });
    const read = say(grounded, 'queue', [], 'Show the queue');
    expect(read.phase).toBe('orient');
    expect(read.intent).toMatchObject({ kind: 'queue', subjects: ['arrival'] });
    expect(read.references.releaseRef).toBe('rref_arrival');
    expect(say(read, 'download', [], 'Download it').phase).toBe('propose');
  });

  it('a read about another title starts over', () => {
    const grounded = seed('download', { phase: 'select', references: { mediaRef: 'mref_arrival', releaseRef: 'rref_arrival' } });
    const read = say(grounded, 'library', ['severance'], 'Which episodes of Severance do I have?');
    expect(read.phase).toBe('orient');
    expect(read.references).toEqual({});
  });
});
