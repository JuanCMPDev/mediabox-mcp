import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

export interface EffectRecord {
  type: "write" | "delete" | "mkdir" | "api_call" | "subprocess";
  target: string;
  payload?: unknown;
  timestamp: number;
}

/**
 * EffectLedger tracks all side-effects (writes, deletes, API mutations)
 * during tests and flags any operation targeting outside allowed test roots.
 */
export class EffectLedger {
  private effects: EffectRecord[] = [];
  private violations: string[] = [];
  private allowedRoots: string[] = [];

  constructor(allowedRoots: string[] = []) {
    this.allowedRoots = allowedRoots.map((r) => path.resolve(r));
  }

  addAllowedRoot(dir: string): void {
    this.allowedRoots.push(path.resolve(dir));
  }

  recordWrite(targetPath: string, payload?: unknown): void {
    const resolved = path.resolve(targetPath);
    this.effects.push({ type: "write", target: resolved, payload, timestamp: Date.now() });
    this.checkPath(resolved, "write");
  }

  recordDelete(targetPath: string): void {
    const resolved = path.resolve(targetPath);
    this.effects.push({ type: "delete", target: resolved, timestamp: Date.now() });
    this.checkPath(resolved, "delete");
  }

  recordApiCall(service: string, endpoint: string, method = "GET", data?: unknown): void {
    this.effects.push({
      type: "api_call",
      target: `${service}:${method} ${endpoint}`,
      payload: data,
      timestamp: Date.now(),
    });
  }

  recordViolation(reason: string): void {
    this.violations.push(reason);
  }

  private checkPath(target: string, action: string): void {
    const isUnderAllowed = this.allowedRoots.some((allowed) => {
      const rel = path.relative(allowed, target);
      return !rel.startsWith("..") && !path.isAbsolute(rel);
    });
    if (!isUnderAllowed) {
      const violation = `Effect ${action} targeted path outside allowed root: ${target}`;
      this.violations.push(violation);
    }
  }

  getViolations(): string[] {
    return [...this.violations];
  }

  hasViolations(): boolean {
    return this.violations.length > 0;
  }

  assertClean(): void {
    if (this.hasViolations()) {
      throw new Error(`Ledger detected unexpected effects/violations:\n${this.violations.join("\n")}`);
    }
  }

  getEffects(): EffectRecord[] {
    return [...this.effects];
  }

  clear(): void {
    this.effects = [];
    this.violations = [];
  }
}

/**
 * InjectedClock allows tests to control time deterministically.
 */
export class InjectedClock {
  private currentMs: number;

  constructor(initialMs = 1700000000000) {
    this.currentMs = initialMs;
  }

  now(): number {
    return this.currentMs;
  }

  date(): Date {
    return new Date(this.currentMs);
  }

  advance(ms: number): void {
    if (ms < 0) throw new Error("Cannot advance clock backwards");
    this.currentMs += ms;
  }
}

/**
 * FakeServicesRegistry manages stubs for Jellyfin, Sonarr, Radarr, etc.
 */
export class FakeServicesRegistry {
  private services = new Map<string, Record<string, unknown>>();

  constructor(private ledger: EffectLedger) {}

  registerService(name: string, handlers: Record<string, unknown>): void {
    this.services.set(name, handlers);
  }

  getService(name: string): Record<string, unknown> | undefined {
    return this.services.get(name);
  }

  async call(service: string, endpoint: string, method = "GET", data?: unknown): Promise<unknown> {
    this.ledger.recordApiCall(service, endpoint, method, data);
    const s = this.services.get(service);
    if (!s) return { ok: true, mocked: true };
    const handler = s[`${method} ${endpoint}`] ?? s[endpoint];
    if (typeof handler === "function") {
      return handler(data);
    }
    return handler ?? { ok: true, mocked: true };
  }
}

export interface TestInstallationOptions {
  prefix?: string;
  env?: Record<string, string>;
  initialTime?: number;
}

/**
 * TestInstallation provides a hermetic sandbox for tests:
 * - mkdtemp-based root with random secret marker
 * - Injected clock
 * - Effect ledger to capture all disk/api mutations
 * - Stubs for media services
 * - Safety-hardened teardown that refuses to delete if marker or symlink check fails
 */
