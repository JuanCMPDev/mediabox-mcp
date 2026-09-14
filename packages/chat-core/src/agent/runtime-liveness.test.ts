/* ─── Turns that must not end on stale or empty state ──────────────────────
 * G10 experiment 4: an empty completion ended READ-14 in "(sin respuesta)", and
 * after the owner rejected or approved a download the agent kept reporting the
 * status of the proposal turn (DOWNLOAD-07/09).
 * ──────────────────────────────────────────────────────────────────────── */
import { describe, it, expect } from 'vitest';
import type { ChatEvent } from '@mediabox/contracts';
import { AgentRuntime, readOpenPlanStatuses } from './runtime.js';
import { ScriptedProvider, type ScriptedInference } from './replay/scripted-provider.js';
import { FakeMcp } from './replay/fake-mcp.js';
import { InMemoryHistoryStore } from '../history.js';
import { InMemoryWorkflowStore, createInitialWorkflowState, reduce, type WorkflowState } from './workflow.js';
import type { McpCallFn } from '../types.js';

const clock = () => '2026-09-13T00:00:00.000Z';
const NUDGE = 'Your previous reply was empty';

async function runTurn(opts: { conversationId: string; message: string; scripts: ScriptedInference[]; mcp?: FakeMcp; workflowStore?: InMemoryWorkflowStore }) {
  const provider = new ScriptedProvider(opts.scripts);
  const mcp = opts.mcp ?? new FakeMcp({});
  const workflowStore = opts.workflowStore ?? new InMemoryWorkflowStore();
  const events: ChatEvent[] = [];
  for await (const evt of AgentRuntime.streamTurn({
    conversationId: opts.conversationId,
    message: opts.message,
    provider,
    mcpCall: mcp.callFn,
    historyStore: new InMemoryHistoryStore(),
    workflowStore,
    clock,
    locale: 'es',
  })) {
    events.push(evt);
  }
  return { events, provider, mcp, workflowStore };
}

describe('An empty completion gets one nudged retry', () => {
  it('retries once, with the nudge only on the retry, and returns the answer', async () => {
    const { events, provider, mcp } = await runTurn({
      conversationId: 'conv_empty',
      message: '¿Cuántos episodios de Serie Ñandú tengo descargados?',
      scripts: [[], [{ type: 'text', text: 'Tienes 3 episodios de Serie Ñandú.' }]],
    });
    expect(events.at(-1)).toEqual({ type: 'done', fullText: 'Tienes 3 episodios de Serie Ñandú.' });
    expect(provider.seen).toHaveLength(2);
    expect(provider.seen[0].systemPrompt).not.toContain(NUDGE);
    expect(provider.seen[1].systemPrompt).toContain(NUDGE);
    expect(mcp.ledger).toHaveLength(0);
  });

  it('accepts a short answer after the retry: the retry is not a stall', async () => {
    const { events } = await runTurn({ conversationId: 'conv_short', message: '¿Cuántos episodios tengo?', scripts: [[], [{ type: 'text', text: 'Tienes 3.' }]] });
    expect(events.at(-1)).toEqual({ type: 'done', fullText: 'Tienes 3.' });
  });

  it('retries only once: a second empty completion ends with the fallback', async () => {
    const { events, provider } = await runTurn({ conversationId: 'conv_twice', message: '¿Cuántos episodios tengo?', scripts: [[], []] });
    expect(events.at(-1)).toEqual({ type: 'done', fullText: '(sin respuesta)' });
    expect(provider.seen).toHaveLength(2);
  });

  it('drops the nudge after the retry, when the model goes on with a tool call', async () => {
    const { events, provider } = await runTurn({
      conversationId: 'conv_tool',
      message: 'Dame el estado del servidor.',
      scripts: [[], [{ type: 'tool_call', id: 'c1', name: 'server_info', args: { action: 'status' } }], [{ type: 'text', text: 'El servidor está en línea.' }]],
      mcp: new FakeMcp({ server_status: '{"status":"healthy"}' }),
    });
    expect(events.at(-1)).toEqual({ type: 'done', fullText: 'El servidor está en línea.' });
    expect(provider.seen.map((p) => p.systemPrompt.includes(NUDGE))).toEqual([false, true, false]);
  });
});

