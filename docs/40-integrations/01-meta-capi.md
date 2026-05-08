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
| `events.visitor_id` | `user_data.external_id` | Cookie `__fvid` (UUID v4 anônimo). Enviado em **plano** — não SHA-256. Meta hashea internamente. Mapeia direto de `events.visitor_id`. Permite Custom Audience de visitantes anônimos e cross-reference IP+UA → login Facebook do mesmo device (ADR-031, Sprint 16). |
| `events.user_data.client_ip_address` | `user_data.client_ip_address` | Não hashar. Persistido em `events.userData` JSONB pela rota `/v1/events` (ADR-031). Required para website events |
| `events.user_data.client_user_agent` | `user_data.client_user_agent` | Não hashar. Persistido idem. Required |
| `events.user_data.fbc` | `user_data.fbc` | Não hashar |
| `events.user_data.fbp` | `user_data.fbp` | Não hashar |
| `events.user_data.geo_city` | `user_data.ct` | SHA-256 puro (`hashPiiExternal`) com normalização `lowercase().trim()`. Hash em `buildMetaCapiDispatchFn` antes do mapper puro (ADR-033, Sprint 16). Origem: `request.cf.city` (browser) ou `payload.contact.address.city` (Guru). |
| `events.user_data.geo_region_code` | `user_data.st` | SHA-256 puro com `lowercase()` (regionCode 2-letter). Idem origem. |
| `events.user_data.geo_postal_code` | `user_data.zp` | SHA-256 puro com `replace(/\D/g, '')` (dígitos only). Idem origem. |
| `events.user_data.geo_country` | `user_data.country` | SHA-256 puro com `lowercase()` (ISO 3166-1 alpha-2). Idem origem. |
| `events.custom_data.value/currency/order_id` | `custom_data.*` | Para Purchase e monetários |
| `events.attribution.utm_*` | `custom_data.utm_*` | Opcional, contextual |

### Origem do `external_id` (ponto de confusão recorrente)

O valor de `user_data.external_id` enviado ao Meta vem da **coluna dedicada** `events.visitor_id` — **não** de `events.user_data->>'external_id'` nem de `events.user_data->>'fvid'`.

Fluxo end-to-end:

1. `tracker.js` envia `visitor_id` no **top-level** do payload `POST /v1/events` (campo `EventPayloadSchema.visitor_id`), nunca dentro de `user_data`.
2. `raw-events-processor` (Step 6) extrai e persiste em `events.visitor_id` (jsonb-to-column).
3. `apps/edge/src/dispatchers/meta-capi/mapper.ts` lê `event.visitor_id` e atribui a `userData.external_id` em plano (ADR-031). Meta hashea internamente.

Quem inspecionar `events.user_data` no DB **não vai encontrar** o visitor_id ali — `UserDataSchema` só aceita `_ga`, `_gcl_au`, `fbc`, `fbp`, `client_ip_address`, `client_user_agent` (mais geo computed pelo edge); qualquer outro campo é stripado por INV-EVENT-004. Para auditar `external_id` use `SELECT visitor_id FROM events`. Detalhes de storage em [`docs/20-domain/04-mod-identity.md`](../20-domain/04-mod-identity.md) §7 ("Storage de `visitor_id`").

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
2. Pelo menos um de `em`, `ph`, `fbc`, `fbp`, `external_id` (visitor_id) precisa estar populado — `visitor_id` é o 5º sinal válido desde Sprint 16 (ADR-031): PageView anônimo com cookie `__fvid` passa eligibility e é dispatched (antes era skipado com `no_user_data`). Skip continua quando nenhum dos 5 sinais existe (BR-CONSENT-003).
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
- `mapper.ts` — `mapEventToMetaPayload(event: DispatchableEvent, lead: DispatchableLead | null, ctx?: MapperContext): MetaCapiPayload` — função pura, sem I/O
- `client.ts` — `sendToMetaCapi(payload: MetaCapiPayload, config: MetaCapiConfig, fetchFn?): Promise<MetaCapiResult>` com retry awareness; `classifyMetaCapiError(result): 'retry' | 'permanent' | 'skip'`
- `eligibility.ts` — `checkEligibility(event: EligibilityEvent, lead: EligibilityLead | null, launchConfig: MetaLaunchConfig | null): EligibilityResult` — pré-dispatch checks (pixel_id, consent, user_data)

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
