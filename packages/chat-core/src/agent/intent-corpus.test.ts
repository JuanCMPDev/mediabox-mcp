/**
 * Ties classifyIntent to every user message of the sealed P11 corpus
 * (evals/local-agent/corpus.json). A new or reworded message fails here until
 * its intent is declared, so the lexical router cannot drift away from the
 * scenarios that measure it. Placeholders such as {{planId}} are classified
 * as written.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { classifyIntent } from './runtime.js';
import type { IntentKind } from './workflow.js';

const corpusPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../evals/local-agent/corpus.json');
const corpus = JSON.parse(fs.readFileSync(corpusPath, 'utf8')) as {
  scenarios: Array<{ id: string; steps: Array<{ kind: string; message?: string }> }>;
};

/** `none`: the message carries no intent and the conversation keeps the previous one. */
type Expected = IntentKind | 'none';

/** Intent of each user turn of each scenario, in corpus order. */
const EXPECTED: Record<string, Expected[]> = {
  'READ-01': ['library'],
  'READ-02': ['library'],
  'READ-03': ['library'],
  'READ-04': ['library'],
  'READ-05': ['server'],
  'READ-06': ['queue'],
  'READ-07': ['server'],
  'READ-08': ['server'],
  'READ-09': ['library'],
  'READ-10': ['other'],
  'READ-11': ['library'],
  'READ-12': ['library'],
  'READ-13': ['other'],
  'READ-14': ['none', 'library'],
  'READ-15': ['other', 'other', 'library', 'server', 'other'],
  'READ-16': ['status'],
  'READ-17': ['status'],
  'READ-18': ['status'],
  'READ-19': ['library'],
  'READ-20': ['library'],
  'SEARCH-01': ['other'],
  'SEARCH-02': ['other'],
  'SEARCH-03': ['other'],
  'SEARCH-04': ['other'],
  'SEARCH-05': ['other'],
  'SEARCH-06': ['download'],
  'SEARCH-07': ['download'],
  'SEARCH-09': ['other', 'none'],
  'SEARCH-10': ['download'],
  'DOWNLOAD-01': ['download'],
  'DOWNLOAD-02': ['download'],
  'DOWNLOAD-03': ['download'],
  'DOWNLOAD-04': ['download'],
  'DOWNLOAD-05': ['download'],
  'DOWNLOAD-06': ['download'],
  'DOWNLOAD-07': ['download', 'status'],
  'DOWNLOAD-08': ['download', 'status'],
  'DOWNLOAD-09': ['download', 'status'],
  'DOWNLOAD-10': ['download'],
  'STORAGE-01': ['delete'],
  'STORAGE-02': ['delete'],
  'STORAGE-03': ['owner_only'],
  'STORAGE-04': ['owner_only'],
  'STORAGE-05': ['delete'],
  'STORAGE-06': ['convert'],
  'STORAGE-07': ['convert'],
  'STORAGE-08': ['convert'],
  'STORAGE-09': ['convert'],
  'STORAGE-10': ['maintenance'],
  'ADV-01': ['library'],
  'ADV-02': ['download'],
  'ADV-03': ['delete'],
  'ADV-04': ['none'],
  'ADV-05': ['other'],
  'ADV-06': ['owner_only'],
  'ADV-07': ['owner_only'],
  'ADV-08': ['library'],
  'ADV-09': ['none'],
  'ADV-10': ['server'],
};

const rows = corpus.scenarios.flatMap(scenario => scenario.steps
  .filter(step => step.kind === 'user' && typeof step.message === 'string')
  .map((step, turn) => ({ id: scenario.id, turn, message: step.message! })));

describe('classifyIntent over the sealed P11 corpus', () => {
  it('declares the intent of every user message of the corpus, and of nothing else', () => {
    const declared = Object.entries(EXPECTED).flatMap(([id, kinds]) => kinds.map((_, turn) => `${id}#${turn}`));
    expect(rows.map(row => `${row.id}#${row.turn}`)).toEqual(declared);
  });

  it.each(rows)('$id turn $turn: $message', ({ id, turn, message }) => {
    expect(classifyIntent(message)?.kind ?? 'none').toBe(EXPECTED[id]?.[turn]);
  });
});
