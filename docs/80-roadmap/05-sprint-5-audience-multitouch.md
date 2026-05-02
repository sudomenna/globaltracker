# Sprint 5 — Audience sync + multi-touch base (parte B da Fase 3)

## Duração
2 semanas.

## Objetivo
Audience Meta v1, Customer Match Google com strategy condicional, `visitor_id` (`__fvid`) gerado pelo tracker, retroactive linking de eventos anônimos ao lead após cadastro.

## Pré-requisitos
Sprint 4 completo ✓ (commit c1e4abc).

## Critério de aceite global

- [ ] Audience Meta sincronizando com snapshots materializados; diff entre T-1 e T calculado via SET difference.
- [ ] Customer Match Google com strategy (`google_data_manager` default; `google_ads_api_allowlisted` opcional; auto-demote em erro `CUSTOMER_NOT_ALLOWLISTED`).
- [ ] `visitor_id` (`__fvid`) gerado pelo tracker no primeiro acesso, consent-gated (INV-TRACKER-003).
- [ ] `events.visitor_id` populado pelo ingestion processor a partir do payload.
- [ ] Retroactive linking: PageViews anônimos com mesmo `visitor_id` ligados ao `lead_id` após cadastro.
- [ ] FLOW-05 (sync ICP) E2E verde.
- [ ] `typecheck` + `lint` + `test` verdes ao final.

---

## Estado de pré-existência (não re-construir)

| Item | Status |
|---|---|
| Schema `audiences`, `audience_snapshots`, `audience_snapshot_members`, `audience_sync_jobs` | ✓ migrado (0016) |
| `events.visitor_id` coluna (text, nullable) | ✓ no schema + migrado (0018) |
| `EventPayloadSchema` já aceita `visitor_id` opcional | ✓ em `routes/schemas/event-payload.ts` |
| tracker.js: constante `FVID_COOKIE = '__fvid'` e `readVisitorIdCookie()` | ✓ lê, não escreve |
| Dispatchers Meta CAPI, GA4, Google Ads | ✓ Sprint 3/4 |
| Migration 0022 (Metabase views Sprint 4) | ✓ |

**O que falta construir:**
- `audiences.auto_demoted_at` (nova coluna — Sprint 5)
- `apps/edge/src/lib/audience.ts` (novo — domain logic completa)
- `apps/edge/src/crons/audience-sync.ts` (novo)
- `apps/edge/src/dispatchers/audience-sync/` (novo diretório + adapters)
- tracker.js: escrita do cookie `__fvid` com consent gate
- `raw-events-processor.ts`: extrair + persistir `visitor_id` + retroactive backfill

---

## Decisões de arquitetura

### Credenciais — padrão Sprint 5 (mesmo do Sprint 4)

Credenciais são env vars globais (uma conta por plataforma). Per-workspace fica para Sprint 6.

| Env var | Uso |
|---|---|
| `META_CUSTOM_AUDIENCE_TOKEN` | Meta Ads API — token para Custom Audiences (`ads_management`) |
| `META_DEFAULT_AD_ACCOUNT_ID` | Meta — ad account do qual as audiences são gerenciadas |
| `GOOGLE_ADS_CUSTOMER_ID` | Google Customer Match (já existe, Sprint 4) |
| `GOOGLE_ADS_DEVELOPER_TOKEN` | Google Ads API (já existe, Sprint 4) |
| `GOOGLE_ADS_CLIENT_ID` | OAuth (já existe, Sprint 4) |
| `GOOGLE_ADS_CLIENT_SECRET` | OAuth (já existe, Sprint 4) |
| `GOOGLE_ADS_REFRESH_TOKEN` | OAuth (já existe, Sprint 4) |

### Advisory lock para sync concorrente

`acquireSyncLock()` usa Postgres advisory lock (`pg_try_advisory_xact_lock`) com chave derivada de `(audience_id, platform_resource_id)`. Lock scoped à transação — liberado no commit/rollback. Não usar Redis neste sprint (não está no stack ativo).

### Retroactive linking — escopo e idempotência

