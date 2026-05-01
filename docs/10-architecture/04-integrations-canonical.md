# 04 — Modelo canônico de integrações

> Detalhe por provedor em [`40-integrations/`](../40-integrations/).

## Princípio: modelo interno é canônico, adapters mapeiam

Sistema interno tem schema canônico (`events`, `leads`, `consents`, etc.). Cada provedor externo tem seu schema próprio. **Adapters** convertem entre eles.

```
Externo (Hotmart/Stripe/Meta/Google)
        ↓
 Adapter inbound (mapToInternal) ──→ canonical event
                                              ↓
                                         events table
                                              ↓
                                         dispatch_jobs
                                              ↓
                                       Adapter outbound (mapToExternal)
                                              ↓
                                       Externo (Meta CAPI, Google Ads)
```

## Padrão de adapter inbound (webhook)

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

Localização:
- Handler: `apps/edge/src/routes/webhooks/<provider>.ts`
- Mapper puro: `apps/edge/src/integrations/<provider>/mapper.ts`
- Tests + fixtures: `tests/fixtures/<provider>/`

## Padrão de adapter outbound (dispatch)

```ts
type Dispatcher = {
  isEligible(event: Event, lead: Lead | null, config: TrackingConfig): EligibilityResult;
  buildPayload(event: Event, lead: Lead | null, config: TrackingConfig): ExternalPayload;
  send(payload: ExternalPayload, credentials: Credentials): Promise<DispatchResponse>;
  classifyError(error: unknown): 'retry' | 'permanent' | 'skip';
};
```

Localização: `apps/edge/src/dispatchers/<provider>/`.

## Princípios universais

1. **Idempotência obrigatória** (`30-contracts/04-webhook-contracts.md`, `BR-WEBHOOK-002`):
   - Inbound: `event_id = sha256(platform || ':' || platform_event_id)[:32]`.
   - Outbound: `idempotency_key = sha256(workspace_id|event_id|destination|destination_resource_id|destination_subresource)`.

2. **Assinatura validada antes de parse** (BR-WEBHOOK-001, ADR-022 para Stripe).

3. **Logs sanitizados** (BR-PRIVACY-001) — nunca payload completo com PII.

4. **Retry & DLQ** (BR-DISPATCH-003):
   - 4xx permanente: failed sem retry.
   - 429/5xx: retrying com backoff exponencial + jitter.
   - Após `max_attempts=5`: dead_letter.

5. **Fixtures de teste** em `tests/fixtures/<provider>/` cobrem: happy path, signature invalid, rate limit, payload malformado.

6. **Credenciais via env vars** ou (Fase 4+) `integration_credentials` table com encrypt-at-rest. Nunca em código.

7. **Eligibility check antes de chamar API**:
   - Consent check (BR-CONSENT-003).
   - Pré-condições por destino (e.g., Google Ads precisa `gclid` + `conversion_action`).
   - Skip explícito com `skip_reason` quando falha.

8. **Eventos não-mapeáveis** (inbound) vão para `raw_events.processing_status='failed'` com 200 ao caller (BR-WEBHOOK-003) — nunca 4xx que faria provedor retry forever.

## Fluxo de dados — visão consolidada

```
Inbound (webhook)
  → POST /v1/webhook/:platform
  → adapter.validateSignature
  → adapter.parsePayload
  → adapter.deriveEventId (idempotency)
  → Edge persiste em raw_events com platform_event_id em payload
  → 202 ao caller (rápido)
  → Ingestion processor (async):
    → adapter.mapToInternal (pure)
    → adapter.associateLead (lookup + merge)
    → MOD-EVENT.acceptRawEvent → events row
    → MOD-DISPATCH.createDispatchJobs

Outbound (dispatch)
  → CF Queue consumer recebe dispatch_job
  → Lock atômico (BR-DISPATCH-002)
  → Dispatcher.isEligible (check)
  → Dispatcher.buildPayload (lookup leads para enriquecer)
  → Dispatcher.send com retry awareness
  → Atualiza dispatch_job + dispatch_attempts
```

## Adapters atuais (Fase 2-3)

| Provedor | Direção | Fase | Doc |
|---|---|---|---|
| Meta CAPI | out | 2 | `40-integrations/01-meta-capi.md` |
| Meta Custom Audiences | out | 3 | `02-meta-custom-audiences.md` |
| Google Ads Conversion Upload | out | 3 | `03-google-ads-conversion-upload.md` |
| Google Ads Enhanced Conversions | out | 3 | `04-google-ads-enhanced-conversions.md` |
| Google Customer Match | out | 3 | `05-google-customer-match.md` |
| GA4 Measurement Protocol | out | 3 | `06-ga4-measurement-protocol.md` |
| Hotmart | in | 2 | `07-hotmart-webhook.md` |
| Kiwify | in | 2 | `08-kiwify-webhook.md` |
| Stripe | in | 2 | `09-stripe-webhook.md` |
| WebinarJam | in | 3 | `10-webinarjam-webhook.md` |
| Typeform/Tally | in | 3 | `11-typeform-tally-webhook.md` |
| FX Rates Provider | in (data fetch) | 3 | `12-fx-rates-provider.md` |

## Adicionar novo provedor

Checklist:
1. Criar arquivo em `40-integrations/<NN>-<provider>.md` seguindo template.
2. Implementar handler em `apps/edge/src/routes/webhooks/<provider>.ts` (inbound) ou dispatcher em `apps/edge/src/dispatchers/<provider>/` (outbound).
3. Mapper puro em `apps/edge/src/integrations/<provider>/mapper.ts`.
4. Fixtures em `tests/fixtures/<provider>/`.
5. Tests unit + integration.
6. ADR se afeta contrato canônico.
7. Atualizar `02-id-registry.md` se novo `EventSource` enum value.
8. Atualizar este overview com linha em "Adapters atuais".

ETA típico: 1-2 dias para provider simples (Hotmart-like); 3-5 dias para complexo (Stripe com signing scheme próprio).
