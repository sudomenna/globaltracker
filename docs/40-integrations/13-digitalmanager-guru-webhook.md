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
| `transaction` | `abandoned` | `InitiateCheckout` | `sha256("guru:transaction:" + id + ":abandoned")[:32]` |
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
    "phone_local_code": "55",
    "address": {
      "city": "São Paulo",
      "state": "SP",
      "zip_code": "01310-100",
      "country": "BR"
    }
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

## PII enrichment via webhook (Sprint 14)

Após `resolveLeadByAliases` resolver/criar o lead, o `guru-raw-events-processor` chama `enrichLeadPii({ leadId, workspaceId, email, phone, name, db, masterKey })` (`apps/edge/src/lib/pii-enrich.js`). Esta etapa preenche os campos plain-text + ciphertext do lead que o resolver não toca:

- `leads.email_enc` / `leads.phone_enc` / `leads.name_enc` — AES-256-GCM workspace-scoped via `PII_MASTER_KEY_V1`.
- `leads.name` — plaintext (ADR-034).
- `leads.fn_hash` / `leads.ln_hash` (T-OPB) — hashes externos do nome split via `splitName`.

Antes desta etapa, leads criados exclusivamente por webhook ficavam com `email_hash` / `phone_hash` populados (via `resolveLeadByAliases`) mas **sem** `email_enc` / `phone_enc` / `name`. Resultado prático: na tela Contatos, esses leads apareciam com dados mascarados/vazios mesmo para roles privilegiadas. `enrichLeadPii` é idempotente — só escreve em colunas atualmente `NULL`.

Requer `PII_MASTER_KEY_V1` propagado do queue consumer (`apps/edge/src/index.ts`). Se a key não estiver presente, `enrichLeadPii` faz soft-fail (log, sem bloquear o pipeline).

## Campos monetários

Os valores monetários no Guru são retornados em **centavos** (inteiros). Converter para unidade monetária antes de persistir:

```ts
const amountBRL = payload.payment.total / 100; // 29700 → 297.00
```

> Confirmado: `payment.total: 500` = R$ 5,00 no exemplo da documentação oficial.

## Geo enrichment via `contact.address` (ADR-033, Sprint 16)

Quando o payload Guru inclui `contact.address` (depende do plano Guru / habilitação de NF), o `guru-raw-events-processor` extrai os campos para `events.userData` em chaves canônicas:

| Campo Guru | Campo `events.userData` |
|---|---|
| `contact.address.city` | `geo_city` |
| `contact.address.state` | `geo_region_code` |
| `contact.address.zip_code` | `geo_postal_code` |
| `contact.address.country` | `geo_country` |

Spread é condicional — quando ausente no payload, os campos `geo_*` ficam fora do JSONB (sem `null`). Não há fallback para `request.cf.*` em eventos Guru: o request vem do servidor do Guru, não do comprador (ADR-033).

> **`contact.address` aceita string ou objeto.** Algumas instalações Guru emitem `contact.address` como string plana (ex.: `"Rua Acre"`) em vez do objeto estruturado `{ city, state, zip_code, country }`. O Zod schema do `guru-raw-events-processor.ts` aplica `z.preprocess(v => typeof v === 'string' ? null : v, ...)` antes do parse — string é coerced para `null` (não dá pra extrair geo confiável de string livre); objeto continua aceito normalmente. Antes deste fix, payloads com address-string falhavam em `payload_validation` → 400 → eventos perdidos.

Os campos são consumidos por dispatchers outbound:
- **Meta CAPI** hasheia para `user_data.{ct,st,zp,country}` em `buildMetaCapiDispatchFn`.
- **Google Enhanced Conversions** repassa em plain text para `addressInfo.{city,state,zipCode,countryCode}`.

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
| `abandoned` | Processar como `InitiateCheckout` (recuperação de checkout iniciado e não finalizado — Sprint 14, T-RECOVERY-001) |
| `waiting_payment` | Ignorar (pedido pendente) |
| `expired` | Ignorar |
| outros | DLQ com `processing_status='failed'` |

> **`abandoned` → `InitiateCheckout`**: dispara dispatch outbound para Meta CAPI (`InitiateCheckout`) e GA4 MP (`begin_checkout`). Antes de Sprint 14 caía em `default → unknown_status` (mapping_failed). Use case: alimentar tela `GET /v1/launches/:id/recovery` com checkouts iniciados mas não completados.

## Status de assinatura mapeáveis

