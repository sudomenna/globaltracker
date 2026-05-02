# 04 — Webhook contracts (inbound)

> Especificação de webhooks **inbound** — eventos que provedores externos enviam para o GlobalTracker. Cada provedor tem suas particularidades; este documento padroniza o que é universal.

## Princípios universais

1. **Idempotência obrigatória.** `event_id = sha256(platform || ':' || platform_event_id)[:32]` (ADR-019). Constraint `unique (workspace_id, event_id)` em `events` garante que retry da plataforma não duplica.
2. **Assinatura validada antes de qualquer processamento.** Falha de assinatura → 400 imediato sem processar payload.
3. **Raw body preservado** quando provedor exige (Stripe). Hono provê `c.req.raw.text()`.
4. **Comparação de assinatura em tempo constante** (`crypto.timingSafeEqual`). Nunca `===`/`==`.
5. **Anti-replay com tolerância de timestamp** quando provedor envia (Stripe: 5min — ADR-022).
6. **Mapper para evento canônico interno** em `mapToInternal()`. Mapper é função pura testável com fixtures.
7. **Eventos não mapeáveis vão para DLQ** com `processing_status='failed'` em `raw_events` (não rejeitar 4xx — provedor vai retry forever).
8. **Logs sanitizados.** Nunca logar payload completo se contém PII; apenas IDs e signature status.

## Endpoint padrão

```
POST /v1/webhook/:platform
```

Onde `platform` ∈ `['guru', 'hotmart', 'kiwify', 'stripe', 'webinarjam', 'typeform', 'tally']`.

Headers comuns:
- Específicos por provedor (assinatura, timestamp).
- `Content-Type: application/json` (exceção Stripe: lê raw body).

Resposta:
- `2xx` se aceito (provedor não retry).
- `4xx` apenas se assinatura inválida (`400`) ou plataforma desconhecida (`404`).
- `5xx` em erros internos — provedor retry.

## Por provedor

### Digital Manager Guru (`POST /v1/webhook/guru`)

| Item | Detalhe |
|---|---|
| **Eventos suportados (Fase 3)** | `webhook_type=transaction` (approved, refunded, chargedback, canceled) + `webhook_type=subscription` (active, canceled) |
| **Autenticação** | `api_token` (40 chars) no corpo JSON — comparado em tempo constante com `workspace_integrations.guru_api_token`. **Sem header HMAC.** |
| **Idempotency key** | `event_id = sha256("guru:" + webhook_type + ":" + id + ":" + status)[:32]` |
| **`platform_event_id`** | `id` (UUID da transação) ou `id` da assinatura |
| **Mapper** | `mapGuruTransactionToInternal()`, `mapGuruSubscriptionToInternal()` |
| **Eventos canônicos resultantes** | `Purchase`, `RefundProcessed`, `Chargeback`, `OrderCanceled`, `SubscriptionActivated`, `SubscriptionCanceled` |
| **Associação a lead** | `source.pptc.lead_public_id` → `contact.email` (hash) → `contact.phone` (hash) |
| **Valores monetários** | Em centavos (inteiros); dividir por 100 antes de persistir |
| **E-tickets** | Recebidos com 202, persistidos como `skipped` — não processados na Fase 3 |
| **Spec completa** | [`docs/40-integrations/13-digitalmanager-guru-webhook.md`](../40-integrations/13-digitalmanager-guru-webhook.md) |

### Hotmart (`POST /v1/webhook/hotmart`)

| Item | Detalhe |
|---|---|
| **Eventos suportados (Fase 2)** | `PURCHASE_APPROVED`, `PURCHASE_CHARGEBACK`, `PURCHASE_REFUNDED`, `PURCHASE_BILLET_PRINTED`, `PURCHASE_PROTEST` |
| **Assinatura** | Header `X-Hotmart-Hottok` ou HMAC sobre body com secret `HOTMART_WEBHOOK_SECRET`. (Validar contra documentação atual da Hotmart no momento da implementação.) |
| **Idempotency key** | `event_id = sha256("hotmart:" || data.purchase.transaction || ":" || event)` |
| **`platform_event_id`** | `data.purchase.transaction` (código único do pedido) |
| **Mapper** | `mapHotmartToInternal(payload): InternalEvent` |
| **Eventos canônicos resultantes** | `Purchase`, `RefundProcessed`, `Chargeback` (mapping na Fase 2) |
| **Associação a lead** | Prioridade: `metadata.lead_public_id` → `data.purchase.transaction` (order_id) → `data.buyer.email` (hash) → `data.buyer.phone` (hash) |
| **DLQ** | Eventos não mapeáveis ou erro de processing |

### Kiwify (`POST /v1/webhook/kiwify`)

