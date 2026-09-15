# PR05 — Controlador confiable local de G10

Fecha: 2026-09-14. Diseño y operación del controlador que produce la evidencia
`trusted-controller` de G10 en el puesto del mantenedor. Aplica la revisión de
la regla del [blueprint §7.5](../LOCAL-AGENT-HARDENING.es.md) y del
[contrato de PR05 §5](PR05-P10-P11-SPEC.es.md). El estado de P11 está en
[PR05-QA-HANDOFF.es.md](PR05-QA-HANDOFF.es.md).

## 1. Decisión

El contrato pedía una máquina o VM aislada y desechable. El proyecto tiene un
solo equipo con GPU, y el mantenedor no puede dedicarle espacio a un segundo
sistema. El 2026-09-14 decidió admitir ese puesto como controlador confiable,
con las condiciones de §2, que se comprueban en cada ejecución.

El perfil lab3 es este hardware: RX 7800 XT con ROCm y Ollama nativo en Windows.
El controlador local lo reproduce sin perfil ni experimento nuevos.

La confianza descansa en que el candidato es un commit revisado del mantenedor,
nunca código de forks. El controlador local no es una máquina desechable ni un
sandbox frente al candidato; §8 enumera lo que queda fuera.

## 2. Qué se garantiza y cómo se comprueba

| Condición | Cómo se impone | Comprobación antes de medir |
|---|---|---|
| Solo la cuenta dedicada produce evidencia confiable | El instalador crea `mediabox-g10`, cuenta estándar oculta en el inicio de sesión | `account`: el SID del proceso es el aprovisionado |
| Sin privilegios | Fuera del grupo Administradores | `not-administrator`: ni ese grupo ni integridad alta en el token |
| Aprovisionamiento inalterable | `C:\ProgramData\mediabox-g10` solo lo modifican administradores | `provisioning-read-only` |
| Sin perfil ni datos del mantenedor | El perfil es privado por defecto; permiso denegado en los otros discos locales y en las carpetas de C:\ que no son de Windows | `maintainer-profile`, `denied-paths`, `drives`, que también rechaza soportes extraíbles legibles |
| Sin red doméstica | Regla de salida de la cuenta hacia redes privadas | `lan-blocked`: la puerta de enlace devuelve `EACCES` del cortafuegos |
| Procesos evaluados solo en loopback | Reglas por programa para el Node de evaluación, Ollama, llama-server y ffmpeg | `eval-loopback-only`: loopback conecta; direcciones pública y privada devuelven `EACCES` |
| Cortafuegos activo | Perfiles de Windows | `firewall-profiles`, `firewall-rules` |
| Sin sockets del host | La cuenta no pertenece a `docker-users` | `host-sockets`: los pipes de Docker no responden |
| Sin credenciales del controlador | Runner JIT de un solo job; el paso que evalúa no recibe token; checkout sin credenciales persistidas | El verificador confirma el run con GitHub (§3) |
| Candidato exacto y revisado | Solo una etiqueta `g10/` del mantenedor lanza el workflow | El controlador exige que el job y el workflow sean el commit evaluado |
| Mismo perfil | Copias del runtime, los pesos y el toolchain verificadas contra el perfil sellado | El runner compara CPU, RAM, SO, GPU, driver y librerías del runtime; una deriva aborta el run |

Un solo fallo detiene la ejecución antes de medir. El manifiesto guarda los
once resultados en `controller.isolation`, sin rutas del host ni el SID.

## 3. Vínculo entre la evidencia y el run

1. El mantenedor empuja la etiqueta `g10/<sha8>-<fecha>` sobre el commit
   revisado. Los PR y los forks no pueden hacerlo.
2. El workflow [`g10-controller.yml`](../../../.github/workflows/g10-controller.yml)
   asigna el job del controlador al runner `self-hosted` con la etiqueta
   `mediabox-g10`. Ese runner solo existe mientras dura la ejecución.
3. El controlador comprueba el aislamiento, crea un worktree limpio, instala,
   compila y ejecuta las 180 evaluaciones con el Node de evaluación.
4. El manifiesto registra repositorio, run, intento, referencia y commit del
   workflow, evento, etiqueta, runner y el resultado del aislamiento.
5. Un job alojado por GitHub publica en el commit el estado
   `g10/trusted-controller`, con el sha256 del `SHA256SUMS` del paquete y el ID
   del experimento. La máquina local nunca recibe un token de escritura.
6. En CI, `ci:verify-evidence` confirma con la API de GitHub:
   - el intento terminado con éxito sobre el candidato;
   - el workflow, el evento de etiqueta y el repositorio;
   - el runner autoalojado con la etiqueta `mediabox-g10`, que es el que figura
     en el manifiesto;
   - que todos los jobs terminaron bien;
   - que el estado del commit contiene el digest del paquete commiteado.

