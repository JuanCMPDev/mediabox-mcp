import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { parse } from "yaml";
import { EDGE_IMAGE, generateDockerCompose } from "./docker-compose.js";
import { baseConfig } from "../config/fixtures.js";
import {
  findUnpinnedImages,
  imageRefsFromCompose,
  imageRepository,
  lockedImage,
  type ArtifactLock,
} from "../artifacts/lock.js";

describe("generateDockerCompose", () => {
  it("generates valid YAML with expected top-level keys", () => {
    const yaml = generateDockerCompose(baseConfig());
    const parsed = parse(yaml) as Record<string, unknown>;
    expect(parsed).toHaveProperty("services");
    expect(parsed).toHaveProperty("networks");
  });

  it("includes the core services for a local deployment", () => {
    const parsed = parse(generateDockerCompose(baseConfig())) as {
      services: Record<string, unknown>;
    };
    expect(Object.keys(parsed.services).sort()).toEqual(
      [
        "jellyfin",
        "mcp-server",
        "pyload",
        "qbittorrent",
        "flaresolverr",
        "prowlarr",
        "radarr",
        "sonarr",
      ].sort(),
    );
  });

  it("exposes ports publicly in local mode", () => {
    const parsed = parse(generateDockerCompose(baseConfig())) as any;
    expect(parsed.services.jellyfin.ports).toContain("8096:8096");
    // UDP discovery ports present only in local mode
    expect(parsed.services.jellyfin.ports).toContain("7359:7359/udp");
  });

  it("binds ports to 127.0.0.1 in VPS mode and adds caddy", () => {
    const cfg = baseConfig();
    cfg.deployment.mode = "vps";
    cfg.deployment.baseDomain = "mediabox.example.com";
    cfg.deployment.letsEncryptEmail = "me@example.com";
    const parsed = parse(generateDockerCompose(cfg)) as any;
    expect(parsed.services.jellyfin.ports).toContain("127.0.0.1:8096:8096");
    expect(parsed.services.jellyfin.ports).not.toContain("7359:7359/udp");
    expect(parsed.services).toHaveProperty("caddy");
  });

  it("adds cloudflared (and no caddy) in tunnel mode", () => {
    const cfg = baseConfig();
    cfg.deployment.mode = "tunnel";
    cfg.deployment.baseDomain = "mediabox.example.com";
    cfg.deployment.tunnelToken = "tok";
    const parsed = parse(generateDockerCompose(cfg)) as any;
    expect(parsed.services).toHaveProperty("cloudflared");
    expect(parsed.services).not.toHaveProperty("caddy");
    expect(parsed.services.jellyfin.ports).toContain("127.0.0.1:8096:8096");
  });

  it("includes telegram-bot when telegram config is present", () => {
    const cfg = baseConfig();
    cfg.telegram = {
      botToken: "bot",
      llm: { kind: "openrouter", apiKey: "k", model: "m" },
      allowedUserIds: [],
    };
    const parsed = parse(generateDockerCompose(cfg)) as any;
    expect(parsed.services).toHaveProperty("telegram-bot");
    expect(parsed.services["telegram-bot"].environment).toContain(
      "LLM_PROVIDER=openrouter",
    );
  });

  it("omits telegram-bot when telegram is absent", () => {
    const parsed = parse(generateDockerCompose(baseConfig())) as any;
    expect(parsed.services).not.toHaveProperty("telegram-bot");
  });

  it("includes bazarr when enabled", () => {
    const cfg = baseConfig();
    cfg.services.bazarr.enabled = true;
    const parsed = parse(generateDockerCompose(cfg)) as any;
    expect(parsed.services).toHaveProperty("bazarr");
  });

  it("uses a monorepo-root build context for mcp-server when localBuild is true (P0.3)", () => {
    const cfg = baseConfig();
    cfg.deployment.localBuild = true;
    const parsed = parse(generateDockerCompose(cfg)) as any;
    expect(parsed.services["mcp-server"].build).toEqual({
      context: ".",
      dockerfile: "packages/mcp-server/Dockerfile",
    });
    expect(parsed.services["mcp-server"].image).toBeUndefined();
  });

  it("uses a monorepo-root build context for telegram when localBuild is true (P0.3)", () => {
    const cfg = baseConfig();
    cfg.deployment.localBuild = true;
    cfg.telegram = {
      botToken: "bot",
      llm: { kind: "openrouter", apiKey: "k", model: "m" },
      allowedUserIds: [],
    };
    const parsed = parse(generateDockerCompose(cfg)) as any;
    expect(parsed.services["telegram-bot"].build).toEqual({
      context: ".",
      dockerfile: "packages/mcp-telegram-client/Dockerfile",
    });
    expect(parsed.services["telegram-bot"].image).toBeUndefined();
  });

  it("uses a GHCR image (with IMAGE_TAG default) when localBuild is false", () => {
    const parsed = parse(generateDockerCompose(baseConfig())) as any;
    expect(parsed.services["mcp-server"].image).toBe(
      "ghcr.io/juancmpdev/mediabox-mcp:${IMAGE_TAG:-2.2.0-beta.3}",
    );
    expect(parsed.services["mcp-server"].build).toBeUndefined();
  });

  it("renders media paths as ${MOVIES_PATH} env-var refs with the configured value as default", () => {
    const cfg = baseConfig();
    cfg.paths.movies = "media\\movies";
    const parsed = parse(generateDockerCompose(cfg)) as any;
    // PR 3.4a: paths are emitted as `${MOVIES_PATH:-./media/movies}` so
    // PATCH /api/setup/env can rewrite the path in `.env` and a recreate
    // picks it up. The default keeps backslashes normalized to POSIX.
    expect(parsed.services.jellyfin.volumes).toContain("${MOVIES_PATH:-./media/movies}:/data/movies");
  });

  it("never emits MCP_AUTH_SECRET (confirmed dead config)", () => {
    const yaml = generateDockerCompose(baseConfig());
    expect(yaml).not.toContain("MCP_AUTH_SECRET");
  });

  it("emits ALLOWED_ORIGINS defaulting to MCP_PUBLIC_URL (P0.2)", () => {
    const parsed = parse(generateDockerCompose(baseConfig())) as any;
    expect(parsed.services["mcp-server"].environment).toContain(
      "ALLOWED_ORIGINS=${ALLOWED_ORIGINS:-${MCP_PUBLIC_URL}}",
    );
  });

  it("binds the mcp-server to 0.0.0.0 inside the container", () => {
    // The server code defaults to 127.0.0.1 for bare host runs; the container
    // must opt into 0.0.0.0 so the published-port mapping can reach it.
    const parsed = parse(generateDockerCompose(baseConfig())) as any;
    expect(parsed.services["mcp-server"].environment).toContain("BIND_HOST=0.0.0.0");
  });
});

