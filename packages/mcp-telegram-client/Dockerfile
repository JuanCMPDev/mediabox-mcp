# syntax=docker/dockerfile:1.6
#
# Mediabox MCP Telegram bot image.
#
# Build context MUST be the monorepo root so the builder stage can install
# and compile @mediabox/contracts → @mediabox/chat-core → mcp-telegram-client.
#
# Usage:
#   docker build -f packages/mcp-telegram-client/Dockerfile -t mediabox-telegram .

# ── Builder ─────────────────────────────────────────────────────────────────
FROM node:22-slim AS builder
WORKDIR /repo

COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/contracts/package.json            packages/contracts/
COPY packages/chat-core/package.json            packages/chat-core/
COPY packages/mcp-telegram-client/package.json  packages/mcp-telegram-client/

RUN npm ci

COPY packages/contracts/tsconfig.json           packages/contracts/
COPY packages/contracts/src                     packages/contracts/src
COPY packages/chat-core/tsconfig.json           packages/chat-core/
COPY packages/chat-core/src                     packages/chat-core/src
COPY packages/mcp-telegram-client/tsconfig.json packages/mcp-telegram-client/
COPY packages/mcp-telegram-client/src           packages/mcp-telegram-client/src

RUN npm run build --workspace=@mediabox/contracts \
 && npm run build --workspace=@mediabox/chat-core \
 && npm run build --workspace=mcp-telegram-client

RUN npm prune --omit=dev --workspaces

# ── Runtime ─────────────────────────────────────────────────────────────────
FROM node:22-slim AS runtime
WORKDIR /repo/packages/mcp-telegram-client
COPY --from=builder /repo /repo
CMD ["node", "dist/index.js"]
