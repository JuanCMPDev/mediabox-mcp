import { randomBytes } from "node:crypto";

/** Generate a random hex string of the given byte length (for secrets/keys). */
export function randomHex(bytes = 32): string {
  return randomBytes(bytes).toString("hex");
}
