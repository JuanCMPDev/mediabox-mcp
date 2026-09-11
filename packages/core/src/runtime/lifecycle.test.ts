import { describe, it, expect } from "vitest";
import { RuntimeLifecycleManager, RuntimeLifecycleError } from "./lifecycle.js";

describe("RuntimeLifecycleManager (P10 / §3.2, §3.3)", () => {
  it("starts in not_provisioned and transitions through starting to ready", () => {
    const mgr = new RuntimeLifecycleManager();
    expect(mgr.state).toBe("not_provisioned");

    mgr.transition("starting", "provisioning verified");
    expect(mgr.state).toBe("starting");

    mgr.transition("ready", "runtime healthy");
    expect(mgr.state).toBe("ready");
    expect(mgr.snapshot.state).toBe("ready");
  });

  it("rejects invalid transitions", () => {
    const mgr = new RuntimeLifecycleManager();
    // not_provisioned cannot jump directly to ready
    expect(() => mgr.transition("ready")).toThrow(RuntimeLifecycleError);
  });

  it("admits inference when ready and respects parallel limit", () => {
    const mgr = new RuntimeLifecycleManager({ maxParallelInferences: 1 });
    mgr.transition("starting");
    mgr.transition("ready");

    const admission1 = mgr.admitInference();
    expect(mgr.snapshot.activeInferences).toBe(1);

    // Second parallel inference exceeds limit
    expect(() => mgr.admitInference()).toThrow("Max parallel inferences limit (1) reached");

    admission1.release();
    expect(mgr.snapshot.activeInferences).toBe(0);

    // Now second admission succeeds
    const admission2 = mgr.admitInference();
    expect(mgr.snapshot.activeInferences).toBe(1);
    admission2.release();
  });

  it("refuses inference when not in ready state", () => {
    const mgr = new RuntimeLifecycleManager();
    expect(() => mgr.admitInference()).toThrow("Cannot admit inference while runtime state is 'not_provisioned'");
  });

  it("waitForReady succeeds when probe returns true", async () => {
    const mgr = new RuntimeLifecycleManager();
    let calls = 0;
    await mgr.waitForReady(
      async () => {
        calls++;
        return calls >= 2;
      },
      { timeoutMs: 1000, pollIntervalMs: 10 },
    );
    expect(mgr.state).toBe("ready");
    expect(calls).toBe(2);
  });

  it("waitForReady transitions to unavailable on timeout", async () => {
    const mgr = new RuntimeLifecycleManager();
    await expect(
      mgr.waitForReady(async () => false, { timeoutMs: 50, pollIntervalMs: 10 }),
    ).rejects.toThrow("Runtime failed to reach ready state within 0.05s");
    expect(mgr.state).toBe("unavailable");
  });
});
