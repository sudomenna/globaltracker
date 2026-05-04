# MOD-AUDIENCE — Audiences, snapshots, sync jobs

## 1. Identidade

- **ID:** MOD-AUDIENCE
- **Tipo:** Core
- **Dono conceitual:** MARKETER (definição) + DOMAIN (snapshot/diff/sync)

## 2. Escopo

### Dentro
- `audiences` (definição declarativa com `query_definition` em DSL validada).
- `audience_snapshots` (estado materializado em momento T).
- `audience_snapshot_members` (membros do snapshot — para diff).
- `audience_sync_jobs` (job de envio do diff a Meta/Google).
- Aplicação de consent policy (remove leads sem consent exigido antes do sync).
- Lock por `audience_id + platform_resource_id` para evitar concorrência.
- Strategy pattern para Google: `google_data_manager` / `google_ads_api_allowlisted` / `disabled_not_eligible` (ADR-012).

### Fora
- Avaliação SQL livre (apenas DSL validada — `query_definition` é jsonb estruturado).
- Match rate analytics (consumido por dashboard, calculado por dispatcher).

## 3. Entidades

### Audience
- `id`, `workspace_id`
- `public_id` (único por workspace — INV-AUDIENCE-001)
- `name`
- `platform` (`meta` / `google`)
- `destination_strategy` (Meta: `meta_custom_audience`; Google: `google_data_manager` / `google_ads_api_allowlisted` / `disabled_not_eligible`)
- `query_definition` (jsonb — DSL validada)
- `consent_policy` (jsonb — quais finalidades exigir)
- `status` (`active` / `paused` / `archived`)
- `created_at`, `updated_at`

### Audiences scaffoldadas de template (Sprint 10)

Quando `POST /v1/launches` é chamado com `funnel_template_slug`, `scaffoldLaunch()` insere audiências definidas no `blueprint.audiences` do template. Cada linha inserida:

| Campo | Valor |
|---|---|
| `workspace_id` | workspace do launch |
| `public_id` | `audience.slug` do blueprint |
| `name` | `audience.name` do blueprint |
| `platform` | `audience.platform` ('meta' ou 'google') |
| `destination_strategy` | `'disabled_not_eligible'` (padrão — BR-AUDIENCE-001) |
| `query_definition` | `audience.query_template` do blueprint (DSL placeholder) |
| `status` | `'draft'` |

**Idempotência:** `ON CONFLICT (workspace_id, public_id) DO NOTHING` — chamar o scaffolding duas vezes não gera duplicatas.

**Observação — `query_template`:** o campo `query_template` do blueprint é um DSL placeholder. A avaliação real e o sync de audiences ficarão operacionais na Sprint 11+, quando `MOD-AUDIENCE.evaluateAudience()` for integrado ao pipeline.

### AudienceSnapshot
- `id`, `workspace_id`
- `audience_id` (FK)
- `snapshot_hash` (deterministic hash do conjunto de membros — detecta no-op)
- `generated_at`
- `member_count`
- `retention_status` (`active` / `archived` / `purged`)

### AudienceSnapshotMember
- `snapshot_id` (FK; PK composta com `lead_id`)
- `lead_id` (FK)
- `(particionada por snapshot_id se volume crescer)`

### AudienceSyncJob
- `id`, `workspace_id`, `audience_id`
- `snapshot_id` (FK — snapshot atual)
- `prev_snapshot_id` (FK — snapshot anterior; NULL no primeiro sync)
- `status` (`pending` / `processing` / `succeeded` / `failed`)
- `planned_additions`, `planned_removals`, `sent_additions`, `sent_removals`
- `platform_job_id` (ID retornado pela plataforma)
- `error_code`, `error_message`
- `started_at`, `finished_at`
- `next_attempt_at`

## 4. Relações

- `Audience 1—N AudienceSnapshot`
- `AudienceSnapshot 1—N AudienceSnapshotMember`
- `AudienceSnapshotMember N—1 Lead`
- `AudienceSyncJob N—2 AudienceSnapshot` (snapshot atual + anterior)

## 5. Estados

### Audience
```
[draft] → [active] ↔ [paused] → [archived]
```

### AudienceSnapshot
```
[active] → [archived] → [purged]
```

Retenção: últimos 2 snapshots `active` por audience; demais marcados `archived`; após 30 dias, `purged` (membros deletados).

