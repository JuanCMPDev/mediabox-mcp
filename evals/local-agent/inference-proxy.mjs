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

/** A completion is at most outputReserve tokens; this bounds a runaway stream. */
const MAX_CHAT_BODY_BYTES = 4 * 1024 * 1024;
/** Characters kept from an empty completion so it can be diagnosed. */
export const EMPTY_SAMPLE_CHARS = 512;

const hasValue = (v) => v !== null && v !== undefined && v !== '' && !(Array.isArray(v) && v.length === 0);

/**
 * Reads a chat completion (SSE stream or JSON body) and returns what the runtime
 * reported (usage, finish reason) and what the model emitted: visible content
 * characters and tool calls. An empty completion (no content, no tool call) also
 * keeps `emptySample`, the non-empty delta fields the runtime sent, so a turn
 * that ends in "(sin respuesta)" can be told apart from a swallowed tool call.
 */
export function summarizeCompletion(body) {
  const out = { contentChars: 0, toolCalls: 0 };
  const payloads = body.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim());
  if (payloads.length === 0 && body.trim().startsWith('{')) payloads.push(body.trim());
  const calls = new Set();
  const meaningful = [];
  for (const p of payloads) {
    if (p === '[DONE]') continue;
    let json;
    try { json = JSON.parse(p); } catch { continue; }
    // Usage arrives in the last SSE chunk (stream_options.include_usage) or the JSON body.
    if (json?.usage && typeof json.usage === 'object') {
      out.promptTokens = json.usage.prompt_tokens;
      out.completionTokens = json.usage.completion_tokens;
    }
    for (const choice of Array.isArray(json?.choices) ? json.choices : []) {
      if (choice?.finish_reason) out.finishReason = choice.finish_reason;
      const delta = choice?.delta ?? choice?.message;
      if (!delta || typeof delta !== 'object') continue;
      if (typeof delta.content === 'string') out.contentChars += delta.content.length;
      if (Array.isArray(delta.tool_calls)) {
        delta.tool_calls.forEach((tc, i) => calls.add(`${choice.index ?? 0}:${tc?.index ?? tc?.id ?? i}`));
      }
      if (Object.entries(delta).some(([k, v]) => k !== 'role' && hasValue(v))) meaningful.push(JSON.stringify(delta));
    }
  }
  out.toolCalls = calls.size;
  if (out.contentChars === 0 && out.toolCalls === 0) out.emptySample = meaningful.join('').slice(0, EMPTY_SAMPLE_CHARS);
  return out;
}

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
        const parts = [];
        let kept = 0;
        up.on('data', (d) => {
          if (rec.tFirstByte === undefined) rec.tFirstByte = performance.now();
          res.write(d);
          if (rec.kind === 'chat' && kept < MAX_CHAT_BODY_BYTES) {
            parts.push(d);
            kept += d.length;
          }
        });
        up.on('end', () => {
          rec.tEnd = performance.now();
          res.end();
          if (rec.kind === 'chat') Object.assign(rec, summarizeCompletion(Buffer.concat(parts).toString('utf8')));
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
