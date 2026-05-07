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

## §3 — `client_id` resolution (cascata 4 níveis — ADR-032 fecha OQ-012, OQ-003)

GlobalTracker resolve o GA4 `client_id` na ordem abaixo. A cascata garante que **todo evento com `lead_id` populado** sempre alcança o GA4 (não há mais skip por `no_client_id` quando o lead é conhecido):

1. **self** — `event.user_data.client_id_ga4` (extraído do `_ga` cookie pelo `tracker.js`) → `event.user_data._ga` (cookie cru `GA1.1.<id>.<ts>`) → `event.user_data.fvid` (mintado em `GA1.1.<8d>.<10d>`).
2. **sibling** — se `self` vazio E `event.lead_id` presente: busca `_ga`/`fvid` no evento anterior MAIS RECENTE do mesmo lead (`received_at < event.received_at`). Cobre Purchase via webhook quando o lead já visitou a LP em sessão anterior.
3. **cross_lead** — se `sibling` vazio E lead tem `phone_hash_external` ou `email_hash_external`: busca `_ga`/`fvid` em evento anterior de OUTRO lead no mesmo workspace com hash igual. Tenta `phone` primeiro, `email` como fallback. Recupera caso o lead-resolver não tenha mergeado múltiplos leads da mesma pessoa.
4. **deterministic** — se `cross_lead` vazio E `lead_id` presente: minta `client_id` via `SHA-256(workspace_id:lead_id)` → 2 segmentos (`getUint32` × 2) → formato `GA1.1.<8d>.<10d>`. **Determinístico**: mesmo `(workspace, lead)` sempre gera o mesmo `client_id` → cross-event continuity preservada no GA4 (Purchase + eventos subsequentes do lead aparecem como o mesmo "user").

**Skip `no_client_id_unresolvable`** só dispara quando `lead_id` ausente (caso raro de evento totalmente anônimo sem visitor identifier).

| Nível | Fonte | Trigger | client_id resultante |
|---|---|---|---|
| 1 — self | `event.user_data` | `_ga` cookie no request, ou `__fvid` cookie no request | extraído ou mintado de `__fvid` |
| 2 — sibling | DB lookup: evento anterior do mesmo lead | `lead_id` populado, sem self | extraído ou mintado de `__fvid` do evento histórico |
| 3 — cross_lead | DB lookup: evento de outro lead com `phone_hash_external` ou `email_hash_external` igual | hashes externos populados, sem sibling | extraído ou mintado de `__fvid` do evento histórico |
| 4 — deterministic | `SHA-256(workspace_id:lead_id)` | `lead_id` populado | `GA1.1.<8d>.<10d>` mintado |
| 5 — unresolved | — | `lead_id` ausente | `null` → skip `no_client_id_unresolvable` |

**Implementação:**
- `apps/edge/src/dispatchers/ga4-mp/client-id-resolver.ts` — `resolveClientIdExtended(input)` (puro, sem I/O); `mintDeterministicClientId` (SHA-256 + 2× uint32).
- `apps/edge/src/index.ts` — `buildGa4DispatchFn` coleta `sibling_user_data` + `cross_lead_user_data` via DB antes de chamar o resolver.

Trade-off documentado em `docs/00-product/06-glossary.md` e na UI do Control Plane.

## Eligibility check

1. `consent_snapshot.analytics='granted'`.
2. `measurement_id` configurado em `launches.config.tracking.google.ga4_measurement_id`.
3. `api_secret` configurado.
4. `client_id` derivado pela cascata 4 níveis (ver §3 acima). Skip só com `lead_id` ausente (`skip_reason='no_client_id_unresolvable'` — antes, genérico `no_client_id`).

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
