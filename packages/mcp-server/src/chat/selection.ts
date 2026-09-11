import type { TypedSelection } from "@mediabox/contracts";

/**
 * Typed card selections (Blueprint 4.4 / CAT-04). The click of a card sends a
 * structured selection; the server turns it into a deterministic user turn so
 * the model receives verifiable references instead of free text it authored.
 * References are opaque HMAC tokens and are re-verified by every tool that
 * consumes them; a selection can never widen scope on its own.
 */

const SELECTION_TYPES: ReadonlySet<string> = new Set(["select_candidate", "select_release", "propose_download"]);
const REF_PATTERN = /^(?:mref|rref)_(?:[0-9a-f]{8,32}|[A-Za-z0-9_-]{1,4096}\.[0-9a-f]{64})$/;
const MAX_LABEL_CHARS = 200;

export function isValidTypedSelection(input: unknown): input is TypedSelection {
  if (!input || typeof input !== "object") return false;
  const s = input as Record<string, unknown>;
  if (typeof s.type !== "string" || !SELECTION_TYPES.has(s.type)) return false;
  if (s.mediaRef !== undefined && (typeof s.mediaRef !== "string" || !REF_PATTERN.test(s.mediaRef))) return false;
  if (s.releaseRef !== undefined && (typeof s.releaseRef !== "string" || !REF_PATTERN.test(s.releaseRef))) return false;
  if (s.mediaRef === undefined && s.releaseRef === undefined) return false;
  return true;
}

/** Builds the user turn for a typed selection. `label` is display context only. */
export function formatTypedSelection(selection: TypedSelection, label?: string): string {
  const parts = [`type=${selection.type}`];
  if (selection.mediaRef) parts.push(`mediaRef=${selection.mediaRef}`);
  if (selection.releaseRef) parts.push(`releaseRef=${selection.releaseRef}`);
  const cleanLabel = (label ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_LABEL_CHARS);
  return `[typed_selection ${parts.join(" ")}]${cleanLabel ? ` ${cleanLabel}` : ""}`;
}