describe("generateDockerCompose — agent credential wiring (Blueprint §4.1 / B02)", () => {
  it("passes AGENT_API_KEY and MEDIABOX_INSTALLATION_ID to mcp-server next to INTERNAL_API_KEY", () => {
    const parsed = parse(generateDockerCompose(baseConfig())) as any;
    const env: string[] = parsed.services["mcp-server"].environment;
    expect(env).toContain("INTERNAL_API_KEY=${INTERNAL_API_KEY}");
    expect(env).toContain("AGENT_API_KEY=${AGENT_API_KEY}");
    expect(env).toContain("MEDIABOX_INSTALLATION_ID=${MEDIABOX_INSTALLATION_ID}");
  });

  it("gives the telegram bot the agent credential, never the owner key", () => {
    const cfg = baseConfig();
    cfg.telegram = {
      botToken: "bot",
      llm: { kind: "openrouter", apiKey: "k", model: "m" },
      allowedUserIds: [],
    };
    const parsed = parse(generateDockerCompose(cfg)) as any;
    const env: string[] = parsed.services["telegram-bot"].environment;
    expect(env).toContain("MCP_AGENT_API_KEY=${AGENT_API_KEY}");
    expect(env).not.toContain("MCP_INTERNAL_API_KEY=${INTERNAL_API_KEY}");
    expect(env.some((e) => e.startsWith("MCP_INTERNAL_API_KEY="))).toBe(false);
    expect(env.some((e) => e.includes("${INTERNAL_API_KEY}"))).toBe(false);
  });

  it("wires the agent credential for the google provider variant too", () => {
    const cfg = baseConfig();
    cfg.telegram = {
      botToken: "bot",
      llm: { kind: "google", apiKey: "k" },
      allowedUserIds: [],
    };
    const parsed = parse(generateDockerCompose(cfg)) as any;
    const env: string[] = parsed.services["telegram-bot"].environment;
    expect(env).toContain("MCP_AGENT_API_KEY=${AGENT_API_KEY}");
    expect(env.some((e) => e.includes("INTERNAL_API_KEY"))).toBe(false);
  });

  it("emits inference services with profiles when provider is local", () => {
    const cfg = baseConfig();
    cfg.ai = {
      kind: "local",
      runtime: "ollama",
      baseUrl: "http://127.0.0.1:11434",
      model: "qwen2.5:7b",
      contextTokens: 8192,
      backend: "rocm",
    };
    const parsed = parse(generateDockerCompose(cfg)) as any;
    expect(parsed.services).toHaveProperty("inference-cuda");
    expect(parsed.services).toHaveProperty("inference-rocm");
    expect(parsed.services).toHaveProperty("inference-vulkan");
    expect(parsed.services).toHaveProperty("inference-cpu");

    expect(parsed.services["inference-rocm"].profiles).toEqual(["inference-rocm"]);
    expect(parsed.services["inference-rocm"].environment).toContain("OLLAMA_NO_CLOUD=1");
    expect(parsed.services["inference-rocm"].environment).toContain("OLLAMA_CONTEXT_LENGTH=${LOCAL_LLM_CONTEXT_TOKENS:-8192}");
    expect(parsed.services["inference-rocm"].devices).toEqual(["/dev/kfd", "/dev/dri"]);

    expect(parsed.services["inference-cuda"].profiles).toEqual(["inference-cuda"]);
    expect(parsed.services["inference-cuda"].deploy.resources.reservations.devices[0].driver).toBe("nvidia");
  });
});

