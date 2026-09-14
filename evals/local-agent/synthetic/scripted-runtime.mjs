/**
 * Scripted Ollama-compatible inference runtime for GPU-free self-tests of the
 * REAL chat path (mcp-server LocalProvider → this server).
 *
 * Emulates what packages/chat-core/src/providers/local.ts and runtime-probe.ts
 * call on an Ollama runtime:
 *   GET  /                      "Ollama is running"
 *   GET  /api/version           {version}
 *   GET  /api/tags              {models:[{name, model, digest, size, details}]}
 *   POST /api/show              {model_info{"<arch>.context_length"}, capabilities, parameters, template}
 *   GET  /v1/models             OpenAI list
 *   POST /v1/chat/completions   stream:true → SSE chat.completion.chunk frames, finish_reason,
 *                               a usage frame (stream_options.include_usage) and `data: [DONE]`;
 *                               stream:false → one chat.completion object.
 *
 * Responses come from a FIFO queue. Each queued item is an array of steps (or
 * `{ steps, usage?, delayMs? }`):
 *   { text: string }                                  streamed as content deltas (chunkChars per frame)
 *   { toolCall: { name, arguments: object|string, id? } }  one tool_calls delta (string args are sent verbatim,
 *                                                     so invalid JSON can be scripted)
 *   { reasoning: string, inline?: boolean }           `delta.reasoning` (or `<think>…</think>` inline)
 *   { delayMs: number }                               pause before the next frame (TTFT / stall emulation)
 *   { raw: string }                                   raw SSE text written as-is (protocol-quirk tests)
 *   { error: string }                                 an in-stream `{"error":{...}}` frame
 * An empty queue answers with the text "(script exhausted)".
 *
 * Faults (`setFault`) apply to chat completion requests only:
 *   { status: 503, body? }        HTTP error before streaming (the queue item is NOT consumed)
 *   { hang: true }                accept the request and never answer (item NOT consumed)
 *   { destroyAfterChunks: n }     stream n frames of the next item, then reset the socket (item consumed)
 *   any of them + { times: n }    apply only n times (default: until clearFault()).
 *
 * `contextTokens` is reported as `model_info["qwen2.context_length"]`; `numCtx`
 * (default = contextTokens) is reported as `parameters: "num_ctx <n>"`. Real
 * Ollama reports the trained maximum in model_info and the served window in
 * num_ctx, so setting them apart reproduces that discrepancy.
 */
import http from 'node:http';
import crypto from 'node:crypto';
import { performance } from 'node:perf_hooks';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function archOf(model) {
  const base = String(model).split(':')[0].toLowerCase();
  if (base.startsWith('qwen3')) return 'qwen3';
  if (base.startsWith('qwen')) return 'qwen2';
  if (base.startsWith('llama')) return 'llama';
  if (base.startsWith('mistral')) return 'llama';
  if (base.startsWith('gemma')) return 'gemma3';
  return 'llama';
}

function estimateTokens(value) {
  return Math.max(1, Math.ceil(JSON.stringify(value ?? '').length / 4));
}

function normalizeItem(item) {
  if (Array.isArray(item)) return { steps: item };
  if (item && typeof item === 'object' && Array.isArray(item.steps)) return item;
  if (typeof item === 'string') return { steps: [{ text: item }] };
  throw new Error('scripted item must be an array of steps, { steps }, or a string');
}

/**
 * @param {{ model?: string, contextTokens?: number, numCtx?: number, supportsTools?: boolean,
 *   script?: Array<object[]|{steps:object[]}|string>, host?: string, port?: number,
 *   advertiseHost?: string, chunkChars?: number, chunkDelayMs?: number, version?: string,
 *   onRequest?: (entry: object) => void }} [opts]
 */