Backfill atualiza `events.lead_id` apenas quando `lead_id IS NULL` (idempotente). Aplica-se a **todos os event_names** (não só PageView) com o mesmo `visitor_id` no mesmo `workspace_id`. Janela: sem limite de tempo — retroativo completo.

### Google Data Manager API — stub

A spec da Data Manager API ainda não é pública (TBD). T-5-006 implementa um **stub válido**: chama eligibility check, loga, retorna `{status: 'succeeded', sent_additions: 0, sent_removals: 0}` com `error_code: 'DATA_MANAGER_NOT_IMPLEMENTED'`. O auto-demote não é ativado neste stub (é erro esperado de engineering, não de credencial).

---

## T-IDs detalhadas

---

### T-5-001 — Schema: `auto_demoted_at` + Metabase views multi-touch

**Tipo:** `schema`
**Parallel-safe:** `yes` (Onda 1)
**Ownership:**
- `packages/db/src/schema/audience.ts` (adicionar coluna)
- `packages/db/migrations/0023_sprint5_schema.sql` (novo)

**BRs / INVs:** BR-AUDIENCE-001 (auto_demoted_at documenta demote), INV-AUDIENCE-004

**Critério de aceite:**
- [ ] `audiences.auto_demoted_at` (timestamptz, nullable) adicionada ao schema Drizzle.
- [ ] Migration `0023_sprint5_schema.sql` com:
  - `ALTER TABLE audiences ADD COLUMN IF NOT EXISTS auto_demoted_at TIMESTAMPTZ;`
  - `CREATE OR REPLACE VIEW v_lead_attribution_summary AS ...` (ver spec abaixo)
  - `CREATE OR REPLACE VIEW v_audience_sync_health AS ...` (ver spec abaixo)
- [ ] `pnpm db:generate` passa sem erro.

**Spec das views:**

```sql
-- v_lead_attribution_summary: used by Metabase multi-touch dashboard
CREATE OR REPLACE VIEW v_lead_attribution_summary AS
SELECT
  la.workspace_id,
  la.launch_id,
  la.lead_id,
  MAX(la.source)    FILTER (WHERE la.touch_type = 'first') AS first_touch_source,
  MAX(la.medium)    FILTER (WHERE la.touch_type = 'first') AS first_touch_medium,
  MAX(la.campaign)  FILTER (WHERE la.touch_type = 'first') AS first_touch_campaign,
  MAX(la.ts)        FILTER (WHERE la.touch_type = 'first') AS first_touch_at,
  MAX(la.source)    FILTER (WHERE la.touch_type = 'last')  AS last_touch_source,
  MAX(la.medium)    FILTER (WHERE la.touch_type = 'last')  AS last_touch_medium,
  MAX(la.campaign)  FILTER (WHERE la.touch_type = 'last')  AS last_touch_campaign,
  MAX(la.ts)        FILTER (WHERE la.touch_type = 'last')  AS last_touch_at,
  COUNT(*)          FILTER (WHERE la.touch_type = 'all')   AS all_touch_count,
  BOOL_OR(la.gclid IS NOT NULL)  AS has_google_click,
  BOOL_OR(la.fbclid IS NOT NULL) AS has_meta_click
FROM lead_attribution la
GROUP BY la.workspace_id, la.launch_id, la.lead_id;

-- v_audience_sync_health: Metabase audience sync monitoring
CREATE OR REPLACE VIEW v_audience_sync_health AS
SELECT
  asj.workspace_id,
  asj.audience_id,
  a.name                AS audience_name,
  a.platform,
  a.destination_strategy,
  a.auto_demoted_at,
  COUNT(*) FILTER (WHERE asj.status = 'succeeded') AS succeeded_count,
  COUNT(*) FILTER (WHERE asj.status = 'failed')    AS failed_count,
  COUNT(*) FILTER (WHERE asj.status = 'pending')   AS pending_count,
  MAX(asj.finished_at)  FILTER (WHERE asj.status = 'succeeded') AS last_succeeded_at,
  SUM(asj.sent_additions)  AS total_additions,
  SUM(asj.sent_removals)   AS total_removals
FROM audience_sync_jobs asj
JOIN audiences a ON a.id = asj.audience_id
GROUP BY asj.workspace_id, asj.audience_id, a.name, a.platform,
         a.destination_strategy, a.auto_demoted_at;
```

