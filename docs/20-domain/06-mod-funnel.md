# MOD-FUNNEL — Lead stages e progressão de funil

## 1. Identidade

- **ID:** MOD-FUNNEL
- **Tipo:** Core
- **Dono conceitual:** MARKETER (semântica) + DOMAIN (regras de transição)

## 2. Escopo

### Dentro
- `lead_stages` por `(lead_id, launch_id, stage)` com unique parcial onde `is_recurring=false`.
- `funnel_templates` — presets globais e templates workspace-scoped com blueprint JSONB.
- `launches.funnel_blueprint` — cópia editável do blueprint do template, armazenada por launch.
- `launches.funnel_template_id` — FK para o template de origem (SET NULL on delete).
- Resolução dinâmica de stages via blueprint (`source_events` + `source_event_filters`).
- Transições válidas entre stages canônicos (`registered` → `engaged` → `purchased` → `refunded`).
- Stages recorrentes para webinar (`watched_class_1`, `watched_class_2`, etc.).
- Cálculo de progresso de funil para dashboard.
- Scaffolding de pages e audiences a partir de um template via `scaffoldLaunch()`.

### Fora
- Custom stages (operador define stage names — sistema só impõe regras estruturais).
- Score de ICP (`MOD-ENGAGEMENT`).

## 3. Entidades

### FunnelTemplate (Sprint 10)

Tabela `funnel_templates`. Armazena presets do sistema e templates workspace-scoped.

| Campo | Tipo | Descrição |
|---|---|---|
| `id` | uuid PK | Identificador interno |
| `workspace_id` | uuid NULL | NULL = preset global; NOT NULL = template do workspace |
| `slug` | text NOT NULL | Identificador único dentro do escopo (workspace ou global) |
| `name` | text NOT NULL | Nome legível |
| `description` | text | Descrição opcional |
| `blueprint` | jsonb NOT NULL | Blueprint completo do funil (validado por FunnelBlueprintSchema) |
| `is_system` | boolean DEFAULT false | true = gerenciado pelo GlobalTracker |
| `status` | text DEFAULT 'active' | 'active' ou 'archived' |
| `created_at`, `updated_at` | timestamptz | Timestamps |

**INV-FUNNEL-001:** slug único por `(COALESCE(workspace_id::text, '_global'), slug)` — índice único `uq_funnel_templates_workspace_slug`.

**INV-FUNNEL-002:** templates com `is_system=true` exigem `workspace_id IS NULL` — check constraint `chk_funnel_templates_system_no_workspace`.

**RLS:** presets globais (`workspace_id IS NULL`) visíveis a todos os usuários autenticados; templates workspace-scoped seguem o padrão dual-mode da migration 0028: `app.current_workspace_id` (Edge Worker GUC) ou `public.auth_workspace_id()` (Supabase JWT). INSERT/UPDATE/DELETE restritos ao membro do workspace.

**Presets globais** (seeded na migration 0029, UUIDs fixos para referência estável em testes):

| Slug | UUID |
|---|---|
| `lancamento_gratuito_3_aulas` | `a1000000-0000-0000-0000-000000000001` |
| `lancamento_pago_workshop_com_main_offer` | `a1000000-0000-0000-0000-000000000002` |
| `lancamento_pago_workshop_apenas` | `a1000000-0000-0000-0000-000000000003` |
| `evergreen_direct_sale` | `a1000000-0000-0000-0000-000000000004` |

### FunnelBlueprint (shape do JSONB)

Validado pelo `FunnelBlueprintSchema` (Zod) na camada Edge antes de qualquer persistência.

```ts
{
  version: number,          // int positivo, default 1
  type?: string,            // ex: 'lancamento_gratuito', 'lancamento_pago', 'evergreen'
  has_main_offer?: boolean,
  has_workshop?: boolean,
  stages: BlueprintStage[],
  pages: BlueprintPage[],
  audiences: BlueprintAudience[]
}

BlueprintStage {
  slug: string,             // max 64 chars — vira o valor de lead_stages.stage
  label?: string,
  is_recurring: boolean,
  source_events: string[],  // event_name values que disparam este stage
  source_event_filters?: Record<string, unknown>  // predicados AND adicionais (ver §3.1)
}

BlueprintPage {
  role: string,             // PageRole: 'capture' | 'sales' | 'thankyou' | 'webinar' | 'checkout' | 'survey'
  suggested_public_id?: string,   // max 64 chars
  event_config?: Record<string, unknown>
}

BlueprintAudience {
  slug: string,             // max 64 chars — usado como public_id na inserção
  name: string,
  platform: 'meta' | 'google',
  query_template?: Record<string, unknown>  // DSL placeholder — wired Sprint 11+
}
```

### launches (colunas adicionadas na migration 0029)

| Campo | Tipo | Descrição |
|---|---|---|
| `funnel_template_id` | uuid NULL FK → funnel_templates(id) ON DELETE SET NULL | Template de origem |
| `funnel_blueprint` | jsonb NULL | Cópia editável do blueprint no momento do scaffolding. Alterações aqui não afetam o template. |

### LeadStage
- `id`, `workspace_id`
- `launch_id` (FK)
- `lead_id` (FK)
- `stage` (text — nome do stage; vem do `slug` do `BlueprintStage` ou do fallback hardcoded)
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

