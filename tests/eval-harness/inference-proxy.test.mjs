/**
 * Inference proxy records (PR05 §4.4): usage, finish reason, and what the model
 * emitted. An empty completion (no visible text, no tool call) keeps a bounded
 * sample of what the runtime did send, so a "(sin respuesta)" turn can be diagnosed.
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'node:test';

import { EMPTY_SAMPLE_CHARS, startInferenceProxy, summarizeCompletion } from '../../evals/local-agent/inference-proxy.mjs';

const sse = (...chunks) => chunks.map((c) => `data: ${typeof c === 'string' ? c : JSON.stringify(c)}\n\n`).join('');
const delta = (d, extra = {}) => ({ choices: [{ index: 0, delta: d, ...extra }] });
const usage = (prompt, completion) => ({ choices: [], usage: { prompt_tokens: prompt, completion_tokens: completion } });

test('visible text is counted and no sample is kept', () => {
  const out = summarizeCompletion(sse(delta({ role: 'assistant', content: 'Hola, ' }), delta({ content: 'mundo' }, { finish_reason: 'stop' }), usage(1200, 4), '[DONE]'));
  assert.deepEqual(out, { contentChars: 11, toolCalls: 0, finishReason: 'stop', promptTokens: 1200, completionTokens: 4 });
});

test('a tool call streamed over several chunks counts once', () => {
  const out = summarizeCompletion(sse(
    delta({ role: 'assistant', tool_calls: [{ index: 0, id: 'call_1', function: { name: 'catalog', arguments: '' } }] }),
    delta({ tool_calls: [{ index: 0, function: { arguments: '{"action":"search"}' } }] }),
    delta({}, { finish_reason: 'tool_calls' }),
    usage(1300, 20),
  ));
  assert.equal(out.toolCalls, 1);
  assert.equal(out.contentChars, 0);
  assert.equal(out.emptySample, undefined);
});

test('an empty completion keeps the non-empty fields the runtime sent, bounded', () => {
  const empty = summarizeCompletion(sse(delta({ role: 'assistant', content: '' }), delta({ content: '' }, { finish_reason: 'stop' }), usage(1629, 30)));
  assert.equal(empty.contentChars, 0);
  assert.equal(empty.toolCalls, 0);
  assert.equal(empty.completionTokens, 30);
  assert.equal(empty.emptySample, '', 'nothing visible was sent: the tokens were swallowed');

  const reasoning = summarizeCompletion(sse(delta({ role: 'assistant', reasoning: 'x'.repeat(2000) }), usage(1500, 600)));
  assert.equal(reasoning.emptySample.length, EMPTY_SAMPLE_CHARS);
  assert.ok(reasoning.emptySample.startsWith('{"role":"assistant","reasoning":"xxx'));
});

test('a JSON (non-streamed) body is read the same way', () => {
  const out = summarizeCompletion(JSON.stringify({
    choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [{ id: 'a', function: { name: 'x' } }, { id: 'b', function: { name: 'y' } }] } }],
    usage: { prompt_tokens: 900, completion_tokens: 40 },
  }));
  assert.equal(out.toolCalls, 2);
  assert.equal(out.finishReason, 'tool_calls');
  assert.equal(out.promptTokens, 900);
});

test('the proxy forwards the stream unchanged and records the summary', async () => {
  const body = sse(delta({ role: 'assistant', content: '' }, { finish_reason: 'stop' }), usage(1629, 30), '[DONE]');
  const upstream = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(body);
    });
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const proxy = await startInferenceProxy({ targetBaseUrl: `http://127.0.0.1:${upstream.address().port}` });
  try {
    const res = await fetch(`${proxy.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'hola' }], tools: [{ type: 'function', function: { name: 'catalog' } }], max_tokens: 1024 }),
    });
    assert.equal(await res.text(), body);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const [rec] = proxy.records;
    assert.equal(rec.kind, 'chat');
    assert.deepEqual(rec.toolNames, ['catalog']);
    assert.equal(rec.completionTokens, 30);
    assert.equal(rec.contentChars, 0);
    assert.equal(rec.toolCalls, 0);
    assert.equal(rec.emptySample, '');
  } finally {
    await proxy.close();
    await new Promise((resolve) => upstream.close(resolve));
  }
});