**Contexto canônico:** `docs/20-domain/09-mod-audience.md §3`, `docs/20-domain/07-mod-attribution.md §3`

---

### T-5-002 — Audience core domain + cron

**Tipo:** `domain`
**Parallel-safe:** `yes` (Onda 1; disjunto de T-5-003)
**Ownership:**
- `apps/edge/src/lib/audience.ts` (novo)
- `apps/edge/src/crons/audience-sync.ts` (novo)

**BRs / INVs:** BR-AUDIENCE-001 a 004, INV-AUDIENCE-001 a 007

**Critério de aceite:**
- [ ] `evaluateAudience(audienceId, ctx)` avalia `query_definition` DSL e retorna `{memberCount, snapshotHash, members: string[]}`. Filtra leads com `status='active'`. Aplica consent_policy (BR-AUDIENCE-004).
- [ ] `generateSnapshot(audienceId, ctx)` insere `audience_snapshots` + `audience_snapshot_members` em transação. Retorna `{status: 'created', snapshot}` ou `{status: 'noop'}` quando hash igual. Arquiva snapshots além dos 2 mais recentes (INV-AUDIENCE-006).
- [ ] `createSyncJob(audienceId, snapshotId, prevSnapshotId, ctx)` calcula diff via SQL SET difference → insere `audience_sync_jobs` com `planned_additions` e `planned_removals`.
- [ ] `acquireSyncLock(audienceId, platformResourceId, db)` → Postgres advisory lock (`pg_try_advisory_xact_lock`). Retorna `{acquired: boolean}`.
- [ ] Zod DSL validator: `AudienceQueryDefinitionSchema` = `{type: 'builder', all: Array<{stage?: string, is_icp?: boolean, not_stage?: string, purchased?: boolean}>}` (INV-AUDIENCE-007).
- [ ] `apps/edge/src/crons/audience-sync.ts`: exporta `runAudienceSync(env, db)`. Itera `audiences` com `status='active'` por workspace; chama `generateSnapshot` + `createSyncJob` por audience. Audiences com `destination_strategy='disabled_not_eligible'` ainda geram snapshot (para histórico) mas não criam sync job. Não chama APIs externas (isso é responsabilidade dos dispatchers, Onda 2).
- [ ] Cron registrado no scheduled handler de `apps/edge/src/index.ts` (adicionar entrada para cron expression `0 1 * * *` — 01:00 UTC diário).

**Interfaces exportadas de `audience.ts`:**
```ts
export type AudienceEvalResult = {
  memberCount: number;
  snapshotHash: string;
  members: string[]; // lead_ids
};

export type GenerateSnapshotResult =
  | { status: 'created'; snapshot: AudienceSnapshot }
  | { status: 'noop'; existingSnapshotId: string };

export function evaluateAudience(audienceId: string, ctx: AudienceCtx): Promise<AudienceEvalResult>
export function generateSnapshot(audienceId: string, ctx: AudienceCtx): Promise<GenerateSnapshotResult>
export function createSyncJob(audienceId: string, snapshotId: string, prevSnapshotId: string | null, ctx: AudienceCtx): Promise<AudienceSyncJob>
export function acquireSyncLock(audienceId: string, platformResourceId: string, db: Db): Promise<{ acquired: boolean }>
export const AudienceQueryDefinitionSchema: z.ZodSchema
```

**Não implementar:** Chamadas a Meta/Google API (delegadas a T-5-005/T-5-006, Onda 2).

**Contexto canônico:**
- `docs/20-domain/09-mod-audience.md`
- `docs/50-business-rules/BR-AUDIENCE.md`
- `docs/60-flows/05-sync-icp-audience.md`
- `docs/40-integrations/02-meta-custom-audiences.md`

---

### T-5-003 — Retroactive linking no ingestion processor

**Tipo:** `domain`
**Parallel-safe:** `yes` (Onda 1; disjunto de T-5-002 — arquivos diferentes)
**Ownership:**
- `apps/edge/src/lib/raw-events-processor.ts` (estender)