describe("local inference reachability inside the compose network (§3.2 / B4)", () => {
  const localConfig: any = {
    ...baseConfig(),
    ai: {
      kind: "local",
      runtime: "ollama",
      baseUrl: "http://127.0.0.1:11434",
      model: "qwen2.5:7b",
      contextTokens: 8192,
      backend: "rocm",
    },
  };

  it("rewrites a loopback endpoint to the inference service and allow-lists it", () => {
    const yaml = generateDockerCompose(localConfig);
    expect(yaml).toContain("LOCAL_LLM_BASE_URL=${LOCAL_LLM_BASE_URL_CONTAINER:-http://mediabox-inference:11434}");
    expect(yaml).toContain("INFERENCE_ALLOW_LAN=${INFERENCE_ALLOW_LAN:-true}");
    expect(yaml).toContain("INFERENCE_ENDPOINT_HOSTS=${INFERENCE_ENDPOINT_HOSTS:-mediabox-inference}");
  });

  it("leaves a non-loopback endpoint exactly as configured", () => {
    const yaml = generateDockerCompose({
      ...localConfig,
      ai: { ...localConfig.ai, baseUrl: "http://inference.lan:11434", allowLan: true, endpointHosts: ["inference.lan"] },
    });
    expect(yaml).toContain("LOCAL_LLM_BASE_URL=${LOCAL_LLM_BASE_URL_CONTAINER:-http://inference.lan:11434}");
    expect(yaml).toContain("INFERENCE_ENDPOINT_HOSTS=${INFERENCE_ENDPOINT_HOSTS:-inference.lan}");
  });

  it("gives the vulkan profile a model, a context size and a tools template", () => {
    const yaml = generateDockerCompose(localConfig);
    expect(yaml).toContain("inference-vulkan");
    expect(yaml).toContain("--jinja");
    expect(yaml).toContain("--ctx-size");
    expect(yaml).toMatch(/-hf/);
  });

  it("keeps one inference profile per backend, each with its own device requirements", () => {
    const yaml = generateDockerCompose(localConfig);
    for (const profile of ["inference-cuda", "inference-rocm", "inference-vulkan", "inference-cpu"]) {
      expect(yaml).toContain(profile);
    }
    expect(yaml).toContain("/dev/kfd");
    expect(yaml).toContain("OLLAMA_NO_CLOUD=1");
  });
});

