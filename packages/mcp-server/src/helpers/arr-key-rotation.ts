/* ─── *arr API key rotation ────────────────────────────────────────────────
 * Rotates the ApiKey stored in `config/<service>/config.xml` for Sonarr,
 * Radarr or Prowlarr. The container has to be stopped during the edit,
 * otherwise it would write its in-memory state on shutdown and clobber our
 * change.
 *
 * Sequence (each step bubbles up an ArrKeyRotationError on failure):
 *   1. Read config.xml — fail fast if missing or no <ApiKey> element.
 *   2. `docker compose stop <svc>`
 *   3. Replace <ApiKey> in config.xml with a fresh 32-hex key.
 *   4. Patch the stack .env so the sidecar's dashboard handlers learn the
 *      new key on their next process restart.
 *   5. `docker compose start <svc>`
 *
 * If step 3 or 4 fails, we still attempt step 5 so the container isn't left
 * in a stopped state — but the original error still surfaces to the caller.
 * ──────────────────────────────────────────────────────────────────────── */
import { readFile, writeFile } from "node:fs/promises";
import { randomBytes }         from "node:crypto";
import path                    from "node:path";
import { execa }               from "execa";
import { stackDir, patchEnvFile } from "./stack-env.js";

export const ARR_SERVICES = ["sonarr", "radarr", "prowlarr"] as const;
export type  ArrService    = typeof ARR_SERVICES[number];

export type RotationStage = "preflight" | "stop" | "edit" | "start";

export class ArrKeyRotationError extends Error {
  public readonly stage: RotationStage;
  constructor(message: string, stage: RotationStage) {
    super(message);
    this.stage = stage;
    this.name  = "ArrKeyRotationError";
  }
}

const API_KEY_RE = /<ApiKey>[^<]*<\/ApiKey>/;

export async function rotateArrApiKey(service: ArrService, t: (key: string, opts?: any) => string): Promise<{ apiKey: string }> {
  const cwd = stackDir();
  if (!cwd) {
    throw new ArrKeyRotationError(t("regen.stackUnavailable"), "preflight");
  }

  const xmlPath = path.join(cwd, "config", service, "config.xml");
  const envKey  = `${service.toUpperCase()}_API_KEY`;

  // 1. Read config.xml + verify <ApiKey> presence.
  let xml: string;
  try {
    xml = await readFile(xmlPath, "utf-8");
  } catch (err) {
    throw new ArrKeyRotationError(
      t("regen.configNotFound", { path: xmlPath, message: err instanceof Error ? err.message : String(err) }),
      "preflight",
    );
  }
  if (!API_KEY_RE.test(xml)) {
    throw new ArrKeyRotationError(t("regen.noApiKeyElement", { path: xmlPath }), "preflight");
  }

  const newKey = randomBytes(16).toString("hex");

  // 2. Stop container.
  await runCompose(cwd, ["stop", service], "stop", t);

  // 3-4. Edit config.xml + .env. On failure, attempt to start the container
  //      back up so it isn't left stopped — but propagate the original error.
  try {
    const updated = xml.replace(API_KEY_RE, `<ApiKey>${newKey}</ApiKey>`);
    await writeFile(xmlPath, updated, "utf-8");
    await patchEnvFile({ [envKey]: newKey });
  } catch (err) {
    await runCompose(cwd, ["start", service], "start", t).catch(() => { /* best-effort recovery */ });
    throw new ArrKeyRotationError(
      t("regen.updateFailed", { file: path.basename(xmlPath), message: err instanceof Error ? err.message : String(err) }),
      "edit",
    );
  }

  // 5. Start container.
  await runCompose(cwd, ["start", service], "start", t);

  return { apiKey: newKey };
}

async function runCompose(cwd: string, args: string[], stage: RotationStage, t: (key: string, opts?: any) => string): Promise<void> {
  const { exitCode, stderr, stdout } = await execa("docker", ["compose", ...args], {
    cwd,
    reject:  false,
    timeout: 2 * 60_000,
  });
  if (exitCode !== 0) {
    const tail = (stderr || stdout || "").trim().split("\n").pop()?.trim() || `exit ${exitCode}`;
    throw new ArrKeyRotationError(t("regen.composeFailed", { command: args.join(" "), message: tail }), stage);
  }
}
