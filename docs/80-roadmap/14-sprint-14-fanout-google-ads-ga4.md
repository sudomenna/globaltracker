# Sprint 14 — Fanout multi-destination (Google Ads + GA4 + Enhanced Conversions)

> **Inserido em 2026-05-06**: o Sprint 14 anterior (Webhooks Hotmart/Kiwify/Stripe) foi renomeado para Sprint 15. Este sprint passa à frente porque alimentar Meta + Google Ads + GA4 com **todos os eventos canonical** é pré-requisito comercial pra rodar campanhas de remarketing — destrava o objetivo do operador (Tiago/CNE) de escalar mídia paga em cima do funil já em produção.

## Duração estimada
~1 semana (7 ondas, 17 T-IDs).

## Objetivo
Fechar o pipeline de **conversion fanout** para todos os destinations já implementados como adapter:

| Destination | Status atual | Após Sprint 14 |
|---|---|---|
| `meta_capi` | ✅ wired + validado E2E | ✅ (sem mudanças) |
| `ga4_mp` | ⚠️ wired mas nunca exercitado em prod | ✅ wired + mapper enriquecido + UI + smoke |
| `google_ads_conversion` | ❌ adapter existe, Step 9 não cria jobs | ✅ wired + UI mapping conversion_action |
| `google_enhancement` | ❌ adapter existe, Step 9 não cria jobs | ✅ wired junto com conversion |

**Fora do escopo (Sprint 16):** Custom Audiences (Meta) + Customer Match (Google) — UI de DSL builder de audience definitions.

**Fora do escopo (FUTURE-001):** custom events (`click_buy_workshop`, `wpp_joined`, `survey_responded`) → Google Ads. Google Ads exige cadastro manual de `conversion_action` por evento custom no painel; deixamos o JSONB extensível, mas a UI cobre só canonical agora.