describe("PrivacyProfile network isolation in docker-compose (§3.1 / NET-01, NET-06)", () => {
  it("offline-library uses internal-only networks, isolates mcp-server and inference, and omits telegram", () => {
    const cfg = baseConfig();
    cfg.deployment.privacyProfile = "offline-library";
    cfg.telegram = {
      botToken: "tok",
      llm: { kind: "local", runtime: "ollama", baseUrl: "http://127.0.0.1:11434", model: "qwen2.5:7b" },
      allowedUserIds: [],
    };
    cfg.ai = { kind: "local", runtime: "ollama", baseUrl: "http://127.0.0.1:11434", model: "qwen2.5:7b" };

    const parsed = parse(generateDockerCompose(cfg)) as any;

    // Internal only networks
    expect(parsed.networks["mediabox-inference-net"]).toEqual({ driver: "bridge", internal: true });
    expect(parsed.networks["mediabox-services-net"]).toEqual({ driver: "bridge", internal: true });
    expect(parsed.networks["mediabox-external-net"]).toBeUndefined();

    // mcp-server on internal networks only
    expect(parsed.services["mcp-server"].networks).toEqual([
      "mediabox-inference-net",
      "mediabox-services-net",
    ]);
    expect(parsed.services["mcp-server"].environment).toContain("PRIVACY_PROFILE=offline-library");

    // mcp-server has NO docker socket mounted
    const volumes = parsed.services["mcp-server"].volumes.join(" ");
    expect(volumes).not.toContain("docker.sock");

    // Telegram bot is disabled/omitted in offline-library
    expect(parsed.services["telegram-bot"]).toBeUndefined();

    // Inference services on internal inference network only
    expect(parsed.services["inference-cuda"].networks).toEqual(["mediabox-inference-net"]);
  });

  it("local-agent-online-media keeps mcp-server and inference internal, but gives media services external egress", () => {
    const cfg = baseConfig();
    cfg.deployment.privacyProfile = "local-agent-online-media";
    cfg.ai = { kind: "local", runtime: "ollama", baseUrl: "http://127.0.0.1:11434", model: "qwen2.5:7b" };

    const parsed = parse(generateDockerCompose(cfg)) as any;

    // Both internal networks and external network
    expect(parsed.networks["mediabox-inference-net"]).toEqual({ driver: "bridge", internal: true });
    expect(parsed.networks["mediabox-services-net"]).toEqual({ driver: "bridge", internal: true });
    expect(parsed.networks["mediabox-external-net"]).toEqual({ driver: "bridge" });

    // mcp-server is NEVER connected to mediabox-external-net
    expect(parsed.services["mcp-server"].networks).toEqual([
      "mediabox-inference-net",
      "mediabox-services-net",
    ]);

    // Inference is NEVER connected to mediabox-external-net
    expect(parsed.services["inference-cuda"].networks).toEqual(["mediabox-inference-net"]);

    // Downloaders are connected to both services and external
    expect(parsed.services.qbittorrent.networks).toEqual([
      "mediabox-services-net",
      "mediabox-external-net",
    ]);
    expect(parsed.services.pyload.networks).toEqual([
      "mediabox-services-net",
      "mediabox-external-net",
    ]);
  });
});

