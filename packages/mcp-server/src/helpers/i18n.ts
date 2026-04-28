/* ─── Server-side i18n (PR 3.4d) ───────────────────────────────────────────────
 * Mirrors the UI's i18next setup so error messages can be localised. The
 * client tells us its locale via `Accept-Language: <lang>` (the UI sets
 * this from `useAppPreferences().locale`); we resolve to a supported
 * language (currently `en` only with a stub `es` bundle) and stash a
 * `t()` function on `req.locale` for handlers to use.
 *
 * Design notes:
 *   • i18next is initialised once at process start; per-request "scope" is
 *     achieved via `i18next.getFixedT(lang)` — cheap, no global mutation.
 *   • Bundles are imported with `--resolveJsonModule` so they ship inside
 *     the bun-compiled binary.
 *   • Falls back to English for any unrecognised Accept-Language header.
 * ──────────────────────────────────────────────────────────────────────── */
import i18next, { type TFunction } from "i18next";
import type { Request, Response, NextFunction } from "express";

import enSetup from "../locales/en/setup.json" with { type: "json" };
import esSetup from "../locales/es/setup.json" with { type: "json" };

export const SUPPORTED_LOCALES = ["en", "es"] as const;
export type SupportedLocale = typeof SUPPORTED_LOCALES[number];

let initialised = false;

export async function initI18n(): Promise<void> {
  if (initialised) return;
  await i18next.init({
    resources: {
      en: { setup: enSetup },
      es: { setup: esSetup },
    },
    lng:           "en",
    fallbackLng:   "en",
    defaultNS:     "setup",
    ns:            ["setup"],
    interpolation: { escapeValue: false },
    returnNull:    false,
  });
  initialised = true;
}

/** Pick the closest supported locale from an Accept-Language header. */
export function pickLocale(header: string | undefined): SupportedLocale {
  if (!header) return "en";
  // Cheap parse: take the first language tag, drop the region and the
  // q-weight. e.g. "es-ES,es;q=0.9,en;q=0.8" → "es".
  const tag = header.split(",")[0]?.trim().split(";")[0]?.trim().toLowerCase();
  const primary = tag?.split("-")[0];
  if (primary && (SUPPORTED_LOCALES as readonly string[]).includes(primary)) {
    return primary as SupportedLocale;
  }
  return "en";
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Active locale resolved from Accept-Language. */
      locale?: SupportedLocale;
      /** Pre-bound `t()` for the active locale; safe to call from handlers. */
      t?: TFunction;
    }
  }
}

/** Express middleware: stash `req.locale` and `req.t` per request. */
export function localeMiddleware(req: Request, _res: Response, next: NextFunction): void {
  const lang = pickLocale(req.headers["accept-language"]);
  req.locale = lang;
  req.t = i18next.getFixedT(lang);
  next();
}
