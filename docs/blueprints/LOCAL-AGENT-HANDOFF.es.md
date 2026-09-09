# Plantilla de Delegación y Cierre de Fase (Handoff)

Documento complementario al blueprint [LOCAL-AGENT-HARDENING.es.md](./LOCAL-AGENT-HARDENING.es.md).

## Ficha del Encargo / Lote

| Campo | Valor |
|---|---|
| **Fase(s)** | [Ej. P00] |
| **Lote / PR** | [Ej. PR00] |
| **Rama de trabajo** | [Ej. fix/auth-delete-containment] |
| **Rama base** | [Ej. master o integration/local-agent-v1] |
| **Responsable** | [Integrador / Seguridad / Datos / Consultas / Agente / Integración-QA] |
| **Fecha de entrega** | [AAAA-MM-DD] |

---

## 1. Alcance y Archivos Modificados / Creados

- **Nuevos:**
  - `...`
- **Modificados:**
  - `...`

---

## 2. Invariantes y Casos de Aceptación Cubiertos

| ID de Caso | Descripción | Evidencia / Test que lo valida |
|---|---|---|
| [HAR-01] | [Descripción] | `npm run ...` -> PASS |

---

## 3. Gates Evaluados

| Gate | Check ejecutado | Resultado |
|---|---|---|
| **G00** | `npm run ci:policy` | PASS |
| **G01** | `npm run ci:typecheck && npm run ci:build && npm run ci:test` | PASS |

---

## 4. Evidencia de Ejecución Local y CI

```text
[Pegar output de tests, logs de verificación o hashes de artefactos]
```

---

## 5. Riesgos, Limitaciones o Decisiones Diferidas

- [Detallar si alguna capacidad quedó deliberadamente acotada o no soportada en esta fase según el blueprint]
