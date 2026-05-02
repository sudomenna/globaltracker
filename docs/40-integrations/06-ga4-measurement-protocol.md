# GA4 Measurement Protocol

## Papel no sistema
Reportar eventos para GA4 server-side via Measurement Protocol. Permite captura de eventos quando GA4 web-side não está presente ou para complementar.

## Eventos emitidos (out)

| Ação interna | Chamada externa |
|---|---|
| `dispatch_jobs.destination='ga4_mp'` | `POST https://www.google-analytics.com/mp/collect?measurement_id={id}&api_secret={secret}` |

## Mapping

```json
{
  "client_id": "<events.user_data.client_id_ga4>",
  "user_id": "<lead_public_id ou external_id_hash>",
  "events": [
    {
      "name": "<events.event_name>",
      "params": {
        "value": "<events.custom_data.value>",
        "currency": "<events.custom_data.currency>",
        "session_id": "<events.user_data.session_id_ga4>",
        ...
      }
    }
  ],
  "consent": {
    "ad_user_data": "<events.consent_snapshot.ad_user_data>",
    "ad_personalization": "<events.consent_snapshot.ad_personalization>"
  }
}
```

## Idempotência

`idempotency_key = sha256(workspace_id|event_id|ga4_mp|measurement_id)`.

GA4 não tem dedup nativo via API server-side; sistema confia em `unique` constraint local.

## Estratégia de `client_id` (OQ-003)

| Cenário | `client_id` usado |
|---|---|
| LP tem GA4 client-side ativo | Lê cookie `_ga`, extrai `client_id` (ex.: `GA1.X.YYYY.ZZZZ`) |
| LP sem GA4 client-side | Mintera próprio derivado de `__fvid`: `GA1.1.<8digits>.<10digits>` (formato compatível) |

Trade-off documentado em `00-product/06-glossary.md` e em UI do Control Plane.

## Eligibility check

1. `consent_snapshot.analytics='granted'`.
2. `measurement_id` configurado em `launches.config.tracking.google.ga4_measurement_id`.
3. `api_secret` configurado.
4. `client_id` derivado (cookie ou mintado).

## Credenciais

```
GA4_MEASUREMENT_ID
GA4_API_SECRET
```

Por workspace quando multi-account.

## Retry & DLQ

GA4 MP retorna 204 No Content em sucesso, sem confirmação real de aceite. Erros 4xx/5xx tratados como qualquer dispatch.

Validation API (`/mp/collect?...&debug_mode=1`) usada em testes.

## Adapter

`apps/edge/src/dispatchers/ga4-mp/`:
- `client.ts` — `sendToGa4`, `classifyGa4Error`, `Ga4Config`, `Ga4Result`
- `mapper.ts` — `mapEventToGa4Payload`, tipos `Ga4MpPayload`, `Ga4DispatchableEvent`, etc.
- `client-id-resolver.ts` — `resolveClientId`, `ClientIdUserData`
- `eligibility.ts` — `checkEligibility`, `EligibilityResult`, `Ga4SkipReason`
- `index.ts` — re-exporta todos os símbolos públicos

## Fixtures

`tests/fixtures/ga4-mp/`:
- `request-purchase.json`
- `response-success-204.json`

## Observabilidade

- `ga4_mp_dispatch_total{measurement_id}`
- `ga4_mp_client_id_minted_total` vs `ga4_mp_client_id_from_cookie_total` (ratio)

## Referências

- [Mapeamento canônico de nomes de evento por plataforma](./00-event-name-mapping.md) — tabela interna → Meta/GA4 com diferenças semânticas
- [GA4 Measurement Protocol](https://developers.google.com/analytics/devguides/collection/protocol/ga4)
