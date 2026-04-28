# Translation guide — Mediabox OS

This document is for whoever is taking on the **Spanish translation pass** for PR 3.4d. Everything described here is wired up and waiting; you only need to fill in JSON files and (optionally) move a few hardcoded strings into them.

If you're translating to a *different* language later, the same instructions apply — just swap the locale code (`pt`, `de`, `fr`, …).

---

## TL;DR

1. Open `packages/ui/src/locales/es/common.json` and translate every key to Spanish.
2. Open `packages/mcp-server/src/locales/es/setup.json` and translate every key there too.
3. (Optional, biggest impact) Walk through the UI files listed in **§3 — Strings still hardcoded** and move them into the translation bundles using the patterns described.
4. Run `npm run build` — must finish clean. Any missing key in the Spanish bundle silently falls back to English; build won't catch missing translations, only missing keys.
5. Launch the desktop app, switch language to **Español** in Settings → Preferences, click around, and verify everything renders the way you expect.

---

## 1. The translation system at a glance

### Frontend (`@mediabox/ui`)

- Uses `i18next` + `react-i18next`.
- Initialised once in `packages/ui/src/lib/i18n.ts`.
- Active locale is sourced from the user preference at `useLocale()` (persisted in `state.json` → `appPreferences.locale`).
- The Settings → Preferences → Language toggle calls `updatePrefs({ locale: 'es' })`. A small effect (`useLanguageSync`) mirrors that into i18next, so switching is **live** — no app reload.
- Translation keys live under `packages/ui/src/locales/<locale>/common.json`.

```ts
// Component using a translation:
import { useTranslation } from 'react-i18next';

export function MyComponent() {
  const { t } = useTranslation();
  return <h1>{t('boot.starting')}</h1>;
}
```

### Backend (`@mediabox/mcp-server`)

- Uses the Node version of `i18next` (no `react-i18next`).
- Initialised in `packages/mcp-server/src/helpers/i18n.ts` at process start (top-level `await initI18n()` in `index.ts`).
- An Express middleware (`localeMiddleware`) reads the `Accept-Language` header that the UI sends on every request and stashes a per-request `t()` on `req.t`.
- Route handlers call `req.t!('errors.envEmpty', { key })` and the middleware picks the matching bundle.
- Translation keys live under `packages/mcp-server/src/locales/<locale>/setup.json`.

```ts
// Route handler using a translation:
res.status(400).json({ error: req.t!('jellyfin.passwordTooShort') });
```

### LLM system prompt

