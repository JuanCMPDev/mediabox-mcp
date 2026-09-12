/**
 * STORAGE-05 needs a library file that is a hard link of a download (the
 * quarantine must not claim reclaimable space). The first live experiment on
 * 0e81321 could not materialize it: the link was resolved inside the media root
 * and the downloads root was created afterwards. This pins the fix.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { materializeInstallation } from '../../evals/local-agent/stack.mjs';
import { expandScenario } from '../../evals/local-agent/runner.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const corpus = JSON.parse(fs.readFileSync(path.join(repoRoot, 'evals/local-agent/corpus.json'), 'utf8'));

test('STORAGE-05 media: the library file is a hard link of the download', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mbx-links-'));
  try {
    const paths = { media: path.join(root, 'media'), downloads: path.join(root, 'downloads') };
    const { media } = expandScenario(corpus.scenarios.find((s) => s.id === 'STORAGE-05'), corpus.base);
    await materializeInstallation(paths, media);
    const lib = fs.statSync(path.join(paths.media, 'movies', 'Crónica de Cobre (2019)', 'Crónica de Cobre (2019).mkv'));
    const dl = fs.statSync(path.join(paths.downloads, 'Crónica de Cobre (2019)', 'Crónica de Cobre (2019).mkv'));
    assert.equal(lib.ino, dl.ino, 'same inode');
    assert.equal(lib.nlink, 2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
