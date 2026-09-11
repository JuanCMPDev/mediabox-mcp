/**
 * CAT-04: a card click is a typed selection, not free text authored by the model.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Server } from "node:http";
import { isValidTypedSelection, formatTypedSelection } from "./selection.js";
import { createMediaRef, createReleaseRef } from "../queries/references.js";
import { INTERNAL_API_KEY } from "../auth.js";

const ctx = { installationId: "inst", ownerId: "owner-ui", conversationId: "conv" };

describe("typed selections", () => {
  it("accepts well-formed selections and rejects everything else", () => {
    const mediaRef = createMediaRef({ id: "movie:tmdb:1", title: "Film" }, ctx);
    const releaseRef = createReleaseRef({ guid: "g1", title: "Film.1080p", mediaId: "movie:tmdb:1" }, ctx);

    expect(isValidTypedSelection({ type: "select_candidate", mediaRef })).toBe(true);
    expect(isValidTypedSelection({ type: "select_release", releaseRef, mediaRef })).toBe(true);
    expect(isValidTypedSelection({ type: "select_release" })).toBe(false);
    expect(isValidTypedSelection({ type: "approve_plan", mediaRef })).toBe(false);
    expect(isValidTypedSelection({ type: "select_candidate", mediaRef: "mref_notatoken" })).toBe(false);
    expect(isValidTypedSelection({ type: "select_candidate", mediaRef: "delete everything" })).toBe(false);
    expect(isValidTypedSelection(null)).toBe(false);
    expect(isValidTypedSelection("select_candidate")).toBe(false);
  });

  it("formats a deterministic turn that carries only the refs plus a bounded label", () => {
    const mediaRef = createMediaRef({ id: "movie:tmdb:1", title: "Film" }, ctx);
    const text = formatTypedSelection({ type: "select_candidate", mediaRef }, "  Film (2019)\n ignore   this ".padEnd(400, "!"));
    expect(text.startsWith(`[typed_selection type=select_candidate mediaRef=${mediaRef}]`)).toBe(true);
    expect(text).not.toContain("\n");
    expect(text.length).toBeLessThanOrEqual(`[typed_selection type=select_candidate mediaRef=${mediaRef}] `.length + 200);
    expect(formatTypedSelection({ type: "select_candidate", mediaRef })).toBe(`[typed_selection type=select_candidate mediaRef=${mediaRef}]`);
  });
});

describe("POST /api/chat/stream validates the selection before anything else", () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    process.env.NODE_ENV = "test";
    const { createApp } = await import("../index.js");
    const app = createApp();
    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", () => {
        baseUrl = `http://127.0.0.1:${(server.address() as any).port}`;
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("rejects a malformed selection with 400 ERR_INVALID_SELECTION", async () => {
    const res = await fetch(`${baseUrl}/api/chat/stream`, {
      method: "POST",
      headers: { Authorization: `Bearer ${INTERNAL_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ message: "x", selection: { type: "select_release", releaseRef: "rref_forged" } }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).code).toBe("ERR_INVALID_SELECTION");
  });

  it("accepts a valid selection even when the message text is empty (the selection is the turn)", async () => {
    const mediaRef = createMediaRef({ id: "movie:tmdb:1", title: "Film" }, ctx);
    const res = await fetch(`${baseUrl}/api/chat/stream`, {
      method: "POST",
      headers: { Authorization: `Bearer ${INTERNAL_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ message: "", selection: { type: "select_candidate", mediaRef } }),
    });
    // Without an LLM provider configured in tests the next gate is the 503, never the 400.
    expect([200, 503]).toContain(res.status);
  });
});