### Resolução dinâmica de stages via blueprint (Sprint 10)

O processor (`raw-events-processor.ts`) resolve stages via blueprint quando `launches.funnel_blueprint` não é NULL.

**Caminho dinâmico (blueprint presente):**

1. `getBlueprintForLaunch(launchId, db)` busca e parseia o blueprint, com cache module-level por `launchId` (TTL 60 s em produção; sobrescrito via `globalThis.BLUEPRINT_CACHE_TTL_MS` em testes).
2. Para cada stage do blueprint, `matchesStageFilters(event_name, custom_data, stage)` verifica:
   - `event_name` está em `stage.source_events`, AND
   - Cada `source_event_filters[key]` === `custom_data[key]` (AND logic, null-safe: campo ausente no payload → sem match).
3. Todos os stages que passam no filtro são inseridos via `insertLeadStageIgnoreDuplicate()`.

**Caminho de fallback (blueprint NULL ou ausente):**

- `Lead` | `lead_identify` → stage `lead_identified`, `is_recurring=false`
- `Purchase` → stage `purchased`, `is_recurring=false`

**Limitação conhecida — `source_event_filters.funnel_role`:**

Stages que filtram por `funnel_role` (ex.: `{"funnel_role": "workshop"}`) apenas funcionam quando a Sprint 11 (Fase 3) injeta `funnel_role` no payload do evento. Antes da Sprint 11, eventos `Purchase` sem `funnel_role` no `custom_data` não fazem match nesses stages e caem no fallback genérico `purchased`. Isso é intencional e backward-compatible.

### scaffoldLaunch() (Sprint 10)

Função `apps/edge/src/lib/funnel-scaffolder.ts`. Executada de forma assíncrona via `waitUntil` no `POST /v1/launches` quando `funnel_template_slug` é fornecido.

**Passos (dentro de uma única transaction Drizzle):**

1. Busca `funnel_templates` por slug — workspace-scoped tem prioridade sobre sistema global (`ORDER BY workspace_id NULLS LAST`).
2. Parseia blueprint com `FunnelBlueprintSchema.safeParse()`.
3. Insere pages: `ON CONFLICT (launch_id, public_id) DO NOTHING`.
4. Insere audiences: `ON CONFLICT (workspace_id, public_id) DO NOTHING`.
5. `UPDATE launches SET funnel_blueprint, funnel_template_id, updated_at`.

**Idempotência:** chamar `scaffoldLaunch()` duas vezes com o mesmo `launchId` não gera duplicatas (ON CONFLICT DO NOTHING).

**BR-RBAC-002:** todas as inserções escoopadas ao `workspaceId` do chamador.

**BR-PRIVACY-001:** `safeLog` recebe apenas campos não-PII.

## 7. Invariantes

- **INV-FUNNEL-001 — Unique parcial em stages não-recorrentes.** `unique (workspace_id, launch_id, lead_id, stage) where is_recurring = false`. Testável.
- **INV-FUNNEL-002 — `source_event_id` (quando presente) referencia evento do mesmo workspace e lead.** Validador. Testável.
- **INV-FUNNEL-003 — `stage` é não-vazio e tem comprimento ≤ 64.** Validador. Testável.
- **INV-FUNNEL-004 — Stages do mesmo lead em launches diferentes não conflitam.** Implícito via constraint. Testável.
- **INV-FUNNEL-005 — `funnel_templates.slug` único por escopo (workspace ou global).** Índice único `uq_funnel_templates_workspace_slug` em `COALESCE(workspace_id::text, '_global')`. Testável.
- **INV-FUNNEL-006 — Templates com `is_system=true` têm `workspace_id IS NULL`.** Check constraint `chk_funnel_templates_system_no_workspace`. Testável.
- **INV-FUNNEL-007 — `launches.funnel_blueprint` é snapshot imutável em relação ao template.** Alterações pós-scaffolding no template não afetam blueprints já gravados em launches. Validador conceitual.

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
- `packages/db/src/schema/funnel_template.ts`
- `packages/db/migrations/0029_funnel_templates.sql`
- `apps/edge/src/lib/funnel.ts`
- `apps/edge/src/lib/funnel-scaffolder.ts`
- `apps/edge/src/routes/funnel-templates.ts`
- `apps/edge/src/routes/launches.ts` (campos funnel_*)
- `apps/control-plane/src/app/(app)/launches/[launch_public_id]/funnel/page.tsx`
- `tests/unit/funnel/**`
- `tests/integration/funnel/**`

**Lê:**
- `apps/edge/src/lib/lead-resolver.ts`
- `apps/edge/src/lib/launch.ts`
- `apps/edge/src/lib/raw-events-processor.ts` (seção blueprint cache + matchesStageFilters)

## 13. Dependências permitidas / proibidas

**Permitidas:** `MOD-IDENTITY`, `MOD-LAUNCH`, `MOD-EVENT` (referência).
**Proibidas:** `MOD-DISPATCH`, `MOD-AUDIENCE`.

## 14. Test harness

- `tests/integration/funnel/unique-non-recurring.test.ts` — INV-FUNNEL-001.
- `tests/integration/funnel/recurring-allows-multiple.test.ts` — `watched_class_1` registrado 2× ok.
- `tests/integration/funnel/cross-launch-isolation.test.ts` — INV-FUNNEL-004.
