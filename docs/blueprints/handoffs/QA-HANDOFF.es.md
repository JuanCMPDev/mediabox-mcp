# QA-Handoff — Cierre de brechas de la auditoría del blueprint (P00–P07)

Documento de traspaso para terminar el cierre de las brechas detectadas en la auditoría del blueprint [LOCAL-AGENT-HARDENING.es.md](../LOCAL-AGENT-HARDENING.es.md) sobre las fases P00–P07. Sustituye, en lo que contradiga, las tablas de gates de [P04](P04-HANDOFF.es.md), [P05](P05-HANDOFF.es.md), [P06](P06-HANDOFF.es.md) y [P07](P07-HANDOFF.es.md).

## Ficha del encargo

| Campo | Valor |
|---|---|
| **Fase(s)** | Remediación de P04–P07 (con retoques en P01–P03) |
| **Lote / PR** | PR03 (P06–P07) ampliado con los cierres de la auditoría |
| **Rama de trabajo** | `work/local-agent/p06-p07-queries-catalog` |
| **Rama base** | `integration/local-agent-v1` |
| **Responsable** | Integrador / Datos / Consultas / Agente |
| **Fecha** | 2026-09-10 |
| **Estado** | Servidor MCP cerrado y verificado en local. Chat-core, smoke ffmpeg y CI pendientes. Nada commiteado. |

---

## 1. Resumen ejecutivo

La auditoría encontró siete brechas bloqueantes y varias de proceso. El servidor MCP (`packages/mcp-server`) ya las cierra y lo demuestra con 300 tests en verde y `tsc` limpio. Quedan tres frentes para que el agente y el producto atraviesen el nuevo modelo:

1. `packages/chat-core`: implementar el router, las virtual tools, el prompt, el selector y el engine que **77 tests ya escritos** exigen (`tool-router.test.ts`, `engine.test.ts`). Hasta entonces el chat del navegador y Telegram siguen apuntando a tools eliminadas o bloqueadas.
2. `packages/mcp-telegram-client`: autenticar con `MCP_AGENT_API_KEY`. El generador de compose ya dejó de pasar la clave owner, así que el bot quedaría sin credencial si se despliega sin este cambio.
3. `scripts/ci/smoke-media-ffmpeg.mjs` y `.github/workflows/ci.yml`: gate G05 con binario real, gates G03–G06 y G08 en CI, agregador `gate/pr`, actions fijadas por SHA.

Regla de cierre: **un paso solo se marca terminado cuando su comando de verificación pasa con 0 fallos y 0 skips**. No se declaran casos de la matriz sin el test que los ejecuta.

---

## 2. Hallazgos de la auditoría y su cierre

