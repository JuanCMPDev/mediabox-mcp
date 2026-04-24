/* ─── @mediabox/contracts ────────────────────────────────────────────────────
 * Single source of truth for every type that crosses the wire between
 * @mediabox/mcp-server (REST responses) and @mediabox/ui (fetch hooks).
 *
 * Rules:
 *  - No runtime values — only `type` and `interface` exports.
 *  - Keep 1-to-1 with REST response shapes in api/dashboard.ts.
 *  - UI-only types (View, ChatMessage, etc.) live in @mediabox/ui.
 * ──────────────────────────────────────────────────────────────────────── */
export {};