**BRs / INVs:** INV-EVENT-007 (lead_token válido → lead_id resolvido), INV-TRACKER-003 (visitor_id só existe com consent)

**Critério de aceite:**
- [ ] `processRawEvent()` extrai `visitor_id` do payload (`raw_events.payload->>'visitor_id'`) e persiste em `events.visitor_id` ao criar o evento canônico.
- [ ] Após lead ser resolvido (lead_id não-null): `UPDATE events SET lead_id = <resolved_lead_id> WHERE workspace_id = <w> AND visitor_id = <v> AND lead_id IS NULL` (idempotente — só atualiza NULL).
- [ ] Backfill executado dentro da mesma transação do processamento do evento (ou em savepoint se transação não disponível). Nunca falha silenciosamente — erros de backfill são logados sem bloquear o evento principal.
- [ ] Eventos sem `visitor_id` no payload não são afetados (graceful skip).

**Nota:** `EventPayloadSchema` já aceita `visitor_id` como `z.string().optional()`. Não há alteração necessária na rota `/v1/events`.

**Contexto canônico:**
- `docs/20-domain/05-mod-event.md §2, §7`
- `docs/20-domain/13-mod-tracker.md §7` (INV-TRACKER-003)

---

### T-5-004 — tracker.js: `__fvid` geração e escrita

**Tipo:** `tracker`
**Parallel-safe:** `yes` (Onda 1)
**Ownership:**
- `apps/tracker/src/cookies.ts` (estender)
- `apps/tracker/src/state.ts` (estender)
- `apps/tracker/src/index.ts` (integrar)

**BRs / INVs:** INV-TRACKER-001 (< 15 KB gzipped), INV-TRACKER-002 (sem deps externas), INV-TRACKER-003 (`__fvid` só com consent), INV-TRACKER-007 (falha silenciosa)

**Critério de aceite:**
- [ ] `cookies.ts` exporta `ensureVisitorId(consentAnalytics: boolean): string | null`:
  - Se `consentAnalytics=false`: retorna `null`, não escreve cookie.
  - Lê `__fvid` existente via `readVisitorIdCookie()`. Se válido (UUID v4), retorna.
  - Se ausente ou inválido: gera `crypto.randomUUID()`, escreve cookie `__fvid=<uuid>; Path=/; SameSite=Lax; Secure; Max-Age=31536000`, retorna uuid.
  - Falhas de `document.cookie` capturadas silenciosamente (INV-TRACKER-007).
- [ ] `state.ts`: `TrackerState` adiciona campo `visitorId: string | null`.
- [ ] `index.ts`: chama `ensureVisitorId()` na inicialização após consent check. Inclui `visitor_id` no body de todos os eventos enviados a `/v1/events` quando `visitorId` não-null.
- [ ] Bundle mantém < 15 KB gzipped (INV-TRACKER-001): verificar `build.config.ts` smoke.

**Atenção:** `Funil.identify()` não deve alterar o `__fvid` — ele é do visitante anônimo, não do lead. O `__ftk` continua sendo escrito apenas pelo backend.

**Contexto canônico:**
- `docs/20-domain/13-mod-tracker.md §7`
- `docs/50-business-rules/BR-CONSENT.md`

---

### T-5-005 — Meta Custom Audience dispatcher

**Tipo:** `dispatcher`
**Parallel-safe:** `yes` (Onda 2; disjunto de T-5-006)
**Depende de:** T-5-002 (audience domain deve existir)
**Ownership:**
- `apps/edge/src/dispatchers/audience-sync/meta/client.ts` (novo)
- `apps/edge/src/dispatchers/audience-sync/meta/mapper.ts` (novo)
- `apps/edge/src/dispatchers/audience-sync/meta/batcher.ts` (novo)
- `apps/edge/src/dispatchers/audience-sync/meta/index.ts` (novo — entry point)
- `apps/edge/src/dispatchers/audience-sync/index.ts` (novo — orquestrador; cria e delega por platform)

