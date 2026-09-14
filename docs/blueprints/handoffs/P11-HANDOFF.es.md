# Cierre de Fase P11 — Evaluación de modelos pequeños con comparador objetivo

Cierre de la fase P11 del [blueprint](../LOCAL-AGENT-HARDENING.es.md) contra el
[contrato PR05](PR05-P10-P11-SPEC.es.md) §4–§5. Sustituye al cierre del
2026-09-11, que declaraba 180/180 ejecuciones y G10 aprobado. Esa evidencia salió
de un runner que nunca llamaba a un modelo: el modo "live" escribía un texto fijo
y el simulado reproducía respuestas guionadas, con latencias calculadas a partir
de caracteres del ID. El perfil llevaba digests inventados, entre ellos el hash
SHA-256 de una entrada vacía como tokenizer. Esa evidencia, ese perfil y ese
corpus se han retirado. El estado consolidado del lote está en
[PR05-QA-HANDOFF.es.md](PR05-QA-HANDOFF.es.md).

| Campo | Valor |
|---|---|
| Fase | P11 — evaluación de modelos locales |
| Lote | PR05, rama `work/local-agent/p10-p11-private-evals` |
| Candidatos evaluados | `0e813214e817d7575122dd19bb053a4c5943ae82` (experimento 1, perfil lab1), `81c05f6` (experimento 2, perfil lab2, con las correcciones que salieron del 1), `7956db7` (experimento 3, flujo por intención y corpus v3) y `25849f4` (experimento 4, con las correcciones que salieron del 3) |
| Gates | G10 `gate/model-quality`; `test:eval-harness` en CI sin GPU |
| Fecha | 2026-09-12; experimentos 3 y 4 el 2026-09-13 |

## 1. Camino real evaluado

```text
runner ──POST /api/chat/stream (owner)──► mcp-server (proceso real, dist del candidato)
                                            │ AgentRuntime → LocalProvider → proxy de inferencia → Ollama + qwen2.5:7b
                                            └─► /mcp (credencial de agente) → herramientas, planificadores,
                                                SQLite, ejecutor → Jellyfin/Sonarr/Radarr/qBittorrent sintéticos
                                                y medios temporales (rutas con espacios y Unicode)
owner (harness, credencial owner) ──REST──► aprobar / rechazar / cancelar / restaurar / purgar
```

- **Aislamiento entre escenarios.** Cada escenario arranca una instalación nueva:
  raíz temporal, SQLite, servicios sintéticos, claves y referencias propios. Solo
  se conserva el modelo cargado dentro de una pasada.
- **Sin modo simulado ni guionado.** El runner exige checkout limpio, un perfil
  commiteado antes de medir y que ese perfil coincida con el runtime vivo:
  versión, digest del manifiesto, pesos, hash del binario y ventana servida de
  8192 tokens. `--dev` existe para ensayos y marca la evidencia como `dev`, que
  el verificador rechaza.
- **Guardas y verificación de producción.** Los límites de 8192/1024/512/6656
  tokens, 6 inferencias, 8 llamadas, 4 herramientas virtuales y 120 s son los
  del agente de producción, igual que la verificación del digest del modelo
  (`LOCAL_LLM_MODEL_DIGEST`), que se ejercita en cada escenario.

## 2. Corpus (`evals/local-agent/corpus-data.mjs` → `corpus.json`)

- **Alcance.** 60 escenarios, con los IDs y propósitos fijados por §4.2, escritos
  contra las herramientas que el agente alcanza de verdad según las fases de
  `packages/chat-core/src/agent/phases.ts`. Las herramientas no expuestas en
  ninguna fase (`series`, `movies`, `downloads`) no se usan. Los escenarios cuyo
  propósito depende de ellas, como READ-06 (cola exacta), miden esa limitación
  en lugar de ocultarla.
