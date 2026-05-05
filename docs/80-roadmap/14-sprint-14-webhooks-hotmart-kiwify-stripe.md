# Sprint 14 — Webhook adapters Hotmart, Kiwify, Stripe

> **Nota**: Este escopo era originalmente Sprint 13. Foi realocado para Sprint 14 em 2026-05-05 para abrir espaço ao Sprint 13 atual (foundation de identidade + SendFlow inbound + cleanups herdados S12), que destrava a operação real do funil B em produção. Os adapters multi-plataforma (Hotmart/Kiwify/Stripe) são prioridade da próxima onda — depois que SendFlow + normalizador de phone BR estiverem maduros e validados em prod.

## Duração estimada
A definir.

## Objetivo
Adicionar suporte a webhooks inbound das principais plataformas BR/global: Hotmart, Kiwify e Stripe. Completa o suporte multi-plataforma de purchase events para FLOW-04.

## Pré-requisitos
- Sprint 13 completo (foundation de identidade BR-aware + SendFlow webhook inbound em produção).
- Sprint 11 completo (Funil Configurável Fase 3 — webhook Guru contextualizado já serve de referência de implementação).
- Sprint 3 completo (Meta CAPI + Guru webhook base).

## Critério de aceite global

- [ ] Adapter Hotmart: `X-Hotmart-Hottok` signature validation + mapper + fixtures.
- [ ] Adapter Kiwify: HMAC-SHA256 validation (`X-Kiwify-Signature`) + mapper + fixtures.
- [ ] Adapter Stripe: `constructEvent` raw body + tolerância 5min (ADR-022) + mapper + fixtures.
- [ ] FLOW-04 (Purchase via webhook) E2E verde para os três provedores.
- [ ] Smoke em produção com webhook test mode de cada provedor.

## T-IDs (alto nível)

- T-14-001: adapter Hotmart (handler + mapper).
- T-14-002: adapter Kiwify (handler + mapper).
- T-14-003: adapter Stripe (handler + mapper, raw body obrigatório).
- T-14-004: testes E2E FLOW-04 para Hotmart, Kiwify, Stripe.
- T-14-005: ADR-022 tolerance window off-by-one no `verifyStripeSignature` — confirmar inequalidade `<= 300` vs `< 300` na implementação atual e alinhar com a doc do ADR. Originalmente catalogado como T-13-007 (cleanup herdado do Sprint 12); migrado pra Sprint 14 junto com o Stripe adapter por proximidade de domínio. Referência: `tests/integration/webhooks/stripe-signature.test.ts:148`.

## Referências de integração

- [`docs/40-integrations/07-hotmart-webhook.md`](../40-integrations/07-hotmart-webhook.md)
- [`docs/40-integrations/08-kiwify-webhook.md`](../40-integrations/08-kiwify-webhook.md)
- [`docs/40-integrations/09-stripe-webhook.md`](../40-integrations/09-stripe-webhook.md)
- [`docs/30-contracts/04-webhook-contracts.md`](../30-contracts/04-webhook-contracts.md)
