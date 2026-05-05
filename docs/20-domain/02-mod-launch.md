# MOD-LAUNCH — Lançamentos

## 1. Identidade

- **ID:** MOD-LAUNCH
- **Tipo:** Core
- **Dono conceitual:** MARKETER (operação) + OPERATOR (configuração técnica)

## 2. Escopo

### Dentro
- Lançamentos com `public_id` legível + UUID interno + status (`draft`/`configuring`/`live`/`ended`/`archived`).
- Configuração de tracking por lançamento: Pixel ID + policy, GA4 measurement_id, Google Ads customer_id e conversion_actions, Customer Match strategy.
- Configuração de produto e preço.
- Timezone do lançamento (afeta cohort e relatórios).

### Fora
- Páginas (`MOD-PAGE`).
- Links e atribuição (`MOD-ATTRIBUTION`).
- Audiences (`MOD-AUDIENCE`).
- Métricas/dashboards (consumo, não escopo).

## 3. Entidades

### Launch
- `id` (UUID interno)
- `workspace_id`
- `public_id` (slug humano, único por workspace)
- `name`
- `status` (`draft` / `configuring` / `live` / `ended` / `archived`)
- `timezone` (default `America/Sao_Paulo`)
- `config` (jsonb com tracking config + metadados opcionais de lançamento — ver abaixo)
- `created_at`, `updated_at`

### Campos opcionais em `launches.config` (JSONB)

Além da configuração de tracking (`config.tracking.*`), o JSONB `config` persiste metadados editoriais do lançamento, todos opcionais:

| Campo | Tipo | Descrição |
|---|---|---|
| `config.type` | `string` enum | Tipo do lançamento: `lancamento_gratuito`, `lancamento_pago`, `evergreen`, `outro` |
| `config.objective` | `string` | Objetivo livre (textarea) — usado internamente como contexto |
| `config.timeline.start_date` | `string` ISO date (`YYYY-MM-DD`) | Data de início planejada |
| `config.timeline.end_date` | `string` ISO date (`YYYY-MM-DD`) | Data de encerramento planejada |

`config.type` é exibido como badge na lista de lançamentos no Control Plane.

### Funnel snapshot — `launches.funnel_template_id` + `launches.funnel_blueprint`

Adicionados na migration `0029_funnel_templates.sql` (Sprint 10). Detalhe canônico em [`docs/20-domain/06-mod-funnel.md`](06-mod-funnel.md).

| Campo | Tipo | Descrição |
|---|---|---|
| `funnel_template_id` | `uuid NULL` FK → `funnel_templates(id)` | Template de origem (SET NULL on delete). |
| `funnel_blueprint` | `jsonb NULL` | Snapshot editável do blueprint do template no momento do scaffolding. Mutações posteriores no template **não afetam** o blueprint do launch (INV-FUNNEL-007). |

**Realinhamento por migration ad-hoc:** alterações pós-scaffolding em `funnel_blueprint` podem vir de:
- (a) edição via UI no Control Plane (`/launches/[public_id]/funnel`); ou
- (b) migration de realinhamento operacional, ex.: `0031_funnel_template_paid_workshop_v2.sql` (T-FUNIL-030, Sprint 12) que re-snapshot o blueprint do launch real `wkshop-cs-jun26` após reshape do template `lancamento_pago_workshop_com_main_offer` (v1 → v2). Ver ADR-026.

## 4. Relações

- `Launch N—1 Workspace`
- `Launch 1—N Page`
- `Launch 1—N Link`
- `Launch 1—N LeadAttribution` (via `lead_attribution.launch_id`)
- `Launch 1—N LeadStage`
- `Launch 1—N Event` (via `events.launch_id`, opcional — eventos sem lançamento existem)

## 5. Estados

```
[draft] → [configuring] → [live] → [ended] → [archived]
                       ↑              ↓
                       └─── voltar ────┘   (ended → live só com action explícita)
```

- `draft` — criado mas tracking config incompleto.
- `configuring` — config em progresso; ainda não aceita eventos.
- `live` — aceita eventos; campanhas ativas.
- `ended` — não aceita novos eventos; mantém histórico para relatórios.
- `archived` — terminal; soft-delete.

## 6. Transições válidas

| De | Para | Quem | Validação |
|---|---|---|---|
| `draft` | `configuring` | MARKETER, ADMIN | Nome preenchido. |
| `configuring` | `live` | MARKETER, ADMIN | Pixel policy declarada + ao menos 1 page registrada. |
| `live` | `ended` | MARKETER, ADMIN | — |
| `ended` | `live` | ADMIN | Confirmação dupla. |
| `ended` | `archived` | OWNER | Confirmação dupla. |
| qualquer | `archived` | OWNER | Confirmação dupla. |

## 7. Invariantes

- **INV-LAUNCH-001 — `public_id` é único por workspace.** Constraint `unique (workspace_id, public_id)`. Testável.
- **INV-LAUNCH-002 — Launch `archived` não aceita ingestão.** Eventos com `launch_id` de launch arquivado são rejeitados ou marcados `processing_status='rejected_archived_launch'`. Testável.
- **INV-LAUNCH-003 — Launch só vai para `live` com Pixel policy declarada.** Validação no service: `config.tracking.meta.pixel_policy IN ('server_only', 'browser_and_server_managed', 'coexist_with_existing_pixel')`. Testável.
- **INV-LAUNCH-004 — `timezone` é IANA tz database válido.** Validado por Zod (`z.string().refine(isValidIanaTimezone)`). Testável.
- **INV-LAUNCH-005 — `config.tracking.google.customer_match_strategy` ∈ enum.** Constraint check.

## 8. BRs relacionadas

- `BR-DISPATCH-001` — Pixel policy obriga `event_id` compartilhado quando `browser_and_server_managed`.
- `BR-AUDIENCE-001` — Customer Match strategy condicional.

## 9. Contratos consumidos

- `MOD-WORKSPACE.requireActiveWorkspace()`

## 10. Contratos expostos

- `getLaunchByPublicId(workspace_id, public_id, ctx): Result<Launch, NotFound>`
- `requireActiveLaunch(launch_id, ctx): Result<Launch, NotLive | Archived>`
- `getLaunchTrackingConfig(launch_id): Result<TrackingConfig, NotFound>`
- `transitionLaunch(launch_id, target_status, actor, ctx): Result<Launch, InvalidTransition>`

## 11. Eventos de timeline emitidos

- `TE-LAUNCH-CREATED`
- `TE-LAUNCH-STATUS-CHANGED`
- `TE-LAUNCH-CONFIG-UPDATED`

## 12. Ownership de código

**Pode editar:**
- `packages/db/src/schema/launch.ts`
- `apps/edge/src/lib/launch.ts`
- `tests/unit/launch/**`
- `tests/integration/launch/**`

**Lê:**
- `apps/edge/src/lib/workspace.ts`
- `30-contracts/01-enums.md`

## 13. Dependências permitidas / proibidas

**Permitidas:** `MOD-WORKSPACE`.
**Proibidas:** `MOD-PAGE`, `MOD-LEAD`, `MOD-EVENT`, `MOD-DISPATCH`, etc. (eles dependem de Launch, não o contrário).

## 14. Test harness

- `tests/unit/launch/transitions.test.ts` — INV-LAUNCH-003 e INV-LAUNCH-005.
- `tests/integration/launch/timezone.test.ts` — INV-LAUNCH-004.
- `tests/integration/launch/archived-rejects-ingestion.test.ts` — INV-LAUNCH-002.
