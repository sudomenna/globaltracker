# Google Customer Match (Data Manager API / Google Ads API)

## Papel no sistema
Sync de audiences materializadas para Google Ads remarketing/segmentação. Suporta **estratégia condicional** (ADR-012) para acomodar mudança de 2026.

## Estratégias

| `destination_strategy` | API usada | Quando usar |
|---|---|---|
| `google_data_manager` | Data Manager API | Default para novos workspaces (post-2026-04). |
| `google_ads_api_allowlisted` | Google Ads API → `:uploadOfflineUserData` ou `OfflineUserDataJob` | Workspace com token allowlisted antes do cutoff. |
| `disabled_not_eligible` | nenhuma | Sem credenciais, sem consent, ou não-allowlisted. Sistema **NÃO chama API** (BR-AUDIENCE-001). |

## Eventos emitidos (out)

| Ação interna | Chamada externa |
|---|---|
| Audience sync com `google_data_manager` | Data Manager API endpoints (TBD na implementação — Google publica spec quando entrar) |
| Audience sync com `google_ads_api_allowlisted` | `customers/{customer_id}/userLists:upload` ou `offlineUserDataJobs:create + addOperations + run` |

## Mapping

Membros enviados como hash de email/phone (formato Google):

```ts
{
  user_identifiers: [
    {
      hashed_email: sha256(normalize(email)), // lowercase + trim, então SHA-256
      hashed_phone_number: sha256(normalize(phone)) // E.164, então SHA-256
    },
    // ...
  ]
}
```

`leads.email_hash` e `phone_hash` já são pré-normalizados (BR-IDENTITY-002).

## Idempotência

`idempotency_key = sha256(workspace_id|audience_id|customer_match|customer_id|user_list_id|snapshot_hash)`.

## Eligibility check

1. `audience.destination_strategy != 'disabled_not_eligible'`.
2. `audience.consent_policy.require_customer_match=true` aplicado (membros sem `consent_customer_match='granted'` excluídos do snapshot).
3. `audience.consent_policy.require_ad_personalization=true` aplicado.
4. Customer ID e user list ID configurados em `audiences.platform_resource_id` (preencher manualmente após criação no Google Ads).

## Erro `CUSTOMER_NOT_ALLOWLISTED_FOR_THIS_FEATURE`

Se workspace tentar `google_ads_api_allowlisted` mas Google retornar este erro:
1. Sync job vai para `failed` com `error_code='CUSTOMER_NOT_ALLOWLISTED'`.
2. Audience é automaticamente reclassificada para `disabled_not_eligible` (com flag `auto_demoted_at`).
3. Operador é notificado via dashboard técnico — precisa migrar para `google_data_manager` ou aceitar que audience não sincroniza.

## Lock por audience

Igual a Meta Custom Audiences (BR-AUDIENCE-002). Google Customer Match exige especialmente — jobs simultâneos sobre a mesma user list são proibidos pela API.

## Adapter

`apps/edge/src/dispatchers/audience-sync/google/`:
- `data-manager-client.ts` (futuro)
- `ads-api-client.ts` (legacy, usado quando allowlisted)
- `strategy.ts` (escolhe client baseado em `destination_strategy`)
- `eligibility.ts`

## Fixtures

`tests/fixtures/google-customer-match/`:
- `data-manager-add-batch.json`
- `ads-api-add-batch.json`
- `error-not-allowlisted.json`

## Referências

- [Google Customer Match Get Started](https://developers.google.com/google-ads/api/docs/remarketing/audience-segments/customer-match/get-started)
- [Changes to Customer Match Support 2026](https://ads-developers.googleblog.com/2026/03/changes-to-customer-match-support-in.html)