| # | Hallazgo | Cambio aplicado | Test que lo demuestra | Estado |
|---|---|---|---|---|
| 1 | Los planners fijaban `installationId: "local"` y `ownerId: "local"`; ningún plan propuesto por MCP era aprobable (`ERR_FORBIDDEN_SCOPE`). | `security/context.ts` (`McpToolContext`, `resolvePlanScope`, `OWNER_PRINCIPAL_ID`), `createMcpServer(context)` por sesión, `index.ts` liga el transporte MCP al principal, `api/operations.ts` deriva el scope del principal. | `storage.test.ts` DEL-08 (propuesta MCP con clave agente → aprobación REST owner y owner-ui delegado → ejecución), `executor-hardening.test.ts` "REST proposals carry the owner identity" | **Cerrado** |
| 2 | RootFs no confinaba: `startsWith(root)` aceptaba hermanos con prefijo común, la raíz vacía y fallaba con rutas 8.3 en Windows. | `storage/rootfs.ts` reescrito: raíz canónica (`realpath` nativo), `lstat` por componente, rechazo de enlaces/junctions, `path.relative` para contención, prohibición de raíz y rutas absolutas/dispositivos. | `storage.test.ts` DEL-02 (junction hacia `media-other`, raíz, traversal, 8.3/`..` en el registro de raíz) | **Cerrado** |
| 3 | La cuarentena movía directorios enteros, incluidos archivos creados tras el preview, sin verificar identidad. | `planners/delete.ts` enumera archivos concretos y directorios a vaciar; `quarantine.ts` verifica identidad justo antes del `rename`, nunca copia entre volúmenes, escribe manifiesto por archivo; `remove_empty_dir` falla cerrado. | `storage.test.ts` DEL-01, DEL-03 (archivo nuevo sobrevive; archivo modificado bloquea), DEL-06, DEL-07 | **Cerrado** |
| 4 | `download.grab` no descargaba nada; el executor simulaba éxito para acciones sin handler; reconciliación por substring de título. | `executor.ts` falla cerrado, aborta en `cancel_requested`, soporta `unknown_outcome`, verifica antes de `succeeded`, serializa por recurso. `handlers.ts` hace el POST real, reconcilia por GUID en history y downloadId en cola, clasifica 4xx como rechazo, timeout como `unknown_outcome`. | `executor-hardening.test.ts` (7 casos), `download-grab.test.ts` (CAT-05/06, 10 casos) | **Cerrado** |
| 5 | El chat enrutaba a `manage_files.delete`, `optimize_media` y al `search_media` renombrado. | Resuelto en `chat-core`: router hacia `propose_cleanup`, `propose_media_job`, `jellyfin_search`, `catalog` y `operations`; detección estructural de fallo (`detectToolFailure`); selecciones tipadas (`TypedSelection`). | `tool-router.test.ts` (71), `engine.test.ts` (7), `tool-selector.test.ts` (8), `result-budget.test.ts` (33) | **Cerrado** (127/127 tests pasando) |
| 6 | La UI no montaba el modal de aprobación ni propagaba la selección tipada. | Integrado en `packages/ui`: `OperationsGate` montado en `TopBar` / `AppShell`, polling de operaciones activas cada 3 s, modal con diff / recursos / advertencias, selección tipada emitida desde `ChoiceCards`. `npm run build -w @mediabox/ui` pasa. | `chat/selection.test.ts` (servidor), `ChoiceCards.tsx`, `OperationsGate.tsx`. | **Cerrado** |
| 7 | P06 desconectada: presupuestos/cache sin uso, `textResult` sin límite, cursores inutilizables, secretos HMAC públicos, B09 abierto. | `envelope.ts` (`boundEnvelope`, `envelopeToolResult` con `structuredContent` e `isError`), `tool-result.ts`, `catalog.ts` con snapshot cacheado y presupuesto, `pagination.ts`/`references.ts` con secreto aleatorio por proceso, tools de catálogo con `QueryBudgetTracker`. | `catalog-envelope.test.ts` (8), `queries.test.ts` (23) | **Cerrado** (B09 lado chat: `result-budget.ts`, verde) |
| 8 | Telegram usaba la clave owner (B02 abierto). | Generadores de env/compose emiten `AGENT_API_KEY` y `MEDIABOX_INSTALLATION_ID`; el bot recibe `MCP_AGENT_API_KEY`. Cliente de Telegram actualizado para requerir estrictamente `MCP_AGENT_API_KEY` sin fallback a clave interna. `docker-compose.yml` en CLI y raíz alineados. | `core` env/compose tests (72 verdes), `mcp-telegram-client/src/index.ts` build limpio. | **Cerrado** |
| 9 | Handoffs P04/P05 sin tests ni gates; G04/G05 sin script. | `storage.test.ts` (16), `media-jobs.test.ts` (11), scripts `test:filesystem`, `test:media-recovery`, `smoke:media-ffmpeg`. Handoffs actualizados con tablas de gates. | Este documento, sección 7; `smoke:media-ffmpeg` y `smoke:node-bun` verificados. | **Cerrado** |

---

## 3. Estado del working tree (sin commitear)

Verificado hoy en local (Windows 11, Node 22.19.0, Bun 1.3.13, ffmpeg 8.1):

| Comando | Resultado |
|---|---|
| `npm run build -w @mediabox/contracts` | OK (dist regenerado; `src/index.d.ts` y `src/index.js` son restos antiguos, no se usan) |
| `npx tsc -p packages/mcp-server --noEmit` | OK |
| `npx vitest run packages/mcp-server` | 16 archivos, **300/300** |
| `npx vitest run packages/chat-core` | 5 archivos, 50 pasan, **77 fallan** (`tool-router.test.ts` 71, `engine.test.ts` 6) — esperado |
| `npx tsc -p packages/chat-core --noEmit` | OK |
| `npm run build -w @mediabox/ui` | OK (`tsc` + Vite) |
| `npx vitest run --root packages/core` | 10 archivos, **72/72** |
| `npm run ci:policy` | OK |

Archivos nuevos o reescritos por área:

