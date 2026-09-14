import { afterEach, describe, it, expect, vi } from "vitest";
import type { RuntimeLifecycleState } from "../config/types.js";
import { RuntimeLifecycleManager, RuntimeLifecycleError } from "./lifecycle.js";

const STATES: RuntimeLifecycleState[] = ["not_provisioned", "stopped", "starting", "ready", "unavailable", "error"];

// §3.3 table, written out independently of the implementation.
const ALLOWED: Record<RuntimeLifecycleState, RuntimeLifecycleState[]> = {
  not_provisioned: ["stopped", "error"],
  stopped: ["starting", "not_provisioned", "error"],
  starting: ["ready", "unavailable", "error", "stopped"],
  ready: ["stopped", "unavailable", "error"],
  unavailable: ["starting", "stopped", "error"],
  error: ["stopped", "not_provisioned"],
};

function managerIn(state: RuntimeLifecycleState, limits?: ConstructorParameters<typeof RuntimeLifecycleManager>[0]) {
  const mgr = new RuntimeLifecycleManager(limits);
  if (state === "not_provisioned") return mgr;
  if (state === "error") {
    mgr.transition("error", "artifact check failed");
    return mgr;
  }
  mgr.markProvisioned();
  if (state === "stopped") return mgr;
  mgr.transition("starting");
  if (state === "starting") return mgr;
  mgr.transition(state);
  return mgr;
}

describe("RuntimeLifecycleManager transitions (P10 / §3.3)", () => {
  it("follows not_provisioned → stopped → starting → ready", () => {
    const mgr = new RuntimeLifecycleManager();
    expect(mgr.state).toBe("not_provisioned");

    mgr.markProvisioned("artifacts verified");
    expect(mgr.state).toBe("stopped");
    expect(mgr.snapshot.reason).toBe("artifacts verified");

    mgr.transition("starting", "runtime launched");
    mgr.transition("ready", "runtime healthy");
    expect(mgr.snapshot.state).toBe("ready");
  });

  it("never starts before the artifacts are verified", () => {
    const mgr = new RuntimeLifecycleManager();
    expect(() => mgr.transition("starting")).toThrow(RuntimeLifecycleError);
    expect(() => mgr.transition("ready")).toThrow(RuntimeLifecycleError);
    expect(mgr.state).toBe("not_provisioned");
  });

  it("allows exactly the §3.3 transitions from every state", () => {
    for (const from of STATES) {
      for (const to of STATES) {
        const mgr = managerIn(from);
        expect(mgr.state).toBe(from);
        if (ALLOWED[from].includes(to)) {
          mgr.transition(to);
          expect(mgr.state).toBe(to);
        } else {
          expect(() => mgr.transition(to), `${from} → ${to}`).toThrow("Invalid lifecycle transition");
          expect(mgr.state).toBe(from);
        }
      }
    }
  });

  it("markProvisioned works before start and after an error, and is a no-op when stopped", () => {
    const recovered = managerIn("error");
    recovered.markProvisioned("artifacts verified again");
    expect(recovered.state).toBe("stopped");

    recovered.markProvisioned();
    expect(recovered.state).toBe("stopped");

    for (const running of ["starting", "ready", "unavailable"] as const) {
      expect(() => managerIn(running).markProvisioned()).toThrow("Cannot mark artifacts provisioned");
    }
  });

  it("stop() stops any started or failed runtime and leaves not_provisioned alone", () => {
    for (const from of ["starting", "ready", "unavailable", "error"] as const) {
      const mgr = managerIn(from);
      mgr.stop("owner stop");
      expect(mgr.state).toBe("stopped");
      expect(mgr.snapshot.reason).toBe("owner stop");
    }

    const stopped = managerIn("stopped");
    stopped.stop();
    expect(stopped.state).toBe("stopped");

    const fresh = new RuntimeLifecycleManager();
    fresh.stop();
    expect(fresh.state).toBe("not_provisioned");
  });

  it("sanitizes secrets and paths from transition reasons", () => {
    const mgr = new RuntimeLifecycleManager();
    mgr.transition("error", "failed with token abcdefghijklmnopqrstuvwxyz012345 at /srv/models/qwen");
    expect(mgr.snapshot.reason).toBe("failed with token [REDACTED] at [PATH]");
  });
});

describe("RuntimeLifecycleManager admission (§3.2)", () => {
  it("admits inference when ready and respects the parallel limit", () => {
    const mgr = managerIn("ready", { maxParallelInferences: 1 });

    const admission1 = mgr.admitInference();
    expect(mgr.snapshot.activeInferences).toBe(1);
    expect(() => mgr.admitInference()).toThrow("Max parallel inferences limit (1) reached");

    admission1.release();
    admission1.release(); // idempotent
    expect(mgr.snapshot.activeInferences).toBe(0);

    const admission2 = mgr.admitInference();
    expect(mgr.snapshot.activeInferences).toBe(1);
    admission2.release();
  });

  it("refuses inference in every state but ready", () => {
    for (const state of STATES.filter((s) => s !== "ready")) {
      expect(() => managerIn(state).admitInference()).toThrow(
        `Cannot admit inference while runtime state is '${state}'`,
      );
    }
  });

  it("drops active inferences when the runtime stops or becomes unavailable", () => {
    const mgr = managerIn("ready", { maxParallelInferences: 2 });
    mgr.admitInference();
    mgr.admitInference();
    mgr.transition("unavailable", "health probe failed");
    expect(mgr.snapshot.activeInferences).toBe(0);
  });
});

