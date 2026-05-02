# Sprint 4 — Analytics + Google integrations (parte A da Fase 3)

## Duração
2 semanas.

## Objetivo
Cost ingestor com FX, Metabase views, GA4 MP, Google Ads Conversion Upload, Enhanced Conversions.

## Pré-requisitos
Sprint 3 completo. OQ-001 e OQ-003 decididas antes de despachar.

## Critério de aceite

- [ ] Cron de cost ingestor diário roda; `ad_spend_daily.spend_cents_normalized` populado.
- [ ] FX rates fetch funcional (ECB default, configurável via `FX_RATES_PROVIDER`).
- [ ] GA4 MP dispatcher operacional com estratégia client_id (OQ-003 decidida).
- [ ] Google Ads Conversion Upload com eligibility check (gclid/gbraid/wbraid).
- [ ] Enhanced Conversions com `order_id` + hash de PII (email/phone normalizados).
- [ ] Novos destinations (`ga4_mp`, `google_ads_conversion`, `google_enhancement`) wired no queue handler.
- [ ] Metabase views: `daily_funnel_rollup`, `ad_performance_rollup`, `dispatch_health_view`.
- [ ] Dashboard CPL/CPA/ROAS funcional para lançamento de teste.

---

## Decisões de arquitetura

### Credenciais — padrão Sprint 4 (mesma decisão do Sprint 3)

Todos os tokens e IDs de conta são **env vars globais** (um único account por plataforma para todo o sistema). Por-workspace é Fase 2.

| Env var | Uso |
|---|---|
| `META_ADS_ACCOUNT_ID` | Cost ingestor Meta Insights |
| `META_ADS_ACCESS_TOKEN` | Cost ingestor Meta Insights |
| `GOOGLE_ADS_CUSTOMER_ID` | Cost ingestor + dispatchers |
| `GOOGLE_ADS_DEVELOPER_TOKEN` | Google Ads API |
| `GOOGLE_ADS_CLIENT_ID` | OAuth |
| `GOOGLE_ADS_CLIENT_SECRET` | OAuth |
| `GOOGLE_ADS_REFRESH_TOKEN` | OAuth refresh |
| `GA4_MEASUREMENT_ID` | GA4 MP dispatcher |
| `GA4_API_SECRET` | GA4 MP dispatcher |
| `FX_RATES_PROVIDER` | `ecb` \| `wise` \| `manual` (default: `ecb`) |
| `FX_RATES_API_KEY` | Apenas quando `FX_RATES_PROVIDER=wise` |

**Sem mudança de schema no Sprint 4** — `workspace_integrations` permanece como está. Account IDs por-workspace entram em sprint futuro.

### OQ-001 — FX provider → **FECHADA: ECB default**

ECB (European Central Bank): gratuito, oficial, atualiza diariamente às ~16:00 CET, cobre 30+ moedas. `FX_RATES_PROVIDER=ecb`. Moeda base de normalização: BRL (default em `workspaces.fx_normalization_currency`). Sistema implementa os 3 providers (ecb/wise/manual).

### OQ-003 — GA4 client_id quando `_ga` ausente → **FECHADA: opção B (mintar do `__fvid`)**

Quando LP não tem GA4 client-side ativo: mintar `client_id` próprio derivado de `__fvid` no formato `GA1.1.<8digits>.<10digits>`. Trade-off documentado na UI. Caso edge de checkout direto via Guru sem passagem pela LP → ver **OQ-012** (avaliar pós-Sprint 9 com dados reais).

---

## Ondas de execução

### Onda 0 (paralela — 4 agentes)

| T-ID | Agente | Ownership |
|---|---|---|
| T-4-003 | `globaltracker-domain-author` | `apps/edge/src/integrations/fx-rates/` + `apps/edge/src/lib/fx.ts` |
| T-4-004 | `globaltracker-dispatcher-author` | `apps/edge/src/dispatchers/ga4-mp/` |
| T-4-005 | `globaltracker-dispatcher-author` | `apps/edge/src/dispatchers/google-ads-conversion/` |
| T-4-006 | `globaltracker-dispatcher-author` | `apps/edge/src/dispatchers/google-enhanced-conversions/` |

### Onda 1 (serial — cost ingestor depende de FX da Onda 0)

| T-ID | Agente | Ownership |
|---|---|---|
| T-4-001 + T-4-002 | `globaltracker-domain-author` | `apps/edge/src/crons/cost-ingestor.ts` + `apps/edge/src/integrations/meta-insights/` + `apps/edge/src/integrations/google-ads-reporting/` |

### Onda 2 (serial — wiring novos destinations)

| T-ID | Agente | Ownership |
|---|---|---|
| — | `globaltracker-edge-author` | `apps/edge/src/index.ts` — adiciona `ga4_mp`, `google_ads_conversion`, `google_enhancement` ao queue handler |

