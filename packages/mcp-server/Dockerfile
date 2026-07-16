# syntax=docker/dockerfile:1.6
#
# Mediabox MCP server image.
#
# Build context MUST be the monorepo root (not packages/mcp-server) so the
# builder stage can install and compile the four workspaces this binary
# depends on: @mediabox/contracts → @mediabox/core → @mediabox/chat-core →
# mediabox-mcp.
#
# Usage:
#   docker build -f packages/mcp-server/Dockerfile -t mediabox-mcp .

# ── Builder ─────────────────────────────────────────────────────────────────
FROM node:22-slim AS builder
WORKDIR /repo

# Manifests first so the npm-install layer can be cached across source edits.
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/contracts/package.json     packages/contracts/
COPY packages/core/package.json          packages/core/
COPY packages/chat-core/package.json     packages/chat-core/
COPY packages/mcp-server/package.json    packages/mcp-server/

# `npm ci` always installs the full lockfile graph regardless of --workspace
# filters. We accept that extra weight in the builder; `npm prune --omit=dev`
# below trims it before the runtime stage copies the tree.
RUN npm ci

# Sources (split per package so a tsconfig edit doesn't bust the src layer).
COPY packages/contracts/tsconfig.json    packages/contracts/
COPY packages/contracts/src              packages/contracts/src
COPY packages/core/tsconfig.json         packages/core/
COPY packages/core/src                   packages/core/src
COPY packages/chat-core/tsconfig.json    packages/chat-core/
COPY packages/chat-core/src              packages/chat-core/src
COPY packages/mcp-server/tsconfig.json   packages/mcp-server/
COPY packages/mcp-server/src             packages/mcp-server/src

# Build in dependency order — each later workspace consumes the dist of the
# earlier ones via the symlink npm wrote into node_modules/@mediabox/*.
RUN npm run build --workspace=@mediabox/contracts \
 && npm run build --workspace=@mediabox/core \
 && npm run build --workspace=@mediabox/chat-core \
 && npm run build --workspace=mediabox-mcp

# Drop dev deps. Workspace symlinks survive the prune; the runtime stage
# resolves @mediabox/* by walking the symlinks into /repo/packages/*.
RUN npm prune --omit=dev --workspaces

# ── Runtime ─────────────────────────────────────────────────────────────────
FROM node:22-slim AS runtime

# yt-dlp/aria2c/p7zip + curl/unzip used by download_direct, organize and
# fix_subtitles. ca-certificates so HTTPS works after the slim base shrinks.
RUN apt-get update && apt-get install -y --no-install-recommends \
        python3 python3-pip aria2 curl unzip p7zip ca-certificates xz-utils \
    && pip3 install --break-system-packages yt-dlp gdown \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

# unrar is amd64-only via RARLAB (their arm64 builds aren't published as a
# stable URL we can pin). On arm64 we fall back to Debian's unrar-free —
# loses RAR5 / encrypted-archive support but keeps the build green.
RUN ARCH=$(dpkg --print-architecture) \
    && if [ "$ARCH" = "amd64" ]; then \
         curl -fL https://www.rarlab.com/rar/rarlinux-x64-721b1.tar.gz -o /tmp/rar.tar.gz \
           && tar -xzf /tmp/rar.tar.gz -C /tmp \
           && cp /tmp/rar/unrar /usr/local/bin/ \
           && chmod +x /usr/local/bin/unrar \
           && rm -rf /tmp/rar*; \
       else \
         apt-get update && apt-get install -y --no-install-recommends unrar-free \
           && apt-get clean && rm -rf /var/lib/apt/lists/*; \
       fi

# ffmpeg/ffprobe — pick the matching static build for the target arch.
RUN ARCH=$(dpkg --print-architecture) \
    && case "$ARCH" in \
         amd64) FFMPEG_ARCH=amd64 ;; \
         arm64) FFMPEG_ARCH=arm64 ;; \
         *) echo "Unsupported arch: $ARCH" >&2; exit 1 ;; \
       esac \
    && curl -fL "https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-${FFMPEG_ARCH}-static.tar.xz" -o /tmp/ffmpeg.tar.xz \
    && tar -xf /tmp/ffmpeg.tar.xz -C /tmp \
    && cp /tmp/ffmpeg-*-${FFMPEG_ARCH}-static/ffmpeg /usr/local/bin/ \
    && cp /tmp/ffmpeg-*-${FFMPEG_ARCH}-static/ffprobe /usr/local/bin/ \
    && rm -rf /tmp/ffmpeg*

# Run from inside the monorepo layout so the workspace symlinks in
# node_modules/@mediabox resolve correctly. The "wasted" source files from
# contracts/core/chat-core are tiny TypeScript inputs; node executes their
# pre-compiled dist/.
WORKDIR /repo/packages/mcp-server
COPY --from=builder /repo /repo

EXPOSE 3000

# Containers must bind all interfaces so Docker's published-port mapping can
# reach the listener. The server code itself defaults to 127.0.0.1 (safe for
# bare host runs); this ENV opts every container run into 0.0.0.0.
ENV BIND_HOST=0.0.0.0

CMD ["node", "dist/index.js"]