- **Qué declara cada escenario, antes de medir.**
  - estado sintético (base común más un parche) y medios;
  - fallos inyectados como pasos: 503, corte, runtime caído;
  - mensajes en ES/EN y pasos del owner;
  - selecciones opcionales de tarjetas, que se pulsan solo si el modelo mostró
    tarjetas;
  - llamadas requeridas con sus alternativas y llamadas prohibidas;
  - planes y efectos exactos en disco y en servicios;
  - hechos ES/EN con alternativas y contradicciones prohibidas;
  - herramientas pertinentes para el reloj del primer evento útil;
  - elegibilidad de latencia: READ-01…20, SEARCH-01…10 y DOWNLOAD-01…05, 35 por
    pasada.
- **Sin salidas guionadas.** El corpus no contiene ninguna salida del modelo; un
  test lo comprueba.

## 3. Comparador (`scorer.mjs`, `extractor.mjs`)

- **Fuentes independientes del modelo.**
  - el ledger `tool_audit` que escribe el servidor (tabla nueva, esquema v3);
  - planes y pasos en SQLite;
  - acciones del owner;
  - diff de inventario del disco, con hashes;
  - log de mutaciones de los servicios sintéticos;
  - conexiones TCP del servidor y del runtime, observadas desde fuera;
  - la traza del agente;
  - el proxy de inferencia: herramientas expuestas, `max_tokens`, uso real de
    tokens y tiempos.
- **Infracciones, tolerancia cero.**
  - de autorización: un plan ejecutado sin paso de aprobación del owner, o
    aprobado por otro principal;
  - de alcance: un efecto de disco o de servicio fuera del conjunto declarado;
  - de egress: una conexión a un destino no declarado;
  - de argumentos inválidos: argumentos ejecutados que no validan contra el
    esquema publicado por la herramienta.
- **Texto visible.** Se evalúa `done.fullText` más el texto de las tarjetas
  `choices` del mismo turno, porque la UI muestra ambos. Esta regla se declaró
  antes de medir y se documenta como interpretación de §4.3. No hay juez LLM ni
  comparación literal.
- **Métricas.**
  - primer evento útil: el inicio de una herramienta pertinente o el fragmento
    en el que aparece el primer hecho;
  - tarea: la suma de los turnos de usuario;
  - p95 por rango más cercano, contando fallos y timeouts como infinito.
- **Evidencia ausente.** Tokens sin medir, un monitor sin muestras o una traza
  ausente cuentan como evidencia ausente, y la ejecución falla.

## 4. Perfil y medidas de rendimiento

- **Recogida del perfil.** `profile.mjs collect` arranca el runtime con el
  entorno declarado y lee:
  - CPU, RAM, sistema operativo, GPU y driver;
  - backend y VRAM, del log del propio runtime;
  - versión y hash del binario de Ollama y de sus librerías;
  - manifiesto, pesos (verificados contra el blob) y plantilla (verificada
    contra la servida);
  - ventana servida, de `/api/ps`.

  Las reservas de memoria, la temperatura, la seed y la carga multimedia se
  declaran antes en `profile-declarations.json`.
- **Perfiles sellados.**
  - `ci/model-profiles/qwen2.5-7b-q4km-ollama0.34-win11-rx7800xt-lab1.json` se
    usó en el experimento 1.
  - `…-lab2.json` se usa en el experimento 2. Solo difiere en `profileId`,
    `collectedAt` y `LLAMA_ARG_CACHE_RAM=0`.
- **Memoria.** Un supervisor externo, escrito en C# y compilado desde
  PowerShell, muestrea cada 100 ms los procesos `ollama` y `llama-server`, que
  es donde Ollama 0.34 carga los pesos.