describe("RuntimeLifecycleManager.waitForReady (§3.3)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts from stopped and becomes ready when the probe answers", async () => {
    const mgr = managerIn("stopped");
    let calls = 0;
    await mgr.waitForReady(async () => ++calls >= 2, { timeoutMs: 1000, pollIntervalMs: 10 });
    expect(mgr.state).toBe("ready");
    expect(calls).toBe(2);
  });

  it("restarts from unavailable", async () => {
    const mgr = managerIn("unavailable");
    await mgr.waitForReady(async () => true, { timeoutMs: 1000, pollIntervalMs: 10 });
    expect(mgr.state).toBe("ready");
  });

  it("returns at once when already ready", async () => {
    const mgr = managerIn("ready");
    const probe = vi.fn(async () => true);
    await mgr.waitForReady(probe);
    expect(probe).not.toHaveBeenCalled();
  });

  it("refuses to start without verified artifacts or from error", async () => {
    await expect(managerIn("not_provisioned").waitForReady(async () => true)).rejects.toThrow("ERR_NOT_PROVISIONED");
    await expect(managerIn("error").waitForReady(async () => true)).rejects.toThrow("ERR_INVALID_TRANSITION");
    await expect(managerIn("starting").waitForReady(async () => true)).rejects.toThrow("ERR_INVALID_TRANSITION");
  });

  it("times out to unavailable with a sanitized cause", async () => {
    const mgr = managerIn("stopped");
    await expect(
      mgr.waitForReady(
        async () => {
          throw new Error("connect ECONNREFUSED http://10.0.0.1:11434/api/version key=abcdefghijklmnopqrstuvwxyz012345");
        },
        { timeoutMs: 50, pollIntervalMs: 10 },
      ),
    ).rejects.toThrow("Runtime failed to reach ready state within 0.05s");
    expect(mgr.state).toBe("unavailable");
    expect(mgr.snapshot.reason).toContain("Runtime startup timed out after 0.05s");
    expect(mgr.snapshot.reason).not.toContain("abcdefghijklmnopqrstuvwxyz012345");
    expect(mgr.snapshot.reason).not.toContain("10.0.0.1:11434/api/version");
  });

  it("defaults to 120 s with a probe every 30 s", async () => {
    vi.useFakeTimers();
    const mgr = managerIn("stopped");
    const probe = vi.fn(async () => false);

    const waiting = mgr.waitForReady(probe);
    const outcome = expect(waiting).rejects.toThrow("within 120s");

    await vi.advanceTimersByTimeAsync(29_999);
    expect(probe).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(probe).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(90_000);
    await outcome;
    // Probes at 0, 30, 60, 90 and 120 s.
    expect(probe).toHaveBeenCalledTimes(5);
    expect(mgr.state).toBe("unavailable");
  });

  it("becomes ready on the next 30 s probe", async () => {
    vi.useFakeTimers();
    const mgr = managerIn("stopped");
    const probe = vi.fn(async () => probe.mock.calls.length >= 2);

    const waiting = mgr.waitForReady(probe);
    await vi.advanceTimersByTimeAsync(30_000);
    await waiting;
    expect(mgr.state).toBe("ready");
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it("an abort signal ends the wait and leaves the runtime stopped", async () => {
    vi.useFakeTimers();
    const mgr = managerIn("stopped");
    const controller = new AbortController();
    const probe = vi.fn(async (signal?: AbortSignal) => {
      expect(signal).toBe(controller.signal);
      return false;
    });

    const waiting = mgr.waitForReady(probe, { signal: controller.signal });
    const outcome = expect(waiting).rejects.toThrow("ERR_STARTUP_ABORTED");
    await vi.advanceTimersByTimeAsync(1_000);
    controller.abort();
    await outcome;

    expect(mgr.state).toBe("stopped");
    expect(mgr.snapshot.reason).toBe("Startup cancelled");
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it("an already aborted signal does not start the runtime", async () => {
    const mgr = managerIn("stopped");
    const controller = new AbortController();
    controller.abort();
    await expect(mgr.waitForReady(async () => true, { signal: controller.signal })).rejects.toThrow("cancelled");
    expect(mgr.state).toBe("stopped");
  });

  it("an explicit stop during a pending probe is not overridden by a late healthy answer", async () => {
    const mgr = managerIn("stopped");
    let answer!: (healthy: boolean) => void;
    const waiting = mgr.waitForReady(() => new Promise<boolean>((resolve) => { answer = resolve; }));

    mgr.stop("owner stop");
    answer(true);

    await expect(waiting).rejects.toThrow("interrupted");
    expect(mgr.state).toBe("stopped");
  });
});
