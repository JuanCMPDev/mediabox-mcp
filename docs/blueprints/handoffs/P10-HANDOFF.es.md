# Cierre de Fase P10 — Despliegue local y privacidad verificable

Cierre de la fase P10 del [blueprint](../LOCAL-AGENT-HARDENING.es.md) contra el
[contrato PR05](PR05-P10-P11-SPEC.es.md) §3. Sustituye al cierre del 2026-09-11,
que declaraba G09 aprobado con pruebas en proceso (un resolver simulado con un
mapa JavaScript, `fs.renameSync` como "plan aprobado" e inspección de YAML). La
auditoría y el estado consolidado del lote están en
[PR05-QA-HANDOFF.es.md](PR05-QA-HANDOFF.es.md).

| Campo | Valor |
|---|---|
| Fase | P10 — despliegue local y privacidad observables |
| Lote | PR05, rama `work/local-agent/p10-p11-private-evals` → `integration/local-agent-v1` |
| Base | `79d2d16` (merge de PR04) |
| Gates | G09 `gate/local-egress`; regresión G00–G08 |
| Fecha | 2026-09-12 |

## 1. Qué entrega P10

### 1.1 Perfiles y topología (`packages/core/src/generators/docker-compose.ts`)

- `offline-library` y `local-agent-online-media`: `mcp-server` e inferencia solo
  en redes `internal: true` (`mediabox-inference-net`, `mediabox-services-net`);
  en online-media, descargadores, indexador y *arr también en
  `mediabox-external-net`. El generador se niega a emitir un perfil estricto en
  el que `mcp-server` o la inferencia se unan a una red no interna o publiquen
  puertos. Sin perfil, la salida es idéntica byte a byte a la anterior.
- **Defecto corregido, verificado en Docker:** un contenedor conectado solo a
  redes internas no publica puertos (`docker port` vacío, conexión rechazada).
  El cierre anterior declaraba `ports:` en `mcp-server` y Jellyfin, que en ambos
  perfiles estrictos quedaban inalcanzables para el owner. Ahora `mediabox-edge`
  (`alpine/socat` fijado por digest, `read_only`, `cap_drop: [ALL]`,
  `no-new-privileges`, usuario 65534) está en `mediabox-edge-net` y reenvía solo
  3000→mcp-server y 8096/8920→Jellyfin. Si un reenviador muere, el contenedor
  sale y se reinicia. Los servicios que solo tienen redes internas ya no declaran
  `ports:`.
- Telegram y `cloudflared` no existen en `offline-library`.

### 1.2 Artefactos por digest, preparación separada de ejecución

- `packages/core/src/artifacts/lock.ts`: `ArtifactLock` con, por imagen,
  `platformDigest` y el índice multiarquitectura, y por modelo, el digest del
  manifiesto y sus capas. `applyArtifactLock` fija `repo@sha256:…` y
  `pull_policy: never`; una imagen sin entrada en el lock es un error.
- `deployStack` en perfil estricto añade la fase `deploy:prepare-artifacts`:
  1. resuelve cada imagen para la plataforma del daemon;
  2. escribe `artifacts.lock.json` y el compose fijado;
  3. ejecuta el aprovisionador;
  4. verifica el manifiesto del modelo con
     `createArtifactManifest`/`verifyOrProvisionArtifact("run")`;
  5. escribe `LOCAL_LLM_MODEL_DIGEST` en `.env`.

  `deploy:start` relee el compose y se niega a arrancar con imágenes sin fijar;
  `up` se ejecuta con `--pull never`.
- Aprovisionador `mediabox-provisioner`: perfil `provision`, en
  `mediabox-provision-net`, comparte el volumen de modelos. Solo actúa en la
  fase de preparación.
- llama.cpp se rechaza en perfiles estrictos (su `-hf` descarga al arrancar).

### 1.3 Ciclo de vida y admisión (`packages/core/src/runtime/lifecycle.ts`, `packages/mcp-server/src/chat/runtime-supervisor.ts`)

- Tabla de §3.3: `not_provisioned → stopped → starting → ready`, más
  `unavailable`, `error` y parada explícita.
- El `RuntimeSupervisor` del servidor arranca el runtime al levantar el proceso,
  fuera de cualquier turno: consulta la salud cada 30 s durante 120 s como
  máximo. Con salud correcta verifica el digest fijado contra `/api/tags` del
  runtime. En un perfil estricto se niega a pasar a `ready` si el digest no está
  fijado (`ERR_ARTIFACT_UNPINNED`), no coincide (`ERR_ARTIFACT_MISMATCH`), falta
  (`ERR_ARTIFACT_MISSING`) o el runtime no permite verificarlo
  (`ERR_ARTIFACT_UNVERIFIABLE`). Nunca descarga.
- Admite una inferencia a la vez: un segundo turno recibe 429
  `ERR_INFERENCE_CONCURRENCY_EXCEEDED`. Un fallo durante el turno marca el
  runtime `unavailable` y lo vuelve a comprobar en segundo plano, sin fallback a
  la nube.

### 1.4 Endpoints, credenciales y diagnóstico

- `endpoint-policy.ts`: rechaza credenciales en la URL. Cada nombre conserva la
  primera IP validada durante toda la vida del proceso: un cambio de respuesta
  DNS entre peticiones se trata como rebinding. Antes solo se fijaba dentro de
  cada petición y un DNS que cambiara a otra IP privada podía desviar los
  prompts siguientes.
