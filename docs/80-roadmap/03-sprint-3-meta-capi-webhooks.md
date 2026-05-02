# Sprint 3 — Meta CAPI v1 + webhook Digital Manager Guru

## Duração estimada
2-3 semanas.

## Objetivo
Dispatcher Meta CAPI funcional com enriquecimento server-side; adapter Digital Manager Guru; FLOW-03 e FLOW-04 verdes.

## Pré-requisitos
- Sprint 2 completo.

## Critério de aceite global

- [ ] Meta CAPI dispatcher: lookup em leads, retry 429/5xx, DLQ após 5 attempts, idempotency_key.
- [ ] Adapter Digital Manager Guru: validação de `api_token`, mapper transaction + subscription, fixtures.
- [ ] FLOW-03 (Meta CAPI dedup) e FLOW-04 (Purchase via webhook) E2E verdes.
- [ ] Métricas operacionais (`dispatch_health_view`) populadas.
- [ ] Smoke em produção (com pixel/webhook test mode).

## T-IDs (alto nível)

- T-3-001 a T-3-003: Meta CAPI dispatcher (mapper, client, eligibility).
- T-3-004: webhook adapter Digital Manager Guru (transaction + subscription).
- T-3-007: dispatch worker (CF Queue consumer).
- T-3-008: backoff + DLQ logic.
- T-3-009: E2E FLOW-03, FLOW-04.

## Fora de escopo (Sprint 9)

- Adapter Hotmart
- Adapter Kiwify
- Adapter Stripe
