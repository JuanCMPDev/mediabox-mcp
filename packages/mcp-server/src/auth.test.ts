/**
 * Auth middleware + constant-time key comparison.
 *
 * INTERNAL_API_KEY is captured at module load (`process.env.INTERNAL_API_KEY ||
 * randomUUID()`), so we set the env var BEFORE a dynamic import of auth.js.
 */
import { describe, it, expect, vi } from "vitest";

const TEST_KEY = "unit-test-internal-key-0123456789";
process.env.INTERNAL_API_KEY = TEST_KEY;

const { authMiddleware, timingSafeEqualStr } = await import("./auth.js");

function mockRes() {
  const res: any = { statusCode: 0, body: undefined };
  res.status = vi.fn((c: number) => {
    res.statusCode = c;
    return res;
  });
  res.json = vi.fn((b: unknown) => {
    res.body = b;
    return res;
  });
  return res;
}

describe("timingSafeEqualStr", () => {
  it("is true for equal strings", () => {
    expect(timingSafeEqualStr(TEST_KEY, TEST_KEY)).toBe(true);
  });

  it("is false for different strings of equal length", () => {
    expect(timingSafeEqualStr("abcdef", "abcdeg")).toBe(false);
  });

  it("is false for different-length strings (never throws)", () => {
    expect(timingSafeEqualStr("abc", "abcdef")).toBe(false);
    expect(timingSafeEqualStr("", "x")).toBe(false);
    expect(timingSafeEqualStr("x", "")).toBe(false);
  });
});

describe("authMiddleware", () => {
  it("calls next() for the correct internal key", async () => {
    const next = vi.fn();
    const res = mockRes();
    await authMiddleware(
      { headers: { authorization: `Bearer ${TEST_KEY}` } } as any,
      res as any,
      next,
    );
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  it("401s a wrong key of the same length", async () => {
    const next = vi.fn();
    const res = mockRes();
    const wrong = "X".repeat(TEST_KEY.length);
    await authMiddleware(
      { headers: { authorization: `Bearer ${wrong}` } } as any,
      res as any,
      next,
    );
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it("401s a wrong key of a different length without throwing", async () => {
    const next = vi.fn();
    const res = mockRes();
    await authMiddleware(
      { headers: { authorization: "Bearer short" } } as any,
      res as any,
      next,
    );
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it("401s when the Authorization header is missing", async () => {
    const next = vi.fn();
    const res = mockRes();
    await authMiddleware({ headers: {} } as any, res as any, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });
});
