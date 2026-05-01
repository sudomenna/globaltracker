# FLOW-04 — Registrar Purchase via webhook

## Gatilho
Plataforma de checkout (Hotmart/Stripe/Kiwify) envia webhook após compra.

## Atores
Plataforma externa (caller); sistema; MARKETER (consulta).

## UC envolvidos
UC-004.

## MOD-* atravessados
`MOD-EVENT`, `MOD-IDENTITY`, `MOD-FUNNEL`, `MOD-DISPATCH`, `MOD-ATTRIBUTION` (last-touch update).

## CONTRACT-* envolvidos
`30-contracts/04-webhook-contracts.md`, `40-integrations/07-hotmart-webhook.md` ou similar.

## BRs aplicadas
BR-WEBHOOK-001 a 004, BR-IDENTITY-003 (merge), BR-EVENT-002 (idempotency).

## Fluxo principal (exemplo Stripe)

1. Lead conclui checkout em `pay.cliente.com` (Stripe Checkout). Stripe envia `POST /v1/webhook/stripe?workspace=<slug>` com header `Stripe-Signature: t=<ts>,v1=<sig>`.
2. Adapter Stripe lê raw body via `c.req.raw.text()` (CRÍTICO — BR-WEBHOOK-001).
3. Adapter chama `stripe.webhooks.constructEvent(rawBody, sigHeader, STRIPE_WEBHOOK_SECRET, 300)` — valida assinatura tempo-constante + tolerância 5min.
4. Sucesso → adapter parse event como `Stripe.Event`.
5. Adapter deriva `event_id = sha256("stripe:" || event.id)[:32]`.
6. Adapter chama Edge `acceptRawEvent()` → persiste em `raw_events` com payload normalizado para shape interno.
7. Edge retorna 202 ao Stripe (Stripe não retry).
8. Ingestion processor (async) chama mapper `mapStripeToInternal()`:
   - `email = event.data.object.customer_details.email`
   - `value_cents = event.data.object.amount_total`
   - `currency = event.data.object.currency`
   - `order_id = event.data.object.id` (session id ou similar)
   - `lead_public_id = event.data.object.metadata.lead_public_id` (se decorado).
9. Processor chama `associateLead()` (BR-WEBHOOK-004):
   - Prioridade 1: `lead_public_id` resolve → lead L direto.
   - Caso ausente: `client_reference_id` → busca em `events.custom_data.order_id` anterior.
   - Caso ausente: `email_hash` em `lead_aliases`.
10. Processor chama `resolveLeadByAliases()` que pode merge se necessário (A2 do FLOW-02).
11. Processor cria evento `Purchase` em `events` com `lead_id=L`, `event_name='Purchase'`, `custom_data={value, currency, order_id}`, `event_source='webhook:stripe'`.
12. Processor chama `recordTouches()` para atualizar `last_touch` (last-touch da Purchase reflete attribution do checkout).
13. Processor chama `recordStage(L, launch_id, 'purchased', source_event_id, is_recurring=false)`.
14. Processor cria `dispatch_jobs`: Meta CAPI Purchase (com `value`/`currency`/`em`/`ph`/`order_id`), Google Ads Conversion Upload (se `gclid` propagado), Enhanced Conversions adjustment (com `order_id`), GA4 MP.
15. Workers de dispatch processam (FLOW-03 padrão).
16. MARKETER vê Purchase em dashboard, ROAS atualiza.

## Fluxos alternativos

### A1 — Assinatura inválida

3'. `constructEvent` lança `Stripe.errors.StripeSignatureVerificationError`:
   - Adapter retorna 400 `invalid_signature`.
   - Métrica `stripe_webhook_signature_failures_total` incrementa (ALERTA — possível tampering ou misconfig).
   - Stripe não envia webhook similar novamente para esse endpoint até ser corrigido.

### A2 — Replay (mesmo event.id 3×)

5'. Stripe network retry → 3× mesmo event.id:
   - 1ª: persiste em `raw_events`, processor cria event row, `dispatch_jobs`.
   - 2ª: `raw_events` insert OK (raw_events não tem unique). Processor tenta inserir em `events` → unique violation `(workspace_id, event_id)` → marca raw_event como `processed` com nota `duplicate`. Sem novos `dispatch_jobs`.
   - 3ª: idem.
   - Stripe recebe 202 todas vezes; deixa de retry.

### A3 — Lead não encontrado (associação fraca)

9'. Sem `lead_public_id`, sem `client_reference_id`, email não bate em `lead_aliases`:
   - Processor cria lead novo via `resolveLeadByAliases({email: stripe.email})`.
   - Lead criado com origem `webhook:stripe`. First-touch ausente (lead apareceu já no Purchase).
   - Operacionalmente, lead "órfão" — fila de revisão sugerida (Fase 4).

### A4 — Webhook conhecido mas evento não-mapeável

8'. Mapper recebe `event.type` que não está mapeado (ex.: `customer.tax.id_invalidated`):
   - Mapper retorna error `unknown_event_type`.
   - `raw_events.processing_status='failed'`, `processing_error='unknown_event_type:customer.tax.id_invalidated'`.
   - Adapter retorna 200 ao Stripe (BR-WEBHOOK-003 — não retry).
   - Operador investiga via dashboard técnico.

### A5 — Refund

Stripe envia `charge.refunded`:
   - Adapter mapeia para `RefundProcessed`.
   - Processor cria evento + stage `refunded`.
   - Não cria dispatch jobs (sem mapping para Meta/Google ainda — Fase 3+ se relevante).

## Pós-condições

- `events` com Purchase row.
- `lead_stages` `stage='purchased'`.
- `lead_attribution.last_touch` atualizado.
- `dispatch_jobs` para Meta/Google/GA4.
- Stripe webhook respondido com 2xx.

## TE-* emitidos

- TE-EVENT-INGESTED-v1, TE-EVENT-NORMALIZED-v1
- TE-LEAD-STAGE-RECORDED-v1
- TE-LAST-TOUCH-UPDATED-v1
- TE-DISPATCH-CREATED-v1 × N

## Casos de teste E2E

1. **Happy path** Stripe Purchase com lead pré-existente (via `lead_public_id`).
2. **Replay**: 3× mesmo event.id → 1 evento, 1 set de dispatch jobs.
3. **Signature invalid**: 400 + nenhum processing.
4. **Unknown event_type**: 200 + DLQ + alerta.
5. **Lead órfão**: lead criado no Purchase sem first-touch.