- `privacyIsolation` en `/api/chat/info`:
  - `no-default-route` solo si el propio proceso ve su espacio de red sin ruta
    por defecto (IPv4 e IPv6);
  - `unverified-native` fuera de Linux;
  - `default-route-present` en los demás casos.

  La UI muestra el perfil estricto como "no verificado" salvo con
  `no-default-route`: un sidecar nativo no obtiene la etiqueta por escuchar en
  localhost.
- Saneador de diagnósticos por lista de campos permitidos. Además, redacta la
  query string antes que las credenciales y conserva el esquema; antes, una
  redacción ocultaba la URL a la otra.
- Encontrados por NET-05 y corregidos:
  - las URLs de `/api/dashboard/services` y `/api/setup/info` ya no incluyen
    `usuario:clave`;
  - los errores del dashboard ya no devuelven el cuerpo del servicio externo,
    solo servicio y código HTTP;
  - `VITE_INTERNAL_API_KEY` solo se lee en el servidor de desarrollo de Vite, y
    un build de producción ya no incluye la clave de owner;
  - `packages/ui/.env.local` deja de estar versionado. Contenía una clave de
    owner, que sigue en el historial de git y debe rotarse.
- Cuarentena en el sistema de archivos del propio archivo
  (`packages/mcp-server/src/storage/quarantine.ts`). El despliegue generado monta
  `/data/movies`, `/data/tv`… por separado bajo `MEDIA_PATH=/data`, y la papelera
  en `/data/.mediabox-trash` hacía fallar como cross-device todo borrado de la
  biblioteca. La papelera va ahora al directorio más alto del mismo sistema de
  archivos; restaurar, purgar, listar y verificar la localizan ahí.

## 2. G09: evidencia real (`npm run test:local-egress`)

Topología de prueba:
- Las redes y su asignación son las que emite el generador, sin cambios.
- `mcp-server` es la imagen real construida desde el árbol.
- Los servicios de terceros y Ollama se sustituyen por los servicios sintéticos
  y el runtime guionado, cada uno en sus redes generadas.
- El sink y el resolver autoritativo son contenedores aparte, con su ledger en
  un directorio del host que solo monta el sink.
- Las sondas se ejecutan en el espacio de red del candidato
  (`--network container:<id>`).
- Instrumentación explícita de la prueba: `dns:` apuntando al sink como
  resolver de origen del DNS embebido de Docker.

Sin Docker o sin imagen, la suite falla; no hay omisiones.

| Caso | Qué se observa |
|---|---|
| NET-01 | Control positivo: se entregan TCP 80/8080, UDP, DNS directo y DNS a través del resolver. `mcp-server` e inferencia en ambos perfiles: cero entregas, ni ruta por defecto IPv4/IPv6, ni acceso a direcciones públicas o de metadata. El edge solo reenvía sus puertos fijos. Metaprueba: unir los candidatos a una red no interna hace llegar las cinco formas y quitar `internal: true` les da ruta por defecto, así que el oráculo se pone en rojo. |
| NET-02 | Con egress denegado: consulta de la biblioteca por el edge con la clave de agente; turno de chat real con el modelo guionado; `privacyIsolation: no-default-route` y artefacto verificado; cuarentena aprobada por el owner con el efecto exacto en el host (el archivo en la papelera de su montaje, los vecinos idénticos byte a byte); el agente recibe 403 al intentar aprobar. Modelo ausente → `ERR_ARTIFACT_MISSING`; digest distinto → `ERR_ARTIFACT_MISMATCH`, sin pull ni inferencia. Sink vacío. |
| NET-03 | Orígenes y destinos registrados: prowlarr → indexador Torznab y qBittorrent → origen de descarga. `mcp-server` e inferencia bloqueados por nombre y por dirección. En `offline-library` nadie alcanza las fuentes. |
| NET-04 | Dentro de la imagen real, con el transporte de producción: DNS cambiante (el primer intento llega al runtime fijado y los siguientes se rechazan como rebinding), redirect, proxy heredado y claves cloud con el runtime caído. Cero bytes en el sink; el servidor real responde `ERR_PROVIDER_UNAVAILABLE` sin fallback y no registra las claves. |
| NET-05 | Canarios de formato arbitrario en el entorno, en errores de servicios, en URLs con credenciales y en frases de conversación. Se escanean `docker logs`, `/api/chat/info`, dashboard, setup, traza, el bundle de la UI construido con una clave canario y los informes de `evals/evidence/**`, en forma literal, URL-encoded, escapada en JSON y base64. |
| NET-06 | Contenedor: solo los montajes declarados (rutas con espacios y Unicode), sin socket ni pipe de Docker, sin privilegios ni capacidades añadidas, sin `DOCKER_*`, solo las dos redes internas y el endpoint de inferencia correcto. Node y Bun compilado en el host: solo loopback, endpoint configurado, `unverified-native`, efecto dentro de la raíz temporal. No ejercita la webview de Tauri. |

Resultado de la ejecución final contra el árbol candidato: ver
[PR05-QA-HANDOFF.es.md](PR05-QA-HANDOFF.es.md) §3.

## 3. Límites que siguen abiertos

- El script del aprovisionador no se ha ejecutado con la imagen real de Ollama
  (varios GB); solo se verificó su parte de compose. Si alguna de sus
  suposiciones es incorrecta, `prepare` falla cerrado por hash.
- `deployStack` no arranca por sí mismo un perfil de inferencia; el owner lo
  inicia.
- La variante nativa (sidecar Desktop, runtime en el host) no puede certificarse
  como `offline-library`; la UI lo explica. macOS no se ha ejecutado.
- El edge está en una red bridge y tiene salida a Internet por diseño; se
  demuestra que no entrega nada y que solo reenvía sus puertos fijos.