**BRs / INVs:** BR-AUDIENCE-001 (disabled_not_eligible → noop), BR-AUDIENCE-002 (lock), BR-AUDIENCE-003 (diff), BR-AUDIENCE-004 (consent no snapshot), INV-AUDIENCE-004

**Critério de aceite:**
- [ ] `processSyncJob(syncJobId, env, db)` no orquestrador (`audience-sync/index.ts`):
  - Lê `audience_sync_job` com lock (`acquireSyncLock`). Se não adquire: retorna `{status: 'lock_contention'}`.
  - Verifica `destination_strategy`: se `disabled_not_eligible` → atualiza job para `succeeded` com `sent_additions=0, sent_removals=0` sem chamar API (INV-AUDIENCE-004).
  - Roteia para adapter correto por `audience.platform`.
- [ ] `meta/client.ts`: `MetaCustomAudienceClient` wraps Meta Marketing API `v18.0/{audience_id}/users`:
  - `addMembers(audienceId, batch)` → `POST`
  - `removeMembers(audienceId, batch)` → `DELETE`
  - Auth: Bearer token via `META_CUSTOM_AUDIENCE_TOKEN`.
  - Retry: 429 → exponential backoff (máx 3 tentativas).
  - Error 400 `INVALID_PARAMETER` → `failed` sem retry.
- [ ] `meta/mapper.ts`: converte `leads.email_hash` / `phone_hash` em `["EMAIL_SHA256_NORMALIZED", "PHONE_SHA256_NORMALIZED"]` payload. Hashes já pré-normalizados (BR-IDENTITY-002).
- [ ] `meta/batcher.ts`: divide lista de lead_ids em batches de 10.000 membros (limite Meta).
- [ ] `audience_sync_jobs` atualizado: `status='succeeded'`, `sent_additions`, `sent_removals`, `platform_job_id` (se retornado). Em falha: `status='failed'`, `error_code`, `error_message`, `next_attempt_at = now() + backoff`.
- [ ] Idempotência: `idempotency_key = sha256(workspace_id|audience_id|meta_custom_audience|audience_resource_id|snapshot_hash)`. Unique constraint em `audience_sync_jobs` detecta duplicatas.

**Env vars usadas:** `META_CUSTOM_AUDIENCE_TOKEN`, `META_DEFAULT_AD_ACCOUNT_ID`

**Contexto canônico:**
- `docs/40-integrations/02-meta-custom-audiences.md`
- `docs/20-domain/09-mod-audience.md §10`
- `docs/60-flows/05-sync-icp-audience.md`
- `docs/50-business-rules/BR-AUDIENCE.md`

---

### T-5-006 — Google Customer Match dispatchers + auto-demote

**Tipo:** `dispatcher`
**Parallel-safe:** `yes` (Onda 2; disjunto de T-5-005)
**Depende de:** T-5-001 (`auto_demoted_at` coluna), T-5-002 (audience domain)
**Ownership:**
- `apps/edge/src/dispatchers/audience-sync/google/data-manager-client.ts` (novo)
- `apps/edge/src/dispatchers/audience-sync/google/ads-api-client.ts` (novo)
- `apps/edge/src/dispatchers/audience-sync/google/strategy.ts` (novo)
- `apps/edge/src/dispatchers/audience-sync/google/eligibility.ts` (novo)
- `apps/edge/src/dispatchers/audience-sync/google/index.ts` (novo — entry point Google)
- `apps/edge/src/dispatchers/audience-sync/index.ts` (atualizar orquestrador, criado por T-5-005)

**Atenção sobre conflito com T-5-005:** `audience-sync/index.ts` é criado por T-5-005. T-5-006 irá **estendê-lo** adicionando o case `platform='google'`. Orquestrar isso no prompt: T-5-006 deve criar o arquivo `google/index.ts` e **adicionar a linha de roteamento** no orquestrador, que T-5-005 deixou com `// TODO: google` ou similar.

**BRs / INVs:** BR-AUDIENCE-001 (disabled_not_eligible → noop), INV-AUDIENCE-004, ADR-012 (strategy condicional)

