# Sprint 13 — Webhook adapters Hotmart, Kiwify, Stripe

> **Nota**: Este sprint era originalmente Sprint 12, foi realocado para Sprint 13 em 2026-05-04 para abrir espaço ao Sprint 12 (realinhamento do template `lancamento_pago_workshop_com_main_offer` com fluxo operacional real, descoberto durante o E2E usability test do `wkshop-cs-jun26`).

## Duração estimada
A definir.

## Objetivo
Adicionar suporte a webhooks inbound das principais plataformas BR/global: Hotmart, Kiwify e Stripe. Completa o suporte multi-plataforma de purchase events para FLOW-04.

## Pré-requisitos
- Sprint 12 completo (template paid_workshop realinhado e funil B validado E2E em produção real).
- Sprint 11 completo (Funil Configurável Fase 3 — webhook Guru contextualizado já serve de referência de implementação).
- Sprint 3 completo (Meta CAPI + Guru webhook base).

## Critério de aceite global

- [ ] Adapter Hotmart: `X-Hotmart-Hottok` signature validation + mapper + fixtures.
- [ ] Adapter Kiwify: HMAC-SHA256 validation (`X-Kiwify-Signature`) + mapper + fixtures.
- [ ] Adapter Stripe: `constructEvent` raw body + tolerância 5min (ADR-022) + mapper + fixtures.
- [ ] FLOW-04 (Purchase via webhook) E2E verde para os três provedores.
- [ ] Smoke em produção com webhook test mode de cada provedor.

## T-IDs (alto nível)

- T-13-001: adapter Hotmart (handler + mapper).
- T-13-002: adapter Kiwify (handler + mapper).
- T-13-003: adapter Stripe (handler + mapper, raw body obrigatório).
- T-13-004: testes E2E FLOW-04 para Hotmart, Kiwify, Stripe.

### T-IDs de cleanup herdadas do Sprint 12

Falhas pré-existentes detectadas durante a verificação consolidada do Sprint 12 (descobertas por T-FUNIL-039 e T-FUNIL-041), fora do escopo Sprint 12 e realocadas para este sprint:

- **T-13-005** — `tests/integration/routes/config.test.ts:443` — fallback "200 quando DB binding ausente" não retorna o esperado. Investigar `apps/edge/src/routes/config.ts` para o caminho `env.DB === undefined`.
- **T-13-006** — `tests/integration/routes/integrations-test.test.ts:235` — Zod `.strict()` não rejeita extra fields no `POST /v1/integrations/:provider/test`. Possível downgrade do schema em refactor recente — verificar com `git log -p apps/edge/src/routes/integrations-test.ts`.
- **T-13-007** — `tests/integration/webhooks/stripe-signature.test.ts:148` — ADR-022 tolerance window off-by-one no `verifyStripeSignature`. Confirmar inequalidade `<= 300` vs `< 300` na implementação atual e alinhar com a doc do ADR.

## Referências de integração

- [`docs/40-integrations/07-hotmart-webhook.md`](../40-integrations/07-hotmart-webhook.md)
- [`docs/40-integrations/08-kiwify-webhook.md`](../40-integrations/08-kiwify-webhook.md)
- [`docs/40-integrations/09-stripe-webhook.md`](../40-integrations/09-stripe-webhook.md)
- [`docs/30-contracts/04-webhook-contracts.md`](../30-contracts/04-webhook-contracts.md)