### Onda 3 (paralela — analytics infra)

| T-ID | Agente | Ownership |
|---|---|---|
| T-4-007 | `globaltracker-schema-author` | Migration com SQL views: `daily_funnel_rollup`, `ad_performance_rollup`, `dispatch_health_view` |
| T-4-008 | `general-purpose` | `docs/70-ux/` ou `docs/80-roadmap/` — Metabase setup guide |

### Onda 4 (paralela — fechar sprint)

| T-ID | Agente | Ownership |
|---|---|---|
| — | `globaltracker-test-author` | Testes E2E relevantes (cost ingestor idempotency, GA4 dispatch) |
| — | `globaltracker-docs-sync` | Sync doc canônica Sprint 4 + fechar OQ-001 e OQ-003 como ADR |

---

## T-IDs detalhadas

### T-4-003 — FX rates client
**Tipo:** domain
**Ownership:** `apps/edge/src/integrations/fx-rates/{ecb-client,wise-client,manual-resolver,cache,factory}.ts` + `apps/edge/src/lib/fx.ts`
**Critério:** `getRateForPair(from, to, date, env)` via factory; ECB parser XML; cache CF KV TTL 25h; fallback para última taxa + flag `fx_stale`; 3 retries com backoff.

### T-4-004 — GA4 MP dispatcher
**Tipo:** dispatcher
**Ownership:** `apps/edge/src/dispatchers/ga4-mp/{mapper,client,client-id-resolver,index}.ts`
**Critério:** `mapEventToGa4Payload` com `client_id` resolvido (cookie `_ga` → mint do `__fvid`); eligibility: `consent.analytics=granted` + `measurement_id` configurado; `sendToGa4` interpreta 204 como sucesso; fixtures em `tests/fixtures/ga4-mp/`.

### T-4-005 — Google Ads Conversion Upload
**Tipo:** dispatcher
**Ownership:** `apps/edge/src/dispatchers/google-ads-conversion/{mapper,client,eligibility,index}.ts`
**Critério:** eligibility exige `gclid` OU `gbraid` OU `wbraid` → skip `no_click_id_available`; `conversion_action` mapeado em `launches.config` → skip `no_conversion_action_mapped`; OAuth refresh automático; `RESOURCE_EXHAUSTED` retryable; `INVALID_GCLID` permanent_failure; fixtures em `tests/fixtures/google-ads/conversion-upload/`.

### T-4-006 — Enhanced Conversions
**Tipo:** dispatcher
**Ownership:** `apps/edge/src/dispatchers/google-enhanced-conversions/{mapper,client,eligibility,index}.ts`
**Critério:** eligibility estrita — requer conversão original + `order_id` + consent + email/phone hash + adjustment dentro de 24h; mapper normaliza PII (lowercase/trim antes de SHA-256 conforme spec Google); `order_id` desconhecido → permanent_failure sem retry.

### T-4-001 — Cost ingestor Meta Insights
**Tipo:** domain
**Ownership:** `apps/edge/src/integrations/meta-insights/` + `apps/edge/src/crons/cost-ingestor.ts` (parte Meta)
**Critério:** `GET /v20.0/act_{account_id}/insights` com `fields=spend,impressions,clicks` por dia; upsert em `ad_spend_daily` (INV-COST-001: unique constraint); normaliza com FX; idempotente (INV-COST-006): rodar 2× = mesmo estado.

### T-4-002 — Cost ingestor Google Ads Reporting
**Tipo:** domain
**Ownership:** `apps/edge/src/integrations/google-ads-reporting/` + `apps/edge/src/crons/cost-ingestor.ts` (parte Google)
**Critério:** Google Ads Query Language (GAQL) para `campaign_budget.amount_micros`, `metrics.cost_micros`; converte micros para cents; upsert com mesmo INV-COST-001; cron CF Trigger diário 17:30 UTC (após FX publish ECB 17:00 UTC).

### T-4-007 — Metabase views
**Tipo:** schema
**Ownership:** `packages/db/migrations/0022_metabase_views.sql`
**Critério:** views `daily_funnel_rollup`, `ad_performance_rollup`, `dispatch_health_view` — sem dados dependentes (views são lidas do estado atual).

### T-4-008 — Metabase setup
**Tipo:** docs/infra
**Ownership:** `docs/80-roadmap/metabase-setup.md` ou equivalente
**Critério:** instruções para conectar Metabase ao Supabase (read-only user), importar views, criar dashboard CPL/CPA/ROAS.

---

## Fora de escopo (sprints futuros)

- Audience sync (Sprint 5)
- Tokens por-workspace (Fase 2)
- Dashboard UI no Control Plane (Sprint 6+)