**Critério de aceite:**
- [ ] `google/strategy.ts`: `selectGoogleStrategy(destinationStrategy)` → `'data_manager' | 'ads_api' | 'disabled'`.
- [ ] `google/eligibility.ts`: `checkGoogleEligibility(audience, env)` → `{eligible: boolean, reason?: string}`. Verifica `platform_resource_id` configurado + strategy não-disabled.
- [ ] `google/data-manager-client.ts`: **stub** — `syncWithDataManager(job, members, env)` → loga `[STUB] Data Manager API not yet available` → retorna `{status: 'succeeded', sent_additions: 0, sent_removals: 0, note: 'data_manager_stub'}`. Sem chamada HTTP real.
- [ ] `google/ads-api-client.ts`: `GoogleAdsCustomerMatchClient`:
  - Usa Google Ads API `OfflineUserDataJobService.create + addUserData + run` (ou `uploadOfflineUserData`).
  - Formato de membro: `{hashedEmail: lead.email_hash, hashedPhoneNumber: lead.phone_hash}`.
  - Auth: OAuth refresh via variáveis existentes (`GOOGLE_ADS_*`).
  - Trata `CUSTOMER_NOT_ALLOWLISTED_FOR_THIS_FEATURE`:
    - Marca job como `failed`, `error_code='CUSTOMER_NOT_ALLOWLISTED'`.
    - **Auto-demote**: `UPDATE audiences SET destination_strategy='disabled_not_eligible', auto_demoted_at=now() WHERE id=...`.
    - Não faz retry.
- [ ] Dispatch: `google/index.ts` exporta `processGoogleSyncJob(syncJobId, env, db)`. Chama `selectGoogleStrategy` → `eligibility` → adapter correto.
- [ ] Orquestrador (`audience-sync/index.ts`) roteia `platform='google'` para `processGoogleSyncJob`.

**Env vars usadas:** `GOOGLE_ADS_CUSTOMER_ID`, `GOOGLE_ADS_DEVELOPER_TOKEN`, `GOOGLE_ADS_CLIENT_ID`, `GOOGLE_ADS_CLIENT_SECRET`, `GOOGLE_ADS_REFRESH_TOKEN` (todos já existem do Sprint 4)

**Contexto canônico:**
- `docs/40-integrations/05-google-customer-match.md`
- `docs/20-domain/09-mod-audience.md §3, §10`
- `docs/50-business-rules/BR-AUDIENCE.md`

---

### T-5-007 — Testes Sprint 5

**Tipo:** `test`
**Parallel-safe:** `yes` (Onda 3 — após Onda 2)
**Ownership:**
- `tests/unit/audience/` (novo diretório)
- `tests/integration/audience/` (novo diretório)
- `tests/unit/tracker/fvid.test.ts` (novo)
- `tests/integration/tracker/fvid-consent-gate.test.ts` (novo)

**Critério de aceite — testes mínimos por INV:**

| Arquivo de teste | INV / BR coberta |
|---|---|
| `tests/unit/audience/dsl-zod-validation.test.ts` | INV-AUDIENCE-007 — aceita DSL válida, rejeita inválida |
| `tests/unit/audience/diff-calculation.test.ts` | INV-AUDIENCE-003 — dado T-1={A,B,C} e T={B,C,D}, additions={D}, removals={A} |
| `tests/unit/audience/snapshot-hash.test.ts` | BR-AUDIENCE-003 — hash determinístico (mesma lista → mesmo hash; ordem diferente → mesmo hash) |
| `tests/unit/audience/disabled-not-eligible-noop.test.ts` | INV-AUDIENCE-004 — disabled_not_eligible → noop sem API call |
| `tests/unit/audience/consent-filter.test.ts` | BR-AUDIENCE-004 — lead sem consent excluído do snapshot |
| `tests/integration/audience/lock-concurrent-syncs.test.ts` | INV-AUDIENCE-002 — 2 processSyncJob simultâneos: 1 adquire lock, outro recebe lock_contention |
| `tests/integration/audience/snapshot-retention.test.ts` | INV-AUDIENCE-006 — gerar 3 snapshots; apenas 2 ficam 'active' |
| `tests/integration/audience/meta-batch-10k.test.ts` | `batcher.ts` — lista de 25.001 leads → 3 batches (10k, 10k, 1) |
| `tests/integration/audience/google-auto-demote.test.ts` | `ads-api-client.ts` — mock retorna CUSTOMER_NOT_ALLOWLISTED → strategy demotada para disabled_not_eligible |
| `tests/unit/tracker/fvid.test.ts` | INV-TRACKER-003 — consent=false → null; consent=true + cookie ausente → gera UUID; consent=true + cookie presente → lê existente |
| `tests/integration/tracker/fvid-consent-gate.test.ts` | INV-TRACKER-003 + INV-TRACKER-007 — falha de cookie capturada silenciosamente |
| `tests/integration/event/visitor-id-retroactive-link.test.ts` | T-5-003 — evento PageView anônimo com visitor_id; lead criado depois; backfill atualiza lead_id no PageView |

