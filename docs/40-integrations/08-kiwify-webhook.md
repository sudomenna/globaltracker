# Kiwify Webhook (inbound)

## Papel no sistema
Receber notificações de Order Paid, Refund, Subscription events da Kiwify e normalizar para eventos internos.

## Eventos consumidos (in)

| Evento Kiwify | Mapeia para | Idempotency key |
|---|---|---|
| `order.paid` | `Purchase` (stage `purchased`) | `order.id` |
| `order.refunded` | `RefundProcessed` | `order.id:refund` |
| `subscription.canceled` | `SubscriptionCanceled` (Fase 3+) | `subscription.id:cancel` |
| `order.created` | `InitiateCheckout` | `order.id:created` |

## Endpoint

```
POST /v1/webhook/kiwify?workspace=<workspace_slug>
```

## Assinatura

Kiwify usa HMAC-SHA256 sobre body com secret. Header `X-Kiwify-Signature`.

```ts
const computed = hmac('sha256', KIWIFY_WEBHOOK_SECRET, rawBody);
const received = req.headers.get('x-kiwify-signature');
if (!timingSafeEqual(received, computed)) return c.json({error: 'invalid_signature'}, 400);
```

## `event_id` derivation

```
event_id = sha256("kiwify:" || order.id || ":" || event_type)[:32]
```

## Mapping

| Campo Kiwify | Campo interno |
|---|---|
| `customer.email` | `email` |
| `customer.phone` | `phone` |
| `customer.name` | `name` |
| `order.id` | `events.custom_data.order_id` |
| `order.total_value_cents` | `events.custom_data.value` |
| `order.currency` | `events.custom_data.currency` |
| `order.tracking.utm_source` etc. | `events.attribution.utm_*` |

## Associação de lead

Mesma hierarquia BR-WEBHOOK-004:
1. `metadata.lead_public_id` (se decorated).
2. `order.id`.
3. `customer.email` hash via `lead_aliases`.
4. Click IDs.

## Credenciais

```
KIWIFY_WEBHOOK_SECRET
```

## Adapter

`apps/edge/src/routes/webhooks/kiwify.ts` + `apps/edge/src/integrations/kiwify/mapper.ts`.

## Fixtures

`tests/fixtures/kiwify/`:
- `order-paid.json`
- `order-refunded.json`
- `subscription-canceled.json`

## Observabilidade

- `kiwify_webhook_received_total{event_type}`
- `kiwify_webhook_signature_failures_total`

## Referências

- [Kiwify Webhook Documentation](https://docs.kiwify.com.br/webhook)
