# Sprint 15 — Webhook adapters Hotmart, Kiwify, Stripe

> **Histórico de renumeração**: este escopo era originalmente Sprint 13, foi promovido para Sprint 14 em 2026-05-05 e finalmente para Sprint 15 em 2026-05-06 quando um novo Sprint 14 dedicado ao fanout multi-destination (Google Ads + GA4 + Enhanced Conversions) foi inserido na frente. A motivação: alimentar Google Ads + Meta com **todos** os eventos canonical pra rodar campanhas de remarketing é pré-requisito comercial pra escalar o funil — vem antes da multiplicação de adapters webhook.

## Duração estimada
A definir.

## Objetivo
Adicionar suporte a webhooks inbound das principais plataformas BR/global: Hotmart, Kiwify e Stripe. Completa o suporte multi-plataforma de purchase events para FLOW-04.

## Pré-requisitos
- Sprint 13 completo (foundation de identidade BR-aware + SendFlow webhook inbound em produção).
- Sprint 14 completo (fanout Google Ads/GA4/Enhanced — garante que purchase events de qualquer adapter chegam nos 4 destinations).
- Sprint 11 completo (Funil Configurável Fase 3 — webhook Guru contextualizado já serve de referência de implementação).
- Sprint 3 completo (Meta CAPI + Guru webhook base).

## Critério de aceite global

- [ ] Adapter Hotmart: `X-Hotmart-Hottok` signature validation + mapper + fixtures.
- [ ] Adapter Kiwify: HMAC-SHA256 validation (`X-Kiwify-Signature`) + mapper + fixtures.
- [ ] Adapter Stripe: `constructEvent` raw body + tolerância 5min (ADR-022) + mapper + fixtures.
- [ ] FLOW-04 (Purchase via webhook) E2E verde para os três provedores.
- [ ] Smoke em produção com webhook test mode de cada provedor.

## T-IDs (alto nível)

- T-15-001: adapter Hotmart (handler + mapper). **Inclui chamada a `enrichLeadPii` (T-13-015)** após `resolveLeadByAliases` retornar — leads criados via webhook Hotmart sem form prévio precisam ter `email_enc/phone_enc/name_enc` populados pra admin recovery + DSAR.
- T-15-002: adapter Kiwify (handler + mapper). **Idem — chamada a `enrichLeadPii` no fluxo de criação de lead via webhook**.
- T-15-003: adapter Stripe (handler + mapper, raw body obrigatório). **Idem — `enrichLeadPii` na criação de lead via webhook (`receipt_email` + metadata).** Stripe pode não vir com phone — popular só os campos disponíveis (helper já é tolerante a campos ausentes).
- T-15-004: testes E2E FLOW-04 para Hotmart, Kiwify, Stripe — incluir asserções no DB de que `email_enc IS NOT NULL` e (quando aplicável) `phone_enc IS NOT NULL` após o evento de compra.
- T-15-005: ADR-022 tolerance window off-by-one no `verifyStripeSignature` — confirmar inequalidade `<= 300` vs `< 300` na implementação atual e alinhar com a doc do ADR. Originalmente catalogado como T-13-007 (cleanup herdado do Sprint 12); migrado pra Sprint 14 (renumeração 2026-05-05) e então pra Sprint 15 (renumeração 2026-05-06) junto com o Stripe adapter por proximidade de domínio. Referência: `tests/integration/webhooks/stripe-signature.test.ts:148`.

## Referências de integração

- [`docs/40-integrations/07-hotmart-webhook.md`](../40-integrations/07-hotmart-webhook.md)
- [`docs/40-integrations/08-kiwify-webhook.md`](../40-integrations/08-kiwify-webhook.md)
- [`docs/40-integrations/09-stripe-webhook.md`](../40-integrations/09-stripe-webhook.md)
- [`docs/30-contracts/04-webhook-contracts.md`](../30-contracts/04-webhook-contracts.md)