**Fixtures a criar:**
- `tests/fixtures/meta-custom-audiences/add-batch-success.json`
- `tests/fixtures/meta-custom-audiences/delete-batch-success.json`
- `tests/fixtures/meta-custom-audiences/429-rate-limit.json`
- `tests/fixtures/google-customer-match/error-not-allowlisted.json`

**Contexto canônico:** `TESTING.md`, `docs/80-roadmap/98-test-matrix-by-sprint.md`

---

## Ondas de paralelização

```
Onda 1 — 4 agentes em paralelo (sem dependências entre si)
  ├── schema-author     T-5-001  audiences.auto_demoted_at + views migration
  ├── domain-author A   T-5-002  audience core domain + cron
  ├── domain-author B   T-5-003  retroactive linking no processor
  └── tracker-author    T-5-004  __fvid geração + escrita + payload

  ↓ verificação: pnpm typecheck && pnpm lint && pnpm test

Onda 2 — 2 agentes em paralelo (dependem da Onda 1)
  ├── dispatcher-author A  T-5-005  Meta Custom Audience dispatcher
  └── dispatcher-author B  T-5-006  Google Customer Match + auto-demote

  ↓ verificação: pnpm typecheck && pnpm lint && pnpm test

Onda 3 — 1 agente (após Onda 2)
  └── test-author          T-5-007  Testes Sprint 5
      (+ docs-sync se necessário)

  ↓ verificação final: pnpm typecheck && pnpm lint && pnpm test
```

### Notas de coordenação entre T-5-005 e T-5-006

`apps/edge/src/dispatchers/audience-sync/index.ts` é criado por **T-5-005** e estendido por **T-5-006** — ambos estão na Onda 2, portanto rodam sequencialmente apenas para este arquivo. Estratégia: T-5-005 cria o orquestrador com case `platform='meta'` e um comment `// platform='google' — wired by T-5-006`. T-5-006 lê o arquivo e adiciona o case Google.

Para garantir que isso funcione em paralelo real, T-5-005 deve deixar o arquivo estruturado como:
```ts
if (audience.platform === 'meta') {
  return processMetaSyncJob(syncJobId, env, db);
}
// google: wired by T-5-006
throw new Error(`Unsupported platform: ${audience.platform}`);
```

T-5-006 substitui o `throw` pelo case Google.

---

## Env vars novas (Sprint 5)

| Var | Obrigatória | Default | Uso |
|---|---|---|---|
| `META_CUSTOM_AUDIENCE_TOKEN` | Sim (se Meta audiences ativas) | — | Token para Meta Marketing API Custom Audiences |
| `META_DEFAULT_AD_ACCOUNT_ID` | Sim (se Meta audiences ativas) | — | Ad account ID para gerenciar audiences no Meta |

As demais vars Google já existem do Sprint 4.

---

## Atualização de `MEMORY.md` ao concluir

Ao finalizar Sprint 5 com sucesso, atualizar `MEMORY.md §4` e `§5`:
```
Sprint 5 | **completed** (data, commit hash) | docs/80-roadmap/05-sprint-5-audience-multitouch.md
```
E adicionar secrets novos à lista de pendências de deploy em `§5`.
