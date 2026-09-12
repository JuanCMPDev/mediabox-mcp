/**
 * Recording proxy between the server and the inference runtime (PR05 §4.4).
 *
 * It sits outside the candidate process and forwards every request unchanged.
 * For each chat completion it records what the model was actually given (tool
 * names, max_tokens, message count) and what the runtime reported (prompt and
 * completion tokens), with monotonic timestamps of the first and last byte.
 * The server addresses it as a loopback endpoint, so the production endpoint
 * policy and transport run unmodified.
 */

import http from 'node:http';

export async function startInferenceProxy({ targetBaseUrl }) {
  const target = new URL(targetBaseUrl);
  const records = [];
  let fault = null;
  let seq = 0;

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const rec = { seq: ++seq, method: req.method, path: req.url, tStart: performance.now(), wallStart: new Date().toISOString() };
      if (req.url.includes('/chat/completions')) {
        try {
          const json = JSON.parse(body.toString('utf8'));
          rec.kind = 'chat';
          rec.toolNames = (json.tools ?? []).map((t) => t.function?.name ?? t.name);
          rec.maxTokens = json.max_tokens;
          rec.messages = json.messages?.length ?? 0;
          rec.temperature = json.temperature;
          rec.seed = json.seed;
        } catch {
          rec.kind = 'chat-unparseable';
        }
      }
      records.push(rec);

      if (fault?.type === 'down') {
        rec.status = 'refused-by-fault';
        req.socket.destroy();
        return;
      }
      if (fault?.type === 'status') {
        rec.status = fault.status;
        res.writeHead(fault.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'injected runtime fault' }));
        return;
      }

      const upstream = http.request({
        hostname: target.hostname,
        port: target.port,
        path: req.url,
        method: req.method,
        headers: { ...req.headers, host: target.host },
      }, (up) => {
        rec.status = up.statusCode;
        res.writeHead(up.statusCode, up.headers);
        let tail = '';
        up.on('data', (d) => {
          if (rec.tFirstByte === undefined) rec.tFirstByte = performance.now();
          res.write(d);
          if (rec.kind === 'chat') {
            tail = (tail + d.toString('utf8')).slice(-8192);
          }
        });
        up.on('end', () => {
          rec.tEnd = performance.now();
          res.end();
          if (rec.kind === 'chat') {
            // Usage arrives in the last SSE chunk (stream_options.include_usage) or the JSON body;
            // it may contain nested objects, so every `data:` line is parsed as JSON.
            const payloads = tail.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim());
            if (payloads.length === 0 && tail.trim().startsWith('{')) payloads.push(tail.trim());
            for (const p of payloads) {
              if (p === '[DONE]') continue;
              let json;
              try { json = JSON.parse(p); } catch { continue; }
              if (json?.usage && typeof json.usage === 'object') {
                rec.promptTokens = json.usage.prompt_tokens;
                rec.completionTokens = json.usage.completion_tokens;
              }
              const fin = json?.choices?.find?.((c) => c?.finish_reason)?.finish_reason;
              if (fin) rec.finishReason = fin;
            }
          }
        });
        up.on('error', () => { rec.error = 'upstream-stream-error'; res.destroy(); });
      });
      upstream.on('error', (err) => {
        rec.error = err.code ?? err.message;
        if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'runtime unreachable' }));
      });
      upstream.end(body);
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    records,
    /** Chat records started inside [t0, t1] (performance.now() clock). */
    window(t0, t1) {
      return records.filter((r) => r.kind === 'chat' && r.tStart >= t0 && r.tStart <= t1);
    },
    setFault(f) { fault = f; },
    clearFault() { fault = null; },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
