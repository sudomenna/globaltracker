# Hotmart Webhook (inbound)

## Papel no sistema
Receber notificações de Purchase, Refund, Chargeback, BilletPrinted da Hotmart e normalizar para eventos internos.

## Eventos consumidos (in)

| Evento Hotmart | Mapeia para evento interno | Idempotency key derivada de |
|---|---|---|
| `PURCHASE_APPROVED` | `Purchase` (com `lead_stages.stage='purchased'`) | `data.purchase.transaction` |
| `PURCHASE_BILLET_PRINTED` | `InitiateCheckout` ou `BilletGenerated` | `data.purchase.transaction:billet` |
| `PURCHASE_PROTEST` | `Chargeback` | `data.purchase.transaction:protest` |
| `PURCHASE_REFUNDED` | `RefundProcessed` | `data.purchase.transaction:refund` |
| `PURCHASE_CHARGEBACK` | `Chargeback` | `data.purchase.transaction:chargeback` |
| `SUBSCRIPTION_CANCELLATION` | `SubscriptionCanceled` (Fase 3+) | `data.subscription.code:cancellation` |

## Endpoint

```
POST /v1/webhook/hotmart?workspace=<workspace_slug>
```

Workspace via query param (Hotmart não suporta header customizado por evento).

## Assinatura / autenticação

Hotmart envia header `X-Hotmart-Hottok` (token shared secret) ou usa HMAC sobre body. Validação no adapter consulta documentação atualizada da Hotmart.

```ts
const expected = HOTMART_WEBHOOK_SECRET; // ou HMAC computado
const received = req.headers.get('x-hotmart-hottok');
if (!timingSafeEqual(received, expected)) return c.json({error: 'invalid_signature'}, 400);
```

## `event_id` derivation (BR-WEBHOOK-002)

```
event_id = sha256("hotmart:" || data.purchase.transaction || ":" || event)[:32]
```

Exemplo: `event="PURCHASE_APPROVED"`, `transaction="HC123"` → `event_id = sha256("hotmart:HC123:PURCHASE_APPROVED")[:32]`.

## Mapping

| Campo Hotmart | Campo interno |
|---|---|
| `data.buyer.email` | `email` (no `/v1/lead` interno chamado pelo adapter) |
| `data.buyer.checkout_phone` | `phone` |
| `data.buyer.name` | `name` |
| `data.purchase.transaction` | `events.custom_data.order_id` |
| `data.purchase.price.value` | `events.custom_data.value` (cents) |
| `data.purchase.price.currency_value` | `events.custom_data.currency` |
| `data.purchase.tracking.source` etc. | `events.attribution.utm_source` etc. |
| `data.purchase.utms.*` | `events.attribution.utm_*` (se Hotmart propaga) |

## Associação de lead

Prioridade (BR-WEBHOOK-004):
1. `metadata.lead_public_id` (se decorated em link → Hotmart pass-through).
2. `data.purchase.transaction` (order_id) — busca em `events` anteriores com este `order_id`.
3. `email_hash` ou `phone_hash` consultando `lead_aliases`.
4. Click IDs propagados.

## Retry & DLQ

Hotmart retry: ~5x com backoff exponencial até 24h. GlobalTracker:
- Aceita request, persiste em `raw_events`, retorna 202.
- Sucesso de mapeamento + lead resolve → evento normalizado em `events`.
- Falha → `raw_events.processing_status='failed'` + 200 ao Hotmart (não retry).

## Credenciais

```
HOTMART_WEBHOOK_SECRET
```

Por workspace via Control Plane (Fase 4).

## Adapter

`apps/edge/src/routes/webhooks/hotmart.ts` (handler) +
`apps/edge/src/integrations/hotmart/mapper.ts` (puro).

## Fixtures

`tests/fixtures/hotmart/`:
- `purchase-approved.json`
- `purchase-refunded.json`
- `purchase-chargeback.json`

## Observabilidade

- `hotmart_webhook_received_total{event_type}`
- `hotmart_webhook_signature_failures_total`
- `hotmart_webhook_unmapped_events_total`

## Referências

- [Hotmart Webhook Documentation](https://developers.hotmart.com/docs/en/start/webhook/)