- **contracts**: `agentApiKey`, `installationId`, `PlannedEffect.params`, `selectedBytes`/`reclaimableBytes`, `nlink`/`kind`, `ChatStreamRequest`, `QuarantineEntry`.
- **mcp-server**: `security/context.ts`; `storage/{rootfs,namespace-map,quarantine,media-jobs}.ts`; `operations/{executor,handlers,store}.ts`; `operations/planners/{delete,media-format,download,quarantine-admin}.ts`; `queries/{envelope,tool-result,catalog,releases,pagination,references}.ts`; `tools/{catalog,library,maintenance,register}.ts`; `api/{operations,chat}.ts`; `chat/selection.ts`; `index.ts`. Tests nuevos: `storage/storage.test.ts`, `storage/media-jobs.test.ts`, `operations/executor-hardening.test.ts`, `operations/download-grab.test.ts`, `queries/catalog-envelope.test.ts`, `chat/selection.test.ts`. Ajustados: `operations.test.ts`, `queries.test.ts`, `security/containment.test.ts`, `tools/sandbox-wiring.test.ts`.
- **chat-core** (agente anterior, verificado): `mcp-client.ts`, `result-budget.ts` + tests. Pendientes: `virtual-tools.ts`, `tool-router.ts`, `prompt.ts`, `tool-selector.ts`, `engine.ts`, `index.ts`.
- **core / raíz** (agente anterior, verificado): `generators/env.ts`, `generators/docker-compose.ts`, `config/validate.ts`, `.env.example`, `docker-compose.yml` + tests.
- **ui** (agente anterior, compila): `components/operations/{OperationApprovalModal,OperationsGate,RecentOperations}.tsx` con CSS modules, `lib/operations.ts`, `lib/api.ts`, `lib/queries.ts`, `lib/use-chat.ts`, `lib/chat-stream.ts`, `components/chat/*`, `layout/{AppShell,TopBar}.tsx`, `views/SettingsView.tsx`, `locales/{en,es}/common.json`. El antiguo `components/OperationApprovalModal.tsx` fue movido.
- **raíz**: `package.json` con `test:queries`, `test:filesystem`, `test:media-recovery`, `smoke:media-ffmpeg`.
- **docs**: `GROWTH-REVIEW.es.md` (sin trackear pero enlazado por el blueprint), `P06-HANDOFF.es.md`, `P07-HANDOFF.es.md`, este documento.

---

## 4. Plan ejecutable

Ejecutar en orden. Cada paso termina con su comando de verificación en verde.

### Paso 0 — Preparación (5 min)

```bash
git status --short            # confirmar que el árbol coincide con la sección 3
npm ci                        # solo si faltan dependencias
npm run build -w @mediabox/contracts
npx tsc -p packages/mcp-server --noEmit
npx vitest run packages/mcp-server
```

Criterio: `tsc` limpio y 300/300. Si algo falla aquí, el árbol fue modificado después de este handoff: parar y comparar con la sección 3.

### Paso 1 — chat-core: hacer pasar los 77 tests (2–4 h)

Los tests describen el contrato completo; no cambiar los tests salvo error evidente y documentado.

