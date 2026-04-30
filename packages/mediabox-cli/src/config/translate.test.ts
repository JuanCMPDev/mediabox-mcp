import { describe, it, expect } from "vitest";
import { translateWizardAnswers } from "./translate.js";
import type { WizardAnswers } from "../types.js";

function baseAnswers(overrides: Partial<WizardAnswers> = {}): WizardAnswers {
  return {
    deploymentMode: "local",
    timezone: "UTC",
    mediaMovies: "./media/movies",
    mediaTv: "./media/tv",
    mediaAnime: "./media/anime",
    mediaMusic: "./media/music",
    qbitPassword: "qbitpass1",
    mcpPublicUrl: "http://localhost:3000",
    internalApiKey: "deadbeef",
    jellyfinUser: "admin",
    jellyfinPassword: "jfpass",
    enableTelegram: false,
    enableBazarr: false,
    puid: 1000,
    pgid: 1000,
    localBuild: false,
    ...overrides,
  };
}

describe("translateWizardAnswers", () => {
  it("produces a valid local DeployConfig from happy-path answers", () => {
    const cfg = translateWizardAnswers(baseAnswers());
    expect(cfg.deployment.mode).toBe("local");
    expect(cfg.deployment.imageTag).toBe("latest");
    expect(cfg.paths.movies).toBe("./media/movies");
    expect(cfg.services.qbittorrent.password).toBe("qbitpass1");
    expect(cfg.services.pyload).toEqual({ username: "pyload", password: "pyload" });
    expect(cfg.mcp.internalApiKey).toBe("deadbeef");
    expect(cfg.telegram).toBeUndefined();
    expect(cfg.services.bazarr.enabled).toBe(false);
  });

  it("passes through vps fields", () => {
    const cfg = translateWizardAnswers(
      baseAnswers({
        deploymentMode: "vps",
        baseDomain: "m.example.com",
        letsEncryptEmail: "me@example.com",
      }),
    );
    expect(cfg.deployment.mode).toBe("vps");
    expect(cfg.deployment.baseDomain).toBe("m.example.com");
    expect(cfg.deployment.letsEncryptEmail).toBe("me@example.com");
  });

  it("passes through tunnel token", () => {
    const cfg = translateWizardAnswers(
      baseAnswers({
        deploymentMode: "tunnel",
        baseDomain: "m.example.com",
        tunnelToken: "tok",
      }),
    );
    expect(cfg.deployment.tunnelToken).toBe("tok");
  });

  it("builds an openrouter telegram block with model", () => {
    const cfg = translateWizardAnswers(
      baseAnswers({
        enableTelegram: true,
        telegramBotToken: "bt",
        llmProvider: "openrouter",
        llmApiKey: "or-key",
        llmModel: "openai/gpt-4o-mini",
        allowedTelegramUsers: "1,2, 3",
      }),
    );
    expect(cfg.telegram?.llm).toEqual({
      kind: "openrouter",
      apiKey: "or-key",
      model: "openai/gpt-4o-mini",
    });
    expect(cfg.telegram?.allowedUserIds).toEqual([1, 2, 3]);
  });

  it("defaults openrouter model when not provided", () => {
    const cfg = translateWizardAnswers(
      baseAnswers({
        enableTelegram: true,
        telegramBotToken: "bt",
        llmProvider: "openrouter",
        llmApiKey: "k",
      }),
    );
    expect(cfg.telegram?.llm).toMatchObject({
      kind: "openrouter",
      model: "openai/gpt-4o",
    });
  });

  it("builds a google telegram block", () => {
    const cfg = translateWizardAnswers(
      baseAnswers({
        enableTelegram: true,
        telegramBotToken: "bt",
        llmProvider: "google",
        llmApiKey: "g-key",
      }),
    );
    expect(cfg.telegram?.llm).toEqual({ kind: "google", apiKey: "g-key" });
  });

  it("treats empty allowed-users string as all-allowed (empty array)", () => {
    const cfg = translateWizardAnswers(
      baseAnswers({
        enableTelegram: true,
        telegramBotToken: "bt",
        llmProvider: "openrouter",
        llmApiKey: "k",
        allowedTelegramUsers: "",
      }),
    );
    expect(cfg.telegram?.allowedUserIds).toEqual([]);
  });

  it("drops non-numeric entries from allowed users", () => {
    const cfg = translateWizardAnswers(
      baseAnswers({
        enableTelegram: true,
        telegramBotToken: "bt",
        llmProvider: "openrouter",
        llmApiKey: "k",
        allowedTelegramUsers: "1, not-a-number, 2",
      }),
    );
    expect(cfg.telegram?.allowedUserIds).toEqual([1, 2]);
  });

  it("propagates localBuild and bazarr flags", () => {
    const cfg = translateWizardAnswers(
      baseAnswers({ localBuild: true, enableBazarr: true }),
    );
    expect(cfg.deployment.localBuild).toBe(true);
    expect(cfg.services.bazarr.enabled).toBe(true);
  });
});
