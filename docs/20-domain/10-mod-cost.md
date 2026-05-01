# MOD-COST — Custos de mídia e normalização cambial

## 1. Identidade

- **ID:** MOD-COST
- **Tipo:** Supporting
- **Dono conceitual:** OPERATOR (cron + integração) + MARKETER (consumo em dashboards)

## 2. Escopo

### Dentro
- `ad_spend_daily` com gasto Meta + Google por dia, com `granularity` (`account|campaign|adset|ad`).
- Cron diário de ingestão (CF Cron Trigger).
- Normalização cambial: `spend_cents_normalized` em `workspaces.fx_normalization_currency`.
- Reprocessamento retroativo quando taxa cambial é revisada.
- Provedor de FX configurável (`FX_RATES_PROVIDER`).

### Fora
- Billing / financial reporting (fora do GlobalTracker).
- Otimização automática de budget (fora de escopo total).

## 3. Entidades

### AdSpendDaily
- `id`, `workspace_id`
- `launch_id` (FK opcional)
- `platform` (`meta` / `google`)
- `account_id`
- `campaign_id`, `adset_id`, `ad_id` (NULLs conforme granularity)
- `granularity` (`account` / `campaign` / `adset` / `ad`)
- `date`
- `timezone` (informativo, **não** unique key)
- `currency` (moeda original da conta)
- `spend_cents` (em moeda original)
- `spend_cents_normalized` (em `workspaces.fx_normalization_currency`)
- `fx_rate` (numeric 18,8)
- `fx_source` (`ecb` / `wise` / `manual`)
- `fx_currency` (moeda alvo da normalização)
- `impressions`, `clicks`
- `fetched_at`
- `source_payload_hash`

## 4. Relações

- `AdSpendDaily N—1 Workspace`
- `AdSpendDaily N—1 Launch` (FK opcional, definido por mapeamento operacional)

## 5. Estados

Sem state machine — `ad_spend_daily` é tabela de fatos append/upsert. Modificação só via reprocessamento (que faz UPDATE incrementando `fetched_at`).

## 6. Transições válidas

- Insert pelo cron diário.
- Upsert quando provedor da plataforma reporta valor revisado (ex.: Meta atualiza spend de D-2).
- Reprocessamento de FX retroativo: UPDATE em batch de últimos N dias, atualiza `fx_rate` + `spend_cents_normalized`.

## 7. Invariantes

- **INV-COST-001 — Unique por `(workspace_id, platform, account_id, coalesce(campaign_id,''), coalesce(adset_id,''), coalesce(ad_id,''), granularity, date)`.** Sem `timezone` no unique. Testável.
- **INV-COST-002 — `granularity` ∈ enum `('account','campaign','adset','ad')`.** Constraint check. Testável.
- **INV-COST-003 — `spend_cents_normalized` está populado para 100% dos rows após sync diário.** Validador post-sync. Testável.
- **INV-COST-004 — `fx_currency` corresponde a `workspaces.fx_normalization_currency` no momento da gravação.** Testável.
- **INV-COST-005 — `currency` é código ISO 4217 válido.** Constraint check. Testável.
- **INV-COST-006 — Cron de ingestão é idempotente: rodar 2× no mesmo dia gera mesmo estado.** Testável.

## 8. BRs relacionadas

- `BR-COST-*` — em `50-business-rules/BR-COST.md`.

## 9. Contratos consumidos

- `MOD-WORKSPACE` (config de FX).
- Provedores externos via adapters em `40-integrations/`:
  - Meta Ads Insights API.
  - Google Ads API (reporting).
  - FX Rates provider (ECB / Wise / manual).

## 10. Contratos expostos

- `ingestDailySpend(date, ctx): Promise<{ingested: number, errors: ErrorReport[]}>`
- `getNormalizedSpend(launch_id, date_range, granularity, ctx): Promise<AdSpendDaily[]>`
- `reprocessFxRetroactive(workspace_id, days_back, ctx): Promise<{updated: number}>`

## 11. Eventos de timeline emitidos

- `TE-COST-INGESTED`
- `TE-COST-FX-REPROCESSED`
- `TE-COST-INGESTION-FAILED`

## 12. Ownership de código

**Pode editar:**
- `packages/db/src/schema/ad_spend_daily.ts`
- `apps/edge/src/crons/cost-ingestor.ts`
- `apps/edge/src/lib/fx.ts`
- `apps/edge/src/integrations/meta-insights/**`
- `apps/edge/src/integrations/google-ads-reporting/**`
- `apps/edge/src/integrations/fx-rates/**`
- `tests/unit/cost/**`
- `tests/integration/cost/**`

**Lê:**
- `apps/edge/src/lib/workspace.ts`

## 13. Dependências permitidas / proibidas

**Permitidas:** `MOD-WORKSPACE`, `MOD-LAUNCH`, `MOD-AUDIT`.
**Proibidas:** `MOD-EVENT`, `MOD-DISPATCH` (cost vai para analytics, não pipeline de eventos).

## 14. Test harness

- `tests/unit/cost/fx-normalization.test.ts` — `spend_cents_normalized = round(spend_cents * fx_rate)`.
- `tests/unit/cost/granularity-coalesce.test.ts` — INV-COST-001 com NULLs.
- `tests/integration/cost/cron-idempotency.test.ts` — INV-COST-006.
- `tests/integration/cost/retroactive-reprocess.test.ts` — atualiza taxa antiga.
