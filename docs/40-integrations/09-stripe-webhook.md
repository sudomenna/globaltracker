# Stripe Webhook (inbound)

## Papel no sistema
Receber notificações de checkout, payment, refund, subscription da Stripe via webhook signed.

## Eventos consumidos (in)

| Evento Stripe | Mapeia para | Idempotency key |
|---|---|---|
| `checkout.session.completed` | `Purchase` (stage `purchased`) | `event.id` |
| `payment_intent.succeeded` | `PaymentCompleted` (alternativa para flows não-Checkout) | `event.id` |
| `charge.refunded` | `RefundProcessed` | `event.id` |
| `customer.subscription.deleted` | `SubscriptionCanceled` (Fase 3+) | `event.id` |
| `customer.subscription.created` | `SubscriptionStarted` (Fase 3+) | `event.id` |

## Endpoint

```
POST /v1/webhook/stripe?workspace=<workspace_slug>
```

## Assinatura — ADR-022 (CRÍTICO)

Stripe usa esquema próprio: `Stripe-Signature` header com `t=<timestamp>,v1=<signature>`. Signature é HMAC-SHA256 sobre `${timestamp}.${rawBody}` com `STRIPE_WEBHOOK_SECRET`.

**Implementação obrigatória:**

```ts
// CRITICAL: ler raw body antes de QUALQUER parse
const rawBody = await c.req.raw.text();
const sigHeader = c.req.header('stripe-signature');

try {
  // Stripe SDK faz validação tempo-constante + tolerância de timestamp
  const event = stripe.webhooks.constructEvent(
    rawBody,
    sigHeader,
    STRIPE_WEBHOOK_SECRET,
    300 // tolerance: 5 minutos (default)
  );
  // ... process event
} catch (err) {
  return c.json({error: 'invalid_signature'}, 400);
}
```

**NÃO** usar `===` ou `==` para comparar signatures. **NÃO** parse JSON antes de validar.

## `event_id` derivation

```
event_id = sha256("stripe:" || event.id)[:32]
```

(Stripe `event.id` é único globalmente — `evt_xxx`.)

## Mapping

| Campo Stripe | Campo interno |
|---|---|
| `event.data.object.customer_email` ou `.customer_details.email` | `email` |
| `event.data.object.customer_details.phone` | `phone` |
| `event.data.object.customer_details.name` | `name` |
| `event.id` | `events.custom_data.order_id` (Stripe usa event.id como referência) |
| `event.data.object.amount_total` | `events.custom_data.value` (já em cents) |
| `event.data.object.currency` | `events.custom_data.currency` (uppercase) |
| `event.data.object.metadata.lead_public_id` | associação prioridade 1 |
| `event.data.object.client_reference_id` | associação prioridade 2 |
| `event.data.object.metadata.utm_*` | `events.attribution.utm_*` |

## Associação de lead

Hierarquia BR-WEBHOOK-004:
1. `event.data.object.metadata.lead_public_id` (Stripe permite metadata até 50 keys, 500 chars cada — usar).
2. `event.data.object.client_reference_id`.
3. `customer_email` hash.
4. `customer.id` (Stripe customer) cross-ref se previamente vinculado.

## Retry da Stripe

Stripe retry: até 3 dias com backoff. Resposta 2xx do GlobalTracker para qualquer adapter mapeamento ok ou unknown event (BR-WEBHOOK-003).

## Credenciais

```
STRIPE_WEBHOOK_SECRET
```

(Por endpoint Stripe quando workspace tem múltiplos endpoints — webhook secret é por endpoint, não por conta.)

## Adapter

`apps/edge/src/routes/webhooks/stripe.ts`:
- Lê raw body via `c.req.raw.text()`.
- Chama `stripe.webhooks.constructEvent()`.
- Delega a `apps/edge/src/integrations/stripe/mapper.ts`.

## Fixtures

`tests/fixtures/stripe/`:
- `checkout-session-completed.json`
- `payment-intent-succeeded.json`
- `charge-refunded.json`
- `signature-invalid.txt` (raw body + invalid sig)

## Observabilidade

- `stripe_webhook_received_total{event_type}`
- `stripe_webhook_signature_failures_total` (alerta se > 0 — possível tampering ou misconfig)
- `stripe_webhook_replay_rejected_total` (timestamp tolerance violations)

## Test específico

`tests/integration/webhooks/stripe-signature.test.ts`:
- Sucesso com assinatura válida.
- Falha com assinatura inválida (timing-safe comparison).
- Falha com timestamp > 5min (replay).
- Sucesso com timestamp dentro da tolerância.

## Referências

- [Stripe Webhooks](https://docs.stripe.com/webhooks)
- [Verify webhook signatures](https://docs.stripe.com/webhooks#verify-events)
