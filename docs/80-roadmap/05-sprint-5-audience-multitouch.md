# Sprint 5 — Audience sync + multi-touch base (parte B da Fase 3)

## Duração
2 semanas.

## Objetivo
Audience Meta v1, Customer Match Google com strategy condicional, `visitor_id` + retroactive linking.

## Pré-requisitos
Sprint 4 completo.

## Critério de aceite

- [ ] Audience Meta sincronizando com snapshots materializados; diff entre T-1 e T.
- [ ] Customer Match Google com strategy (`google_data_manager` default; `google_ads_api_allowlisted` opcional; auto-demote em erro).
- [ ] `visitor_id` (`__fvid`) gerado pelo tracker; coluna `events.visitor_id` populada.
- [ ] Retroactive linking: PageViews anônimos com `visitor_id` ligados retroativamente ao lead após cadastro.
- [ ] FLOW-05 (sync ICP) E2E verde.

## T-IDs (alto nível)

- T-5-001 a T-5-003: audience sync Meta (snapshot, diff, dispatcher).
- T-5-004: audience sync Google Data Manager.
- T-5-005: audience sync Google Ads API allowlisted (com auto-demote).
- T-5-006: tracker.js v1 com `__fvid`.
- T-5-007: retroactive linking no ingestion processor.
- T-5-008: dashboard multi-touch base.