export class TestInstallation {
  readonly rootDir: string;
  readonly markerPath: string;
  readonly markerSecret: string;
  readonly ledger: EffectLedger;
  readonly clock: InjectedClock;
  readonly fakeServices: FakeServicesRegistry;
  readonly env: Record<string, string>;
  private tornDown = false;

  private constructor(
    rootDir: string,
    markerPath: string,
    markerSecret: string,
    ledger: EffectLedger,
    clock: InjectedClock,
    env: Record<string, string>
  ) {
    this.rootDir = rootDir;
    this.markerPath = markerPath;
    this.markerSecret = markerSecret;
    this.ledger = ledger;
    this.clock = clock;
    this.env = env;
    this.fakeServices = new FakeServicesRegistry(ledger);
  }

  static async create(options: TestInstallationOptions = {}): Promise<TestInstallation> {
    const tmpBase = os.tmpdir();
    const prefix = options.prefix ?? "mediabox-test-";
    const rootDir = await fs.promises.mkdtemp(path.join(tmpBase, prefix));
    const markerSecret = crypto.randomUUID();
    const markerPath = path.join(rootDir, `.mediabox-test-marker-${markerSecret}`);
    await fs.promises.writeFile(markerPath, markerSecret, "utf8");

    const ledger = new EffectLedger([rootDir]);
    const clock = new InjectedClock(options.initialTime ?? 1700000000000);

    // Clean test env: does NOT inherit user's .env
    const testEnv: Record<string, string> = {
      NODE_ENV: "test",
      MEDIABOX_TEST_ROOT: rootDir,
      MEDIABOX_TEST_MARKER: markerSecret,
      ...options.env,
    };

    return new TestInstallation(rootDir, markerPath, markerSecret, ledger, clock, testEnv);
  }

  /**
   * Resolves a path strictly within rootDir.
   */
  resolvePath(...segments: string[]): string {
    const full = path.resolve(this.rootDir, ...segments);
    const rel = path.relative(this.rootDir, full);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      this.ledger.recordViolation(`Path escaped rootDir: ${full}`);
      throw new Error(`Path escaped TestInstallation root: ${full}`);
    }
    return full;
  }

  /**
   * Safely writes a file inside rootDir, tracking it in the ledger.
   */
  async writeFile(subpath: string, content: string | Buffer): Promise<string> {
    const target = this.resolvePath(subpath);
    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    await fs.promises.writeFile(target, content);
    this.ledger.recordWrite(target);
    return target;
  }

  /**
   * Safely deletes a file or directory inside rootDir, tracking it in the ledger.
   */
  async deleteFile(subpath: string): Promise<void> {
    const target = this.resolvePath(subpath);
    await fs.promises.rm(target, { recursive: true, force: true });
    this.ledger.recordDelete(target);
  }

  /**
   * Teardown safety checks:
   * 1. Must be absolute path.
   * 2. Must not be a symbolic link.
   * 3. Must contain the valid marker file with matching secret.
   * If any check fails, teardown throws and refuses to delete anything.
   */
  async teardown(): Promise<void> {
    if (this.tornDown) return;

    if (!path.isAbsolute(this.rootDir)) {
      throw new Error(`Teardown aborted: rootDir is not absolute: ${this.rootDir}`);
    }

    const stat = await fs.promises.lstat(this.rootDir).catch(() => null);
    if (!stat) {
      this.tornDown = true;
      return;
    }

    if (stat.isSymbolicLink()) {
      throw new Error(`Teardown aborted: rootDir is a symbolic link: ${this.rootDir}`);
    }

    let markerContent: string | null = null;
    try {
      markerContent = await fs.promises.readFile(this.markerPath, "utf8");
    } catch {
      throw new Error(`Teardown aborted: marker file missing or unreadable: ${this.markerPath}`);
    }

    if (markerContent.trim() !== this.markerSecret) {
      throw new Error(`Teardown aborted: marker secret mismatch in ${this.markerPath}`);
    }

    await fs.promises.rm(this.rootDir, { recursive: true, force: true });
    this.tornDown = true;
  }
}
