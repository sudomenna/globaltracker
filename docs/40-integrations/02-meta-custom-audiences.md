# Meta Custom Audiences

## Papel no sistema
Sync de audiences materializadas para Meta Ads Custom Audiences. Permite remarketing baseado em qualificação (`is_icp`, `not_purchased`, etc.).

## Eventos emitidos (out)

| Ação interna | Chamada externa |
|---|---|
| `audience_sync_jobs` processado com diff > 0 | `POST /{audience_id}/users` (additions) e/ou `DELETE /{audience_id}/users` (removals) |

## Mapping

Membros são enviados como hash de email/phone:

```json
{
  "schema": ["EMAIL_SHA256_NORMALIZED", "PHONE_SHA256_NORMALIZED"],
  "data": [
    ["abc123...", "def456..."],
    ["ghi789...", "jkl012..."]
  ]
}
```

`leads.email_hash` e `leads.phone_hash` são pré-normalizados (BR-IDENTITY-002), prontos para envio.

## Idempotência

`idempotency_key = sha256(workspace_id|audience_id|meta_custom_audience|audience_resource_id|snapshot_hash)`.

Cada `audience_sync_job` corresponde a um snapshot diff específico — execução duplicada é noop pela `unique` constraint.

## Assinatura / autenticação

Mesma `META_CAPI_TOKEN` ou token escopado para Ads API. Permission: `ads_management`.

## Eligibility check

1. `audience.platform = 'meta'`.
2. `audience.destination_strategy = 'meta_custom_audience'`.
3. Filtro de consent já aplicado em snapshot (BR-AUDIENCE-004); membros sem consent não estão em members.
4. `META_DEFAULT_PIXEL_ID` ou audience-specific `meta_audience_id` configurado.

## Lock por audience

`acquireSyncLock(audience_id, audience_resource_id)` impede sync concorrente (BR-AUDIENCE-002).

## Retry & DLQ

- 429: retry com backoff.
- `INVALID_PARAMETER` (400): failed.
- Limite Meta: 10k members per request → batch automático.

## Adapter

`apps/edge/src/dispatchers/audience-sync/meta/`:
- `client.ts` — Meta Ads API client
- `mapper.ts` — converte members do snapshot em payload
- `batcher.ts` — divide diff em batches de 10k

## Fixtures

`tests/fixtures/meta-custom-audiences/`:
- `add-batch-success.json`
- `delete-batch-success.json`
- `429-rate-limit.json`

## Observabilidade

- `meta_audience_sync_succeeded_total{audience_id}`
- `meta_audience_sync_failed_total{audience_id, error_code}`
- `meta_audience_match_rate{audience_id}` (quando disponível)

## Referências

- [Customer Audiences API](https://developers.facebook.com/documentation/marketing-api/audiences/guides/custom-audiences)
