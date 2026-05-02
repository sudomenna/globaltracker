# Digital Manager Guru Webhook (inbound)

## Papel no sistema
Receber notificações de transações, assinaturas e e-tickets do Digital Manager Guru e normalizar para eventos internos.

## Eventos suportados (Fase 3 — Sprint 3)

| `webhook_type` | `status` / gatilho | Mapeia para evento interno | Idempotency key derivada de |
|---|---|---|---|
| `transaction` | `approved` | `Purchase` | `sha256("guru:transaction:" + id + ":approved")[:32]` |
| `transaction` | `refunded` | `RefundProcessed` | `sha256("guru:transaction:" + id + ":refunded")[:32]` |
| `transaction` | `chargedback` | `Chargeback` | `sha256("guru:transaction:" + id + ":chargedback")[:32]` |
| `transaction` | `canceled` | `OrderCanceled` | `sha256("guru:transaction:" + id + ":canceled")[:32]` |
| `subscription` | `active` | `SubscriptionActivated` | `sha256("guru:subscription:" + id + ":active")[:32]` |
| `subscription` | `canceled` | `SubscriptionCanceled` | `sha256("guru:subscription:" + id + ":canceled")[:32]` |
| `eticket` | qualquer | *(Fase 4+, ignorar por ora)* | — |

> Eventos `eticket` são recebidos com 202 e não processados na Fase 3; persisted em `raw_events` com `processing_status='skipped'`.

## Endpoint

```
POST /v1/webhook/guru
```

O `workspace_id` é resolvido a partir do `api_token` recebido no payload — **não** usa query param.

## Autenticação

O Digital Manager Guru **não envia header de assinatura HMAC**. Em vez disso, inclui o `api_token` (40 chars) no corpo JSON do webhook. A validação ocorre por:

1. Extrair `payload.api_token` do body JSON.
2. Buscar workspace cujo `guru_api_token` (coluna em `workspace_integrations`) bate com o token recebido — comparação em tempo constante (`crypto.timingSafeEqual`).
3. Se não encontrar correspondência → `400 Unauthorized`.

```ts
const receivedToken = payload.api_token; // string(40)
const workspace = await db.query.workspaceIntegrations.findFirst({
  where: eq(workspaceIntegrations.guruApiToken, receivedToken),
});
if (!workspace) return c.json({ error: 'unauthorized' }, 400);
```

> **Segurança:** O token não é segredo gerado pelo GlobalTracker — é o API Token do workspace no painel Guru. Deve ser armazenado como segredo (não logar, não expor em respostas).

## Estrutura do payload — `webhook_type: "transaction"`

```json
{
  "webhook_type": "transaction",
  "api_token": "<40-char token>",
  "id": "9081534a-7512-4dab-9172-218c1dc1f263",
  "type": "producer",
  "status": "approved",
  "created_at": "2024-01-15T10:30:00Z",
  "confirmed_at": "2024-01-15T10:31:00Z",
  "contact": {
    "name": "Nome Comprador",
    "email": "comprador@email.com",
    "doc": "12345678900",
    "phone_number": "11999999999",
    "phone_local_code": "55"
  },
  "payment": {
    "method": "credit_card",
    "total": 29700,
    "gross": 29700,
    "net": 25245,
    "currency": "BRL",
    "installments": { "qty": 1, "value": 29700 }
  },
  "product": {
    "id": "prod-uuid",
    "name": "Curso XYZ",
    "type": "product",
    "offer": { "id": "offer-uuid", "name": "Oferta Principal" }
  },
  "source": {
    "utm_source": "facebook",
    "utm_campaign": "camp_123",
    "utm_medium": "paid",
    "utm_content": "ad_456",
    "utm_term": null
  }
}
```

## Estrutura do payload — `webhook_type: "subscription"`

```json
{
  "webhook_type": "subscription",
  "api_token": "<40-char token>",
  "id": "sub_BOAEj2WTKoclmg4X",
  "internal_id": "9ad693fe-4366-487b-8ac3-ff4831864929",
  "subscription_code": "sub_9CFyWTuPwXdJUikS",
  "name": "Plano Mensal",
  "last_status": "active",
  "provider": "guru",
  "payment_method": "credit_card",
  "charged_every_days": 30,
  "subscriber": {
    "id": "906d1e37-de6a-4f4d-8271-91ecd0d65ec6",
    "name": "Nome Assinante",
    "email": "email@email.com",
    "doc": "01234567890"
  },
  "current_invoice": {
    "id": "9b71cfb2-da2e-44d5-92ce-d83459dec85f",
    "status": "paid",
    "value": 2937,
    "cycle": 1
  }
}
```

## Mapper

```ts
// apps/edge/src/integrations/guru/mapper.ts

// MapResult é uma union de três variantes:
//   { ok: true; value: InternalEvent }
//   { ok: false; skip: true; reason: string }          — status ignorável (waiting_payment, expired, overdue)
//   { ok: false; skip?: false; error: MappingError }   — erro real (campo ausente, status desconhecido)

mapGuruTransactionToInternal(payload: GuruTransactionPayload): Promise<MapResult>
mapGuruSubscriptionToInternal(payload: GuruSubscriptionPayload): Promise<MapResult>
```

Funções assíncronas (usam Web Crypto para derivar `event_id`), sem outros efeitos colaterais; testáveis com fixtures sem I/O de rede ou banco.

## Associação a lead

Prioridade decrescente:

1. `source.pptc` → `lead_public_id` (se trafegado via UTM customizado)
2. `contact.email` (hash SHA-256)
3. `contact.phone_local_code + contact.phone_number` (hash SHA-256)
4. `subscriber.email` (hash SHA-256) — apenas para `subscription`

## Campos monetários

Os valores monetários no Guru são retornados em **centavos** (inteiros). Converter para unidade monetária antes de persistir:

```ts
const amountBRL = payload.payment.total / 100; // 29700 → 297.00
```

> Confirmado: `payment.total: 500` = R$ 5,00 no exemplo da documentação oficial.

## Idempotência

```ts
// BR-WEBHOOK-002: função deriveGuruEventId em mapper.ts
event_id = sha256("guru:" + webhookType + ":" + id + ":" + status).slice(0, 32)
```

`webhookType` é o valor literal (`"transaction"` ou `"subscription"`).  
Para `transaction`: `id` = UUID da transação; `status` = valor do campo `status`.  
Para `subscription`: `id` = campo `id` da assinatura (ex: `sub_BOAEj2WTKoclmg4X`); `status` = valor de `last_status`.

## Status de transação mapeáveis

| `status` Guru | Ação |
|---|---|
| `approved` | Processar como `Purchase` |
| `refunded` | Processar como `RefundProcessed` |
| `chargedback` | Processar como `Chargeback` |
| `canceled` | Processar como `OrderCanceled` |
| `waiting_payment` | Ignorar (pedido pendente) |
| `expired` | Ignorar |
| outros | DLQ com `processing_status='failed'` |

## Status de assinatura mapeáveis

| `last_status` Guru | Ação |
|---|---|
| `active` | Processar como `SubscriptionActivated` |
| `canceled` | Processar como `SubscriptionCanceled` |
| `overdue` | Ignorar (Fase 4+) |
| outros | DLQ |

## Referências

- [Webhook para Transações](https://docs.digitalmanager.guru/developers/webhook-para-transacoes)
- [Webhook para Assinaturas](https://docs.digitalmanager.guru/developers/webhook-para-assinaturas)
- [FAQ Webhooks](https://docs.digitalmanager.guru/configuracoes-gerais/perguntas-frequentes-sobre-webhooks)