- Located at `packages/chat-core/src/prompt.ts`.
- The prompt **body** stays in English because LLM tool-following is most reliable with English-language directives.
- The first line ("Respond in English / Spanish, concisely.") swaps based on the user's locale.
- Already wired up — no action required from a translator unless we want to translate the body too (we don't).

---

## 2. File layout

```
packages/ui/src/locales/
├── en/
│   └── common.json     ← English source of truth (already filled)
└── es/
    └── common.json     ← Spanish — TRANSLATE THIS

packages/mcp-server/src/locales/
├── en/
│   └── setup.json      ← English source of truth (already filled)
└── es/
    └── setup.json      ← Spanish — TRANSLATE THIS
```

### Key naming conventions

Keys are `dot.delimited.namespaces`. The structure inside each `common.json` mirrors the area of the UI:

```jsonc
{
  "nav":      { "dashboard": "…", "library": "…", "chat": "…", "settings": "…" },
  "actions":  { "save": "…", "cancel": "…", "back": "…", "continue": "…" },
  "status":   { "live": "…", "error": "…", "loading": "…" },
  "boot":     { "starting": "…", "subtitle": "…", "failed": "…" },
  "topbar":   { "mcpConnected": "…", "mcpOffline": "…" },
  "sidebar":  { "navigation": "…", "mcpConnected": "…", "mcpOffline": "…" }
}
```

The backend's `setup.json` is similarly nested:

```jsonc
{
  "errors":   { "stackUnavailable": "…", "envEmpty": "value for {{key}} must be a string" },
  "jellyfin": { "passwordTooShort": "…", "currentPasswordWrong": "…" },
  "prowlarr": { "apiKeyMissing": "…" },
  "regen":    { "serviceInvalid": "service must be one of: {{services}}" }
}
```

### Interpolation

Variables use double curly braces, e.g. `value for {{key}} must be a string`. **Keep the placeholder name verbatim**; don't translate `{{key}}` to `{{clave}}`. The runtime substitutes whatever value the calling code passes.

### Plurals

If you hit a string that needs plural forms (rare in this app today), i18next's standard plural keys work:

```json
"itemCount_one":  "{{count}} item",
"itemCount_other": "{{count}} items"
```

For Spanish, use `_one` and `_other` (Spanish has the same two-form plural rule as English).

### Don't translate

Some strings should stay English even in Spanish UI — they're product names, technical terms, or paths users will copy-paste to other tools:

- Service names: **Jellyfin, Sonarr, Radarr, Prowlarr, qBittorrent, PyLoad, Bazarr, FlareSolverr, Docker**
- Env-var names: `JELLYFIN_API_KEY`, `MOVIES_PATH`, etc.
- Filenames: `docker-compose.yml`, `.env`, `state.json`
- Tag literals: `flaresolverr`, `latino`, `multi`
- CLI fragments inside `<code>`: `docker compose up -d`, `id -u`

Treat these as proper nouns. Wrap them in inline code in user-facing copy where they appear.

---

## 3. Strings still hardcoded (the long tail)

The infrastructure is in place but only a handful of files have been migrated to `t()` so far. **As you translate, you may also want to migrate more strings.** That's a refactor, not a pure translation — feel free to do as much or as little as you have appetite for.

Already migrated (done — these read from `common.json` automatically):

- `Sidebar.tsx`         — nav labels, "Navigation" header, MCP connected/offline.
- `TopBar.tsx`          — breadcrumb (uses `nav.*` keys), window-control labels, MCP tooltip.
- `BootGate.tsx`        — splash titles + subtitle.

Not yet migrated (these are the longest-tail copy in the app):

- `WizardView.tsx`                                   — step titles + subtitles.
- `packages/ui/src/components/wizard/steps/*.tsx`    — every wizard step body (Pre-flight, Deployment, System, Paths, Services, AI, Telegram, Review, ProwlarrSetup).
- `packages/ui/src/components/wizard/StepShell.tsx`  — Back / Continue / Finish button labels.
- `packages/ui/src/components/wizard/DeployProgress.tsx` — phase labels + status messages.
- `packages/ui/src/views/SettingsView.tsx`           — every section heading, subtitle, hint, toast, confirm dialog.
- `packages/ui/src/views/LibraryView.tsx`            — folder tile labels and the bottom tip.
- `packages/ui/src/components/log-drawer/LogDrawer.tsx`   — control labels, status pills, footer.
- `packages/ui/src/components/update-drawer/UpdateDrawer.tsx` — header, status messages, buttons.

### How to migrate a string

1. Find a hardcoded string in a `.tsx`:
   ```tsx
   <h1>Settings</h1>
   ```
2. Add a key to `packages/ui/src/locales/en/common.json` under the most appropriate namespace:
   ```json
   "settings": { "title": "Settings" }
   ```
3. Add the Spanish translation to `packages/ui/src/locales/es/common.json` mirroring the structure:
   ```json
   "settings": { "title": "Configuración" }
   ```
4. Use the key in the component:
   ```tsx
   import { useTranslation } from 'react-i18next';
   // …inside the component
   const { t } = useTranslation();
   <h1>{t('settings.title')}</h1>
   ```

If multiple components share the same namespace (e.g. all Settings sections), keep them grouped under one root key (`settings.*`) to make the JSON easy to scan.

For larger files (Settings, Wizard) consider splitting bundles:

```
locales/en/settings.json
locales/en/wizard.json
```

Then register them as namespaces in `i18n.ts`:

```ts
ns: ['common', 'settings', 'wizard'],
```

And reference with `useTranslation('settings')` inside Settings components.

---

## 4. Backend strings

The mcp-server has fewer translatable strings — they're mostly error messages surfaced to the UI as toasts. The bundle lives at `packages/mcp-server/src/locales/<locale>/setup.json`.

Already migrated (calling `req.t!('key')`):

- `regen.serviceInvalid` — *arr API key rotation: invalid service.
- `jellyfin.currentPasswordRequired` and `jellyfin.passwordTooShort` — Jellyfin admin password change validation.

Not yet migrated (fix these as part of the same pass to keep error messages bilingual):

- `mcp-server/src/api/setup.ts`  — every other `res.status(...).json({ error: '…' })` call.
- `mcp-server/src/helpers/docker-compose.ts`  — `StackUnavailableError` message.
- `mcp-server/src/helpers/log-stream.ts`  — closed-stream messages.
- `mcp-server/src/helpers/arr-key-rotation.ts`  — error stage messages.

### How to migrate a backend string

1. Find a hardcoded message:
   ```ts
   res.status(400).json({ error: 'config is required' });
   ```
2. Add the key to `mcp-server/src/locales/en/setup.json`:
   ```json
   "errors": { "configRequired": "config is required" }
   ```
3. Add the Spanish translation in `es/setup.json`:
   ```json
   "errors": { "configRequired": "config es obligatorio" }
   ```
4. Use the key in the route handler:
   ```ts
   res.status(400).json({ error: req.t!('errors.configRequired') });
   ```

Errors thrown from helper modules (which don't have access to `req`) are out of scope for this pass — they bubble up to a route handler and get serialized at that level. If a helper throws a localised message, factor the i18n key out as a constant the route handler resolves, or pass `t` as a parameter.

---

## 5. The system prompt

The LLM responds in the user's preferred language because the `chat-core` engine builds the system prompt with `buildSystemPrompt(locale)`. The body is intentionally English (instruction-following accuracy) — only the first line ("Respond in English / Spanish, concisely.") swaps.

If you want the model to reply in another future language (Portuguese, German, etc.), edit `LANGUAGE_LINE` in `packages/chat-core/src/prompt.ts`:

```ts
const LANGUAGE_LINE: Record<PromptLocale, string> = {
  en: "Respond in English, concisely.",
  es: "Respond in Spanish, concisely.",
  pt: "Respond in Brazilian Portuguese, concisely.",   // example
};
```

And widen the `PromptLocale` type:

```ts
export type PromptLocale = "en" | "es" | "pt";
```

Then update the corresponding fallback strings in `packages/chat-core/src/engine.ts` (`FALLBACKS` map: `empty`, `iterLimit`).

You don't translate the prompt body. Tool descriptions, action verbs, and JSON keys all stay English so the LLM picks them up reliably.

---

## 6. Testing your translations

1. **Build**: `npm run build` from the repo root. TypeScript catches missing JSON files and import errors but **not** missing translation keys (i18next falls back to English silently). For complete-ness, eyeball the Spanish JSON next to the English JSON and confirm every key is present.
2. **Visual sweep**: launch the app, switch to Español, and click through every screen. Look for:
   - English text that should be Spanish (a hardcoded string we missed).
   - Spanish text that runs off the edge (Spanish averages ~25% longer than English; some buttons / cards may need a wider min-width).
   - Punctuation (Spanish opens questions with `¿` and exclamations with `¡`).
   - Untranslated brand names that should have stayed English (Sonarr, Docker, etc.).
3. **Backend errors**: trigger an error you migrated (e.g. submit an invalid env key) and confirm the toast renders in Spanish. The UI's `Accept-Language` header carries the active locale, so flipping the language in Settings is enough to test.
4. **Chat**: with the AI assistant configured, switch language, send a message. The LLM should reply in Spanish.

---

## 7. Style guide for Spanish

These are the conventions the existing UI copy follows. Stick close to them so the app feels coherent.

- **Voice**: informal **tú** (`pickear`, `guardás`, `clickeá`). Mediabox is a self-hosted hobbyist tool, not enterprise software.
- **Voice — alt**: if you target a broader Latin American / Spain audience, second-person plural `vosotros` is uncommon in LatAm; prefer the imperative without subject (`Guardá`, `Hacé clic`, `Verificá`) which works for both regions.
- **Tense**: prefer the simple present and imperative. Avoid passive voice ("se guardan") in user-facing buttons; use direct action ("Guardar").
- **Accents**: use them. `configuración`, not `configuracion`.
- **Buttons**: imperative. `Guardar`, `Cancelar`, `Reintentar`, `Aplicar`, `Continuar`, `Volver`.
- **Field labels**: noun phrases. `Contraseña`, `Usuario`, `Dirección base`, `Zona horaria`.
- **Hints / subtitles**: full sentences with periods. Conversational tone.
- **Keep technical terms English**: container, log, deploy, sidecar, indexer, tag, repo, branch. These are how users talk in their browser tabs anyway.

---

## 8. Definitions of done

- Every key in `en/common.json` has a non-empty Spanish counterpart in `es/common.json`.
- Every key in `en/setup.json` has a non-empty Spanish counterpart in `es/setup.json`.
- `npm run build` finishes clean.
- Manual click-through in Spanish mode reveals no obvious English leftovers in the migrated areas (Sidebar, TopBar, BootGate, Settings → Preferences).
- Any new keys you added during a string migration are present in **both** bundles.

When that's all green, push to a branch named `feature/i18n-spanish` and open a PR. The reviewer will diff the bundles to confirm parity and run the visual sweep.
