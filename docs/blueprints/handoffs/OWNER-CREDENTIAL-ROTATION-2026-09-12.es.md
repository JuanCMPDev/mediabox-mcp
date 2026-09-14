# Rotación de la credencial owner — 2026-09-12

Acción autorizada: cerrar la exposición de la clave que estuvo versionada en
`packages/ui/.env.local` desde `eae8b10`. Base de código inspeccionada: `132a45a`.
Este registro no contiene credenciales ni cambia el estado de G10.

## Inventario y alcance

Se comparó la clave histórica en memoria, sin imprimirla ni pasarla como argumento
de línea de comandos, con las configuraciones locales identificadas.

| Ubicación | Resultado anterior a la rotación |
|---|---|
| `packages/ui/.env.local` | Única copia encontrada de la clave expuesta; API configurada en `http://localhost:3000`. |
| `packages/mcp-server/.env` | No existía; tampoco había un backend de desarrollo activo. |
| Stack indicado por el estado de Desktop, en `%APPDATA%/dev.mediabox.os/stack/.env` | Su clave owner es diferente de la expuesta. No se modificó. |
| Estado de Desktop y configuraciones existentes de clientes Codex/Claude | Sin coincidencias de la clave expuesta. |
| Variables de entorno del proceso, usuario y máquina | Sin coincidencias de la clave expuesta. |
| Procesos, servicios Windows y contenedores locales | Ninguna instancia Mediabox activa ni listener en el puerto 3000. |

También se buscaron coincidencias en los archivos de texto del repositorio y del
stack identificado, incluidos archivos ignorados y ocultos, excluyendo Git,
dependencias, `target`, medios y descargas; límite de 20 MiB por archivo. No es
un inventario de otros equipos, backups externos o copias del historial de Git.

## Cambios realizados

- Sustituida la clave de la UI por una nueva de 256 bits generada con
  `crypto.randomBytes(32)`.
- Creado `packages/mcp-server/.env` para el backend de desarrollo al que apunta
  esa UI, con la misma clave owner, una clave agent independiente, identificador
  de instalación propio y escucha en loopback. No se copiaron secretos del stack
  Desktop ni se inició una instalación permanente.
- Ambos archivos permanecen ignorados por Git. Sus ACL de Windows tienen la
  herencia deshabilitada y permiten acceso únicamente al propietario del puesto,
  SYSTEM y administradores.
- No se modificaron la clave del stack Desktop, bibliotecas, bases de datos
  existentes, contenedores ajenos ni el historial de Git.

## Sesiones y verificación

No había un proceso Mediabox activo que conservara sesiones de la credencial
anterior. El registro de sesiones delegadas vive en memoria; no hay una tabla de
tokens persistentes que requiera revocación adicional en esta instalación parada.

Se ejecutó una instancia HTTP temporal del servidor real compilado, en un puerto
aleatorio de loopback, cargando las nuevas credenciales persistidas. La base de
datos de verificación estaba en memoria y las raíces de archivos eran temporales.
No se ejecutaron herramientas multimedia ni inferencia.

Las 18 comprobaciones de HTTP y estado pasaron:

| Comprobación | Resultado |
|---|---|
| Clave retirada: listar/crear sesiones, acceder a setup e inicializar MCP | `401` en todos los casos. |
| Clave nueva, leída de la configuración de la UI: acceso owner | `200`. |
| Clave nueva: setup e inicialización MCP | `200`. |
| Clave agent: administración de sesiones | `403`. |
| Crear sesiones owner/agent de verificación y usarlas antes de revocar | Creación `201`; acceso permitido `200`. |
| `POST /api/auth/sessions/revoke-all` | `200`. |
| Sesión owner revocada y reutilización del transporte MCP de la sesión agent revocada | `401`. |
| Clave owner nueva después de revocar | `200`; cero sesiones delegadas activas. |

La instancia de verificación se cerró y sus directorios temporales se retiraron.
Estos resultados acreditan las credenciales locales y la revocación en el servidor
real; no son una prueba contra un despliegue permanente que estuviera ejecutándose.

## Estado

La copia comprometida de la configuración local de desarrollo quedó sustituida y
el servidor local quedó sincronizado con su consumidor. La clave histórica sigue
en Git, por decisión expresa de mantener separada la limpieza del historial.

No se ha identificado una instalación remota que use esa clave. Si existe una
copia en otro equipo, requiere inventario y rotación allí; no queda acreditada por
esta comprobación local. PR05 continúa pendiente de calidad y evidencia confiable
en G10, según el handoff de QA.