describe("strict profiles: owner edge, honest ports and provisioning (§3.1–§3.3)", () => {
  const PROFILES = ["offline-library", "local-agent-online-media"] as const;
  type Profile = (typeof PROFILES)[number];

  /** Well-formed but synthetic digest: sha256 of a label, never a real artifact. */
  const digest = (label: string) => `sha256:${createHash("sha256").update(label).digest("hex")}`;

  function strictConfig(profile: Profile) {
    const cfg = baseConfig();
    cfg.deployment.privacyProfile = profile;
    cfg.ai = { kind: "local", runtime: "ollama", baseUrl: "http://127.0.0.1:11434", model: "qwen2.5:7b" };
    return cfg;
  }

  function strictCompose(profile: Profile): any {
    return parse(generateDockerCompose(strictConfig(profile)));
  }

  function internalNetworks(parsed: any): Set<string> {
    return new Set(
      Object.entries(parsed.networks as Record<string, any>)
        .filter(([, n]) => n.internal === true)
        .map(([name]) => name),
    );
  }

  function lockFor(yaml: string): ArtifactLock {
    const lock: ArtifactLock = {
      schemaVersion: 1,
      resolvedAt: "2026-09-11T00:00:00.000Z",
      platform: "linux/amd64",
      images: {},
      models: {},
    };
    for (const ref of imageRefsFromCompose(yaml)) {
      lock.images[ref] = lockedImage(ref, { indexDigest: digest(`${ref}#index`), platformDigest: digest(ref) }, "linux/amd64");
    }
    return lock;
  }

  it.each(PROFILES)("%s: publishes the owner UI/API and Jellyfin through a hardened fixed-forwarder edge", (profile) => {
    const parsed = strictCompose(profile);
    const edge = parsed.services["mediabox-edge"];

    expect(edge.image).toBe(EDGE_IMAGE);
    expect(edge.container_name).toBe("mediabox-edge");
    expect(edge.networks).toEqual(["mediabox-edge-net", "mediabox-services-net"]);
    expect(parsed.networks["mediabox-edge-net"]).toEqual({ driver: "bridge" });
    expect(edge.ports).toEqual(["3000:3000", "8096:8096", "8920:8920"]);
    expect(edge.entrypoint).toEqual(["sh", "-c"]);
    expect(edge.command).toEqual([
      "socat TCP-LISTEN:3000,fork,reuseaddr TCP:mcp-server:3000 & p0=$$!; " +
        "socat TCP-LISTEN:8096,fork,reuseaddr TCP:jellyfin:8096 & p1=$$!; " +
        "socat TCP-LISTEN:8920,fork,reuseaddr TCP:jellyfin:8920 & p2=$$!; " +
        "while kill -0 $$p0 && kill -0 $$p1 && kill -0 $$p2; do sleep 2; done; exit 1",
    ]);
    // Shell variables are escaped for compose; nothing else is interpolated.
    expect(edge.command[0].replace(/\$\$/g, "")).not.toContain("$");
    expect(edge.read_only).toBe(true);
    expect(edge.cap_drop).toEqual(["ALL"]);
    expect(edge.security_opt).toEqual(["no-new-privileges:true"]);
    expect(edge.restart).toBe("unless-stopped");
    expect(edge.user).toBe("65534:65534");
    expect(edge.volumes).toBeUndefined();
    expect(edge.environment).toBeUndefined();
  });

  it("binds the edge to loopback when the mode binds locally", () => {
    const cfg = strictConfig("local-agent-online-media");
    cfg.deployment.mode = "tunnel";
    cfg.deployment.baseDomain = "mediabox.example.com";
    cfg.deployment.tunnelToken = "tok";
    const parsed = parse(generateDockerCompose(cfg)) as any;
    expect(parsed.services["mediabox-edge"].ports).toEqual([
      "127.0.0.1:3000:3000",
      "127.0.0.1:8096:8096",
      "127.0.0.1:8920:8920",
    ]);
  });

  it.each(PROFILES)("%s: no service whose networks are all internal declares ports", (profile) => {
    const parsed = strictCompose(profile);
    const internal = internalNetworks(parsed);
    for (const [name, service] of Object.entries(parsed.services as Record<string, any>)) {
      if ((service.networks as string[]).every((n) => internal.has(n))) {
        expect(service.ports, name).toBeUndefined();
      }
    }
  });

  it("offline-library: only the edge publishes ports", () => {
    const parsed = strictCompose("offline-library");
    const publishing = Object.entries(parsed.services as Record<string, any>)
      .filter(([, s]) => s.ports)
      .map(([name]) => name);
    expect(publishing).toEqual(["mediabox-edge"]);
  });

  it("local-agent-online-media: bridged services keep their ports, Jellyfin's 8096/8920 move to the edge", () => {
    const parsed = strictCompose("local-agent-online-media");
    expect(parsed.services.qbittorrent.ports).toEqual(["8085:8085", "6881:6881", "6881:6881/udp"]);
    expect(parsed.services.prowlarr.ports).toEqual(["9696:9696"]);
    expect(parsed.services.jellyfin.ports).toEqual(["7359:7359/udp", "1900:1900/udp"]);

    const owners = new Map<string, string[]>();
    for (const [name, service] of Object.entries(parsed.services as Record<string, any>)) {
      for (const mapping of service.ports ?? []) {
        const hostPort = String(mapping).replace(/\/(tcp|udp)$/, "").split(":").slice(-2)[0];
        if (["3000", "8096", "8920"].includes(hostPort)) owners.set(hostPort, [...(owners.get(hostPort) ?? []), name]);
      }
    }
    expect(Object.fromEntries(owners)).toEqual({
      "3000": ["mediabox-edge"],
      "8096": ["mediabox-edge"],
      "8920": ["mediabox-edge"],
    });
  });

  it.each(PROFILES)("%s: mcp-server and inference only ever join internal networks", (profile) => {
    const parsed = strictCompose(profile);
    const internal = internalNetworks(parsed);
    const confined = Object.entries(parsed.services as Record<string, any>).filter(
      ([name, s]) => name === "mcp-server" || s.container_name === "mediabox-inference",
    );
    expect(confined.map(([name]) => name).sort()).toEqual(
      ["inference-cpu", "inference-cuda", "inference-rocm", "inference-vulkan", "mcp-server"],
    );
    for (const [name, service] of confined) {
      for (const network of service.networks) {
        expect(internal.has(network), `${name} on ${network}`).toBe(true);
      }
      expect(service.networks).not.toContain("mediabox-edge-net");
      expect(service.networks).not.toContain("mediabox-external-net");
      expect(service.networks).not.toContain("mediabox-provision-net");
      expect(service.ports, name).toBeUndefined();
    }
  });

  it.each(PROFILES)("%s: the provisioner runs only under the provision profile, on its own bridge", (profile) => {
    const parsed = strictCompose(profile);
    const provisioner = parsed.services["mediabox-provisioner"];

    expect(provisioner.image).toBe("ollama/ollama:latest");
    expect(provisioner.profiles).toEqual(["provision"]);
    expect(provisioner.networks).toEqual(["mediabox-provision-net"]);
    expect(parsed.networks["mediabox-provision-net"]).toEqual({ driver: "bridge" });
    expect(provisioner.volumes).toEqual(["./config/ollama:/root/.ollama"]);
    expect(provisioner.environment).toEqual(["OLLAMA_NO_CLOUD=1", "LOCAL_LLM_MODEL=${LOCAL_LLM_MODEL:-qwen2.5:7b}"]);
    expect(provisioner.entrypoint).toEqual(["/bin/bash", "-c"]);
    expect(provisioner.ports).toBeUndefined();

    const script: string = provisioner.command[0];
    expect(script).toContain('ollama pull "$$model"');
    expect(script).toContain("/api/tags");
    expect(script).toContain('echo "MEDIABOX_MODEL_DIGEST $$name sha256:$$digest"');
    // Every shell `$` is escaped for compose, so compose never interpolates the script.
    expect(script.replace(/\$\$/g, "")).not.toContain("$");

    const others = Object.entries(parsed.services as Record<string, any>).filter(([name]) => name !== "mediabox-provisioner");
    for (const [name, service] of others) {
      expect(service.networks, name).not.toContain("mediabox-provision-net");
      expect(service.profiles ?? [], name).not.toContain("provision");
    }
  });

  it("emits no edge, provisioner or new networks without a privacy profile", () => {
    const cfg = baseConfig();
    cfg.ai = { kind: "local", runtime: "ollama", baseUrl: "http://127.0.0.1:11434", model: "qwen2.5:7b" };
    const parsed = parse(generateDockerCompose(cfg)) as any;
    expect(parsed.services["mediabox-edge"]).toBeUndefined();
    expect(parsed.services["mediabox-provisioner"]).toBeUndefined();
    expect(Object.keys(parsed.networks)).toEqual(["mediabox-net"]);
    expect(parsed.services["mcp-server"].ports).toEqual(["3000:3000"]);
    expect(parsed.services["mcp-server"].environment.some((e: string) => e.startsWith("LOCAL_LLM_MODEL_DIGEST="))).toBe(false);
  });

  it("a strict profile without a local AI still gets the edge but no provisioner", () => {
    const cfg = baseConfig();
    cfg.deployment.privacyProfile = "offline-library";
    const parsed = parse(generateDockerCompose(cfg)) as any;
    expect(parsed.services["mediabox-edge"]).toBeDefined();
    expect(parsed.services["mediabox-provisioner"]).toBeUndefined();
    expect(parsed.networks["mediabox-provision-net"]).toBeUndefined();
  });

  it.each(PROFILES)("%s: llama.cpp loads a local GGUF read-only instead of downloading with -hf", (profile) => {
    const vulkan = strictCompose(profile).services["inference-vulkan"];
    expect(vulkan.command).toContain("-m");
    expect(vulkan.command).toContain("/models/${LOCAL_LLM_MODEL_FILE:-}");
    expect(vulkan.command).not.toContain("-hf");
    expect(vulkan.volumes).toEqual(["./config/llamacpp:/models:ro"]);
  });

  it.each(PROFILES)("%s: mcp-server receives the pinned model digest variable", (profile) => {
    expect(strictCompose(profile).services["mcp-server"].environment).toContain(
      "LOCAL_LLM_MODEL_DIGEST=${LOCAL_LLM_MODEL_DIGEST:-}",
    );
  });

  it("says in the header that an unlocked strict file is unpinned", () => {
    const yaml = generateDockerCompose(strictConfig("offline-library"));
    expect(yaml.split("\n")[3]).toMatch(/^# UNPINNED: images still reference tags\. Run `prepare`/);
    expect(generateDockerCompose(baseConfig())).not.toContain("UNPINNED");
  });

  it.each(PROFILES)("%s: an artifact lock pins every image by digest with pull_policy: never", (profile) => {
    const cfg = strictConfig(profile);
    const unpinnedYaml = generateDockerCompose(cfg);
    const refs = imageRefsFromCompose(unpinnedYaml);
    expect(refs).toContain(EDGE_IMAGE);
    expect(refs).toContain("ollama/ollama:latest");
    expect(refs).toContain("ghcr.io/juancmpdev/mediabox-mcp:2.2.0-beta.3");

    const pinnedYaml = generateDockerCompose(cfg, { artifactLock: lockFor(unpinnedYaml) });
    const pinned = parse(pinnedYaml) as any;
    const unpinned = parse(unpinnedYaml) as any;

    for (const [name, service] of Object.entries(pinned.services as Record<string, any>)) {
      const original = unpinned.services[name].image.replace("${IMAGE_TAG:-2.2.0-beta.3}", "2.2.0-beta.3");
      expect(service.image, name).toBe(`${imageRepository(original)}@${digest(original)}`);
      expect(service.pull_policy, name).toBe("never");
    }
    expect(findUnpinnedImages(pinnedYaml)).toEqual([]);
    expect(pinnedYaml).toContain("# Images pinned by digest from artifacts.lock.json (linux/amd64, resolved 2026-09-11T00:00:00.000Z)");
    expect(pinnedYaml).not.toContain("UNPINNED");
  });

  it("refuses a lock that misses an image", () => {
    const cfg = strictConfig("offline-library");
    const lock = lockFor(generateDockerCompose(cfg));
    delete lock.images[EDGE_IMAGE];
    expect(() => generateDockerCompose(cfg, { artifactLock: lock })).toThrow(
      /ERR_ARTIFACT_UNPINNED.*mediabox-edge \(alpine\/socat:1\.8\.0\.3\)/,
    );
  });

  it("ignores an artifact lock without a privacy profile (legacy output unchanged)", () => {
    const cfg = baseConfig();
    const lock = lockFor(generateDockerCompose(cfg));
    expect(generateDockerCompose(cfg, { artifactLock: lock })).toBe(generateDockerCompose(cfg));
  });
});