## Pré-requisitos
- Sprint 13 completo (PII enrichment + SendFlow webhook + cleanups S12).
- T-OPB completo (4 colunas hash externo `email_hash_external`, `phone_hash_external`, `fn_hash`, `ln_hash` em `leads`).
- Developer token Google Ads aprovado (Basic access serve pra dev — solicitar antes em https://ads.google.com/aw/apicenter).

## Critério de aceite global

- [ ] OAuth Google completo no CP — botão "Conectar Google Ads" + callback persiste refresh_token criptografado.
- [ ] Step 9 do `raw-events-processor.ts` cria jobs `google_ads_conversion` + `google_enhancement` para eventos canonical com mapping configurado.
- [ ] CP UI permite mapear cada canonical event → `conversion_action_id` (dropdown populado da Google Ads API).
- [ ] GA4 mapper enviando `value`/`currency`/`transaction_id`/`items` em Purchase + `value` em Lead.
- [ ] Test mode validado: 1 Purchase real → 4 jobs `succeeded` em <30s (CAPI + GA4 + Google Ads Conv + Enhanced).
- [ ] `pnpm typecheck && pnpm lint && pnpm test` verdes.
- [ ] ADR-028, ADR-029, ADR-030 commitados.
- [ ] MEMORY.md §4 atualizado, docs canônicas em `40-integrations/` sincronizadas.

## T-IDs por onda

### Onda 1 — Schema + config (parallel-safe=yes)

- **T-14-001** [`edge-author`] Estender Zod `IntegrationsSchema` em `apps/edge/src/routes/workspace-config.ts` para incluir bloco `google_ads`:
  ```
  google_ads: {
    customer_id?: string,                   // 10 dígitos sem hífen
    login_customer_id?: string,             // manager account, 10 dígitos
    oauth_token_state?: 'pending'|'connected'|'expired',
    conversion_actions?: Record<canonical_event, conversion_action_id | null>,  // null = tombstone
    enabled?: boolean,
  }
  ```
  **Refresh token NÃO entra no JSONB** — vai em coluna dedicada `workspace_integrations.google_ads_refresh_token_enc` (T-14-002), seguindo o padrão de `guruApiToken` e `sendflowSendtok`. BR-PRIVACY-001: GET /v1/workspace/config nunca expõe refresh_token.
- **T-14-002** [`schema-author`] Migration `0038_google_ads_secrets.sql` adicionando **duas colunas**:
  1. `workspace_integrations.google_ads_refresh_token_enc` (text nullable, ciphertext AES-256-GCM workspace-scoped via `encryptPii`/`PII_MASTER_KEY_V1`, length 50-2048).
  2. `workspaces.google_ads_developer_token` (text nullable, plain text — credencial do operador GlobalTracker, não do cliente; compartilhável via env var fallback).
  Drizzle schema atualizado em `packages/db/src/schema/workspace_integrations.ts` (campo `googleAdsRefreshTokenEnc`) e `packages/db/src/schema/workspace.ts` (campo `googleAdsDeveloperToken`).
- **T-14-003** [`domain-author`] Helper `getGoogleAdsConfig(workspaceId)` em `apps/edge/src/lib/google-ads-config.ts` — descriptografa refresh_token, retorna config validada. Lança erro tipado se incompleta.

### Onda 2 — OAuth backend (parallel-safe=no — depende de Onda 1)

- **T-14-004** [`edge-author`] `GET /v1/integrations/google/oauth/start` em `apps/edge/src/routes/integrations-google.ts`:
  - Gera `state` (random + workspace_id assinado HMAC).
  - Redireciona para `https://accounts.google.com/o/oauth2/v2/auth` com scopes `https://www.googleapis.com/auth/adwords`.
  - Persiste state em KV/DB com TTL 10min.
- **T-14-005** [`edge-author`] `GET /v1/integrations/google/oauth/callback`:
  - Valida state, troca code por refresh_token (`https://oauth2.googleapis.com/token`).
  - Encripta refresh_token com `encryptPii`.
  - Lista accessible customers via `customers:listAccessibleCustomers`.
  - Persiste em `workspaces.config.integrations.google_ads`.
  - Audit `workspace_google_ads_oauth_completed` (sem token cru — BR-PRIVACY-001).
- **T-14-006** [`domain-author`] Helper `getGoogleAdsAccessToken(workspaceId)` em `apps/edge/src/lib/google-ads-oauth.ts`:
  - Cache em-memória (5min TTL) por workspace.
  - Auto-refresh quando expira.
  - Trata `invalid_grant` → marca `oauth_token_state='expired'`.
- **T-14-007** [`edge-author`] `GET /v1/integrations/google/conversion-actions` — retorna lista de conversion actions do customer Google Ads (popula dropdown da UI). Reutiliza `getGoogleAdsAccessToken`.

### Onda 3 — Step 9 wiring (parallel-safe=no — depende de Onda 2)

- **T-14-008** [`domain-author`] Estender bloco `dispatchJobs` em [apps/edge/src/lib/raw-events-processor.ts:788+](../../apps/edge/src/lib/raw-events-processor.ts#L788):
  - Se `integrations.google_ads.enabled && oauth_token_state === 'connected'` E `event_name in conversion_actions`:
    - cria job `google_ads_conversion` com `destination_resource_id = conversion_action_id`.
  - Se PII presente (`email_hash_external` ou `phone_hash_external`) E `event_name in conversion_actions`:
    - cria job `google_enhancement` com mesmo `conversion_action_id`.
  - Skip com motivo `google_ads_not_configured` se workspace não tem `google_ads.connected`.
  - Skip com motivo `no_conversion_action_for_event` se evento canonical não tem mapping.
- **T-14-009** [`dispatcher-author`] Verificar/atualizar `apps/edge/src/dispatchers/google-ads-conversion/mapper.ts` e `google-enhanced-conversions/mapper.ts` — devem ler `conversion_action_id` do `dispatch_job.destination_resource_id`. Reutilizar `email_hash_external`/`phone_hash_external`/`fn_hash`/`ln_hash` do lead (T-OPB).
- **T-14-010** [`domain-author`] Confirmar que blocklist `INTERNAL_ONLY_EVENT_NAMES` cobre Google Ads também (lead_identify, event_duplicate_accepted nunca viram conversion).

### Onda 4 — Frontend CP (parallel-safe=yes com Onda 5)

- **T-14-011** Página nova `apps/control-plane/src/app/(app)/integrations/google-ads/page.tsx`:
  - Card 1: Status conexão OAuth (Connected/Pending/Expired) + botão "Conectar Google Ads".
  - Card 2: Customer selection (dropdown de accessible customers).
  - Card 3: Mapping table — uma linha por canonical event (Lead, Purchase, InitiateCheckout, ViewContent, AddToCart, CompleteRegistration, etc) com dropdown populado via `/v1/integrations/google/conversion-actions`.
  - Reusa `useAccessToken` hook.
- **T-14-012** Health badge — adicionar `google_ads` em `apps/control-plane/src/components/integration-health-badge.tsx` (criar componente compartilhado se não existir).

### Onda 5 — GA4 enrichment (parallel-safe=yes)

- **T-14-013** [`dispatcher-author`] Enriquecer `apps/edge/src/dispatchers/ga4-mp/mapper.ts`:
  - Purchase: garantir `value`, `currency`, `transaction_id`, `items: [{ item_id, item_name, price, quantity }]` (alimenta audiências GA4 automáticas).
  - Lead: garantir `value` quando disponível.
  - Validar contra `docs/40-integrations/06-ga4-measurement-protocol.md`.
- **T-14-014** CP UI — auditar e completar form GA4 (`measurement_id`, `api_secret`) em `apps/control-plane/src/app/(app)/integrations/page.tsx` — provavelmente já existe parcial; só fechar.

### Onda 6 — Tests + validação E2E (parallel-safe=yes)

- **T-14-015** [`test-author`] Unit tests:
  - `apps/edge/src/lib/__tests__/raw-events-processor.step9-google.test.ts` — fixtures: workspace conectado, sem OAuth, com conversion_actions parcial. Asserts: 4 jobs criados em Purchase, skipped corretos.
  - `apps/edge/src/lib/__tests__/google-ads-oauth.test.ts` — refresh token rotation, cache hit/miss, error handling (invalid_grant).
- **T-14-016** [`test-author`] E2E manual + script:
  - `/tmp/pgquery/test-fanout-google.mjs` — POST evento Purchase real, asserts 4 dispatch_jobs criados (`meta_capi`, `ga4_mp`, `google_ads_conversion`, `google_enhancement`) com status `succeeded` em até 30s.
  - Verificar match no Google Ads (test conversion code) e no Events Manager Meta.

### Onda 7 — Backfill (opcional, fora da DoD)

- **T-14-017** Script `/tmp/pgquery/backfill-google-ads-events.mjs` — replay últimos 90 dias de Purchase para Google Ads (limite da API). Não bloqueia DoD do sprint.

## Riscos / observações

1. **Developer token Google Ads**: aprovação Basic leva 1-2 dias úteis; Standard (necessário pra alto volume em prod) leva ~7 dias adicionais. Mitigação: Basic access (15k operations/dia) é suficiente pro workshop atual.
2. **OAuth refresh token rotation**: Google rotaciona refresh_tokens em alguns cenários (revoke + reauth). Helper precisa marcar workspace `oauth_token_state='expired'` + notificar via UI quando receber `invalid_grant`.
3. **Conversion action discovery**: Tiago precisa criar as conversion actions no painel Google Ads ANTES de mapear no CP. Doc canônica `docs/40-integrations/03-google-ads-conversion-upload.md` deve incluir checklist passo-a-passo.
4. **Latência adicional**: cada Purchase agora dispara 4 HTTP calls em paralelo. Queue consumer já trata em paralelo, mas dispatch_jobs vão crescer 4x — monitorar via Cloudflare Queues dashboard.
5. **FUTURE-001**: custom events configuráveis em Google Ads. Schema permite adicionar `custom:click_buy_workshop` em `conversion_actions` no JSONB hoje (sem UI), para teste manual.

## Referências

- [`docs/40-integrations/03-google-ads-conversion-upload.md`](../40-integrations/03-google-ads-conversion-upload.md)
- [`docs/40-integrations/04-google-ads-enhanced-conversions.md`](../40-integrations/04-google-ads-enhanced-conversions.md)
- [`docs/40-integrations/06-ga4-measurement-protocol.md`](../40-integrations/06-ga4-measurement-protocol.md)
- [`docs/40-integrations/00-event-name-mapping.md`](../40-integrations/00-event-name-mapping.md)
- [`docs/50-business-rules/BR-DISPATCH.md`](../50-business-rules/BR-DISPATCH.md)
- [`docs/90-meta/04-decision-log.md`](../90-meta/04-decision-log.md) — ADR-028, ADR-029, ADR-030.
