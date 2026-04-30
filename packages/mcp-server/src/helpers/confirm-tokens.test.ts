import { describe, expect, it, beforeEach, vi, afterEach } from "vitest";
import {
  issueConfirmToken,
  consumeConfirmToken,
  hashPayload,
  _resetConfirmTokensForTest,
} from "./confirm-tokens.js";

beforeEach(() => {
  _resetConfirmTokensForTest();
});

describe("issueConfirmToken / consumeConfirmToken", () => {
  it("consumes a freshly-issued token with matching args", () => {
    const payload = { kind: "path", path: "anime/Show" };
    const token = issueConfirmToken("manage_files.delete", payload);
    expect(consumeConfirmToken("manage_files.delete", token, payload)).toBe(true);
  });

  it("rejects an unknown token", () => {
    expect(consumeConfirmToken("manage_files.delete", "deadbeef", { x: 1 })).toBe(false);
  });

  it("rejects empty / non-string tokens", () => {
    expect(consumeConfirmToken("op", "", {})).toBe(false);
    // @ts-expect-error
    expect(consumeConfirmToken("op", undefined, {})).toBe(false);
  });

  it("is single-use — second consume of the same token fails", () => {
    const token = issueConfirmToken("op", { a: 1 });
    expect(consumeConfirmToken("op", token, { a: 1 })).toBe(true);
    expect(consumeConfirmToken("op", token, { a: 1 })).toBe(false);
  });

  it("burns the token even on mismatched op (no guessing)", () => {
    const token = issueConfirmToken("op.A", { a: 1 });
    expect(consumeConfirmToken("op.B", token, { a: 1 })).toBe(false);
    // Now even the correct op fails — token was burned.
    expect(consumeConfirmToken("op.A", token, { a: 1 })).toBe(false);
  });

  it("burns the token even on mismatched payload", () => {
    const token = issueConfirmToken("op", { target: "A" });
    expect(consumeConfirmToken("op", token, { target: "B" })).toBe(false);
    expect(consumeConfirmToken("op", token, { target: "A" })).toBe(false);
  });
});

describe("payload binding", () => {
  it("treats objects with reordered keys as equivalent", () => {
    const a = { a: 1, b: 2 };
    const b = { b: 2, a: 1 };
    const token = issueConfirmToken("op", a);
    expect(consumeConfirmToken("op", token, b)).toBe(true);
  });

  it("treats nested differences as different payloads", () => {
    const token = issueConfirmToken("op", { x: { n: 1 } });
    expect(consumeConfirmToken("op", token, { x: { n: 2 } })).toBe(false);
  });

  it("hashPayload is deterministic and stable across key ordering", () => {
    expect(hashPayload({ a: 1, b: 2 })).toBe(hashPayload({ b: 2, a: 1 }));
    expect(hashPayload(null)).toBe(hashPayload(null));
  });
});

describe("expiration", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("rejects a token after TTL", () => {
    const token = issueConfirmToken("op", { x: 1 });
    vi.advanceTimersByTime(5 * 60_000 + 1);
    expect(consumeConfirmToken("op", token, { x: 1 })).toBe(false);
  });

  it("accepts a token just before TTL", () => {
    const token = issueConfirmToken("op", { x: 1 });
    vi.advanceTimersByTime(5 * 60_000 - 1);
    expect(consumeConfirmToken("op", token, { x: 1 })).toBe(true);
  });
});
