import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '../..');

test('Corpus contains exactly 60 scenarios with valid schemas', () => {
  const corpusPath = path.join(repoRoot, 'evals/local-agent/corpus.json');
  assert.ok(fs.existsSync(corpusPath), 'corpus.json must exist');

  const corpus = JSON.parse(fs.readFileSync(corpusPath, 'utf8'));
  assert.equal(corpus.length, 60, 'Corpus must have exactly 60 scenarios');

  const categories = { READ: 0, SEARCH: 0, DOWNLOAD: 0, STORAGE: 0, ADV: 0 };
  const ids = new Set();

  for (const s of corpus) {
    assert.ok(s.id, 'Scenario must have an id');
    assert.ok(!ids.has(s.id), `Duplicate scenario id: ${s.id}`);
    ids.add(s.id);

    assert.ok(s.category in categories, `Invalid category: ${s.category}`);
    categories[s.category]++;

    assert.ok(typeof s.title === 'string' && s.title.trim().length > 0, `${s.id}: missing title`);
    assert.ok(typeof s.description === 'string' && s.description.trim().length > 0, `${s.id}: missing description`);
    assert.ok(['es', 'en'].includes(s.locale), `${s.id}: locale must be es or en`);
    assert.ok(Array.isArray(s.turns) && s.turns.length > 0, `${s.id}: turns must be non-empty`);
    assert.ok(typeof s.fixtures === 'object' && s.fixtures !== null, `${s.id}: fixtures must be an object`);
  }

  assert.equal(categories.READ, 20, 'READ category must have exactly 20 scenarios');
  assert.equal(categories.SEARCH, 10, 'SEARCH category must have exactly 10 scenarios');
  assert.equal(categories.DOWNLOAD, 10, 'DOWNLOAD category must have exactly 10 scenarios');
  assert.equal(categories.STORAGE, 10, 'STORAGE category must have exactly 10 scenarios');
  assert.equal(categories.ADV, 10, 'ADV category must have exactly 10 scenarios');
});

test('Corpus scenarios follow exact frozen ordering', () => {
  const corpus = JSON.parse(fs.readFileSync(path.join(repoRoot, 'evals/local-agent/corpus.json'), 'utf8'));
  const ids = corpus.map(s => s.id);

  // READ-01..20
  for (let i = 1; i <= 20; i++) {
    const expectedId = `READ-${String(i).padStart(2, '0')}`;
    assert.equal(ids[i - 1], expectedId, `Index ${i - 1} must be ${expectedId}`);
  }

  // SEARCH-01..10
  for (let i = 1; i <= 10; i++) {
    const expectedId = `SEARCH-${String(i).padStart(2, '0')}`;
    assert.equal(ids[20 + i - 1], expectedId, `Index ${20 + i - 1} must be ${expectedId}`);
  }

  // DOWNLOAD-01..10
  for (let i = 1; i <= 10; i++) {
    const expectedId = `DOWNLOAD-${String(i).padStart(2, '0')}`;
    assert.equal(ids[30 + i - 1], expectedId, `Index ${30 + i - 1} must be ${expectedId}`);
  }

  // STORAGE-01..10
  for (let i = 1; i <= 10; i++) {
    const expectedId = `STORAGE-${String(i).padStart(2, '0')}`;
    assert.equal(ids[40 + i - 1], expectedId, `Index ${40 + i - 1} must be ${expectedId}`);
  }

  // ADV-01..10
  for (let i = 1; i <= 10; i++) {
    const expectedId = `ADV-${String(i).padStart(2, '0')}`;
    assert.equal(ids[50 + i - 1], expectedId, `Index ${50 + i - 1} must be ${expectedId}`);
  }
});

test('Mandatory warm eligible scenarios are strictly marked', () => {
  const corpus = JSON.parse(fs.readFileSync(path.join(repoRoot, 'evals/local-agent/corpus.json'), 'utf8'));

  // READ-01..20, SEARCH-01..10, DOWNLOAD-01..05 must be warm eligible
  const mandatoryWarmIds = [
    ...Array.from({ length: 20 }, (_, i) => `READ-${String(i + 1).padStart(2, '0')}`),
    ...Array.from({ length: 10 }, (_, i) => `SEARCH-${String(i + 1).padStart(2, '0')}`),
    ...Array.from({ length: 5 }, (_, i) => `DOWNLOAD-${String(i + 1).padStart(2, '0')}`)
  ];

  assert.equal(mandatoryWarmIds.length, 35, 'Exactly 35 mandatory warm scenarios');

  for (const s of corpus) {
    if (mandatoryWarmIds.includes(s.id)) {
      assert.equal(s.warmFirstEventEligible, true, `${s.id} must have warmFirstEventEligible=true`);
      assert.equal(s.warmTaskEligible, true, `${s.id} must have warmTaskEligible=true`);
    }
  }
});
