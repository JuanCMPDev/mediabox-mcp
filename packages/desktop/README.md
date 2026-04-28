# @mediabox/desktop

Tauri 2 desktop shell for Mediabox OS. Wraps [@mediabox/ui](../ui) as the
frontend and bundles [mcp-server](../mcp-server) as a self-contained
sidecar binary (compiled with `bun --compile`).

## Architecture

```
┌──────────────────────────────────────────────────┐
│ Tauri webview (loads @mediabox/ui SPA)           │
│   ↕ Tauri IPC: get_runtime_config()              │
│   ↕ HTTP fetch on http://127.0.0.1:<port>        │
└──────────────────────────────────────────────────┘
            │ spawn (with PORT + INTERNAL_API_KEY env)
            ▼
┌──────────────────────────────────────────────────┐
│ Sidecar: mediabox-mcp-<triple>(.exe)             │
│   • Compiled by `bun build --compile`            │
│   • Express + MCP + dashboard REST + chat NDJSON │
└──────────────────────────────────────────────────┘
```

On startup, the Rust `setup()` hook:

1. Picks an unused TCP port via `portpicker`.
2. Generates a random 48-char alphanumeric internal API key.
3. Spawns the sidecar with `PORT` + `INTERNAL_API_KEY` + `PUBLIC_URL` env.
4. Watches stdout and flips `RuntimeConfig.ready = true` when the server logs
   "running on port".

The webview calls the `get_runtime_config` Tauri command once on boot to
discover the URL + token, then talks to the sidecar over HTTP just like
the browser dev build does.

## Commands

```bash
# From repo root
npm run dev:desktop      # Compiles sidecar → starts vite + tauri dev
npm run build:desktop    # Compiles sidecar → builds @mediabox/ui → tauri build

# From this package
npm run sidecar          # Just (re)compile the sidecar binary
npm run icons            # Regenerate Tauri icons from icon-source.png
```

## First-time setup

```bash
# Make sure Rust toolchain is installed
rustc --version

# Install npm deps (downloads @tauri-apps/cli + plugin packages)
npm install

# Generate icons (one-time; produces icons/ folder)
npm run icons --workspace @mediabox/desktop
```

## Cross-compilation

`bun build --compile` supports the following targets, mapped to Tauri triples:

| Tauri triple                  | Bun target          |
| ----------------------------- | ------------------- |
| `x86_64-pc-windows-msvc`      | `bun-windows-x64`   |
| `x86_64-apple-darwin`         | `bun-darwin-x64`    |
| `aarch64-apple-darwin`        | `bun-darwin-arm64`  |
| `x86_64-unknown-linux-gnu`    | `bun-linux-x64`     |
| `aarch64-unknown-linux-gnu`   | `bun-linux-arm64`   |

The `scripts/build-sidecar.mjs` script auto-detects the host triple via
`rustc -vV`. To target a different platform, set the `TAURI_TARGET` env var.
