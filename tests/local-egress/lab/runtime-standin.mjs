/**
 * Minimal OpenAI-compatible runtime stand-in for NET-04 (runs in a container).
 * REDIRECT_TO=<url> makes every chat completion answer 307 to that URL, which
 * the production transport must refuse. Every request is logged to LEDGER.
 */
import http from 'node:http';
import fs from 'node:fs';

const port = Number(process.env.PORT ?? 11434);
const ledger = process.env.LEDGER ?? '/ledger/runtime.jsonl';
const redirectTo = process.env.REDIRECT_TO ?? '';

http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => { body += d; });
  req.on('end', () => {
    fs.appendFileSync(ledger, JSON.stringify({ ts: new Date().toISOString(), method: req.method, path: req.url, src: req.socket.remoteAddress, bytes: body.length }) + '\n');
    if (req.url === '/api/version') return json(res, { version: 'standin' });
    if (req.url === '/api/tags') return json(res, { models: [{ name: 'qwen2.5:7b', model: 'qwen2.5:7b', digest: '0'.repeat(64) }] });
    if (req.url === '/api/show') return json(res, { capabilities: ['completion', 'tools'], model_info: { 'qwen2.context_length': 8192 } });
    if (req.url === '/v1/models') return json(res, { data: [{ id: 'qwen2.5:7b' }] });
    if (req.url?.startsWith('/v1/chat/completions')) {
      if (redirectTo) {
        res.writeHead(307, { Location: redirectTo });
        return res.end();
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const chunk = (delta, finish = null) => `data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', model: 'qwen2.5:7b', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
      res.write(chunk({ role: 'assistant', content: 'standin reply' }));
      res.write(chunk({}, 'stop'));
      res.write(`data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', choices: [], usage: { prompt_tokens: 10, completion_tokens: 2 } })}\n\n`);
      res.end('data: [DONE]\n\n');
      return;
    }
    res.writeHead(404);
    res.end();
  });
}).listen(port, '0.0.0.0');

function json(res, value) {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(value));
}
