import { stringify } from "yaml";
import type { DeployConfig, PrivacyProfile } from "../config/types.js";
import { ensureRelative } from "../utils/paths.js";
import {
  ARTIFACT_LOCK_FILE,
  MODEL_DIGEST_MARKER,
  applyArtifactLock,
  type ArtifactLock,
} from "../artifacts/lock.js";

const GHCR_MCP_IMAGE_BASE = "ghcr.io/juancmpdev/mediabox-mcp";
const GHCR_TELEGRAM_IMAGE_BASE = "ghcr.io/juancmpdev/mediabox-telegram";

/** Service name and DNS host of the inference container inside the compose network. */
const INFERENCE_SERVICE_HOST = "mediabox-inference";

/**
 * Fixed TCP forwarder for the owner-facing edge of strict profiles. The tag is only
 * a search key: `prepare` pins it by digest through the artifact lock (§3.2).
 */
export const EDGE_IMAGE = "alpine/socat:1.8.0.3";
export const EDGE_SERVICE = "mediabox-edge";
export const PROVISIONER_SERVICE = "mediabox-provisioner";
export const PROVISION_PROFILE = "provision";

/** Owner-facing ports the edge publishes, each forwarded to one fixed service port. */
const EDGE_FORWARDS = [
  { port: 3000, service: "mcp-server" },
  { port: 8096, service: "jellyfin" },
  { port: 8920, service: "jellyfin" },
] as const;

/**
 * Provisioner script (compose unescapes `$$` to `$`). It pulls the model on the
 * provision network, then prints the manifest digest the runtime computed so the
 * deployer can check it against the manifest written to the shared volume.
 */
const PROVISIONER_SCRIPT = [
  "set -eu",
  'model="$${LOCAL_LLM_MODEL:?LOCAL_LLM_MODEL is required}"',
  "ollama serve >/tmp/ollama-serve.log 2>&1 &",
  "serve_pid=$$!",
  "ready=0",
  "for _ in $$(seq 1 60); do",
  "  if ollama list >/dev/null 2>&1; then ready=1; break; fi",
  "  sleep 1",
  "done",
  'if [ "$$ready" != 1 ]; then echo "MEDIABOX_PROVISION_ERROR runtime-not-ready" >&2; exit 1; fi',
  'ollama pull "$$model"',
  // /api/tags lists the shortest name with an explicit tag.
  'name="$${model#registry.ollama.ai/}"',
  'name="$${name#library/}"',
  'case "$${name##*/}" in *:*) ;; *) name="$$name:latest" ;; esac',
  // The image ships no HTTP client; bash's /dev/tcp is enough for one GET.
  "exec 3<>/dev/tcp/127.0.0.1/11434",
  "printf 'GET /api/tags HTTP/1.0\\r\\nHost: 127.0.0.1\\r\\n\\r\\n' >&3",
  'tags="$$(cat <&3)"',
  "exec 3<&-",
  `digest="$$(printf '%s' "$$tags" | tr '{' '\\n' | grep -F "\\"name\\":\\"$$name\\"" | sed -n 's/.*"digest":"\\([a-f0-9]\\{64\\}\\)".*/\\1/p' | head -n 1)"`,
  'if [ -z "$$digest" ]; then echo "MEDIABOX_PROVISION_ERROR digest-not-found" >&2; exit 1; fi',
  `echo "${MODEL_DIGEST_MARKER} $$name sha256:$$digest"`,
  'kill "$$serve_pid" 2>/dev/null || true',
  'wait "$$serve_pid" 2>/dev/null || true',
].join("\n");

export interface GenerateDockerComposeOptions {
  /** Strict profiles only: pins every image by digest and sets `pull_policy: never`. */
  artifactLock?: ArtifactLock;
}

export function isStrictPrivacyProfile(profile: string | undefined): profile is PrivacyProfile {
  return profile === "offline-library" || profile === "local-agent-online-media";
}

/**
 * A loopback endpoint is unreachable from inside a container: 127.0.0.1 there is the
 * container itself. When compose runs the runtime, the other services must address it
 * by its service name, which resolves to a private bridge IP and therefore also needs
 * the LAN allow-list entry (§3.5 / §6.7).
 */
