import { describe, it, expect } from "vitest";
import { validateAllowedTelegramUsers } from "./validators.js";

describe("validateAllowedTelegramUsers", () => {
  it("rejects an empty string", () => {
    expect(validateAllowedTelegramUsers("")).toMatch(/at least one/i);
  });

  it("rejects a string of only separators/whitespace", () => {
    expect(validateAllowedTelegramUsers("  , ,")).toMatch(/at least one/i);
  });

  it("rejects a non-numeric ID", () => {
    expect(validateAllowedTelegramUsers("12345, abc")).toMatch(/numeric/i);
  });

  it("accepts a single numeric ID", () => {
    expect(validateAllowedTelegramUsers("12345678")).toBe(true);
  });

  it("accepts multiple numeric IDs with surrounding whitespace", () => {
    expect(validateAllowedTelegramUsers("123, 456 , 789")).toBe(true);
  });
});
