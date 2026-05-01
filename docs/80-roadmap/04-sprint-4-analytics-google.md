# Sprint 4 — Analytics + Google integrations (parte A da Fase 3)

## Duração
2 semanas.

## Objetivo
Cost ingestor com FX, Metabase views, GA4 MP, Google Ads Conversion Upload, Enhanced Conversions.

## Pré-requisitos
Sprint 3 completo. OQ-001 (FX provider) e OQ-003 (GA4 client_id) decididas.

## Critério de aceite

- [ ] Cron de cost ingestor diário roda; `ad_spend_daily.spend_cents_normalized` populado.
- [ ] FX rates fetch funcional (provider escolhido em OQ-001).
- [ ] GA4 MP dispatcher operacional com estratégia client_id (OQ-003).
- [ ] Google Ads Conversion Upload com eligibility check.
- [ ] Enhanced Conversions com `order_id` + hash de PII.
- [ ] Metabase views: `daily_funnel_rollup`, `ad_performance_rollup`, `dispatch_health_view`, `audience_health_view`, `audit_log_view`.
- [ ] Dashboard CPL/CPA/ROAS funcional para lançamento de teste.

## T-IDs (alto nível)

- T-4-001: cost ingestor cron + Meta Insights API client.
- T-4-002: cost ingestor Google Ads reporting.
- T-4-003: FX rates client (provider escolhido).
- T-4-004: GA4 MP dispatcher.
- T-4-005: Google Ads Conversion Upload dispatcher.
- T-4-006: Enhanced Conversions dispatcher.
- T-4-007: views materializadas + cron de refresh.
- T-4-008: dashboard Metabase setup.