export function resolveContainerInferenceUrl(baseUrl: string): { url: string; rewritten: boolean } {
  try {
    const parsed = new URL(baseUrl);
    const isLoopback = /^(127\.|localhost$|\[?::1\]?$)/i.test(parsed.hostname);
    if (!isLoopback) return { url: baseUrl, rewritten: false };
    parsed.hostname = INFERENCE_SERVICE_HOST;
    return { url: parsed.toString().replace(/\/$/, ""), rewritten: true };
  } catch {
    return { url: baseUrl, rewritten: false };
  }
}

/**
 * Endpoint variables for services that run inside the compose network. The
 * loopback value an owner writes in .env belongs to the host, so containers get
 * the service name plus the allow-list entry its private IP requires.
 */
function buildContainerInferenceEnv(config: DeployConfig): string[] {
  const llm = config.ai ?? config.telegram?.llm;
  if (llm?.kind !== "local") {
    return [
      "LOCAL_LLM_BASE_URL=${LOCAL_LLM_BASE_URL:-}",
      "INFERENCE_ALLOW_LAN=${INFERENCE_ALLOW_LAN:-}",
      "INFERENCE_ENDPOINT_HOSTS=${INFERENCE_ENDPOINT_HOSTS:-}",
    ];
  }

  const endpoint = resolveContainerInferenceUrl(llm.baseUrl);
  if (!endpoint.rewritten) {
    return [
      `LOCAL_LLM_BASE_URL=\${LOCAL_LLM_BASE_URL_CONTAINER:-${endpoint.url}}`,
      `INFERENCE_ALLOW_LAN=\${INFERENCE_ALLOW_LAN:-${llm.allowLan ? "true" : ""}}`,
      `INFERENCE_ENDPOINT_HOSTS=\${INFERENCE_ENDPOINT_HOSTS:-${(llm.endpointHosts ?? []).join(",")}}`,
    ];
  }

  const hosts = [INFERENCE_SERVICE_HOST, ...(llm.endpointHosts ?? [])].join(",");
  return [
    `LOCAL_LLM_BASE_URL=\${LOCAL_LLM_BASE_URL_CONTAINER:-${endpoint.url}}`,
    "INFERENCE_ALLOW_LAN=${INFERENCE_ALLOW_LAN:-true}",
    `INFERENCE_ENDPOINT_HOSTS=\${INFERENCE_ENDPOINT_HOSTS:-${hosts}}`,
  ];
}

/** Environment array for the Telegram bot — varies by LLM provider */
function buildTelegramEnv(config: DeployConfig): string[] {
  const env = [
    "TELEGRAM_BOT_TOKEN=${TELEGRAM_BOT_TOKEN}",
    "MCP_SERVER_URL=http://mcp-server:3000/mcp",
    "ALLOWED_TELEGRAM_USERS=${ALLOWED_TELEGRAM_USERS}",
    // The bot is an agent, not the owner: it gets the dedicated agent
    // credential, never INTERNAL_API_KEY (Blueprint §4.1 / B02).
    "MCP_AGENT_API_KEY=${AGENT_API_KEY}",
  ];

  const llm = config.telegram?.llm;
  if (llm?.kind === "local") {
    const endpoint = resolveContainerInferenceUrl(llm.baseUrl);
    env.push(
      "LLM_PROVIDER=local",
      `LOCAL_LLM_RUNTIME=\${LOCAL_LLM_RUNTIME:-${llm.runtime}}`,
      `LOCAL_LLM_BASE_URL=\${LOCAL_LLM_BASE_URL:-${endpoint.url}}`,
      `LOCAL_LLM_MODEL=\${LOCAL_LLM_MODEL:-${llm.model}}`,
    );
    if (llm.apiKey) env.push("LOCAL_LLM_API_KEY=${LOCAL_LLM_API_KEY}");
    if (llm.contextTokens) env.push(`LOCAL_LLM_CONTEXT_TOKENS=\${LOCAL_LLM_CONTEXT_TOKENS:-${llm.contextTokens}}`);
    if (endpoint.rewritten) {
      // The bridge address is private, so the policy needs it allow-listed explicitly.
      env.push(
        `INFERENCE_ALLOW_LAN=\${INFERENCE_ALLOW_LAN:-true}`,
        `INFERENCE_ENDPOINT_HOSTS=\${INFERENCE_ENDPOINT_HOSTS:-${INFERENCE_SERVICE_HOST}}`,
      );
    }
    if (llm.backend) env.push(`INFERENCE_BACKEND=\${INFERENCE_BACKEND:-${llm.backend}}`);
  } else if (llm?.kind === "google") {
    env.push("GOOGLE_AI_API_KEY=${GOOGLE_AI_API_KEY}", "LLM_PROVIDER=google");
    if (llm.model) env.push("LLM_MODEL=${LLM_MODEL}");
  } else {
    env.push(
      "OPENROUTER_API_KEY=${OPENROUTER_API_KEY}",
      "LLM_PROVIDER=openrouter",
      "LLM_MODEL=${LLM_MODEL:-openai/gpt-4o}",
    );
  }

  return env;
}

