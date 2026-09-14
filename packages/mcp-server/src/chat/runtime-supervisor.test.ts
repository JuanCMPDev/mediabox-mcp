/* ─── Runtime supervisor (§3.2 / §3.3) ───────────────────────────────────────
 * Real HTTP runtime doubles on loopback; the production endpoint policy and
 * transport are used unchanged.
 * ──────────────────────────────────────────────────────────────────────── */
import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import { RuntimeSupervisor, RuntimeAdmissionError } from "./runtime-supervisor.js";

const DIGEST = "845dbda0ea48ed749caafd9e6037047aa19acfcfd82e704d7ca97d631a0b697e";

interface FakeRuntime { url: string; requests: string[]; close: () => Promise<void> }

async function fakeOllama(opts: { tags?: unknown; healthy?: boolean } = {}): Promise<FakeRuntime> {
  const requests: string[] = [];
  const server: Server = createServer((req, res) => {
    requests.push(req.url ?? "");
    if (opts.healthy === false) { res.writeHead(503); res.end(); return; }
    res.writeHead(200, { "Content-Type": "application/json" });
    if (req.url === "/api/version") res.end(JSON.stringify({ version: "0.34.0" }));
    else if (req.url === "/api/tags") res.end(JSON.stringify(opts.tags ?? { models: [{ name: "qwen2.5:7b", digest: DIGEST }] }));
    else if (req.url === "/v1/models") res.end(JSON.stringify({ data: [] }));
    else res.end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as any).port;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const supervisors: RuntimeSupervisor[] = [];
const runtimes: FakeRuntime[] = [];
afterEach(async () => {
  for (const s of supervisors.splice(0)) s.stop();
  for (const r of runtimes.splice(0)) await r.close();
});

function supervise(target: { runtime?: string; baseUrl: string }, extra: Partial<ConstructorParameters<typeof RuntimeSupervisor>[0]> = {}) {
  const s = new RuntimeSupervisor({
    target: { runtime: target.runtime ?? "ollama", baseUrl: target.baseUrl, model: "qwen2.5:7b" },
    pollIntervalMs: 20,
    startTimeoutMs: 200,
    admissionWaitMs: 1_000,
    ...extra,
  });
  supervisors.push(s);
  return s;
}

describe("RuntimeSupervisor lifecycle and admission", () => {
  it("starts outside the turn, reaches ready and admits one inference at a time", async () => {
    const rt = await fakeOllama(); runtimes.push(rt);
    const s = supervise({ baseUrl: rt.url });
    expect(s.state).toBe("stopped");
    expect(s.artifactStatus).toBe("not_required");

    const lease = await s.admit();
    expect(s.state).toBe("ready");
    await expect(s.admit()).rejects.toMatchObject({ code: "ERR_INFERENCE_CONCURRENCY_EXCEEDED", httpStatus: 429 });
    lease.release();
    const again = await s.admit();
    again.release();
  });

  it("strict profile without a pinned digest fails closed and never contacts the runtime", async () => {
    const rt = await fakeOllama(); runtimes.push(rt);
    const s = supervise({ baseUrl: rt.url }, { privacyProfile: "offline-library" });
    expect(s.artifactStatus).toBe("unpinned");
    await expect(s.admit()).rejects.toMatchObject({ code: "ERR_ARTIFACT_UNPINNED" });
    expect(rt.requests).toEqual([]);
  });

  it("verifies the pinned manifest digest before ready", async () => {
    const rt = await fakeOllama(); runtimes.push(rt);
    const s = supervise({ baseUrl: rt.url }, { privacyProfile: "offline-library", expectedDigest: `sha256:${DIGEST}` });
    (await s.admit()).release();
    expect(s.artifactStatus).toBe("verified");
    expect(rt.requests).toContain("/api/tags");
  });

  it("a digest mismatch or a missing model moves to error and refuses turns", async () => {
    const other = await fakeOllama({ tags: { models: [{ name: "qwen2.5:7b", digest: "0".repeat(64) }] } }); runtimes.push(other);
    const mismatch = supervise({ baseUrl: other.url }, { expectedDigest: DIGEST });
    await expect(mismatch.admit()).rejects.toMatchObject({ code: "ERR_ARTIFACT_MISMATCH" });
    expect(mismatch.state).toBe("error");

    const empty = await fakeOllama({ tags: { models: [] } }); runtimes.push(empty);
    const missing = supervise({ baseUrl: empty.url }, { expectedDigest: DIGEST });
    await expect(missing.admit()).rejects.toMatchObject({ code: "ERR_ARTIFACT_MISSING" });
  });

  it("a runtime that cannot verify weights is refused in a strict profile", async () => {
    const rt = await fakeOllama(); runtimes.push(rt);
    const s = supervise({ runtime: "llamacpp", baseUrl: rt.url }, { privacyProfile: "local-agent-online-media", expectedDigest: DIGEST });
    await expect(s.admit()).rejects.toMatchObject({ code: "ERR_ARTIFACT_UNVERIFIABLE" });
  });

  it("a down runtime is refused quickly with no fallback and ends unavailable after the start window", async () => {
    const rt = await fakeOllama({ healthy: false }); runtimes.push(rt);
    const s = supervise({ baseUrl: rt.url });
    const started = Date.now();
    const err = await s.admit().catch((e) => e);
    expect(err).toBeInstanceOf(RuntimeAdmissionError);
    expect(err.code).toBe("ERR_PROVIDER_UNAVAILABLE");
    expect(Date.now() - started).toBeLessThan(1_000);
    await s.ensureStarted();
    expect(s.state).toBe("unavailable");
    expect(s.reason).toMatch(/did not answer/);
  });

  it("a failure seen during a turn marks the runtime unavailable and it recovers in the background", async () => {
    const rt = await fakeOllama(); runtimes.push(rt);
    const s = supervise({ baseUrl: rt.url });
    (await s.admit()).release();
    s.markUnavailable("stream failed");
    expect(["unavailable", "starting"]).toContain(s.state);
    await s.ensureStarted();
    expect(s.state).toBe("ready");
  });
});
