/* ─── Owner-facing surfaces never echo secrets (NET-05 findings) ─────────────
 * URLs shown to the owner drop embedded credentials, and dashboard errors
 * carry the service and status only, not the upstream body.
 * ──────────────────────────────────────────────────────────────────────── */
import { describe, it, expect } from "vitest";
import { stripUrlCredentials, toHostUrl } from "../fetchers/utils.js";
import { publicError } from "./dashboard.js";

describe("stripUrlCredentials / toHostUrl", () => {
  it("drops user and password of any scheme, keeping host, port and path", () => {
    expect(stripUrlCredentials("http://admin:p%40ss%2Fw%C3%B6rd@qbittorrent:8085")).toBe("http://qbittorrent:8085");
    expect(stripUrlCredentials("http://token@jellyfin:8096/web/")).toBe("http://jellyfin:8096/web/");
    expect(stripUrlCredentials("http://sonarr:8989")).toBe("http://sonarr:8989");
    expect(toHostUrl("http://u:secret-canary@radarr:7878")).toBe("http://localhost:7878");
  });
});

describe("publicError", () => {
  it("keeps only the service and status of an upstream failure", () => {
    const err = new Error('Jellyfin API 500: {"message":"token=canary-5f5f; retry at http://u:pw@exfil.example/?k=canary-5f5f"}');
    expect(publicError(err)).toBe("Jellyfin API 500");
    expect(publicError(new Error("Sonarr 401: Unauthorized apikey=abc"))).toBe("Sonarr 401");
  });

  it("sanitizes other messages and keeps only their first line", () => {
    const out = publicError(new Error("connect ECONNREFUSED http://user:hunter2@10.0.0.2:8085/api?token=abc\nstack line"));
    expect(out).not.toContain("hunter2");
    expect(out).not.toContain("token=abc");
    expect(out).not.toContain("stack line");
  });
});