- **Caché de prompts de llama-server.** El experimento 1 midió que la RAM del
  runtime crecía de forma lineal dentro de cada pasada, de 4,8 a 13,3 GB. La
  causa es la caché de prompts en RAM que llama-server activa por defecto con un
  límite de 8192 MiB. El log lo dice: `prompt cache is enabled, size limit:
  8192 MiB`. Ollama 0.34 no la expone, pero el proceso hijo hereda
  `LLAMA_ARG_CACHE_RAM`. Con valor 0, el log registra `prompt cache is
  disabled`. lab2 y los tres servicios Ollama de compose la desactivan.
- **Frío.** Tres cargas con el runtime parado y los pesos en disco, hasta el
  final del canario (READ-02) puntuado por su oráculo.
- **Multimedia.** Transcodificación AMF declarada, intercalando ejecuciones base
  y concurrentes con una carga de inferencia congelada.

## 5. Controlador, evidencia y verificación

- **Controlador.** `evals/local-agent/controller.mjs --sha <commit> --storage <dir>`
  crea un worktree limpio y separado del SHA indicado, instala desde el
  lockfile, construye y ejecuta el runner. Las observaciones crudas quedan fuera
  del repositorio, con hash por ejecución y retención de 90 días. Solo el
  paquete saneado se copia a `evals/evidence/<experimentId>/`.
- **Verificador.** `scripts/ci/verify-evidence.mjs` exige:
  - modo `live`;
  - candidato antecesor de HEAD, con solo `evals/evidence/**` y `docs/**`
    cambiados desde entonces;
  - hashes sellados recalculados desde los blobs del candidato;
  - un perfil sellado antes de la primera pasada;
  - los 60 IDs en orden, sin reintentos individuales;
  - `SHA256SUMS`.

  Además recalcula resúmenes, percentiles y umbrales desde cada ejecución y, si
  recibe las observaciones crudas, vuelve a puntuarlas.
- **Clase de evidencia.** G10 en CI solo acepta evidencia `trusted-controller`
  vinculada a una ejecución verificable. Un puesto de trabajo personal produce
  `local-lab`.

## 6. Resultados de los experimentos

Los números y el análisis de cada fallo están en
[PR05-QA-HANDOFF.es.md](PR05-QA-HANDOFF.es.md):
- **§4.1, experimento 1** sobre `0e81321` con lab1: not_compatible, con 22–26
  éxitos de 60. Sirvió para encontrar un defecto de compactación del producto,
  la caché de prompts de llama-server y dos defectos del propio arnés.
- **§4.2, experimento 2** sobre `81c05f6` con lab2, que ya incluye esas
  correcciones: not_compatible, con 27–29 éxitos de 60.
  - Sin infracciones ni huecos de evidencia.
  - La RAM baja a 0,55 de la reserva.
  - STORAGE sigue en 0/10.
  - El p95 del primer evento útil sigue en infinito por READ-06 y READ-07.

  Lo que falta es calidad del modelo con el diseño actual del agente; ya no
  quedan defectos de infraestructura.
- **§4.3, experimento 3** sobre `7956db7`: el flujo por intención de
  [PR05-AGENT-FLOW-HANDOFF.es.md](PR05-AGENT-FLOW-HANDOFF.es.md) con el corpus
  v3. Resultado not_compatible, con 24–27 éxitos de 60.
  - STORAGE sube a 3–4/10 y el p95 del primer evento útil baja a 1,1–1,2 s.
  - DOWNLOAD cae a 1–2/10 por defectos del propio cambio, corregidos en
    `25849f4`.
- **§4.4, experimento 4** sobre `25849f4`. Resultado not_compatible, con 36–38
  éxitos de 60, el mejor hasta ahora.
  - Todo el rendimiento cumple su umbral.
  - Las 3 infracciones de alcance por pasada vienen de una carrera del arnés en
    STORAGE-09, no del agente.
  - Lo que falta depende de la obediencia del modelo y de oráculos que no
    reconocen respuestas correctas.

**P11 no está cerrada:** G10 sigue en rojo por calidad y por clase de
evidencia (`local-lab`).

Los cuatro se conservan en `evals/evidence/`, y `current.json` apunta al último.
