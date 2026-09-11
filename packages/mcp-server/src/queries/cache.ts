import { createHash } from "node:crypto";

export interface CacheEntry<T> {
  value: T;
  installationId: string;
  principalId: string;
  expiresAt: number;
  tags: string[];
}

export const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

export class QueryCache {
  private store = new Map<string, CacheEntry<any>>();

  static hashArgs(args: unknown): string {
    const json = JSON.stringify(args, Object.keys(args as object || {}).sort());
    return createHash("sha256").update(json || "").digest("hex").slice(0, 16);
  }

  static buildKey(
    queryType: string,
    args: Record<string, unknown>,
    context: { installationId: string; roleOrPermission: string }
  ): string {
    const argsHash = QueryCache.hashArgs(args);
    return `inst:${context.installationId}:role:${context.roleOrPermission}:${queryType}:${argsHash}`;
  }

  get<T>(key: string, context: { installationId: string; principalId: string }): T | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;

    // Check expiration
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return undefined;
    }

    // Verify tenant and identity isolation (QRY-05)
    if (entry.installationId !== context.installationId || entry.principalId !== context.principalId) {
      return undefined;
    }

    return entry.value as T;
  }

  set<T>(
    key: string,
    value: T,
    context: { installationId: string; principalId: string },
    ttlMs: number = DEFAULT_CACHE_TTL_MS,
    tags: string[] = []
  ): void {
    const entry: CacheEntry<T> = {
      value,
      installationId: context.installationId,
      principalId: context.principalId,
      expiresAt: Date.now() + ttlMs,
      tags,
    };
    this.store.set(key, entry);
  }

  invalidateTags(tags: string[], installationId?: string): number {
    let count = 0;
    for (const [key, entry] of this.store.entries()) {
      if (installationId && entry.installationId !== installationId) {
        continue;
      }
      const hasMatchingTag = entry.tags.some((t) => tags.includes(t));
      if (hasMatchingTag) {
        this.store.delete(key);
        count++;
      }
    }
    return count;
  }

  invalidateInstallation(installationId: string): number {
    let count = 0;
    for (const [key, entry] of this.store.entries()) {
      if (entry.installationId === installationId) {
        this.store.delete(key);
        count++;
      }
    }
    return count;
  }

  clear(): void {
    this.store.clear();
  }

  size(): number {
    return this.store.size;
  }
}

export const defaultQueryCache = new QueryCache();
