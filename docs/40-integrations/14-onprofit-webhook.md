# OnProfit Webhook (inbound)

## Papel no sistema

Receber notificações de pedidos (`object: "order"`) do checkout OnProfit e normalizar para eventos internos. Diferencial vs Guru: o payload OnProfit carrega **`fbc` e `fbp` nativamente** no body (capturados pelo checkout no momento do submit), elevando o EMQ Meta CAPI sem depender do enrichment histórico (ver [`01-meta-capi.md`](./01-meta-capi.md#enriquecimento-server-side-de-fbc--fbp--ip--ua--visitor_id-webhooks--herdam-do-histórico-do-lead)).

Adapter implementado no commit `59003f9`, deploy `1e905322` (2026-05-09). Spec do payload obtida diretamente com o operador (não há doc pública estável da OnProfit no momento da entrega).

## Eventos suportados

| OnProfit `status` | Mapeia para evento interno | Idempotency key |
|---|---|---|
| `PAID` | `Purchase` | `sha256("onprofit:" + id + ":PAID")[:32]` |
| `AUTHORIZED` | `Purchase` | `sha256("onprofit:" + id + ":AUTHORIZED")[:32]` |
| `WAITING` | `InitiateCheckout` (PIX gerado / boleto emitido) | `sha256("onprofit:" + id + ":WAITING")[:32]` |
| `REFUNDED` | `RefundProcessed` | `sha256("onprofit:" + id + ":REFUNDED")[:32]` |
| `CHARGEBACK` | `Chargeback` | `sha256("onprofit:" + id + ":CHARGEBACK")[:32]` |
| `STARTED` | *skip* (pedido criado antes da intent de pagamento — ruidoso) | — |
| `CANCELLED` | *skip* (usuário cancelou antes de pagar — sem valor de negócio) | — |
| Status desconhecido | erro de mapping → `raw_events.processing_status='failed'` + 200 | — |

A inclusão do `status` na key garante que cada transição do ciclo de vida do mesmo pedido (`WAITING → PAID → REFUNDED`) gere um `event_id` distinto e idempotente contra retries.

## Endpoint

```
POST /v1/webhooks/onprofit?workspace=<slug>
```

- `workspace_id` é resolvido pelo **slug** no query string (ex.: `?workspace=outsiders`).
- Server-to-server only — não usa `authPublicToken` nem `corsMiddleware`.
- Mounted em `apps/edge/src/index.ts` via `createOnprofitWebhookRoute(dbFactory)`.

> **Erro recorrente.** Slug é `outsiders`, **não** `outsiders-digital`. Confirmar com `SELECT slug FROM workspaces WHERE id = ...` antes de configurar a URL no painel OnProfit.

## Autenticação — HMAC pendente (TODO)

OnProfit ainda não publicou spec de header de assinatura. Hoje o webhook está protegido apenas por:

1. Conhecimento do **slug do workspace** (privado por workspace; não é segredo forte).
2. Restrição de URL no painel OnProfit (qual conta posta para qual URL).

O handler loga `event: 'onprofit_webhook_hmac_validation_todo'` em todo request como reminder operacional. Quando OnProfit publicar a spec, espelhar o padrão `timingSafeTokenEqual` usado em `apps/edge/src/routes/webhooks/hotmart.ts` e remover o `safeLog('warn', …)` reminder.

Tracking em `MEMORY.md §3 / ONPROFIT-HMAC-VALIDATION-TODO`.

## Estrutura do payload

```json
{
  "object": "order",
  "id": 12345678,
  "item_type": "product",
  "user_id": 789,
  "customer_id": 4567,
  "product_id": 23,
  "offer_id": 17,
  "offer_hash": "abc123",
  "offer_name": "Workshop CS Junho",
  "offer_price": 9700,
  "price": 9700,
  "currency": "BRL",
  "payment_type": "cc",
  "purchase_date": "2026-05-09 14:32:11",
  "status": "PAID",
  "confirmation_purchase_date": "2026-05-09 14:32:14",

  "utm_source": "facebook",
  "utm_medium": "paid",
  "utm_campaign": "wkshop-cs",
  "utm_content": "ad-456",
  "utm_term": null,

  "fbc": "fb.1.1715258000000.IwAR0...",
  "fbp": "fb.1.1715257900000.987654321",
  "src": null,
  "sck": null,

  "customer": {
    "name": "Nome",
    "lastname": "Sobrenome",
    "document": "12345678900",
    "email": "buyer@email.com",
    "phone": "(21) 99999-8888",
    "cell": "+5521999998888"
  },
  "customer_address": {
    "city": "Rio de Janeiro",
    "state": "RJ",
    "zip_code": "22000-000",
    "country": "BR"
  },

  "product": {
    "id": 23,
    "name": "Workshop Contratos Societários",
    "hash": "..."
  },

  "custom_fields": {
    "lead_public_id": "lp_abc123def456"
  }
}
```

### Notas semânticas

- **`price` e `offer_price` em CENTAVOS.** O mapper divide por 100 antes de gravar `events.custom_data.amount`. **Sem essa divisão, Meta CAPI receberia 100× o valor real**, inflando ROAS dashboards em 2 ordens de magnitude. Não remover.
- **Timestamps** seguem `"YYYY-MM-DD HH:mm:ss"` sem timezone. Tratamos como UTC (best-effort) — para analytics o erro é aceitável (poucas horas). Se OnProfit confirmar a TZ de origem, ajustar `parseOnProfitTimestamp` em `mapper.ts`.
- **Telefone**: `customer.cell` já vem em E.164 (ex.: `+5521999998888`); `customer.phone` é a forma "display" mascarada (ex.: `(21) 99999-8888`). Lead resolution **prefere `cell`** sobre `phone`.
- **`fbc` / `fbp`** são propagados direto para `events.user_data.fbc` / `.fbp` quando não-nulos. **É o motivo principal de existir o adapter** — Guru não carrega esses cookies no payload, OnProfit sim.
- **`customer_address.city/state/zip_code/country`** são propagados para `events.user_data.geo_*` (ADR-033) — Meta CAPI hashea com SHA-256 puro depois.
- **`src` / `sck`** são parâmetros extras com semântica indefinida; armazenados raw em `custom_data.src` / `custom_data.sck` sem mapear para attribution.

## Mapper

```ts
// apps/edge/src/integrations/onprofit/mapper.ts
mapOnProfitToInternal(payload: OnProfitWebhookPayload): Promise<OnProfitMapResult>
```

Função pura, async (usa Web Crypto para `event_id`). Retorna union de três variantes:

- `{ ok: true; value: OnProfitInternalEvent }` — sucesso.
- `{ ok: false; skip: true; reason: string }` — status ignorável (`STARTED`, `CANCELLED`).
- `{ ok: false; error: OnProfitMappingError }` — erro real (status desconhecido, campo obrigatório ausente, payload inválido).

## Associação a lead (BR-WEBHOOK-004)

Prioridade decrescente:

1. `custom_fields.lead_public_id` — `__fvid` injetado pelo tracker.js no checkout via custom field. Highest priority.
2. `customer.email` (hash workspace-scoped via `hashPii`).
3. `customer.cell` em E.164 — preferido sobre `customer.phone`.
4. `customer.phone` (display-formatted, fallback).

> **Operador deve injetar `lead_public_id`** como custom field no link de checkout OnProfit para destravar Strategy 1. Sem esse campo, o adapter cai em email/phone hash e perde a continuidade quando o lead trocou de email entre o opt-in e a compra.

## launch_id resolver — pendente (TODO)

`apps/edge/src/lib/onprofit-raw-events-processor.ts` ainda **não** resolve `launch_id` para Purchase events. Resultado: nenhum `lead_stages` é emitido para Purchases OnProfit (lifecycle promote ainda funciona via `products.category` → `lifecycleForCategory`).

Padrão a replicar: `apps/edge/src/lib/guru-launch-resolver.ts` (Strategy 0 = `launch_products` JOIN; Strategy 1 = `customer.lead_public_id` lookup; Strategy 2 = legacy `product_launch_map`). Para OnProfit, Strategy 0 funciona quando o produto é `upsert`-ado em `products` com `external_provider='onprofit'` + `external_product_id=String(payload.product.id)`.

Tracking em `MEMORY.md §3 / ONPROFIT-LAUNCH-RESOLVER-TODO`.

## Pipeline (8 steps no handler)

1. Read raw body text (preserva bytes exatos para HMAC futuro — BR-WEBHOOK-001).
2. Resolve workspace por `?workspace=<slug>`.
3. Parse JSON body.
4. Call `mapOnProfitToInternal`.
5. Skip → 202 (sem insert).
6. Mapping error → `raw_events.processing_status='failed'` + `processing_error='mapping_failed:<code>'` + 200 (BR-WEBHOOK-003 — não 4xx/5xx para evitar retry infinito).
7. Persist `raw_events` com `processing_status='pending'` (BR-EVENT-001 / INV-EVENT-005). Payload é gravado via helper `jsonb()` (T-13-013-FOLLOWUP) — ver [`30-contracts/02-db-schema-conventions.md`](../30-contracts/02-db-schema-conventions.md#writes-via-hyperdrive--helper-jsonb-obrigatório-t-13-013-followup-2026-05-09).
8. Enqueue para `QUEUE_EVENTS` para ingestion async pelo processor.

Falha de enqueue não derruba o request — `raw_events` já foi persistido e processor pode pegar via sweep job posteriormente (at-least-once).

## Idempotência

`event_id = sha256("onprofit:" + order.id + ":" + status)[:32]` (32 chars hex, BR-WEBHOOK-002). Insert em `events` é dedupe-protected pela constraint `unique (workspace_id, event_id)` (BR-EVENT-002). KV replay protection TTL 7d aplica-se para a primeira camada (BR-EVENT-004).

## Observabilidade

Logs estruturados (sem PII em claro — BR-PRIVACY-001):

- `onprofit_webhook_hmac_validation_todo` (warn — todo request até HMAC implementar)
- `onprofit_webhook_workspace_not_found` (warn — slug inválido)
- `onprofit_webhook_skipped` (info — `STARTED`/`CANCELLED`)
- `onprofit_webhook_mapping_failed` (warn — status desconhecido / campo ausente)
- `onprofit_webhook_accepted` (info — fluxo feliz; inclui flags `has_fbc`/`has_fbp` para visibilidade do EMQ projetado)
- `onprofit_webhook_db_lookup_error` / `_insert_failed` / `_enqueue_failed` (error — investigar)

View `v_meta_capi_health` (migration `0047`) reflete eventos OnProfit junto com Guru/SendFlow/tracker — filtre por `event_source='webhook:onprofit'` para isolar.

## Configuração operacional

Tabela em `MEMORY.md §1 / OnProfit configuração`:

- Webhook URL: `https://globaltracker-edge.globaltracker.workers.dev/v1/webhooks/onprofit?workspace=outsiders`
- Workspace slug: `outsiders` (não `outsiders-digital`).
- Page criada: `checkout-onprofit-workshop` (role=`checkout`, launch=`wkshop-cs-jun26`).
- Tracker.js: snippet instalado no HTML slot do checkout OnProfit com `data-launch-public-id=wkshop-cs-jun26`.
- Pixel Web OnProfit: **OFF** (operador desativou para evitar conflito com Pixel próprio + tracker.js; Meta CAPI server-side cobre o evento).

## Adapter — arquivos

- `apps/edge/src/integrations/onprofit/types.ts` — tipos do payload (PII fields anotadas com BR-PRIVACY-001).
- `apps/edge/src/integrations/onprofit/mapper.ts` — `mapOnProfitToInternal`, `deriveOnProfitEventId`, `parseOnProfitTimestamp`.
- `apps/edge/src/routes/webhooks/onprofit.ts` — `createOnprofitWebhookRoute(dbFactory)` Hono router.
- `apps/edge/src/lib/onprofit-raw-events-processor.ts` — async ingestion processor (insert em `events`, lead resolution, lifecycle promote).
- Migration `0046_add_onprofit_event_source.sql` — adiciona `'webhook:onprofit'` a `chk_events_event_source`.
- Migration `0045_products_onprofit_provider.sql` — adiciona `'onprofit'` a `ProductExternalProvider`.

## Fixtures de teste

Não há fixtures dedicadas committadas. Usar payload real do operador (anonimizado via remoção de email/phone/document) como base — TODO consolidar em `tests/fixtures/onprofit/order-paid.json` quando os testes do processor forem escritos.