### AudienceSyncJob
```
[pending] → [processing] → [succeeded]
                       → [failed]
```

## 6. Transições válidas

- Snapshot novo gerado por cron (default diário, configurável por audience).
- Sync job criado se `snapshot_hash` diferente do anterior.
- Sync job não criado se `destination_strategy='disabled_not_eligible'`.

## 7. Invariantes

- **INV-AUDIENCE-001 — `(workspace_id, public_id)` único em `audiences`.** Testável.
- **INV-AUDIENCE-002 — Lock por `audience_id + platform_resource_id` durante sync.** Concorrência: 2 sync jobs paralelos para mesma audience-plataforma é proibido. Testável (advisory lock no Postgres ou Redis).
- **INV-AUDIENCE-003 — Diff calculado entre `members(T)` e `members(T-1)` em SQL determinístico.** Testável: dada matriz de leads, diff é igual a expectativa.
- **INV-AUDIENCE-004 — Audiences com `destination_strategy='disabled_not_eligible'` nunca chamam API.** Validador no dispatcher: bloqueia call. Testável.
- **INV-AUDIENCE-005 — Consent policy é aplicada antes de gerar snapshot.** `audience_snapshot_members` exclui leads sem consent exigido. Testável.
- **INV-AUDIENCE-006 — Retenção: ≤ 2 snapshots `active` por audience.** Trigger ou cron de archive. Testável.
- **INV-AUDIENCE-007 — `query_definition` é validada por Zod schema antes de save.** DSL: `{type: 'builder', all: [{stage: ...}, {is_icp: true}, ...]}`. Testável.

## 8. BRs relacionadas

- `BR-AUDIENCE-*` — em `50-business-rules/BR-AUDIENCE.md`.
- `BR-CONSENT-*` — sobre consent_customer_match.

## 9. Contratos consumidos

- `MOD-IDENTITY.getLatestConsent()` (filtro de membros por consent).
- `MOD-LEAD` (query base — leads ativos com stages).
- `MOD-DISPATCH` (sync job é uma forma de dispatch).

## 10. Contratos expostos

- `evaluateAudience(audience_id, ctx): Promise<{member_count, snapshot_hash, members: lead_id[]}>`
- `generateSnapshot(audience_id, ctx): Result<AudienceSnapshot, NoChange | Error>`
- `createSyncJob(audience_id, snapshot_id, ctx): Result<AudienceSyncJob>`
- `processSyncJob(sync_job_id, ctx): Result<{additions, removals}, ProcessingError>`

## 11. Eventos de timeline emitidos

- `TE-AUDIENCE-CREATED`
- `TE-AUDIENCE-SNAPSHOT-GENERATED`
- `TE-AUDIENCE-SYNC-SUCCEEDED`
- `TE-AUDIENCE-SYNC-FAILED`

## 12. Ownership de código

**Pode editar:**
- `packages/db/src/schema/audience.ts`
- `packages/db/src/schema/audience_snapshot.ts`
- `packages/db/src/schema/audience_snapshot_member.ts`
- `packages/db/src/schema/audience_sync_job.ts`
- `apps/edge/src/dispatchers/audience-sync/**` (orquestração + strategies)
- `apps/edge/src/crons/audience-sync.ts`
- `tests/unit/audience/**`
- `tests/integration/audience/**`

**Lê:**
- `apps/edge/src/lib/lead-resolver.ts`
- `apps/edge/src/lib/consent.ts`
- Adapters Meta/Google em `40-integrations/`.

## 13. Dependências permitidas / proibidas

**Permitidas:** `MOD-IDENTITY`, `MOD-LAUNCH`, `MOD-DISPATCH` (delega).
**Proibidas:** `MOD-EVENT` direto (audiences operam em leads, não eventos individuais).

## 14. Test harness

- `tests/unit/audience/dsl-zod-validation.test.ts` — INV-AUDIENCE-007.
- `tests/unit/audience/diff-calculation.test.ts` — INV-AUDIENCE-003 com matriz fixa de membros.
- `tests/integration/audience/lock-concurrent-syncs.test.ts` — INV-AUDIENCE-002.
- `tests/integration/audience/disabled-not-eligible-no-api-call.test.ts` — INV-AUDIENCE-004.
- `tests/integration/audience/snapshot-retention.test.ts` — INV-AUDIENCE-006.
- `tests/integration/audience/consent-filter.test.ts` — INV-AUDIENCE-005.