/** Environment array for LinuxServer containers — emitted as `${VAR}`
 * references with the deploy-time value as a default, so PATCH /env can
 * rewrite PUID/PGID/TZ in `.env` and a `docker compose up -d --force-recreate`
 * picks them up without a wizard re-run. */
function lsEnv(config: DeployConfig): string[] {
  return [
    `PUID=\${PUID:-${config.system.puid}}`,
    `PGID=\${PGID:-${config.system.pgid}}`,
    "TZ=${TZ:-UTC}",
  ];
}

/** In VPS mode, bind a port to 127.0.0.1 only (not exposed to the internet). */
function port(mapping: string, bindLocal: boolean): string {
  return bindLocal ? `127.0.0.1:${mapping}` : mapping;
}

/** Agent/MCP and inference containers must only ever join internal networks (§3.1). */
function assertStrictTopology(services: Record<string, any>, internal: Set<string>): void {
  for (const [name, service] of Object.entries(services)) {
    const confined = name === "mcp-server" || service.container_name === INFERENCE_SERVICE_HOST;
    if (!confined) continue;
    const exposed = (service.networks ?? []).filter((n: string) => !internal.has(n));
    if (exposed.length > 0 || service.ports) {
      throw new Error(`Strict privacy topology violated: ${name} must only join internal networks`);
    }
  }
}