| Item | Detalhe |
|---|---|
| **Eventos suportados (Fase 2)** | `order.paid`, `order.refunded`, `subscription.canceled` |
| **Assinatura** | HMAC-SHA256 sobre body com secret `KIWIFY_WEBHOOK_SECRET`. Header `X-Kiwify-Signature`. |
| **Idempotency key** | `event_id = sha256("kiwify:" || order.id || ":" || event_type)` |
| **`platform_event_id`** | `order.id` |
| **Mapper** | `mapKiwifyToInternal(payload): InternalEvent` |
| **Associação a lead** | `metadata.lead_public_id` → `order.id` → `customer.email` (hash) → `customer.phone` (hash) |

### Stripe (`POST /v1/webhook/stripe`)

| Item | Detalhe |
|---|---|
| **Eventos suportados (Fase 2)** | `checkout.session.completed`, `payment_intent.succeeded`, `charge.refunded`, `customer.subscription.deleted` |
| **Assinatura** | Esquema próprio — `Stripe-Signature` header com timestamp + HMAC. Use `stripe.webhooks.constructEvent(rawBody, sigHeader, STRIPE_WEBHOOK_SECRET)`. **ADR-022** com tolerância 5min. |
| **Idempotency key** | `event_id = sha256("stripe:" || event.id)` (Stripe `event.id` é único globalmente) |
| **`platform_event_id`** | `event.id` |
| **Raw body** | Obrigatório (`c.req.raw.text()` antes de qualquer parse). |
| **Mapper** | `mapStripeToInternal(event): InternalEvent` |
| **Associação a lead** | `event.data.object.metadata.lead_public_id` → `client_reference_id` → `customer.email` (hash) |

### WebinarJam (Fase 3) (`POST /v1/webhook/webinarjam`)

| Item | Detalhe |
|---|---|
| **Eventos suportados** | `webinar.registered`, `webinar.attended`, `webinar.left`, `webinar.replay_watched` |
| **Assinatura** | (validar com documentação WebinarJam — pode exigir token shared secret + IP allowlist) |
| **Idempotency key** | `event_id = sha256("webinarjam:" || webinar_id || ":" || attendee_id || ":" || event_type)` |
| **Associação** | `attendee_email` (hash) ou `lead_public_id` se propagado em registration form. |

### Typeform / Tally (Fase 3) (`POST /v1/webhook/typeform` ou `/tally`)

| Item | Detalhe |
|---|---|
| **Eventos suportados** | `form_response` (Typeform), `FORM_RESPONSE` (Tally) |
| **Assinatura** | Typeform: `Typeform-Signature` header SHA-256 HMAC. Tally: shared secret + custom header. |
| **Idempotency key** | `event_id = sha256("typeform:" || response_id)` |
| **Associação** | Hidden fields da resposta (`lead_public_id`, `launch_public_id`) ou email do response. |

## Mapper — interface comum

```ts
type WebhookAdapter = {
  validateSignature(req: Request): Promise<Result<{verified: true}, InvalidSignature>>;
  parsePayload(req: Request): Promise<Result<unknown, ParseError>>;
  derivePlatformEventId(payload: unknown): string;
  deriveEventId(workspace_id: string, platform_event_id: string, event_type: string): string;
  mapToInternal(payload: unknown, ctx: WebhookContext): Promise<Result<InternalEvent, MappingError>>;
  associateLead(internal_event: InternalEvent, ctx: WebhookContext): Promise<Result<{lead_id?: string}, AssociationFailure>>;
};
```

Cada provedor implementa em `apps/edge/src/routes/webhooks/<provider>.ts` (handler) + `apps/edge/src/integrations/<provider>/mapper.ts` (puro).

## Retry da plataforma

Plataformas geralmente retry por:
- `5xx` indefinidamente até max attempts (Stripe: 3 dias; Hotmart: configurável).
- Timeout (sem 2xx em N segundos).
- Não-2xx em geral.

GlobalTracker:
- Aceita request, persiste em `raw_events`, retorna 202 rápido (< 200ms).
- Idempotência via `event_id` derivado garante que retry da plataforma não duplica.
- Erros internos durante validação de assinatura → 400 imediato (provedor para de retry).
- Erros internos durante persistência → 500 (provedor retry).

## Tabela DLQ

`raw_events` com `processing_status='failed'` é a forma de DLQ. Ingestion processor pode marcar como `failed` se:
- Mapper lançou erro inesperado.
- Lead resolution falhou de forma não-recuperável.
- Workspace está `archived` (— vai para `discarded` em vez de `failed`).

Reprocessamento manual via cron ou job admin (Fase 3+).

## Política de evolução

- Adicionar provedor novo: novo arquivo em `40-integrations/` + handler em `apps/edge/src/routes/webhooks/` + adapter em `apps/edge/src/integrations/`. Não toca este contrato a menos que mude regra universal.
- Adicionar evento novo de provedor existente: ajusta mapper. Versionamento aplica se mapper public interface mudar (`mapToInternalV2()` quando muda shape de `InternalEvent`).