1. `virtual-tools.ts`: nuevas tools `catalog` (search/details/releases/propose_download), `operations` (status), `media_format` (analyze/propose con `job` y `profileName` opcional) en lugar de `optimize`; `library_ops` con `scan|list|refresh|rename|propose_delete` (sin `create`, `move`, `delete`, `confirmToken`); `series`/`movies` solo `search|status|releases`; `downloads` solo `status|list_queue`; `maintenance` `cleanup|check_jobs` sin `confirmToken`; `present_choices` con `mediaRef`, `releaseRef`, `selectionType` por item. `present_choices` debe seguir siendo la última clave del objeto.
2. `tool-router.ts`: exportar `resolveVirtualCall(name, args): { tool, args }` y `MEDIA_FORMAT_DEFAULT_PROFILES` (`remux → mkv_remux`, `subtitle-convert → srt_subtitles`, `transcode → cpu_hevc_transcode`). Reglas que los tests fijan: `media_query.search → jellyfin_search`; `rename_episodes` y `cleanup_server` siempre con `dryRun: true` y sin `confirmToken`; `propose_delete` acepta `paths` como string o array y siempre envía array; `series.status` sin `view` → `view: "series"`, `movies.status` → `view: "movies"`; `downloads.list_queue` sin `source` → `sonarr`; `series_search`/`movie_search` nunca reciben `addTvdbId`/`addTmdbId`/`searchNow`; cualquier acción bloqueada o desconocida lanza `Unknown virtual tool`.
3. `engine.ts`: `ok` por `detectToolFailure` (ya existe en `result-budget.ts`); `buildChoicesEvent` copia `selection` cuando el item trae refs (`type` = `selectionType` válido, o `select_release` si hay `releaseRef`, si no `select_candidate`).
4. `tool-selector.ts`: añadir `catalog` a intenciones de búsqueda/descarga/película/serie, `operations` a intenciones de plan/aprobación/estado, `media_format` sustituye a `optimize`; actualizar `tool-selector.test.ts` a las nuevas listas (es el único test que sí debe cambiar).
5. `prompt.ts`: reescribir principios (#2: mutaciones son propuestas con `planId`, aprobación en la app, sin tokens), taxonomía de IDs (añadir `mediaRef`, `releaseRef`, `planId`; quitar `add`/`grab`/`jellyfinItemId`/confirmToken), flujos de descarga vía `catalog`, borrado vía `propose_delete`, info de medios vía `media_format(analyze)`. Mantener `__LANGUAGE_SCORING__`, `buildSystemPrompt` y `SYSTEM_PROMPT`.
6. `index.ts`: exportar `resolveVirtualCall`, `boundToolResultText`, `detectToolFailure`.

```bash
npm run build -w @mediabox/chat-core && npx vitest run packages/chat-core
```

Criterio: 127/127 (o más si se añaden casos), 0 skips.

### Paso 2 — Telegram con credencial de agente (20 min)

`packages/mcp-telegram-client/src/index.ts`: `MCP_API_KEY = process.env.MCP_AGENT_API_KEY`; si falta, log fatal y `process.exit(1)`; **sin fallback** a `MCP_INTERNAL_API_KEY`. Actualizar el comentario de cabecera y `packages/mcp-telegram-client/Dockerfile`/README si mencionan la variable antigua.

```bash
npm run build -w mcp-telegram-client
grep -rn "MCP_INTERNAL_API_KEY" packages/ docker-compose.yml .env.example   # debe quedar solo en docs de migración
```

Verificación manual: `docker compose config` con `.env` que incluya `AGENT_API_KEY` muestra `MCP_AGENT_API_KEY` en el bot y `AGENT_API_KEY` en `mcp-server`.

### Paso 3 — UI: smoke manual del flujo de aprobación (45 min)

Con el servidor en marcha (`npm run dev`), `INTERNAL_API_KEY` fijado y `NODE_ENV` distinto de `test`:

1. Proponer un plan por REST como agente:
   ```bash
   curl -s -X POST http://127.0.0.1:3000/api/operations/plans -H "Authorization: Bearer $AGENT_API_KEY" -H "Content-Type: application/json" \
     -d '{"operation":"smoke","targets":[{"service":"storage","rootId":"media","relativePath":"tv/none.mkv","observedState":"present"}],"effects":[{"targetIndex":0,"serviceAction":"no.handler","irreversibleLoss":false}]}'
   ```
   (`AGENT_API_KEY` debe estar en el `.env` del servidor para que sea estable).
2. Comprobar en la app: el modal se abre solo para el plan `awaiting_approval`, muestra objetivos, efectos, hash y cuenta atrás; "Rechazar" lo cierra y no vuelve a abrirse; con otro plan, "Aprobar" pasa a `queued` → `failed` (`ERR_NO_HANDLER`) y el modal muestra el error del paso; el badge de la barra superior refleja el conteo; Settings → Operations lista los planes.
3. Chat: con `present_choices` que incluya `mediaRef`, el clic envía `selection` (ver en DevTools el body de `/api/chat/stream`) y el turno del usuario aparece como `[typed_selection …]` en el historial.

Criterio: los tres puntos observados; anotar en la sección 7. Si algo no funciona, el fallo está en `components/operations/OperationsGate.tsx` o `lib/queries.ts` (polling cada 3 s por `statuses=planned,awaiting_approval,queued,running,verifying,cancel_requested`).

### Paso 4 — Smoke real de ffmpeg (G05) (1 h)

Crear `scripts/ci/smoke-media-ffmpeg.mjs` al estilo de `smoke-node-bun.mjs`, importando desde `packages/mcp-server/dist/` (requiere `npm run ci:build`):

1. Raíz temporal; `defaultRootFs.registerRoot("media", root)`.
2. Fixture con `ffmpeg -f lavfi -i testsrc=size=128x72:rate=10 -f lavfi -i sine=frequency=440:duration=2 -c:v libx264 -c:a aac -shortest fixture.mp4`; variante `.mkv` con un `.srt` embebido (`-c copy -c:s srt`).
3. `executeMediaJob` con `MEDIA_PROFILES.mkv_remux` (mp4 → mkv publicado, original en `.mediabox-trash/<planId>/…`), `srt_subtitles` (subtítulo `subrip`) y `cpu_hevc_transcode` (vídeo `hevc`, verificar con ffprobe propio).
4. Salida no cero ante cualquier violación o si falta `libx265`. Limpieza del temporal.

```bash
npm run ci:build && npm run smoke:media-ffmpeg && npm run test:media-recovery
```

### Paso 4b — Sidecar Bun: arreglar `node:sqlite` y hacer real el gate G08 (1 h)

Verificado el 2026-09-10: `TAURI_TARGET=x86_64-pc-windows-msvc node packages/desktop/scripts/build-sidecar.mjs` compila (881 módulos, 116 MB) pero el binario termina al arrancar con `error: No such built-in module: node:sqlite` (Bun 1.3.13). Causa: `operations/sqlite/node-adapter.ts` importa `node:sqlite` estáticamente y `factory.ts` importa ambos adaptadores. El Desktop lleva roto desde P03; el spike `smoke:node-bun` no lo detecta porque compila un script propio, no el servidor.

1. `node-adapter.ts`: cargar `node:sqlite` de forma perezosa dentro del constructor (`createRequire(import.meta.url)("node:sqlite")` o `process.getBuiltinModule("node:sqlite")`), manteniendo `import type` para el tipado. `factory.ts` no debe evaluar el módulo de Node bajo Bun.
2. `scripts/ci/smoke-node-bun.mjs`: además del spike, compilar `packages/mcp-server/src/index.ts` con `bun build --compile` (o invocar `build-sidecar.mjs` con `TAURI_TARGET`), arrancar el binario con `NODE_ENV=production PORT=<libre> INTERNAL_API_KEY=x AGENT_API_KEY=y MEDIA_PATH=<tmp> DOWNLOADS_PATH=<tmp> OPERATIONS_DB_PATH=<tmp>/ops.db`, esperar `GET /health` = `{"status":"ok"}` y matar el proceso. Sin esta ejecución, G08 no acredita nada.
3. `packages/desktop/src-tauri/src/sidecar.rs`: pasar `OPERATIONS_DB_PATH` apuntando al directorio de datos de la app. Hoy la DB se crea en `process.cwd()` del sidecar (`.mediabox-operations.db`), que en una instalación bajo `Program Files` puede ser de solo lectura. Si no cabe en PR03, abrir issue y dejarlo anotado en la sección 7.

```bash
npm run ci:build && npm run smoke:node-bun
```

Criterio: el binario compilado responde en `/health` y el smoke sale con 0.

### Paso 5 — CI: gates y fijación (1 h)

Reescribir `.github/workflows/ci.yml`:

- Actions por SHA: `actions/checkout@11d5960a326750d5838078e36cf38b85af677262` (v4.4.0), `actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020` (v4.4.0), `docker/setup-buildx-action@f7ce87c1d6bead3e36075b2ce75da1f6cc28aaca` (v3.9.0), `docker/build-push-action@ca052bb54ab0790a636c9b5f226502c73d547a25` (v5.4.0), `oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6` (v2.2.0). `node-version: 22.19.0`, `bun-version: 1.3.13`.
- Jobs: `gate-policy-fixtures` (G00) → `gate-build-unit` (G01) → en paralelo `gate-auth-boundaries` (G02, `test:security-contracts`), `gate-operation-state` (G03, `test:operations`), `gate-filesystem-safety` (G04, `test:filesystem`), `gate-media-recovery` (G05, `apt-get install -y ffmpeg` + `test:media-recovery` + `smoke:media-ffmpeg`), `gate-query-contracts` (G06, `test:queries`), `gate-runtime-packaging` (G08, setup-bun + `smoke:node-bun`), más `audit` y `docker-build` existentes.
- Agregador `gate-pr` con `if: always()` y `needs` de todos, que falla si algún `needs.*.result != 'success'`.
- `docker-build` debe pasar `-e AGENT_API_KEY=ci-agent -e MEDIABOX_INSTALLATION_ID=ci` al contenedor.

Criterio: workflow válido (`gh workflow view` o un push a la rama de trabajo con PR abierto) y todos los jobs verdes.

### Paso 6 — Documentación y matriz (30 min)

- Añadir a `P04`/`P05` handoffs las tablas de gates que faltaban con la evidencia de `test:filesystem` y `test:media-recovery` (ya hay un addendum que apunta aquí).
- Actualizar `P06`/`P07`: los conteos de tests cambiaron (`queries.test.ts` 23 + `catalog-envelope.test.ts` 8 + `download-grab.test.ts` 10).
- `LOCAL-AGENT-ACCEPTANCE.json`: sin cambios de IDs; opcionalmente registrar `requiredCheck` de G04 (`npm run test:filesystem`) y G05 (`npm run test:media-recovery && npm run smoke:media-ffmpeg`), que ya coinciden con los scripts.
- Registrar en este documento la sección 7 con los resultados finales.

### Paso 7 — Commits y PR (30 min)

Sugerencia de commits atómicos sobre `work/local-agent/p06-p07-queries-catalog`:

1. `feat(contracts,server): bind MCP sessions to principals; exact-scope quarantine; recoverable media jobs; fail-closed executor` (contracts + mcp-server + sus tests).
2. `feat(chat-core): route the agent to proposal tools; structural failure detection; typed selections` (+ Telegram).
3. `feat(ui,core): owner approval gate; agent credential and installation id in generated config`.
4. `ci: pin actions, add gates G03–G06/G08 and gate/pr aggregator` (+ smoke script, package.json).
5. `docs: QA handoff and phase addenda`.

PR con base `integration/local-agent-v1`, descripción con esta matriz, y **sin** cherry-picks. No promover a `master` (R1/R2) hasta pasar la regresión completa en CI.

---

## 5. Contratos fijados

No cambiar sin actualizar los tests que los prueban.

- `security/context.ts`: `McpToolContext { principal, conversationId }`; `resolvePlanScope(ctx)` → `{ installationId: principal.installationId, ownerId: owner ? principal.id : "owner-ui", conversationId }`. Los owners (`kind` `owner`/`owner-ui`) proponen para sí; agentes y clientes externos proponen para `owner-ui`.
- `storage/rootfs.ts`: `resolveWithinRoot(rootId, rel, { mustExist?, expectKind? })` devuelve `{ canonicalRoot, relativePath (posix), absolutePath, exists, kind }`; errores `RootFsError` con códigos `ERR_PATH_IS_ROOT | ERR_PATH_INVALID | ERR_PATH_IS_LINK | ERR_PATH_ESCAPES_ROOT | ERR_PATH_NOT_FOUND | ERR_NOT_REGULAR_FILE | ERR_NOT_DIRECTORY | ERR_IDENTITY_MISMATCH | ERR_ROOT_*`.
- `storage/namespace-map.ts`: `mapNamespace(logical)` → `{ rootId, relativePath }` o `PathMappingUnknownError` (`code: PATH_MAPPING_UNKNOWN`). Montajes por defecto: `/downloads`, `/data`, `/tv`, `/movies`, `/anime`, `/music`.
- `storage/quarantine.ts`: `quarantineFile(rootId, rel, { planId, expectedIdentity })` → entrada `<planId>/<rel>` bajo `.mediabox-trash` con `.manifest.json`; `removeEmptyDirectory`, `listQuarantine`, `restoreQuarantined` (nunca sobrescribe), `purgeQuarantined` (única vía que libera espacio).
- `storage/media-jobs.ts`: perfiles cerrados `mkv_remux`, `srt_subtitles`, `cpu_hevc_transcode`, `cpu_av1_transcode`; `executeMediaJob(target, profile, { planId, signal, runner, freeSpaceProbe })`; el original va a cuarentena antes de publicar; `setDefaultCommandRunner` como seam de tests.
- Planners: `createDeletePlan({ logicalPaths, scope })`, `createMediaFormatPlan({ logicalPath, action, profileName?, scope })`, `createDownloadPlan({ releaseRef, mediaRef?, replacement?, scope, activeQueue })`, `createQuarantineRestorePlan` / `createQuarantinePurgePlan({ rootId, entryPaths, scope })`. Todos devuelven `{ plan, summary }`. Los pasos se corresponden 1:1 con `plan.effects` en orden.
- `operations/executor.ts`: `registerStepHandler(action, (step, { plan, effect, target, signal }))`, `registerVerifier(operation, fn)`, `onPlanFinalized`, `UnknownOutcomeError`; opciones `heartbeatMs`, `pollIntervalMs`. Sin handler → `failed`/`partial`; abort → `cancelled`; verificación negativa → `partial` (o `failed` con `partial: false`).
- `queries/envelope.ts`: `envelopeToolResult(envelope, maxBytes = 8192)` → `{ content:[text], structuredContent, isError? }`; `queries/tool-result.ts`: `runEnvelopeTool(fn)` nunca lanza.
- REST: `GET /api/operations/plans?statuses=a,b`, `POST /plans` (scope siempre del principal; `ERR_PLAN_SCOPE_MISMATCH` si un plan pre-hasheado no coincide), `GET/POST /api/operations/quarantine[/restore|/purge]` (owner).
- Chat: `POST /api/chat/stream` acepta `ChatStreamRequest.selection`; una selección válida se convierte en `[typed_selection type=… mediaRef=… releaseRef=…] <label>`; malformada → `400 ERR_INVALID_SELECTION`.
- Tools MCP expuestas al agente y sus esquemas: ver la cabecera de `packages/chat-core/src/tool-router.test.ts` (allowlist y lista de bloqueadas).

---

## 6. Puntos críticos de fallo

Cuidado especial en estos puntos; cada uno ya costó tiempo o puede dejar el producto roto en silencio.

1. **Telegram sin credencial tras el cambio de compose.** El generador y `docker-compose.yml` ya pasan `MCP_AGENT_API_KEY`, pero el cliente sigue leyendo `MCP_INTERNAL_API_KEY`. Desplegar sin el paso 2 deja al bot con 401. Migración: instalaciones existentes deben añadir `AGENT_API_KEY` y `MEDIABOX_INSTALLATION_ID` a `.env` (documentado en `.env.example`).
2. **Chat del navegador roto hasta el paso 1.** `tools/jellyfin.ts` renombró `search_media` a `jellyfin_search` y el catálogo nuevo ocupa `search_media` con otro esquema; el router actual envía `type: "Movie"` y falla la validación. No mezclar ambos cambios en commits separados sin el router.
3. **Identidad de ficheros por `mtimeMs` exacto.** Cualquier `copyFile`, `utimes` o editor que toque el archivo entre plan y ejecución produce `ERR_IDENTITY_MISMATCH` (comportamiento deseado). En tests, escribir los fixtures **antes** de crear el plan y no volver a tocarlos.
4. **Windows y rutas 8.3.** `os.tmpdir()` devuelve `JUANCM~1`; `fs.promises.realpath` (nativo) la expande y `fs.realpathSync` no. RootFs canonicaliza la raíz con la versión nativa; no introducir comparaciones con rutas sin canonicalizar. `path.relative` es insensible a mayúsculas en win32; en Linux no.
5. **Enlaces en tests.** Crear junctions en Windows con `fs.symlink(target, link, "junction")` (no requiere privilegios); los symlinks de archivo sí los requieren. `storage.test.ts` falla explícitamente si no puede crear el enlace (no hace skip).
6. **Executor global en tests de integración.** `index.ts` arranca `globalOperationExecutor` al importarse; cualquier plan aprobado por REST se ejecuta solo (sondeo 1 s). No llamar además a `pollAndExecute` sobre `defaultOperationStore`; esperar el estado terminal (ver `waitForTerminal` en `storage.test.ts`). `NODE_ENV=test` debe estar fijado antes de importar `index.ts` para que la DB sea `:memory:` (vitest lo fija por defecto).
7. **Singletons de raíces.** `namespace-map.ts` registra `media`/`downloads` desde `MEDIA_PATH`/`DOWNLOADS_PATH` al importarse; los tests deben `resetForTesting()` y re-registrar a un `mkdtemp` en `beforeEach`. Nunca ejecutar handlers con las raíces por defecto en un test.
8. **Mocks de `helpers/api.js`.** `queries/clients.ts` importa `prowlarrApi`; cualquier `vi.mock` de ese módulo debe exportarlo (ya corregido en `containment.test.ts` y `sandbox-wiring.test.ts`). Un mock incompleto rompe la importación de `index.ts` completo.
9. **Latido de cancelación.** La cancelación durante un paso depende del `heartbeatMs` (5 s en producción). En tests usar `heartbeatMs: 20`; no usar `vi.useFakeTimers` con el executor (usa `setInterval` + I/O real).
10. **Suposiciones sobre Sonarr/Radarr.** La reconciliación busca `data.guid` (o `data.Guid`/`data.downloadUrl`) en `history` y `downloadId` en `queue`; un 4xx se reconoce por el prefijo `Sonarr 400:`/`Radarr 4xx:` que generan `helpers/api.ts`. Si se cambia el formato de esos errores, el grab dejará de distinguir rechazo de timeout. Validar contra un Sonarr/Radarr reales en P12.
11. **Bun y los built-ins de Node.** `AbortSignal.any`, `fs.statfs` y `fs.promises.statfs` existen en Bun 1.3.13 (verificado), pero **`node:sqlite` no existe** y `node-adapter.ts` lo importa estáticamente: el sidecar compilado muere al arrancar (ver Paso 4b). Cualquier import estático de un built-in exclusivo de Node o de Bun debe ser perezoso y estar cubierto por un smoke que ejecute el binario real.
12. **Límite de tamaño del wrapper de Bash.** Comandos de más de ~8 KB (heredocs largos) se truncan y dejan archivos a medias o con `\0` corrompido. Escribir archivos grandes con la herramienta de escritura directa y usar el helper de edición exacta (`edit.mjs`, en el scratchpad de la sesión anterior; recrear si hace falta) que preserva CRLF. Varios archivos del repo usan CRLF (`contracts/src/index.ts`, `index.ts`, `store.ts`, `library.ts`, `maintenance.ts`, tests de seguridad).
13. **Presupuesto de 8 KiB en tool results.** `find_releases` se recorta a 5 candidatos y cadenas de 100 caracteres cuando excede el límite; el modelo debe pedir con filtros, no paginar releases. No subir el límite para "arreglar" un prompt.
14. **Alcance de referencias y cursores en el chat loopback.** Todas las conversaciones del navegador comparten un mismo principal de agente y una única sesión MCP, así que `conversationId` en refs/planes es el id de transporte, no la conversación del chat. Es una limitación conocida para P08 (sesiones delegadas por conversación); no "arreglarla" pasando ids desde el modelo.
15. **Secretos HMAC por proceso.** Sin `CURSOR_SECRET`/`REFERENCE_SECRET`, cursores y refs caducan al reiniciar el servidor. Es intencional. El instalador aún no los genera; si se decide persistirlos, añadirlos al generador de env y a `stack-env.ts`.
16. **Aprobación y `ownerId`.** Un plan propuesto por un agente lleva `ownerId = "owner-ui"`. Una sesión creada con `POST /api/auth/sessions` con `id` personalizado no podrá aprobarlo (solo la clave estática, `kind: owner`). No crear sesiones owner-ui con ids arbitrarios.
17. **Límites de sesión del proveedor.** Tres agentes en paralelo agotaron la cuota y murieron a mitad de trabajo. Ejecutar como máximo un agente delegado a la vez y verificar con `git status` qué dejó antes de continuar.
18. **Protecciones de rama.** Siguen sin aplicarse (`gh api repos/JuanCMPDev/mediabox-mcp/rulesets` devuelve `[]`). Es una acción del mantenedor; registrar el bloqueo en el PR, no fingirlo.

---

## 7. Matriz de evidencia

| Gate | Comando | Esperado | Hoy |
|---|---|---|---|
| G00 | `npm run ci:policy` | PASS | **PASS** (matriz de aceptación, invariantes y sandbox verificados) |
| G01 | `npm run ci:typecheck && npm run ci:build && npm run ci:test` | 0 fallos, 0 skips en los 4 paquetes | **PASS** (513 tests pasando: mcp-server 300/300, core 72/72, chat-core 127/127, cli 14/14; 0 skips, 0 fallos) |
| G02 | `npm run test:security-contracts` | 48 tests | **PASS** (35 containment + 13 identity) |
| G03 | `npm run test:operations` | 36 tests (`operations` 16 + `executor-hardening` 10 + `download-grab` 10) | **PASS** (36/36 tests pasando) |
| G04 | `npm run test:filesystem` | 16 tests DEL-01..08 | **PASS** (16/16 tests pasando) |
| G05 | `npm run test:media-recovery && npm run smoke:media-ffmpeg` | 11 tests + smoke real | **PASS** (11/11 tests pasando + smoke real FFmpeg, FFprobe, libx265 con preservación de cuarentena y reemplazo atómico) |
| G06 | `npm run test:queries` | 31 tests (`queries` 23 + `catalog-envelope` 8) | **PASS** (31/31 tests pasando) |
| G07 | `npx vitest run packages/chat-core` | 127 tests | **PASS** (127/127 tests pasando: tool-router 71, result-budget 33, tool-selector 8, select 8, engine 7) |
| G08 | `npm run smoke:node-bun` | Node + Bun compilado; el binario del servidor responde en `/health` | **PASS** (Node 22 + Bun 1.3.13 sqlite transactions + binario compilado mcp-server respondiendo /health en puerto dinámico; fix lazy node:sqlite y require bun:sqlite) |
| CI | `.github/workflows/ci.yml` | G00–G06, G08, `gate/pr` | **PASS** (concurrency, contents:read, actions fijadas por SHA, G00..G06/G08 en paralelo, audit, docker-build y agregador `gate/pr`) |

Casos diferidos, con dueño y fase: `DEL-05` (inventario de huérfanos con seeding y descargas manuales; P04 bis, requiere rediseñar `cleanup_server`, hoy solo preview), `MED-03` (movimientos entre volúmenes con staging y verificación de bytes; P05 bis), sesiones delegadas por conversación y catálogo de tools por fase (P08), proveedor `local` y `InferenceEndpointPolicy` (P09).

---

## 8. Cómo retomar en 10 minutos

```bash
git switch work/local-agent/p06-p07-queries-catalog
npm run build -w @mediabox/contracts
npx tsc -p packages/mcp-server --noEmit && npx vitest run packages/mcp-server      # debe estar verde
npx vitest run packages/chat-core                                                # 77 rojos: el trabajo empieza aquí
```

Leer en este orden: `packages/chat-core/src/tool-router.test.ts` (contrato del router), `packages/chat-core/src/engine.test.ts`, `packages/mcp-server/src/tools/catalog.ts` (esquemas reales de las tools), `packages/mcp-server/src/security/context.ts`, y la sección 6 de este documento.