export function generateDockerCompose(config: DeployConfig, opts: GenerateDockerComposeOptions = {}): string {
  const { deployment, paths: mediaPaths, services: svc } = config;
  // Media paths are emitted as `${MOVIES_PATH}` etc. references with the
  // deploy-time value as a default, so PATCH /env in PR 3.4a can rewrite
  // them in `.env` and a recreate picks them up. ensureRelative() is only
  // needed for the embedded default — at runtime Docker Compose reads the
  // current `.env` and substitutes whatever's there.
  const mov   = ensureRelative(mediaPaths.movies);
  const tv    = ensureRelative(mediaPaths.tv);
  const anime = ensureRelative(mediaPaths.anime);
  const music = ensureRelative(mediaPaths.music);
  const movRef   = "${MOVIES_PATH:-" + mov + "}";
  const tvRef    = "${TV_PATH:-"     + tv + "}";
  const animeRef = "${ANIME_PATH:-"  + anime + "}";
  const musicRef = "${MUSIC_PATH:-"  + music + "}";
  const bindLocal = deployment.mode === "vps" || deployment.mode === "tunnel";
  const ghcrMcpImage = `${GHCR_MCP_IMAGE_BASE}:\${IMAGE_TAG:-${deployment.imageTag}}`;
  const ghcrTelegramImage = `${GHCR_TELEGRAM_IMAGE_BASE}:\${IMAGE_TAG:-${deployment.imageTag}}`;

  const privacy = deployment.privacyProfile;
  const isStrictPrivacy = isStrictPrivacyProfile(privacy);
  const effectiveLlm = config.ai ?? config.telegram?.llm;
  // Only Ollama has a provisioner that pins manifest and blobs before run (§3.2).
  const provisionModel = isStrictPrivacy && effectiveLlm?.kind === "local" && effectiveLlm.runtime === "ollama";

  // Strict network topology (§3.1):
  // - mediabox-inference-net is strictly internal (internal: true) between agent and inference.
  // - mediabox-services-net connects agent with internal media services (internal: true).
  // - mediabox-external-net is bridge with egress only for downloaders/indexers in online-media.
  // - mediabox-edge-net is the bridge the owner edge publishes ports from.
  // - mediabox-provision-net gives the provisioner registry access, before run only.
  // When privacyProfile is omitted (unverified / legacy), defaults to backward-compatible mediabox-net bridge.
  const mcpNetworks = isStrictPrivacy
    ? ["mediabox-inference-net", "mediabox-services-net"]
    : ["mediabox-net"];

  const inferenceNetworks = isStrictPrivacy
    ? ["mediabox-inference-net"]
    : ["mediabox-net"];

  const serviceNetworks = !isStrictPrivacy
    ? ["mediabox-net"]
    : privacy === "offline-library"
      ? ["mediabox-services-net"]
      : ["mediabox-services-net", "mediabox-external-net"];

  const services: Record<string, any> = {};

  // ── Jellyfin ──────────────────────────────────────────────────────────
  // Strict profiles publish 8096/8920 through the edge; UDP discovery stays only
  // where Jellyfin keeps a bridge network (online media).
  const jellyfinPorts = isStrictPrivacy ? [] : [port("8096:8096", bindLocal), port("8920:8920", bindLocal)];
  if (!bindLocal) jellyfinPorts.push("7359:7359/udp", "1900:1900/udp");

  services.jellyfin = {
    image: "lscr.io/linuxserver/jellyfin:latest",
    container_name: "jellyfin",
    networks: serviceNetworks,
    ...(jellyfinPorts.length > 0 ? { ports: jellyfinPorts } : {}),
    environment: lsEnv(config),
    volumes: [
      "./config/jellyfin:/config",
      `${movRef}:/data/movies`,
      `${tvRef}:/data/tv`,
      `${musicRef}:/data/music`,
      `${animeRef}:/data/anime`,
    ],
    restart: "unless-stopped",
    deploy: { resources: { limits: { memory: "4G" } } },
  };

  // ── MCP Server ────────────────────────────────────────────────────────
  const mcpServer: Record<string, any> = {
    container_name: "mcp-server",
    networks: mcpNetworks,
    ports: [port("3000:3000", bindLocal)],
    environment: [
      "TZ=${TZ:-UTC}",
      ...(privacy ? [`PRIVACY_PROFILE=${privacy}`] : []),
      "JELLYFIN_URL=http://jellyfin:8096",
      "JELLYFIN_API_KEY=${JELLYFIN_API_KEY}",
      "MEDIA_PATH=/data",
      "PORT=3000",
      // Containers bind all interfaces so Docker's published-port mapping can
      // reach the listener. The server code defaults to 127.0.0.1 for bare host
      // runs; inside a container we must opt into 0.0.0.0.
      "BIND_HOST=0.0.0.0",
      "PUBLIC_URL=${MCP_PUBLIC_URL}",
      // Defense-in-depth against DNS rebinding for browser callers. Defaults
      // to MCP_PUBLIC_URL so the wizard "just works"; users can override in
      // .env (comma-separated) to add LAN IPs or extra reverse-proxy hosts.
      "ALLOWED_ORIGINS=${ALLOWED_ORIGINS:-${MCP_PUBLIC_URL}}",
      "PYLOAD_URL=http://pyload:8000",
      "PYLOAD_USER=${PYLOAD_USER}",
      "PYLOAD_PASSWORD=${PYLOAD_PASSWORD}",
      "SONARR_URL=http://sonarr:8989",
      "SONARR_API_KEY=${SONARR_API_KEY}",
      "RADARR_URL=http://radarr:7878",
      "RADARR_API_KEY=${RADARR_API_KEY}",
      "INTERNAL_API_KEY=${INTERNAL_API_KEY}",
      // Agent credential + installation identity (Blueprint §4.1 / B02). The
      // agent key is what the loopback chat client presents; it is distinct
      // from the owner key so agent sessions never gain owner authority.
      "AGENT_API_KEY=${AGENT_API_KEY}",
      "MEDIABOX_INSTALLATION_ID=${MEDIABOX_INSTALLATION_ID}",
      "QBIT_URL=http://qbittorrent:8085",
      "QBIT_USER=admin",
      "QBIT_PASSWORD=${QBIT_PASSWORD}",
      "LLM_PROVIDER=${LLM_PROVIDER:-}",
      "OPENROUTER_API_KEY=${OPENROUTER_API_KEY:-}",
      "GOOGLE_AI_API_KEY=${GOOGLE_AI_API_KEY:-}",
      "LLM_MODEL=${LLM_MODEL:-}",
      "LOCAL_LLM_RUNTIME=${LOCAL_LLM_RUNTIME:-}",
      "LOCAL_LLM_MODEL=${LOCAL_LLM_MODEL:-}",
      // Strict profiles: the manifest digest `prepare` recorded. The server checks
      // it against the runtime before starting the agent (§3.2).
      ...(isStrictPrivacy ? ["LOCAL_LLM_MODEL_DIGEST=${LOCAL_LLM_MODEL_DIGEST:-}"] : []),
      "LOCAL_LLM_CONTEXT_TOKENS=${LOCAL_LLM_CONTEXT_TOKENS:-}",
      "LOCAL_LLM_API_KEY=${LOCAL_LLM_API_KEY:-}",
      "INFERENCE_BACKEND=${INFERENCE_BACKEND:-}",
      // Inside the network the runtime is reachable by service name, never by
      // loopback; LOCAL_LLM_BASE_URL_CONTAINER overrides it for a host runtime.
      ...buildContainerInferenceEnv(config),
    ],
    volumes: [
      `${movRef}:/data/movies`,
      `${tvRef}:/data/tv`,
      `${musicRef}:/data/music`,
      `${animeRef}:/data/anime`,
      "./downloads:/downloads",
    ],
    restart: "unless-stopped",
    depends_on: ["jellyfin", "pyload"],
  };

  if (deployment.localBuild) {
    // Build context is the monorepo root so the multi-stage Dockerfile can
    // install and compile the workspace deps (@mediabox/contracts, /core,
    // /chat-core). Pre-2.2 used `./packages/mcp-server` as context which
    // broke against the workspace layout.
    mcpServer.build = { context: ".", dockerfile: "packages/mcp-server/Dockerfile" };
  } else {
    mcpServer.image = ghcrMcpImage;
  }
  services["mcp-server"] = mcpServer;

  // ── PyLoad ────────────────────────────────────────────────────────────
  services.pyload = {
    image: "lscr.io/linuxserver/pyload-ng:latest",
    container_name: "pyload",
    networks: serviceNetworks,
    ports: [port("8001:8000", bindLocal)],
    environment: lsEnv(config),
    volumes: ["./config/pyload:/config", "./downloads:/downloads"],
    restart: "unless-stopped",
  };

  // ── Telegram Bot (optional) ───────────────────────────────────────────
  // Offline-library disables Telegram in process and network (§3.1).
  if (config.telegram && privacy !== "offline-library") {
    const telegramBot: Record<string, any> = {
      container_name: "telegram-bot",
      networks: serviceNetworks,
      environment: buildTelegramEnv(config),
      restart: "unless-stopped",
      depends_on: ["mcp-server"],
    };

    if (deployment.localBuild) {
      telegramBot.build = {
        context: ".",
        dockerfile: "packages/mcp-telegram-client/Dockerfile",
      };
    } else {
      telegramBot.image = ghcrTelegramImage;
    }
    services["telegram-bot"] = telegramBot;
  }

  // ── Download Stack ────────────────────────────────────────────────────
  services.qbittorrent = {
    image: "lscr.io/linuxserver/qbittorrent:latest",
    container_name: "qbittorrent",
    networks: serviceNetworks,
    ports: [port("8085:8085", bindLocal), "6881:6881", "6881:6881/udp"],
    environment: [...lsEnv(config), "WEBUI_PORT=8085"],
    volumes: ["./config/qbittorrent:/config", "./downloads:/downloads"],
    restart: "unless-stopped",
  };

  services.flaresolverr = {
    image: "ghcr.io/flaresolverr/flaresolverr:latest",
    container_name: "flaresolverr",
    networks: serviceNetworks,
    ports: [port("8191:8191", bindLocal)],
    environment: ["LOG_LEVEL=info", "TZ=${TZ:-UTC}"],
    restart: "unless-stopped",
  };

  services.prowlarr = {
    image: "lscr.io/linuxserver/prowlarr:latest",
    container_name: "prowlarr",
    networks: serviceNetworks,
    ports: [port("9696:9696", bindLocal)],
    environment: lsEnv(config),
    volumes: ["./config/prowlarr:/config"],
    restart: "unless-stopped",
  };

  services.radarr = {
    image: "lscr.io/linuxserver/radarr:latest",
    container_name: "radarr",
    networks: serviceNetworks,
    ports: [port("7878:7878", bindLocal)],
    environment: lsEnv(config),
    volumes: [`./config/radarr:/config`, `${movRef}:/movies`, "./downloads:/downloads"],
    restart: "unless-stopped",
    depends_on: ["qbittorrent", "prowlarr"],
  };

  services.sonarr = {
    image: "lscr.io/linuxserver/sonarr:latest",
    container_name: "sonarr",
    networks: serviceNetworks,
    ports: [port("8989:8989", bindLocal)],
    environment: lsEnv(config),
    volumes: [
      "./config/sonarr:/config",
      `${tvRef}:/tv`,
      `${animeRef}:/anime`,
      "./downloads:/downloads",
    ],
    restart: "unless-stopped",
    depends_on: ["qbittorrent", "prowlarr"],
  };

  // ── Bazarr (optional) ─────────────────────────────────────────────────
  if (svc.bazarr.enabled) {
    services.bazarr = {
      image: "lscr.io/linuxserver/bazarr:latest",
      container_name: "bazarr",
      networks: serviceNetworks,
      ports: [port("6767:6767", bindLocal)],
      environment: lsEnv(config),
      volumes: [`./config/bazarr:/config`, `${movRef}:/movies`, `${tvRef}:/tv`],
      restart: "unless-stopped",
    };
  }

  // ── Caddy reverse proxy (VPS mode only) ─────────────────────────────
  if (deployment.mode === "vps") {
    services.caddy = {
      image: "caddy:2-alpine",
      container_name: "caddy",
      networks: serviceNetworks,
      ports: ["80:80", "443:443", "443:443/udp"],
      volumes: [
        "./config/caddy/Caddyfile:/etc/caddy/Caddyfile:ro",
        "./config/caddy/data:/data",
        "./config/caddy/config:/config",
      ],
      restart: "unless-stopped",
      depends_on: Object.keys(services),
    };
  }

  // ── Cloudflare Tunnel (tunnel mode) ──────────────────────────────────
  if (deployment.mode === "tunnel" && privacy !== "offline-library") {
    services.cloudflared = {
      image: "cloudflare/cloudflared:latest",
      container_name: "cloudflared",
      networks: serviceNetworks,
      command: "tunnel --no-autoupdate run",
      environment: ["TUNNEL_TOKEN=${CLOUDFLARE_TUNNEL_TOKEN}"],
      restart: "unless-stopped",
    };
  }

  // ── Owner edge (strict profiles) ──────────────────────────────────────
  // Docker publishes no ports for a container that only joins internal networks,
  // so the owner UI/API and Jellyfin are reached through fixed forwarders on a
  // separate bridge. Not a generic proxy: each listener maps to one service port.
  if (isStrictPrivacy) {
    services[EDGE_SERVICE] = {
      image: EDGE_IMAGE,
      container_name: EDGE_SERVICE,
      networks: ["mediabox-edge-net", "mediabox-services-net"],
      ports: EDGE_FORWARDS.map((f) => port(`${f.port}:${f.port}`, bindLocal)),
      entrypoint: ["sh", "-c"],
      // Busybox `wait -n` misses a forwarder killed by a signal, so the shell polls
      // its listeners: when one dies the container exits and the restart policy
      // brings every listener back together.
      command: [
        EDGE_FORWARDS.map((f, i) => `socat TCP-LISTEN:${f.port},fork,reuseaddr TCP:${f.service}:${f.port} & p${i}=$$!;`).join(" ") +
          ` while ${EDGE_FORWARDS.map((_, i) => `kill -0 $$p${i}`).join(" && ")}; do sleep 2; done; exit 1`,
      ],
      user: "65534:65534",
      read_only: true,
      cap_drop: ["ALL"],
      security_opt: ["no-new-privileges:true"],
      restart: "unless-stopped",
      depends_on: ["mcp-server", "jellyfin"],
    };
  }

  // ── Local Inference Services (optional profiles) ───────────────────────
  if (effectiveLlm?.kind === "local") {
    services["inference-cuda"] = {
      image: "ollama/ollama:latest",
      container_name: "mediabox-inference",
      profiles: ["inference-cuda"],
      networks: inferenceNetworks,
      ports: [port("11434:11434", bindLocal)],
      environment: [
        "OLLAMA_NO_CLOUD=1",
        "OLLAMA_CONTEXT_LENGTH=${LOCAL_LLM_CONTEXT_TOKENS:-8192}",
        "OLLAMA_KEEP_ALIVE=-1",
        "OLLAMA_MAX_LOADED_MODELS=1",
        "OLLAMA_NUM_PARALLEL=1",
        // llama-server keeps a host-RAM prompt cache of up to 8 GiB by default;
        // PR05 G10 measured it outgrowing the inference RAM budget. Off.
        "LLAMA_ARG_CACHE_RAM=0",
      ],
      volumes: ["./config/ollama:/root/.ollama"],
      deploy: {
        resources: {
          reservations: {
            devices: [
              {
                driver: "nvidia",
                count: "all",
                capabilities: ["gpu"],
              },
            ],
          },
        },
      },
      restart: "unless-stopped",
    };

    services["inference-rocm"] = {
      image: "ollama/ollama:rocm",
      container_name: "mediabox-inference",
      profiles: ["inference-rocm"],
      networks: inferenceNetworks,
      ports: [port("11434:11434", bindLocal)],
      devices: ["/dev/kfd", "/dev/dri"],
      group_add: ["video", "render"],
      environment: [
        "OLLAMA_NO_CLOUD=1",
        "OLLAMA_CONTEXT_LENGTH=${LOCAL_LLM_CONTEXT_TOKENS:-8192}",
        "OLLAMA_KEEP_ALIVE=-1",
        "OLLAMA_MAX_LOADED_MODELS=1",
        "OLLAMA_NUM_PARALLEL=1",
        // llama-server keeps a host-RAM prompt cache of up to 8 GiB by default;
        // PR05 G10 measured it outgrowing the inference RAM budget. Off.
        "LLAMA_ARG_CACHE_RAM=0",
      ],
      volumes: ["./config/ollama:/root/.ollama"],
      restart: "unless-stopped",
    };

    services["inference-vulkan"] = {
      image: "ghcr.io/ggml-org/llama.cpp:server-vulkan",
      container_name: "mediabox-inference",
      profiles: ["inference-vulkan"],
      networks: inferenceNetworks,
      ports: [port("8080:8080", bindLocal)],
      devices: ["/dev/dri"],
      // llama.cpp needs the model, the context size and --jinja for tool calling:
      // without a tools template it returns <tool_call> as plain text (§6.2).
      // `-hf` downloads at start, which an internal network cannot do: strict
      // profiles load a local GGUF from a read-only mount instead.
      command: [
        "--host", "0.0.0.0",
        "--port", "8080",
        ...(isStrictPrivacy
          ? ["-m", "/models/${LOCAL_LLM_MODEL_FILE:-}"]
          : ["-hf", "${LOCAL_LLM_HF_REPO:-Qwen/Qwen2.5-7B-Instruct-GGUF:Q4_K_M}"]),
        "--ctx-size", "${LOCAL_LLM_CONTEXT_TOKENS:-8192}",
        "--jinja",
        "--parallel", "1",
      ],
      volumes: [isStrictPrivacy ? "./config/llamacpp:/models:ro" : "./config/llamacpp:/root/.cache/llama.cpp"],
      restart: "unless-stopped",
    };

    services["inference-cpu"] = {
      image: "ollama/ollama:latest",
      container_name: "mediabox-inference",
      profiles: ["inference-cpu"],
      networks: inferenceNetworks,
      ports: [port("11434:11434", bindLocal)],
      environment: [
        "OLLAMA_NO_CLOUD=1",
        "OLLAMA_CONTEXT_LENGTH=${LOCAL_LLM_CONTEXT_TOKENS:-8192}",
        "OLLAMA_KEEP_ALIVE=-1",
        "OLLAMA_MAX_LOADED_MODELS=1",
        "OLLAMA_NUM_PARALLEL=1",
        // llama-server keeps a host-RAM prompt cache of up to 8 GiB by default;
        // PR05 G10 measured it outgrowing the inference RAM budget. Off.
        "LLAMA_ARG_CACHE_RAM=0",
      ],
      volumes: ["./config/ollama:/root/.ollama"],
      restart: "unless-stopped",
    };

    // ── Model provisioner (strict profiles, `prepare` only) ──────────────
    // Registry access lives here, on its own bridge and under its own profile,
    // never in the inference container that serves the agent (§3.1 / §3.3).
    if (provisionModel) {
      services[PROVISIONER_SERVICE] = {
        image: "ollama/ollama:latest",
        profiles: [PROVISION_PROFILE],
        networks: ["mediabox-provision-net"],
        environment: [
          "OLLAMA_NO_CLOUD=1",
          `LOCAL_LLM_MODEL=\${LOCAL_LLM_MODEL:-${effectiveLlm.model}}`,
        ],
        volumes: ["./config/ollama:/root/.ollama"],
        entrypoint: ["/bin/bash", "-c"],
        command: [PROVISIONER_SCRIPT],
        security_opt: ["no-new-privileges:true"],
      };
    }
  }

  let composeNetworks: Record<string, any>;
  if (!isStrictPrivacy) {
    composeNetworks = { "mediabox-net": { driver: "bridge" } };
  } else {
    composeNetworks = {
      "mediabox-inference-net": { driver: "bridge", internal: true },
      "mediabox-services-net": { driver: "bridge", internal: true },
      ...(privacy === "local-agent-online-media" ? { "mediabox-external-net": { driver: "bridge" } } : {}),
      "mediabox-edge-net": { driver: "bridge" },
      ...(provisionModel ? { "mediabox-provision-net": { driver: "bridge" } } : {}),
    };

    const internal = new Set(
      Object.entries(composeNetworks).filter(([, n]) => n.internal === true).map(([name]) => name),
    );
    for (const service of Object.values(services)) {
      const networks: string[] = service.networks ?? [];
      // Docker gives such a container no published ports; declaring them would
      // describe access that does not exist.
      if (networks.length > 0 && networks.every((n) => internal.has(n))) delete service.ports;
    }
    assertStrictTopology(services, internal);
  }

  const lock = isStrictPrivacy ? opts.artifactLock : undefined;
  const compose = applyLockIfAny({ networks: composeNetworks, services }, lock);

  const header = [
    "###############################################################################",
    "# Mediabox MCP — Docker Compose",
    "# Generated by @mediabox/core",
    ...(!isStrictPrivacy
      ? []
      : lock
        ? [`# Images pinned by digest from ${ARTIFACT_LOCK_FILE} (${lock.platform}, resolved ${lock.resolvedAt}); start with --pull never.`]
        : ["# UNPINNED: images still reference tags. Run `prepare` to write the artifact lock; the deployer refuses to start this file."]),
    "###############################################################################",
    "",
  ].join("\n");

  return header + stringify(compose, { lineWidth: 0 });
}

function applyLockIfAny<T extends { services: Record<string, any> }>(compose: T, lock: ArtifactLock | undefined): T {
  return lock ? applyArtifactLock(compose, lock) : compose;
}