export async function startScriptedRuntime(opts = {}) {
  const {
    model = 'qwen2.5:7b',
    contextTokens = 8192,
    numCtx = contextTokens,
    supportsTools = true,
    script = [],
    host = '127.0.0.1',
    port = 0,
    chunkChars = 16,
    chunkDelayMs = 0,
    version = '0.11.4',
    onRequest,
  } = opts;

  const queue = script.map(normalizeItem);
  const requests = [];
  const probes = [];
  const openResponses = new Set();
  let fault = null;
  let seq = 0;
  let served = 0;
  const digest = `sha256:${crypto.createHash('sha256').update(model).digest('hex')}`;
  const arch = archOf(model);

  function notify(entry) {
    if (typeof onRequest !== 'function') return;
    try { onRequest(entry); } catch { /* observer errors are ignored */ }
  }

  function takeFault() {
    if (!fault) return null;
    const f = fault;
    if (f.times !== undefined) {
      f.times -= 1;
      if (f.times <= 0) fault = null;
    }
    return f;
  }

  async function handleChat(req, res, raw, entry) {
    let body;
    try {
      body = JSON.parse(raw || '{}');
    } catch {
      entry.status = 400;
      return sendJson(res, 400, { error: { message: 'invalid JSON body', type: 'invalid_request_error' } });
    }
    const record = { seq: entry.seq, ts: entry.ts, tMs: entry.tMs, path: entry.path, body, outcome: null, itemIndex: null };
    requests.push(record);

    const f = takeFault();
    if (f?.status) {
      record.outcome = `fault:${f.status}`;
      entry.status = f.status;
      return sendJson(res, f.status, f.body ?? { error: { message: `synthetic runtime fault ${f.status}`, type: 'api_error' } });
    }
    if (f?.hang) {
      record.outcome = 'fault:hang';
      entry.status = 0;
      openResponses.add(res);
      return undefined;
    }
    if (body.model !== model) {
      record.outcome = 'model_not_found';
      entry.status = 404;
      return sendJson(res, 404, { error: { message: `model "${body.model}" not found, try pulling it first`, type: 'api_error', param: null, code: null } });
    }
    if (!supportsTools && Array.isArray(body.tools) && body.tools.length > 0) {
      record.outcome = 'tools_unsupported';
      entry.status = 400;
      return sendJson(res, 400, { error: { message: `registry.ollama.ai/library/${model} does not support tools`, type: 'api_error', param: null, code: null } });
    }

    const item = queue.length > 0 ? queue.shift() : { steps: [{ text: '(script exhausted)' }], exhausted: true };
    record.itemIndex = item.exhausted ? null : served;
    if (!item.exhausted) served += 1;
    record.outcome = item.exhausted ? 'exhausted' : 'script';

    const id = `chatcmpl-${crypto.randomBytes(4).toString('hex')}`;
    const created = Math.floor(Date.now() / 1000);
    const base = { id, object: 'chat.completion.chunk', created, model, system_fingerprint: 'fp_ollama' };
    const promptTokens = item.usage?.prompt_tokens ?? estimateTokens(body.messages) + (body.tools ? estimateTokens(body.tools) : 0);
    let completionChars = 0;
    const toolCalls = [];
    let content = '';

    if (item.delayMs) await sleep(item.delayMs);

    if (body.stream !== true) {
      for (const step of item.steps) {
        if (step.delayMs) await sleep(step.delayMs);
        if (typeof step.text === 'string') content += step.text;
        if (typeof step.reasoning === 'string' && step.inline) content += `<think>${step.reasoning}</think>`;
        if (step.toolCall) {
          const args = typeof step.toolCall.arguments === 'string' ? step.toolCall.arguments : JSON.stringify(step.toolCall.arguments ?? {});
          toolCalls.push({ id: step.toolCall.id ?? `call_${crypto.randomBytes(4).toString('hex')}`, index: toolCalls.length, type: 'function', function: { name: step.toolCall.name, arguments: args } });
        }
      }
      entry.status = 200;
      return sendJson(res, 200, {
        id, object: 'chat.completion', created, model, system_fingerprint: 'fp_ollama',
        choices: [{ index: 0, message: { role: 'assistant', content, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) }, finish_reason: toolCalls.length ? 'tool_calls' : 'stop' }],
        usage: { prompt_tokens: promptTokens, completion_tokens: estimateTokens(content), total_tokens: promptTokens + estimateTokens(content) },
      });
    }

    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    entry.status = 200;
    openResponses.add(res);
    res.on('close', () => openResponses.delete(res));
    let frames = 0;
    let cut = false;
    const limit = f?.destroyAfterChunks;
    const writeRaw = (s) => {
      if (cut || res.destroyed) return false;
      res.write(s);
      frames += 1;
      if (limit !== undefined && frames >= limit) {
        cut = true;
        record.outcome = `fault:destroyAfterChunks:${limit}`;
        setTimeout(() => res.socket?.destroy(), 5).unref?.();
        return false;
      }
      return true;
    };
    const frame = (obj) => writeRaw(`data: ${JSON.stringify(obj)}\n\n`);
    const delta = (d, finish = null) => frame({ ...base, choices: [{ index: 0, delta: { role: 'assistant', ...d }, finish_reason: finish }] });

    for (const step of item.steps) {
      if (cut) break;
      if (step.delayMs) await sleep(step.delayMs);
      if (typeof step.raw === 'string') {
        writeRaw(step.raw);
      } else if (typeof step.error === 'string') {
        frame({ error: { message: step.error, type: 'api_error' } });
      } else if (typeof step.reasoning === 'string') {
        if (step.inline) delta({ content: `<think>${step.reasoning}</think>` });
        else delta({ content: '', reasoning: step.reasoning });
        completionChars += step.reasoning.length;
      } else if (typeof step.text === 'string') {
        const size = Math.max(1, step.chunkChars ?? chunkChars);
        const chars = [...step.text];
        for (let i = 0; i < chars.length && !cut; i += size) {
          const piece = chars.slice(i, i + size).join('');
          delta({ content: piece });
          content += piece;
          if (chunkDelayMs) await sleep(chunkDelayMs);
        }
        completionChars += step.text.length;
      } else if (step.toolCall) {
        const args = typeof step.toolCall.arguments === 'string' ? step.toolCall.arguments : JSON.stringify(step.toolCall.arguments ?? {});
        const call = { id: step.toolCall.id ?? `call_${crypto.randomBytes(4).toString('hex')}`, index: toolCalls.length, type: 'function', function: { name: step.toolCall.name, arguments: args } };
        toolCalls.push(call);
        delta({ content: '', tool_calls: [call] });
        completionChars += args.length + String(step.toolCall.name).length;
      }
    }
    if (!cut) delta({ content: '' }, toolCalls.length ? 'tool_calls' : 'stop');
    const completionTokens = item.usage?.completion_tokens ?? Math.max(1, Math.ceil(completionChars / 4));
    if (!cut) frame({ ...base, choices: [], usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens } });
    if (!cut) writeRaw('data: [DONE]\n\n');
    record.responseText = content;
    record.toolCalls = toolCalls.map((c) => ({ name: c.function.name, arguments: c.function.arguments }));
    if (!cut) res.end();
    return undefined;
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://runtime.local');
    const raw = await readBody(req).catch(() => '');
    const entry = { seq: ++seq, ts: Date.now(), tMs: performance.now(), method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), remoteAddress: req.socket?.remoteAddress ?? null, status: null };
    try {
      if (req.method === 'POST' && (url.pathname === '/v1/chat/completions' || url.pathname === '/chat/completions')) {
        await handleChat(req, res, raw, entry);
        return;
      }
      probes.push({ seq: entry.seq, ts: entry.ts, method: req.method, path: url.pathname, body: raw || undefined });
      if (req.method === 'GET' && url.pathname === '/') {
        entry.status = 200;
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('Ollama is running');
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/version') {
        entry.status = 200;
        return sendJson(res, 200, { version });
      }
      if (req.method === 'GET' && url.pathname === '/api/tags') {
        entry.status = 200;
        return sendJson(res, 200, {
          models: [{
            name: model, model, modified_at: '2026-09-01T12:00:00.000Z', size: 4_683_087_332, digest,
            details: { parent_model: '', format: 'gguf', family: arch, families: [arch], parameter_size: '7.6B', quantization_level: 'Q4_K_M' },
          }],
        });
      }
      if (req.method === 'POST' && url.pathname === '/api/show') {
        let body = {};
        try { body = JSON.parse(raw || '{}'); } catch { /* handled below */ }
        const asked = body.model ?? body.name;
        if (asked !== model) {
          entry.status = 404;
          return sendJson(res, 404, { error: `model '${asked}' not found` });
        }
        entry.status = 200;
        return sendJson(res, 200, {
          license: 'synthetic',
          modelfile: `FROM ${model}\nPARAMETER num_ctx ${numCtx}\n`,
          parameters: `num_ctx                        ${numCtx}\nstop                           "<|im_end|>"`,
          template: '{{- if .Tools }}<tools>{{ range .Tools }}{{ . }}{{ end }}</tools>{{ end }}{{ .Prompt }}',
          details: { parent_model: '', format: 'gguf', family: arch, families: [arch], parameter_size: '7.6B', quantization_level: 'Q4_K_M' },
          model_info: {
            'general.architecture': arch,
            'general.parameter_count': 7_615_616_512,
            [`${arch}.context_length`]: contextTokens,
            [`${arch}.embedding_length`]: 3584,
          },
          capabilities: supportsTools ? ['completion', 'tools'] : ['completion'],
          modified_at: '2026-09-01T12:00:00.000Z',
        });
      }
      if (req.method === 'GET' && url.pathname === '/v1/models') {
        entry.status = 200;
        return sendJson(res, 200, { object: 'list', data: [{ id: model, object: 'model', created: 1_756_728_000, owned_by: 'library' }] });
      }
      entry.status = 404;
      return sendJson(res, 404, { error: `synthetic runtime: no route for ${req.method} ${url.pathname}` });
    } finally {
      notify(entry);
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(Number(port) || 0, host, resolve);
  });
  const boundPort = server.address().port;
  const advertise = opts.advertiseHost ?? (host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host);
  const url = `http://${advertise.includes(':') ? `[${advertise}]` : advertise}:${boundPort}`;

  return {
    url,
    port: boundPort,
    model,
    /** Chat completion requests: { seq, ts, tMs, path, body, outcome, itemIndex, responseText, toolCalls }. */
    requests,
    /** Every other request (probes): { seq, ts, method, path, body }. */
    probes,
    push(...items) {
      for (const item of items) queue.push(normalizeItem(item));
    },
    pending: () => queue.length,
    clearQueue() {
      queue.length = 0;
    },
    setFault(f) {
      fault = f ? { ...f } : null;
    },
    clearFault() {
      fault = null;
    },
    async close() {
      for (const res of openResponses) res.socket?.destroy();
      openResponses.clear();
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };
}
