import type { DataSourceStatus } from "@mediabox/contracts";
import { jfApi, sonarrApi, radarrApi, prowlarrApi } from "../helpers/api.js";
import { qbitApi } from "../helpers/qbittorrent.js";
import { pyloadApiJson } from "../helpers/pyload.js";

export interface ServiceQueryResult<T> {
  data: T | null;
  sourceStatus: DataSourceStatus;
}

function sanitizeErrorMessage(err: unknown): string {
  if (err instanceof Error) {
    // Strip any sensitive query params or auth headers from message
    return err.message.replace(/(key|token|password|auth)=([^&]+)/gi, "$1=[REDACTED]");
  }
  return String(err);
}

export async function safeQueryService<T>(
  serviceName: string,
  fetcher: () => Promise<T>
): Promise<ServiceQueryResult<T>> {
  const observedAt = new Date().toISOString();
  try {
    const data = await fetcher();
    return {
      data,
      sourceStatus: {
        source: serviceName,
        observedAt,
        completeness: "complete",
      },
    };
  } catch (err: any) {
    const message = sanitizeErrorMessage(err);
    return {
      data: null,
      sourceStatus: {
        source: serviceName,
        observedAt,
        completeness: "unavailable",
        error: {
          code: "ERR_UPSTREAM_UNAVAILABLE",
          message,
        },
      },
    };
  }
}

export async function queryJellyfinSafe<T = any>(
  endpoint: string,
  method: string = "GET",
  body?: unknown,
  timeoutMs: number = 15000
): Promise<ServiceQueryResult<T>> {
  return safeQueryService<T>("jellyfin", () => jfApi(endpoint, method, body, timeoutMs));
}

export async function querySonarrSafe<T = any>(
  endpoint: string,
  method: "GET" | "POST" | "PUT" | "DELETE" = "GET",
  body?: unknown,
  timeoutMs: number = 15000
): Promise<ServiceQueryResult<T>> {
  return safeQueryService<T>("sonarr", () => sonarrApi(epNormalized(endpoint), method, body, timeoutMs));
}

export async function queryRadarrSafe<T = any>(
  endpoint: string,
  method: "GET" | "POST" | "PUT" | "DELETE" = "GET",
  body?: unknown,
  timeoutMs: number = 15000
): Promise<ServiceQueryResult<T>> {
  return safeQueryService<T>("radarr", () => radarrApi(epNormalized(endpoint), method, body, timeoutMs));
}

export async function queryProwlarrSafe<T = any>(
  endpoint: string,
  method: "GET" | "POST" = "GET",
  body?: unknown,
  timeoutMs: number = 15000
): Promise<ServiceQueryResult<T>> {
  return safeQueryService<T>("prowlarr", () => prowlarrApi(epNormalized(endpoint), method, body, timeoutMs));
}

export async function queryQbitSafe<T = any>(
  endpoint: string,
  method: "GET" | "POST" = "GET",
  params?: Record<string, string>
): Promise<ServiceQueryResult<T>> {
  return safeQueryService<T>("qbittorrent", () => qbitApi(endpoint, method, params));
}

export async function queryPyloadSafe<T = any>(
  methodName: string,
  args: Record<string, any> = {}
): Promise<ServiceQueryResult<T>> {
  return safeQueryService<T>("pyload", () => pyloadApiJson(methodName, args));
}

function epNormalized(ep: string): string {
  return ep.startsWith("/") ? ep.slice(1) : ep;
}
