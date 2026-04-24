import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fetchWithRetry, pollUntilReady, sleep } from "./http.js";

describe("sleep", () => {
  it("resolves after approximately the given duration", async () => {
    const start = Date.now();
    await sleep(50);
    expect(Date.now() - start).toBeGreaterThanOrEqual(40);
  });
});

describe("fetchWithRetry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("returns on the first successful response", async () => {
    const fetchMock = vi.fn(async () => new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const res = await fetchWithRetry("http://x");
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("retries on 5xx responses up to retry limit", async () => {
    const fetchMock = vi.fn(async () => new Response("busy", { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);

    const promise = fetchWithRetry("http://x", { retries: 2, initialDelayMs: 1 });
    await vi.runAllTimersAsync();
    const res = await promise;

    expect(res.status).toBe(503);
    expect(fetchMock).toHaveBeenCalledTimes(3); // initial + 2 retries
  });

  it("returns on first 2xx after a transient 5xx", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("fail", { status: 503 }))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const promise = fetchWithRetry("http://x", { retries: 3, initialDelayMs: 1 });
    await vi.runAllTimersAsync();
    const res = await promise;

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("throws the last network error when all retries fail", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    vi.stubGlobal("fetch", fetchMock);

    const promise = fetchWithRetry("http://x", { retries: 1, initialDelayMs: 1 }).catch(
      (e) => e
    );
    await vi.runAllTimersAsync();
    const err = await promise;
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe("ECONNREFUSED");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("pollUntilReady", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("returns true on first 2xx", async () => {
    const fetchMock = vi.fn(async () => new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const promise = pollUntilReady("http://x", 10_000);
    await vi.runAllTimersAsync();
    expect(await promise).toBe(true);
  });

  it("returns false on timeout with no successful response", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("refused");
    });
    vi.stubGlobal("fetch", fetchMock);

    const promise = pollUntilReady("http://x", 100);
    await vi.runAllTimersAsync();
    expect(await promise).toBe(false);
  });

  it("acceptAny treats 401 as ready", async () => {
    const fetchMock = vi.fn(async () => new Response("unauth", { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);

    const promise = pollUntilReady("http://x", 10_000, { acceptAny: true });
    await vi.runAllTimersAsync();
    expect(await promise).toBe(true);
  });
});
