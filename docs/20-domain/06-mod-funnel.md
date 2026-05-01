# MOD-FUNNEL — Lead stages e progressão de funil

## 1. Identidade

- **ID:** MOD-FUNNEL
- **Tipo:** Core
- **Dono conceitual:** MARKETER (semântica) + DOMAIN (regras de transição)

## 2. Escopo

### Dentro
- `lead_stages` por `(lead_id, launch_id, stage)` com unique parcial onde `is_recurring=false`.
- Transições válidas entre stages canônicos (`registered` → `engaged` → `purchased` → `refunded`).
- Stages recorrentes para webinar (`watched_class_1`, `watched_class_2`, etc.).
- Cálculo de progresso de funil para dashboard.

### Fora
- Custom stages (operador define stage names — sistema só impõe regras estruturais).
- Score de ICP (`MOD-ENGAGEMENT`).

## 3. Entidades

### LeadStage
- `id`, `workspace_id`
- `launch_id` (FK)
- `lead_id` (FK)
- `stage` (text — nome do stage, vindo do `event_config` da página)
- `source_event_id` (FK opcional, aponta o evento que gerou o stage)
- `ts`
- `is_recurring` (boolean — controla unique parcial)

## 4. Relações

- `LeadStage N—1 Lead`
- `LeadStage N—1 Launch`
- `LeadStage N—1 Event` (FK opcional)

## 5. Estados (lógicos, não em banco)

Stages canônicos sugeridos (operador pode customizar):

```
[viewed] → [engaged] → [registered] → [survey_completed] → [icp_qualified]
                                  → [watched_class_1] → [watched_class_2] → [watched_class_3]
                                  → [initiated_checkout] → [purchased]
                                                       → [refunded]
```

`viewed`, `engaged`, `watched_class_*` podem ser recorrentes (operador decide via `event_config`).

## 6. Transições válidas

Sem state machine rígida — a progressão depende do funil do operador. Sistema impõe apenas:
- Stage não-recorrente é único por `(lead_id, launch_id, stage)`.
- Stage recorrente pode ter múltiplos registros (mesmo `(lead_id, launch_id, stage)` em diferentes `ts`).

Validação opcional ao registrar stage: avisar se transição "incomum" (ex.: `purchased` antes de `registered`) — log/warn, mas não bloquear.

## 7. Invariantes

- **INV-FUNNEL-001 — Unique parcial em stages não-recorrentes.** `unique (workspace_id, launch_id, lead_id, stage) where is_recurring = false`. Testável.
- **INV-FUNNEL-002 — `source_event_id` (quando presente) referencia evento do mesmo workspace e lead.** Validador. Testável.
- **INV-FUNNEL-003 — `stage` é não-vazio e tem comprimento ≤ 64.** Validador. Testável.
- **INV-FUNNEL-004 — Stages do mesmo lead em launches diferentes não conflitam.** Implícito via constraint. Testável.

## 8. BRs relacionadas

- `BR-FUNNEL-001` — Stage `purchased` é único por compra única (não cobra refund automático).

## 9. Contratos consumidos

- `MOD-EVENT.acceptRawEvent()` (passa `source_event_id`).
- `MOD-IDENTITY.resolveLeadByAliases()` (lead_id já resolvido pelo processor antes de chamar `recordStage`).

## 10. Contratos expostos

- `recordStage(lead_id, launch_id, stage, source_event_id, is_recurring, ctx): Result<LeadStage, AlreadyRecorded | InvalidStage>`
- `getLeadStages(lead_id, launch_id): Promise<LeadStage[]>`
- `getFunnelSnapshot(launch_id, time_range): Promise<{stage: string, count: number}[]>`

## 11. Eventos de timeline emitidos

- `TE-LEAD-STAGE-RECORDED`
- `TE-LEAD-STAGE-DUPLICATE-IGNORED` (quando insert idempotente)

## 12. Ownership de código

**Pode editar:**
- `packages/db/src/schema/lead_stage.ts`
- `apps/edge/src/lib/funnel.ts`
- `tests/unit/funnel/**`
- `tests/integration/funnel/**`

**Lê:**
- `apps/edge/src/lib/lead-resolver.ts`
- `apps/edge/src/lib/launch.ts`

## 13. Dependências permitidas / proibidas

**Permitidas:** `MOD-IDENTITY`, `MOD-LAUNCH`, `MOD-EVENT` (referência).
**Proibidas:** `MOD-DISPATCH`, `MOD-AUDIENCE`.

## 14. Test harness

- `tests/integration/funnel/unique-non-recurring.test.ts` — INV-FUNNEL-001.
- `tests/integration/funnel/recurring-allows-multiple.test.ts` — `watched_class_1` registrado 2× ok.
- `tests/integration/funnel/cross-launch-isolation.test.ts` — INV-FUNNEL-004.