La política está en el verificador (`TRUSTED_CONTROLLER_POLICY`), no en el
controlador, así que un cambio del controlador no puede relajarla. El
repositorio exige además aprobación para los workflows de cualquier
colaborador externo, de modo que un PR ajeno no puede quedarse con el runner.

## 4. Aprovisionamiento (una vez)

Los ficheros ya están preparados en `E:\mediabox-g10`. La preparación no
necesita administrador y no cambia ningún permiso ajeno a esa carpeta:

    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\controller\Install-G10Controller.ps1 -StageOnly

Queda la parte de administrador. Desde una PowerShell elevada abierta por el
mantenedor, en el repositorio:

    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\controller\Install-G10Controller.ps1

El script repite la verificación de la preparación y además:
1. Crea la cuenta `mediabox-g10` con una contraseña aleatoria. La guarda
   cifrada con DPAPI para el mantenedor en
   `%LOCALAPPDATA%\mediabox-g10\account.clixml`.
2. Da a la cuenta lectura sobre `E:\mediabox-g10` y escritura solo en
   `storage`, `tmp`, `npm-cache` y `runner`.
3. Añade las reglas del grupo de cortafuegos `mediabox-g10` y las prueba como
   la cuenta: la puerta de enlace privada y una dirección pública desde el Node
   de evaluación deben devolver `EACCES`. Si no, se detiene antes de tocar
   ningún permiso de los discos.
4. Deniega a la cuenta D:\, E:\ y las carpetas de C:\ que no son de Windows.
   **Esto reescribe los permisos heredados de todos los ficheros de esos
   discos y puede tardar mucho en discos grandes.** Se puede interrumpir y
   volver a lanzar.
5. Escribe `C:\ProgramData\mediabox-g10\controller.json` y el lanzador de Node
   que usa el workflow.
6. Ejecuta las comprobaciones de §2 como la cuenta y lee los contadores de
   memoria de la GPU con ella.

Si la unidad USB `F:` está conectada, `drives` falla: FAT32 no tiene permisos.
Basta con desconectarla.

## 5. Ensayo y ejecución real

Desde una PowerShell normal, sin elevar, en el repositorio:

    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\controller\Start-G10Controller.ps1 -Rehearsal
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\controller\Start-G10Controller.ps1 -Sha <commit>

El lanzador:
1. Comprueba que el commit está en GitHub y que no hay unidades extraíbles.
2. Para el Ollama del mantenedor.
3. Registra un runner JIT, empuja la etiqueta y arranca el runner como la
   cuenta. El runner corre desde una copia nueva en el perfil de la cuenta,
   porque exige poder listar cada carpeta padre y la cuenta no puede listar
   E:\. Sus logs de diagnóstico vuelven a `E:\mediabox-g10\runner\_diag`. Por
   la misma razón, el worktree y los temporales del run van a la carpeta
   temporal del job, dentro de ese perfil: esbuild también lee cada carpeta
   padre. El almacenamiento, los pesos y el toolchain siguen en
   `E:\mediabox-g10`.
4. Sigue el run, retira el registro del runner si sigue ahí y vuelve a
   arrancar Ollama.

El ensayo (`g10-rehearsal/`) recorre el mismo camino con dos escenarios y una
pasada. Nunca produce evidencia. Tarda unos diez minutos.

La ejecución real tarda unos 40 minutos. Durante ese tiempo el equipo no debe
usarse, porque los umbrales de rendimiento se miden en él.

## 6. Evidencia y G10

Tras una ejecución real con éxito, el lanzador:
1. Lee el ID del experimento en el estado `g10/trusted-controller`.
2. Copia el paquete de `E:\mediabox-g10\storage\<id>\package` a
   `evals/evidence/<id>` y apunta `current.json` a él.
3. Lo verifica con las observaciones crudas y un token de `gh`.

Queda commitear la evidencia en la rama del candidato y empujarla. G10 pasa en
el PR, y después en integración, porque desde el candidato solo cambian
`evals/evidence/` y `docs/`.

## 7. Almacenamiento

Las observaciones crudas quedan en `E:\mediabox-g10\storage\<id>`, legibles solo
por el mantenedor, la cuenta, SYSTEM y los administradores. PR05 exige
conservarlas al menos 90 días. No se suben como artefacto porque el
repositorio es público.

## 8. Límites que quedan

- **Mismo sistema operativo.** Un candidato malicioso que corriera como la
  cuenta podría persistir en su perfil o en sus carpetas con escritura. Por eso
  solo se evalúan commits revisados del mantenedor.
- **Lecturas del sistema.** La cuenta sigue leyendo lo que cualquier usuario
  local lee en `C:\Windows`, `C:\Program Files` y partes de `C:\ProgramData`.
