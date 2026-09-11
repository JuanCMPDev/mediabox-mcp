/**
 * CAT-05 / CAT-06: download plans never duplicate or cancel implicitly, and a
 * grab is reconciled by release identity (guid -> history -> download id) with
 * `unknown_outcome` when the outcome cannot be verified. Sonarr/Radarr are
 * mocked at the API helper boundary.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Principal } from "@mediabox/contracts";

const api = vi.hoisted(() => ({
  radarrApi: vi.fn(),
  sonarrApi: vi.fn(),
  jfApi: vi.fn(),
  prowlarrApi: vi.fn(),
}));

vi.mock("../helpers/api.js", () => ({
  radarrApi: api.radarrApi,
  sonarrApi: api.sonarrApi,
  jfApi: api.jfApi,
  prowlarrApi: api.prowlarrApi,
  textResult: (x: unknown) => ({ content: [{ type: "text", text: JSON.stringify(x) }] }),
}));

import { createReleaseRef } from "../queries/references.js";
import { createDownloadPlan, DownloadPlannerError } from "./planners/download.js";
import { NodeSqliteAdapter } from "./sqlite/node-adapter.js";
import { OperationStore } from "./store.js";
import { OperationExecutor } from "./executor.js";
import { registerStepHandlers, reconcileGrab } from "./handlers.js";
import { OWNER_PRINCIPAL_ID, type PlanScope } from "../security/context.js";

const scope: PlanScope = { installationId: "inst", ownerId: OWNER_PRINCIPAL_ID, conversationId: "conv" };
const owner: Principal = {
  id: OWNER_PRINCIPAL_ID,
  installationId: "inst",
  kind: "owner-ui",
  capabilities: ["*"],
  audience: "mediabox-local",
  sessionId: "s",
  expiresAt: Date.now() + 3_600_000,
  credentialVersion: 1,
};

function releaseRef(guid = "guid_1", title = "Movie.2024.1080p", movieId = 42) {
  return createReleaseRef(
    { guid, title, indexerId: 3, mediaId: "movie:tmdb:1", serviceEntityIds: { service: "radarr", radarrId: movieId } },
    scope
  );
}

function timeoutError() {
  const err = new Error("The operation was aborted due to timeout");
  err.name = "TimeoutError";
  return err;
}

interface RadarrScript {
  release?: () => Promise<unknown>;
  history?: unknown[];
  historyDown?: boolean;
  queue?: unknown[];
  queueDown?: boolean;
}

function scriptRadarr(s: RadarrScript) {
  api.radarrApi.mockImplementation(async (ep: string, method = "GET") => {
    if (ep === "release" && method === "POST") return s.release ? s.release() : {};
    if (ep.startsWith("history")) {
      if (s.historyDown) throw new Error("fetch failed");
      return { records: s.history ?? [] };
    }
    if (ep.startsWith("queue/bulk")) return { status: 200 };
    if (ep.startsWith("queue")) {
      if (s.queueDown) throw new Error("fetch failed");
      return { records: s.queue ?? [] };
    }
    throw new Error(`unexpected radarr call ${method} ${ep}`);
  });
}

async function runPlan(plan: ReturnType<typeof createDownloadPlan>["plan"]) {
  const store = new OperationStore(new NodeSqliteAdapter(":memory:"));
  const executor = new OperationExecutor(store, { workerId: "grab_worker", heartbeatMs: 20 });
  registerStepHandlers(executor);
  store.createPlan(plan, "awaiting_approval");
  store.approveAndEnqueue(plan.id, owner, plan.manifestHash);
  await executor.pollAndExecute();
  return { record: store.getPlan(plan.id)!, store, executor };
}

beforeEach(() => {
  api.radarrApi.mockReset();
  api.sonarrApi.mockReset();
});

describe("CAT-05: duplicates and explicit replacement", () => {
  it("refuses a release already in the live queue by guid or exact title", () => {
    expect(() =>
      createDownloadPlan({ releaseRef: releaseRef("guid_active"), scope, activeQueue: [{ service: "radarr", queueId: 1, guid: "guid_active" }] })
    ).toThrowError(DownloadPlannerError);
    try {
      createDownloadPlan({ releaseRef: releaseRef("guid_x", "Same.Title"), scope, activeQueue: [{ service: "radarr", queueId: 2, title: "Same.Title" }] });
    } catch (err: any) {
      expect(err.code).toBe("ERR_DUPLICATE_DOWNLOAD");
    }
  });

  it("never plans a cancellation unless replacement is explicit, and then only for the same media", () => {
    const plain = createDownloadPlan({ releaseRef: releaseRef(), scope, activeQueue: [{ service: "radarr", queueId: 7, title: "Old.Release", entityId: 42 }] });
    expect(plain.plan.operation).toBe("media_download");
    expect(plain.plan.effects.map((e) => e.serviceAction)).toEqual(["download.grab"]);
    expect(plain.plan.effects[0].params).toMatchObject({ service: "radarr", guid: "guid_1", indexerId: 3, entityId: 42 });

    const replacement = createDownloadPlan({ releaseRef: releaseRef(), scope, replacement: true, activeQueue: [
      { service: "radarr", queueId: 7, title: "Old.Release", entityId: 42 },
      { service: "radarr", queueId: 8, title: "Unrelated", entityId: 99 },
    ] });
    expect(replacement.plan.operation).toBe("media_download_replacement");
    expect(replacement.plan.effects.map((e) => e.serviceAction)).toEqual(["download.grab", "download.cancel_previous"]);
    expect(replacement.plan.effects[1].params).toMatchObject({ service: "radarr", queueIds: "7" });
    expect(replacement.plan.effects[1].irreversibleLoss).toBe(true);

    expect(() => createDownloadPlan({ releaseRef: releaseRef(), scope, replacement: true, activeQueue: [] })).toThrowError(/no active download/);
  });

  it("rejects references minted for another installation or owner", () => {
    const foreign = createReleaseRef({ guid: "g", title: "t", mediaId: "movie:1" }, { ...scope, installationId: "other" });
    expect(() => createDownloadPlan({ releaseRef: foreign, scope })).toThrowError(/installation/);
  });
});

describe("CAT-06: grab reconciliation by identity", () => {
  it("submits once and records the download id found through the grabbed history", async () => {
    scriptRadarr({
      history: [{ id: 5, eventType: "grabbed", downloadId: "ABC123", data: { guid: "guid_1" } }],
      queue: [{ id: 9, downloadId: "abc123", title: "Movie.2024.1080p", movieId: 42 }],
    });
    const { plan } = createDownloadPlan({ releaseRef: releaseRef(), scope, activeQueue: [] });
    const { record } = await runPlan(plan);
    expect(record.status).toBe("succeeded");
    expect(record.steps![0].details).toMatchObject({ status: "downloading", downloadId: "abc123", queueId: 9, reconciled: false });
    expect(api.radarrApi.mock.calls.filter(([ep, m]) => ep === "release" && m === "POST")).toHaveLength(1);
  });

  it("reconciles a timed-out grab that Radarr actually accepted without re-submitting", async () => {
    scriptRadarr({
      release: async () => { throw timeoutError(); },
      history: [{ id: 6, eventType: "grabbed", downloadId: "DEF456", data: { guid: "guid_1" } }],
      queue: [],
    });
    const { plan } = createDownloadPlan({ releaseRef: releaseRef(), scope, activeQueue: [] });
    const { record } = await runPlan(plan);
    expect(record.status).toBe("succeeded");
    expect(record.steps![0].details).toMatchObject({ status: "submitted", downloadId: "DEF456", reconciled: true });
    expect(api.radarrApi.mock.calls.filter(([ep, m]) => ep === "release" && m === "POST")).toHaveLength(1);
  }, 15_000);

  it("ends unknown_outcome when a timed-out grab cannot be found and never retries", async () => {
    scriptRadarr({ release: async () => { throw timeoutError(); }, history: [], queue: [] });
    const { plan } = createDownloadPlan({ releaseRef: releaseRef(), scope, activeQueue: [] });
    const { record, executor } = await runPlan(plan);
    expect(record.status).toBe("unknown_outcome");
    expect(record.statusReason).toMatch(/not re-submitting/);
    expect(await executor.pollAndExecute()).toBeUndefined();
    expect(api.radarrApi.mock.calls.filter(([ep, m]) => ep === "release" && m === "POST")).toHaveLength(1);
  }, 15_000);

  it("ends unknown_outcome when the service is unreachable after the request", async () => {
    scriptRadarr({ release: async () => { throw new Error("fetch failed"); }, historyDown: true, queueDown: true });
    const { plan } = createDownloadPlan({ releaseRef: releaseRef(), scope, activeQueue: [] });
    const { record } = await runPlan(plan);
    expect(record.status).toBe("unknown_outcome");
  }, 15_000);

  it("fails (not unknown) when Radarr definitively rejects the release", async () => {
    scriptRadarr({ release: async () => { throw new Error("Radarr 400: release rejected by indexer"); } });
    const { plan } = createDownloadPlan({ releaseRef: releaseRef(), scope, activeQueue: [] });
    const { record } = await runPlan(plan);
    expect(record.status).toBe("failed");
    expect(record.statusReason).toMatch(/rejected/);
  });

  it("cancels the previous download only after the new grab is secured", async () => {
    const order: string[] = [];
    scriptRadarr({
      release: async () => { order.push("grab"); return {}; },
      history: [{ id: 7, eventType: "grabbed", downloadId: "NEW1", data: { guid: "guid_1" } }],
      queue: [{ id: 7, downloadId: "OLD0", title: "Old.Release", movieId: 42 }],
    });
    api.radarrApi.mockImplementation(async (ep: string, method = "GET", body?: any) => {
      if (ep === "release" && method === "POST") { order.push("grab"); return {}; }
      if (ep.startsWith("queue/bulk")) { order.push(`cancel:${(body as any).ids.join(",")}`); return { status: 200 }; }
      if (ep.startsWith("history")) return { records: [{ id: 7, eventType: "grabbed", downloadId: "NEW1", data: { guid: "guid_1" } }] };
      if (ep.startsWith("queue")) return { records: [{ id: 7, downloadId: "OLD0", title: "Old.Release", movieId: 42 }] };
      throw new Error(`unexpected ${method} ${ep}`);
    });
    const { plan } = createDownloadPlan({ releaseRef: releaseRef(), scope, replacement: true, activeQueue: [{ service: "radarr", queueId: 7, title: "Old.Release", entityId: 42 }] });
    const { record } = await runPlan(plan);
    expect(record.status).toBe("succeeded");
    expect(order).toEqual(["grab", "cancel:7"]);
  });

  it("reconcileGrab matches by guid and download id, never by loose title", async () => {
    scriptRadarr({
      history: [{ id: 1, eventType: "grabbed", downloadId: "H1", data: { guid: "guid_other" } }],
      queue: [{ id: 2, downloadId: "Q1", title: "Movie.2024.1080p.Other", movieId: 42 }],
    });
    const miss = await reconcileGrab("radarr", "guid_1", 42, "Movie.2024.1080p");
    expect(miss).toMatchObject({ found: false, serviceReachable: true });
    scriptRadarr({ history: [], queue: [{ id: 3, downloadId: "Q2", title: "Movie.2024.1080p", movieId: 42 }] });
    const exact = await reconcileGrab("radarr", "guid_1", 42, "Movie.2024.1080p");
    expect(exact).toMatchObject({ found: true, status: "downloading", queueId: 3 });
  });
});
