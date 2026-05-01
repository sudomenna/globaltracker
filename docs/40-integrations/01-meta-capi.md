# Meta Conversions API

## Papel no sistema
Dispatch out de eventos de tracking (PageView, Lead, Purchase, custom) para Meta Pixel via API server-side. Permite enriquecimento server-side de `user_data` (ADR-006).

## Eventos emitidos (out)
| Ação interna | Chamada externa |
|---|---|
| `events` row → `dispatch_jobs.destination='meta_capi'` processado | `POST https://graph.facebook.com/v20.0/{pixel_id}/events` |

## Mapping canônico

| Campo interno | Campo Meta | Notas |
|---|---|---|
| `events.event_name` | `event_name` | Mesmo valor; deve coincidir com Pixel browser quando dedup ativo |
| `events.event_time` | `event_time` | Unix timestamp; já clampado pelo Edge |
| `events.event_id` | `event_id` | Mesmo valor do `eventID` browser quando aplicável |
| `leads.email_hash` | `user_data.em` | Lookup via `event.lead_id` |
| `leads.phone_hash` | `user_data.ph` | Lookup |
| (transient) | `user_data.client_ip_address` | Não hashar; required para website events |
| (transient) | `user_data.client_user_agent` | Não hashar; required |
| `events.user_data.fbc` | `user_data.fbc` | Não hashar |
| `events.user_data.fbp` | `user_data.fbp` | Não hashar |
| `events.custom_data.value/currency/order_id` | `custom_data.*` | Para Purchase e monetários |
| `events.attribution.utm_*` | `custom_data.utm_*` | Opcional, contextual |

## Idempotência

```
idempotency_key = sha256(workspace_id|event_id|meta_capi|account_id|pixel_id)
```

Meta também dedupe por `event_name + event_id` em janela de 48h. Sistema garante mesmo `event_id` em browser (Pixel) e server (CAPI) quando policy = `browser_and_server_managed`.

## Assinatura / autenticação

Header `Authorization: Bearer <META_CAPI_TOKEN>`. Token vinculado a app + pixel. Rotação documentada em `10-architecture/06-auth-rbac-audit.md`.

## Retry & DLQ

- `429` ou `5xx`: retrying com backoff exponencial.
- `400 invalid_event_id`, `400 invalid_pixel_id`: failed (sem retry).
- `400 missing_required_user_data`: skipped com `skip_reason='no_user_data'`.
- `dead_letter` após 5 attempts.

## Eligibility check

Antes de dispatchar:
1. `consent_snapshot.ad_user_data` precisa estar `granted` (exceto PageView sem PII).
2. Pelo menos um de `em`, `ph`, `fbc`, `fbp`, `external_id_hash` precisa estar populado (BR-CONSENT-003).
3. `pixel_id` configurado em `launches.config.tracking.meta`.
4. Test mode opcional via env (`META_CAPI_TEST_EVENT_CODE`).

## Credenciais

```
META_APP_ID
META_APP_SECRET
META_DEFAULT_PIXEL_ID
META_CAPI_TOKEN
META_CAPI_TEST_EVENT_CODE (opcional, dev)
```

Rotação: anual ou após incidente. Tokens novos coexistem em window de 24h durante transition (config em `secrets manager`).

## Fixtures de teste

`tests/fixtures/meta-capi/`:
- `request-pageview.json`
- `request-lead-with-user-data.json`
- `request-purchase.json`
- `response-success.json`
- `response-rate-limit-429.json`
- `response-invalid-pixel-400.json`

## Adapter

`apps/edge/src/dispatchers/meta-capi/`:
- `index.ts` — main dispatcher
- `mapper.ts` — `mapEventToMetaPayload(event, lead, ctx): MetaCapiRequest`
- `client.ts` — HTTP client com retry awareness
- `eligibility.ts` — pre-dispatch checks

## Observabilidade

Métricas:
- `meta_capi_dispatch_succeeded_total{pixel_id, event_name}`
- `meta_capi_dispatch_failed_total{pixel_id, error_code}`
- `meta_capi_dispatch_skipped_total{pixel_id, skip_reason}`
- `meta_capi_match_quality_score` (quando Meta retorna)

## Referências

- [Mapeamento canônico de nomes de evento por plataforma](./00-event-name-mapping.md) — tabela interna → Meta/GA4 com diferenças semânticas
- [Conversions API — Customer Information Parameters](https://developers.facebook.com/documentation/ads-commerce/conversions-api/parameters/customer-information-parameters)
- [Deduplicate Pixel and Server Events](https://developers.facebook.com/documentation/ads-commerce/conversions-api/deduplicate-pixel-and-server-events)