| `last_status` Guru | Ação |
|---|---|
| `active` | Processar como `SubscriptionActivated` |
| `canceled` | Processar como `SubscriptionCanceled` |
| `overdue` | Ignorar (Fase 4+) |
| outros | DLQ |

## Resolução de launch e funnel_role (Sprint 11 — T-FUNIL-022)

Antes de persistir o `raw_event`, o handler chama `resolveLaunchForGuruEvent()` (`apps/edge/src/lib/guru-launch-resolver.ts`) **apenas para eventos do tipo `transaction` e `subscription`** (i.e., todos os eventos de Purchase e afins). Eventos `eticket` são descartados antes desse passo.

### Função `resolveLaunchForGuruEvent`

```ts
resolveLaunchForGuruEvent(params: {
  workspaceId: string;
  productId: string | null | undefined;
  leadHints: { email?: string | null; phone?: string | null; visitorId?: string | null };
  db: Db;
}): Promise<{ launch_id: string | null; funnel_role: string | null; strategy: 'mapping' | 'last_attribution' | 'none' }>
```

### Cadeia de estratégias

| Estratégia | Condição | launch_id | funnel_role |
|---|---|---|---|
| `mapping` | `productId` presente no `workspace.config.integrations.guru.product_launch_map` | UUID resolvido via `launch_public_id` | conforme entrada do mapa |
| `last_attribution` | `productId` ausente no mapa (ou `launch_id` não encontrado) — lead identificado via `leadHints` | `launch_id` da `lead_attribution` mais recente | `null` |
| `none` | Lead não identificável e sem mapa | `null` | `null` |

**Fallthrough:** se `productId` está no mapa mas o `launch_public_id` correspondente não resolve para um `launch_id` existente no workspace, a estratégia cai para `last_attribution`.

### Shape do `product_launch_map`

Armazenado em `workspace.config.integrations.guru.product_launch_map` (JSONB). Cada chave é o `product.id` recebido no payload Guru; o valor mapeia ao launch e ao papel no funil:

```json
{
  "prod_workshop_xyz": {
    "launch_public_id": "lcm-maio-2026",
    "funnel_role": "workshop"
  },
  "prod_main_xyz": {
    "launch_public_id": "lcm-maio-2026",
    "funnel_role": "main_offer"
  },
  "prod_evergreen_abc": {
    "launch_public_id": "evergreen-cs",
    "funnel_role": "main_offer"
  }
}
```

Configurado via `PATCH /v1/workspace/config` (ver `docs/30-contracts/05-api-server-actions.md`). A UI de mapeamento está na tab Overview do launch detail no Control Plane.

### Injeção no `raw_event.payload`

Os campos `launch_id` e `funnel_role` são injetados no JSONB do `raw_event.payload` quando resolvidos (campos omitidos quando `null`):

```json
{
  "webhook_type": "transaction",
  "...<demais campos sanitizados>...",
  "_guru_event_id": "<event_id derivado>",
  "_guru_event_type": "Purchase",
  "launch_id": "<uuid>",
  "funnel_role": "workshop"
}
```

O `raw-events-processor` já lê `payload.funnel_role` via `source_event_filters` para determinar o stage correto (`purchased_workshop` vs `purchased_main`).

### Audit log por estratégia

Para **todas as estratégias** (mapping, last_attribution, none), o resolver emite um log estruturado via `safeLog`:

```json
{
  "event": "guru_launch_resolved",
  "workspace_id": "<uuid>",
  "product_id": "<product_id ou null>",
  "strategy": "mapping | last_attribution | none",
  "launch_id": "<uuid ou null>",
  "funnel_role": "<string ou null>"
}
```

O campo `strategy` fica disponível em `audit_log.metadata` para consulta pelo painel de mapeamento no CP (`action='guru_launch_resolved' AND metadata->>'product_id' IN (...)`).

**BR-AUDIT-001:** safeLog registrado em todas as estratégias.
**BR-PRIVACY-001:** `leadHints` (email, phone) são hasheados antes de qualquer consulta ao DB; valores brutos nunca chegam a logs.

## Referências

- [Webhook para Transações](https://docs.digitalmanager.guru/developers/webhook-para-transacoes)
- [Webhook para Assinaturas](https://docs.digitalmanager.guru/developers/webhook-para-assinaturas)
- [FAQ Webhooks](https://docs.digitalmanager.guru/configuracoes-gerais/perguntas-frequentes-sobre-webhooks)
