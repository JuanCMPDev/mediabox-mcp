# Migrating to 2.2.0

2.2.0 hardens the MCP server against the audit findings (path traversal,
DNS rebinding, SSRF, prompt-only confirmation of destructive tools, broken
Docker distribution). Most deployments do not need to change anything.
Read the section that matches your install.

## 2.2.0-beta.2 — `BIND_HOST` default change

The mcp-server now binds `127.0.0.1` by default instead of `0.0.0.0`, so a
bare host run is not exposed to the LAN. **Container deployments need no
action** — the mcp-server Dockerfile and both compose files set
`BIND_HOST=0.0.0.0`, and the Tauri sidecar sets `127.0.0.1` as before.

You only need to act if you run the server **outside a container** and want
it reachable from another host, or if you use a **hand-rolled compose or
`docker run`** that does not set `BIND_HOST`:

```bash
# bare host run, reachable on the LAN
BIND_HOST=0.0.0.0 node dist/index.js
```

```yaml
# or in a custom compose service
environment:
  - BIND_HOST=0.0.0.0
```

The rest of beta.2 (the `LLM_PROVIDER=google` chat fix, the sandboxed
`manage_library` create, the constant-time internal-key check, and the
wizard's Telegram-ID requirement) needs no migration steps.

## Desktop App

**No action needed.** The bundled sidecar sets `BIND_HOST=127.0.0.1` and
`ALLOWED_ORIGINS=tauri://localhost,http://tauri.localhost,https://tauri.localhost`
automatically.

## Docker — local mode

If you only access the dashboard from `localhost` / `127.0.0.1`,
**no action needed** — the localhost regex is in the allowlist by default.

If you access the dashboard from another LAN address (e.g. a phone at
`http://192.168.1.10:3000`), add that origin to `.env`:

```bash
ALLOWED_ORIGINS=http://localhost:3000,http://192.168.1.10:3000
```

Then re-create the container so it picks up the new env:

```bash
docker compose up -d --force-recreate mcp-server
```

## Docker — VPS / Cloudflare Tunnel mode

If `MCP_PUBLIC_URL` matches the URL your browser hits (e.g.
`https://mediabox.example.com`), **no action needed** — the generated
compose seeds `ALLOWED_ORIGINS` from `MCP_PUBLIC_URL` automatically.

## Headless / external MCP clients

Telegram bot, Claude Desktop, ChatGPT, custom MCP clients: **no action
needed.** These callers do not send the `Origin` header and pass the new
check unchanged. Authentication via `INTERNAL_API_KEY` or OAuth is
unchanged.

## Scripts or custom callers using `..` paths

If a script (or LLM orchestration) was passing paths containing `..` to
any of these tools, those calls now throw `PathSandboxError`:

- `manage_files` (list / move / delete)
- `rename_episodes`
- `fix_subtitles`
- `optimize_media`
- `series_import` / `movie_import`
- `download_status` (action="organize")
- `download_direct`

Fix: pass paths relative to `MEDIA_PATH` (e.g. `anime/Show`) or
`downloads/<folder>`, or absolute paths under those roots. The sandbox
accepts both forms.

## Custom MCP clients calling delete / cleanup / optimize

`manage_files(delete)`, `cleanup_server(dryRun:false)` and
`optimize_media(action:"optimize")` are now **two-step**:

1. **First call** — same args as before, no `confirmToken`. Server
   returns:
   ```json
   {
     "requiresConfirmation": true,
     "confirmToken": "<24-hex-chars>",
     "preview": { ... },
     "message": "..."
   }
   ```
   Nothing is mutated.

2. **Second call** — same args plus `confirmToken: "<token>"`. Server
   consumes the token (single-use) and executes.

Tokens expire in 5 minutes and are bound to the original args; changing
the target invalidates the token. The bundled chat LLM is updated to
follow this protocol. If you have a custom client (e.g. an automation
script), you need to:

- Treat `requiresConfirmation: true` responses as previews, not
  successes.
- Pass the returned `confirmToken` in a follow-up call to commit.

## Docker image distribution

Pre-2.2 the README claimed `npx create-mediabox` used GHCR images, but
no workflow actually published them. 2.2.0 ships
`.github/workflows/docker-publish.yml` which pushes multi-arch images
(`amd64` + `arm64`) on every `v*` tag.

If your previous install used `npx create-mediabox --local-build`
because the published images didn't exist, you can drop that flag —
once 2.2.0 is tagged and the publish workflow runs successfully, the
GHCR images will be available and the unqualified `npx create-mediabox`
flow will work end-to-end.

## Branding-relevant defaults

These defaults are set automatically by the new code; documenting them
here so you know what the server is doing on your behalf:

| Mode | `BIND_HOST` | `ALLOWED_ORIGINS` |
|---|---|---|
| Desktop sidecar | `127.0.0.1` (forced) | `tauri://localhost,http://tauri.localhost,https://tauri.localhost` |
| Docker (any mode) | `0.0.0.0` (container default) | `${MCP_PUBLIC_URL}` (from `.env`) |
| Headless / dev | `0.0.0.0` (default) | `${ALLOWED_ORIGINS}` from env, plus localhost regex |

Localhost (`http(s)://localhost[:port]` and `127.0.0.1[:port]`) and
Tauri webview origins are always allowed unless you opt out via code —
no env override drops them. This is safe for DNS rebinding because
browsers always send `Origin` reflecting the URL the user typed, never
the rebound IP.
