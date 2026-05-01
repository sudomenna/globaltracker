# Google Ads Conversion Upload

## Papel no sistema
Reportar conversões para Google Ads via API server-side. Especialmente útil para Purchase com `gclid`/`gbraid`/`wbraid`.

## Eventos emitidos (out)

| Ação interna | Chamada externa |
|---|---|
| `events` Purchase com click ID válido + `dispatch_jobs.destination='google_ads_conversion'` | `POST /v17/customers/{customer_id}:uploadClickConversions` |

## Mapping

| Campo interno | Campo Google |
|---|---|
| `events.attribution.gclid`/`gbraid`/`wbraid` | `gclid` / `gbraid` / `wbraid` (um deles obrigatório) |
| `events.event_time` | `conversion_date_time` |
| `events.custom_data.value` | `conversion_value` (em cents convertido) |
| `events.custom_data.currency` | `currency_code` |
| `events.custom_data.order_id` | `order_id` (opcional, mas recomendado para Enhanced Conversions) |
| `launches.config.tracking.google.conversion_actions[event_name]` | `conversion_action` |

## Idempotência

`idempotency_key = sha256(workspace_id|event_id|google_ads_conversion|customer_id|conversion_action)`.

Google Ads API também dedupe por `gclid + conversion_action + conversion_date_time`.

## Eligibility check

1. `events.attribution` deve ter `gclid` OU `gbraid` OU `wbraid` (um deles).
2. `launches.config.tracking.google.conversion_actions[event_name]` mapeado.
3. `consent_snapshot.ad_user_data='granted'`.
4. Customer ID configurado (`launches.config.tracking.google.ads_customer_id`).

Skip se faltar:
- Sem click ID: `skip_reason='no_click_id_available'`.
- Sem conversion_action: `skip_reason='no_conversion_action_mapped'`.

## Assinatura / autenticação

OAuth 2.0 com refresh token. Headers:
- `Authorization: Bearer <access_token>` (refrescado).
- `developer-token: <GOOGLE_ADS_DEVELOPER_TOKEN>`.
- `login-customer-id: <manager_customer_id>` (se manager account).

## Retry & DLQ

- `RESOURCE_EXHAUSTED` (429): retry com backoff.
- `INVALID_ARGUMENT` (`INVALID_GCLID`, `EXPIRED_GCLID`): failed sem retry.
- `PERMISSION_DENIED`: failed; alerta operacional.

## Credenciais

```
GOOGLE_ADS_DEVELOPER_TOKEN
GOOGLE_ADS_CLIENT_ID
GOOGLE_ADS_CLIENT_SECRET
GOOGLE_ADS_REFRESH_TOKEN
```

OAuth refresh token é por workspace (em `integration_credentials` quando multi-workspace).

## Adapter

`apps/edge/src/dispatchers/google-ads-conversion/`:
- `client.ts` — Google Ads API client com OAuth refresh
- `mapper.ts`
- `eligibility.ts`

## Fixtures

`tests/fixtures/google-ads/conversion-upload/`:
- `request-purchase-with-gclid.json`
- `response-success.json`
- `response-invalid-gclid.json`

## Observabilidade

- `google_ads_conversion_succeeded_total{customer_id, conversion_action}`
- `google_ads_conversion_failed_total{error_code}`
- `google_ads_conversion_skipped_total{skip_reason}`

## Referências

- [Upload click conversions](https://developers.google.com/google-ads/api/docs/conversions/upload-clicks)
