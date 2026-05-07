# Google Ads Enhanced Conversions for Web

## Papel no sistema
Adjustment de conversão original tagueada com click ID, enriquecendo com dados first-party hashados. Aumenta match rate quando cookies de terceiros estão limitados.

## Eventos emitidos (out)

| Ação interna | Chamada externa |
|---|---|
| Conversão original tagueada (Pixel/Tag) gerou conversão; pós upload via Enhanced API | `POST /v17/customers/{customer_id}/conversionAdjustments:upload` |

## Mapping

| Campo interno | Campo Google |
|---|---|
| `events.custom_data.order_id` | `order_id` (chave de match com tag original) |
| `events.event_time` | `adjustment_date_time` |
| `leads.email_hash` (normalized) | `restatement_value.user_identifiers[].hashed_email` |
| `leads.phone_hash` (E.164 normalized) | `restatement_value.user_identifiers[].hashed_phone_number` |
| `events.user_data.geo_city` | `restatement_value.user_identifiers[].address_info.city` (plain text — Google normaliza/hasheia internamente). Origem: `request.cf.city` (browser) ou `payload.contact.address.city` (Guru). ADR-033. |
| `events.user_data.geo_region_code` | `restatement_value.user_identifiers[].address_info.state` (plain text). |
| `events.user_data.geo_postal_code` | `restatement_value.user_identifiers[].address_info.zipCode` (plain text). |
| `events.user_data.geo_country` | `restatement_value.user_identifiers[].address_info.countryCode` (plain text, ISO 3166-1 alpha-2). |
| `launches.config.tracking.google.conversion_actions[event_name]` | `conversion_action` |

## Idempotência

`idempotency_key = sha256(workspace_id|event_id|google_enhancement|customer_id|conversion_action)`.

## Eligibility check (estrito — pré-requisitos múltiplos)

1. **Conversão original tagueada** existe (web tag com `gtag('event', 'purchase')` + click ID propagado). Sistema **NÃO PODE** fazer Enhanced Conversion sem conversão original — adjustment falha.
2. `events.custom_data.order_id` populado e estável.
3. `consent_snapshot.ad_user_data='granted'`.
4. `leads.email_hash` ou `phone_hash` disponível (hashado normalizado).
5. Adjustment dentro de 24h da conversão original (Google policy).

Skip se faltar qualquer um — não há retry para mudar fato.

## Assinatura

OAuth (mesmo que Conversion Upload).

## Retry & DLQ

- `RESOURCE_EXHAUSTED`: retry.
- `INVALID_ARGUMENT` (order_id desconhecido — conversão original não existe): failed.

## Adapter

`apps/edge/src/dispatchers/google-enhanced-conversions/`:
- `client.ts` — `sendEnhancedConversion`, `classifyGoogleEnhancedError`, `GoogleEnhancedConversionsConfig`, `GoogleAdsResult`
- `mapper.ts` — `mapEventToEnhancedConversion` (normaliza hash: lowercase, trim, SHA-256), tipos de payload. `DispatchableEvent.geo?: { city?, region_code?, postal_code?, country? }` (plain text) é repassado para `addressInfo` quando presente; `buildEnhancedConversionDispatchFn` extrai de `event.userData.geo_*` (ADR-033, Sprint 16).
- `eligibility.ts` — `checkEligibility`, `EligibilityResult`, `SkipReason`
- `oauth.ts` — `refreshAccessToken`, `OAuthConfig` (OAuth 2.0 compartilhado com Conversion Upload)
- `index.ts` — re-exporta todos os símbolos públicos

## Fixtures

- `request-adjustment-with-email-phone.json`
- `response-success.json`
- `response-order-id-not-found-400.json`

## Observabilidade

- `google_enhancement_succeeded_total`
- `google_enhancement_skipped_total{skip_reason}` (esperado alto se `order_id` ausente é comum)

## Referências

- [Enhanced conversions for web (API)](https://developers.google.com/google-ads/api/docs/conversions/upload-online)
