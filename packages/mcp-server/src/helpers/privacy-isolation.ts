/* ─── Privacy isolation self-check (§3.1) ─────────────────────────────────────
 * A strict profile is only reported as contained when this process can see
 * that its network namespace has no default route (Docker internal networks
 * have none). A native process — Desktop sidecar, bare Node — cannot prove
 * containment from localhost alone, so it reports `unverified-native`.
 * This is an observation for diagnostics, not the G09 egress oracle.
 * ──────────────────────────────────────────────────────────────────────── */
import { readFileSync } from "node:fs";

export type PrivacyIsolation = "no-default-route" | "default-route-present" | "unverified-native";

/** /proc/net/route: destination column 00000000 with mask 00000000 is the default route. */
export function hasIpv4DefaultRoute(procNetRoute: string): boolean {
  return procNetRoute
    .split("\n")
    .slice(1)
    .map((line) => line.trim().split(/\s+/))
    .some((cols) => cols.length >= 8 && cols[1] === "00000000" && cols[7] === "00000000");
}

/** /proc/net/ipv6_route: a ::/0 entry that is not the unreachable loopback placeholder. */
export function hasIpv6DefaultRoute(procNetIpv6Route: string): boolean {
  return procNetIpv6Route
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .some((cols) => {
      if (cols.length < 10) return false;
      const isDefault = cols[0] === "00000000000000000000000000000000" && cols[1] === "00";
      const device = cols[9];
      const flags = parseInt(cols[8], 16);
      const RTF_REJECT = 0x0200;
      return isDefault && device !== "lo" && (flags & RTF_REJECT) === 0;
    });
}

export function detectPrivacyIsolation(
  platform: NodeJS.Platform = process.platform,
  read: (path: string) => string = (p) => readFileSync(p, "utf8"),
): PrivacyIsolation {
  if (platform !== "linux") return "unverified-native";
  try {
    const v4 = hasIpv4DefaultRoute(read("/proc/net/route"));
    let v6 = false;
    try {
      v6 = hasIpv6DefaultRoute(read("/proc/net/ipv6_route"));
    } catch {
      // IPv6 disabled in this namespace: nothing to route.
    }
    return v4 || v6 ? "default-route-present" : "no-default-route";
  } catch {
    return "unverified-native";
  }
}