describe('Open plans are read at the start of each turn', () => {
  function withProposal(conversationId: string, status: string): WorkflowState {
    const initial = createInitialWorkflowState(conversationId, 'user', 'inst', clock);
    return reduce(initial, { type: 'proposal_created', planId: 'plan_7dc2e74c', operation: 'media_download', status, manifestHash: 'h', proposalKey: 'k' }, clock);
  }

  it('updates an awaiting plan the owner rejected and shows the live status to the model', async () => {
    const workflowStore = new InMemoryWorkflowStore();
    await workflowStore.set('conv_live', withProposal('conv_live', 'awaiting_approval'));
    const mcp = new FakeMcp({ operation_status: JSON.stringify({ id: 'plan_7dc2e74c', operation: 'media_download', status: 'rejected', statusReason: 'owner declined' }) });
    const { events, provider } = await runTurn({
      conversationId: 'conv_live',
      message: '¿Se descargó Río Quieto?',
      scripts: [[{ type: 'text', text: 'No: el propietario rechazó la descarga.' }]],
      mcp,
      workflowStore,
    });
    expect(events.at(-1)).toMatchObject({ type: 'done' });
    expect(mcp.ledger.map((e) => [e.tool, e.args])).toEqual([['operation_status', { planId: 'plan_7dc2e74c' }]]);
    expect(provider.seen[0].systemPrompt).toContain('media_download:plan_7dc2e74c(rejected)');
    expect((await workflowStore.get('conv_live'))!.proposals[0].status).toBe('rejected');
  });

  it('does not read plans for a proposal request: it acts, and the server checks duplicates', async () => {
    const workflowStore = new InMemoryWorkflowStore();
    await workflowStore.set('conv_act', withProposal('conv_act', 'awaiting_approval'));
    const mcp = new FakeMcp({});
    await runTurn({
      conversationId: 'conv_act',
      message: 'Borra también el episodio 5 de Serie Ñandú.',
      scripts: [[{ type: 'text', text: 'Primero necesito listar la carpeta.' }]],
      mcp,
      workflowStore,
    });
    expect(mcp.ledger).toHaveLength(0);
  });

  it('records the status the model reads itself from the plan summary, keyed by id', async () => {
    const workflowStore = new InMemoryWorkflowStore();
    // A finished plan is not read at the start of the turn: only the model's read changes it.
    await workflowStore.set('conv_read', withProposal('conv_read', 'succeeded'));
    const mcp = new FakeMcp({ operation_status: JSON.stringify({ id: 'plan_7dc2e74c', operation: 'media_download', status: 'partial' }) });
    await runTurn({
      conversationId: 'conv_read',
      message: '¿Cómo va el plan plan_7dc2e74c?',
      scripts: [[{ type: 'tool_call', id: 'c1', name: 'operations', args: { action: 'status', planId: 'plan_7dc2e74c' } }], [{ type: 'text', text: 'Terminó de forma parcial.' }]],
      mcp,
      workflowStore,
    });
    expect(mcp.ledger).toHaveLength(1);
    expect((await workflowStore.get('conv_read'))!.proposals[0].status).toBe('partial');
  });

  it('reads the three most recent open plans and keeps the status when a read fails', async () => {
    const proposals = ['p1', 'p2', 'p3', 'p4', 'p5'].map((planId, i) => ({
      planId, operation: 'quarantine_files', status: i === 0 ? 'succeeded' : 'awaiting_approval', manifestHash: 'h', proposalKey: planId,
    }));
    const calls: unknown[] = [];
    const mcpCall: McpCallFn = async (_tool, args) => {
      calls.push(args.planId);
      if (args.planId === 'p3') throw new Error('operation_status unavailable');
      if (args.planId === 'p4') return JSON.stringify({ status: 'ok', data: { planId: 'p4', status: 'queued' } });
      return JSON.stringify({ id: args.planId, status: 'awaiting_approval' });
    };
    expect(await readOpenPlanStatuses(proposals, mcpCall)).toEqual([{ planId: 'p4', status: 'queued' }]);
    expect(calls).toEqual(['p3', 'p4', 'p5']);
  });
});
