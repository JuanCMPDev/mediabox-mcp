/* ─── Release verdicts survive compaction ──────────────────────────────────
 * find_releases marks each release rejected or not, with the reasons and its
 * languages. Compaction dropped those keys, so the model could propose a Latino
 * release for a Japanese-audio request without seeing that it was rejected.
 * ──────────────────────────────────────────────────────────────────────── */
import { describe, it, expect } from 'vitest';
import { compactToolResult } from './budget.js';

describe('Compaction of release listings', () => {
  it('keeps whether a release was rejected, why, and its languages', () => {
    const envelope = JSON.stringify({
      status: 'ok',
      sources: [{ source: 'radarr', completeness: 'complete' }],
      data: [
        {
          releaseRef: 'rref_16d3352f5e80',
          title: 'Rio.Quieto.2021.1080p.WEB-DL.LATINO.x264-SYN',
          score: 90,
          seeders: 40,
          resolution: '1080p',
          languages: ['Spanish (Latin America)'],
          rejected: true,
          rejections: ['Does not contain required Japanese audio'],
          indexerFlags: ['internal detail the model does not need'],
        },
      ],
    });
    const [item] = JSON.parse(compactToolResult('catalog', envelope)).data;
    expect(item).toMatchObject({
      releaseRef: 'rref_16d3352f5e80',
      rejected: true,
      rejections: ['Does not contain required Japanese audio'],
      languages: ['Spanish (Latin America)'],
    });
    expect(item.indexerFlags).toBeUndefined();
  });
});