- **Loopback.** El cortafuegos de Windows no filtra loopback. Los servicios
  que el mantenedor tenga en `localhost` son alcanzables. El oráculo de egress
  marca como infracción cualquier conexión a un puerto que el arnés no declaró.
- **DNS.** La resolución de nombres pasa por el cliente DNS del sistema, no por
  el proceso evaluado; ya figuraba en las limitaciones de la evidencia.
- **Salida a Internet.** npm, git y el runner salen a Internet, porque la
  instalación y GitHub la necesitan. El Node de evaluación, el runtime y
  ffmpeg no.
- **Token del job.** El token de solo lectura del job vive en la memoria del
  runner, dentro de la misma cuenta.
- **Máquina persistente.** El equipo no es desechable, y el rendimiento exige
  no usarlo durante la ejecución.

## 9. Problemas frecuentes

| Síntoma | Causa probable | Qué hacer |
|---|---|---|
| `drives` falla con `F:\` | Unidad USB conectada | Desconectarla |
| `lan-blocked` recibe `ECONNREFUSED`, `timeout` o `connected` | La regla por cuenta no se aplica o hay otro cortafuegos | Revisar `Get-NetFirewallRule -Group mediabox-g10`; sin esa regla no hay run confiable |
| `eval-loopback-only` con `public connected` | La regla no apunta al Node de evaluación | Volver a ejecutar el instalador |
| La deriva del perfil aborta el run | Driver o Windows actualizados | Recoger un perfil nuevo; exige un experimento nuevo |
| El runner no toma el job | Workflow ausente en el commit o etiqueta distinta | El lanzador retira el registro a los cinco minutos; comprobar la etiqueta `g10/` |
| `npm ci` falla | Sin salida a Internet para npm | La cuenta necesita el registro de npm; el cortafuegos solo cierra redes privadas |

## 10. Desinstalación

Desde una PowerShell elevada:

    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\controller\Uninstall-G10Controller.ps1

Retira las reglas, las denegaciones, la cuenta con su perfil, el
aprovisionamiento y la contraseña guardada. `-RemoveFiles` borra también
`E:\mediabox-g10`, observaciones incluidas.

## 11. Estado

| Paso | Estado |
|---|---|
| Código, workflow y verificador | Hecho |
| Preparación de ficheros en `E:\mediabox-g10` | Hecha el 2026-09-14; los nueve controles coinciden con lab3 |
| Ensayo del runtime preparado, en modo laboratorio | Hecho el 2026-09-14 con la cuenta del mantenedor (`pr05-g10-20260914T224836-2ae5a5fa`, clase `dev`): sin deriva del perfil, 2 de 2 escenarios, tres arranques en frío de unos 9 s, VRAM en 0,57 de la reserva, transcodificación sin OOM y ninguna conexión fuera del arnés |
| Aprobación de workflows externos en el repositorio | Activada el 2026-09-14 |
| Aprovisionamiento como administrador | Hecho el 2026-09-14: las once comprobaciones y los contadores de GPU, correctos; la reescritura de permisos de D:\ tardó unos 27 minutos |
| Ensayo en Actions | Pasó al cuarto intento, sobre `c605e06`. Los tres anteriores fallaron en el lanzador y en las rutas, y se corrigieron (§12) |
| Ejecución real | `pr05-g10-20260915T013942-c605e060` sobre `c605e06`, run 34918137989: compatible, con 60, 60 y 59 de 60 y todo el rendimiento dentro de umbral |

## 12. Primer uso

El primer uso, el 2026-09-14, encontró cinco problemas del instalador y del
lanzador. Todos se corrigieron antes de la ejecución real, y ninguno produjo
evidencia.

| Síntoma | Causa | Corrección |
|---|---|---|
| El instalador falla al crear la cuenta | Windows limita la descripción de una cuenta local a 48 caracteres | Descripción más corta, en `4f60e44` |
| El lanzador aborta en `git push` al ejecutarse con la salida redirigida | Windows PowerShell 5.1 convierte el stderr de un comando nativo en error | Los comandos nativos se juzgan por su código de salida, en `8a83514` |
| `Start-Process` falla con "El parámetro no es correcto" | CreateProcessWithLogonW admite 1024 caracteres de línea de comandos y la configuración JIT es más larga | La configuración pasa por un fichero que la cuenta lee y borra, en `7bb15dc` |
| El runner sale con `Access to the path 'E:\' is denied` | El runner exige listar cada carpeta padre y la cuenta no puede listar E:\ | El runner corre desde una copia en el perfil de la cuenta, en `04350a9` |
| `tsup` falla con "Cannot read directory: Access is denied" | esbuild lee cada carpeta padre del proyecto | El worktree va a la carpeta temporal del job, en `c605e06` |
