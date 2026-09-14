/**
 * NET-04 client (PR05 §3.4). Runs INSIDE the real mcp-server image, so the
 * endpoint policy, LocalProvider and fetch transport are exactly the shipped
 * ones. Each case streams real inference requests with a unique prompt canary;
 * the test then reads the sink ledger to prove nothing reached it.
 *
 *   node /lab/net04-client.mjs <case>   (env configured by the test)
 */
const CHAT_CORE = process.env.CHAT_CORE_DIST ?? '/repo/packages/chat-core/dist/index.js';
const { resolveProvider } = await import(CHAT_CORE);

const kase = process.argv[2];
const canary = process.env.PROMPT_CANARY ?? 'net04-canary';
const attempts = Number(process.env.ATTEMPTS ?? 1);
const results = [];

async function streamOnce(provider, i) {
  const out = { attempt: i + 1 };
  try {
    let text = '';
    for await (const chunk of provider.stream({
      systemPrompt: `system ${canary}`,
      messages: [{ role: 'user', content: `user prompt ${canary} #${i + 1}` }],
      tools: [],
      maxTokens: 16,
      signal: AbortSignal.timeout(10_000),
    })) {
      if (chunk.type === 'text') text += chunk.text;
    }
    out.ok = true;
    out.text = text.slice(0, 40);
  } catch (err) {
    out.ok = false;
    out.code = err?.code ?? err?.name;
    out.message = String(err?.message ?? err).slice(0, 300);
  }
  return out;
}

try {
  const provider = resolveProvider(process.env);
  for (let i = 0; i < attempts; i++) results.push(await streamOnce(provider, i));
  console.log(JSON.stringify({ case: kase, provider: provider.providerName, results }));
} catch (err) {
  console.log(JSON.stringify({ case: kase, resolveError: { code: err?.code, message: String(err?.message ?? err).slice(0, 300) }, results }));
}
