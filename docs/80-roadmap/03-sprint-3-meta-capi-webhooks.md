# Sprint 3 — Meta CAPI v1 + webhooks (parte B da Fase 2)

## Duração estimada
2-3 semanas.

## Objetivo
Dispatcher Meta CAPI funcional com enriquecimento server-side; adapters Hotmart, Kiwify, Stripe; FLOW-04 (Purchase via webhook) verde.

## Pré-requisitos
- Sprint 2 completo.

## Critério de aceite global

- [ ] Meta CAPI dispatcher: lookup em leads, retry 429/5xx, DLQ após 5 attempts, idempotency_key.
- [ ] Adapter Hotmart com signature validation + mapper + fixtures.
- [ ] Adapter Kiwify com HMAC validation.
- [ ] Adapter Stripe com `constructEvent` + tolerância 5min (ADR-022).
- [ ] FLOW-03 (Meta CAPI dedup) e FLOW-04 (Purchase via webhook) E2E verdes.
- [ ] Métricas operacionais (`dispatch_health_view`) populadas.
- [ ] Smoke em produção (com pixel/webhook test mode).

## T-IDs (alto nível)

- T-3-001 a T-3-003: Meta CAPI dispatcher (mapper, client, eligibility).
- T-3-004 a T-3-006: webhook adapters Hotmart, Kiwify, Stripe.
- T-3-007: dispatch worker (CF Queue consumer).
- T-3-008: backoff + DLQ logic.
- T-3-009: E2E FLOW-03, FLOW-04.
