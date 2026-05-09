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
| `events.user_data.fbc` | `user_data.fbc` | Não hashar. Origem dual: (a) cookie `_fbc` lido pelo tracker.js (Pixel SDK escreve com underscore — ver [`docs/20-domain/13-mod-tracker.md`](../20-domain/13-mod-tracker.md) §7.6), (b) fallback sintetizado pelo tracker via `buildFbcFromFbclid(fbclid)` quando o cookie está ausente, (c) cookie nativo do payload do webhook (OnProfit envia `fbc` no body — ver [`14-onprofit-webhook.md`](./14-onprofit-webhook.md)), (d) enriquecimento server-side via `lookupHistoricalBrowserSignals` para eventos sem browser context (webhooks Guru/Hotmart/Stripe) — ver "Enriquecimento server-side" abaixo. |
| `events.user_data.fbp` | `user_data.fbp` | Não hashar. Origem dual: (a) cookie `_fbp` lido pelo tracker.js, (b) cookie nativo do payload OnProfit, (c) enriquecimento server-side a partir do histórico de eventos do mesmo lead — ver "Enriquecimento server-side" abaixo. |
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

### Enriquecimento server-side de `fbc` / `fbp` / IP / UA / `visitor_id` (webhooks → herdam do histórico do lead)

**Problema.** Eventos vindos de webhooks (Guru Purchase, SendFlow Contact, Stripe, Hotmart, Kiwify, etc.) chegam com `events.user_data = {}` porque o request server-side não tem browser context: nenhum cookie `_fbc`/`_fbp`, nenhum IP/UA do cliente real, nenhuma URL com `?fbclid=`. Sem fallback, o evento Purchase — que carrega o sinal monetário mais valioso — vai para o Meta CAPI com EMQ degradado (apenas `em`/`ph`), match score típico 4-5/8 e atribuição de clique perdida.

**Solução (deploys `10bcaaa6` → `974368b9` → `ba2fbe37`, 2026-05-09).** O dispatcher `meta_capi` (orchestrator em `apps/edge/src/index.ts`, função `buildMetaCapiDispatchFn`) faz, **antes** de chamar `mapEventToMetaPayload`:

1. Verifica se o evento corrente já tem `fbc`, `fbp`, `client_ip_address`, `client_user_agent` em `event.user_data` e `visitor_id` em `events.visitor_id`.
2. Se algum dos cinco está faltando **e** o evento tem `lead_id` resolvido, chama `lookupHistoricalBrowserSignals(db, workspace_id, lead_id)` que retorna `{ fbc, fbp, ip, ua, visitor_id }`:
   - `SELECT events.user_data, events.visitor_id FROM events WHERE workspace_id = $1 AND lead_id = $2 AND (visitor_id IS NOT NULL OR (user_data #>> '{}')::jsonb->>'fbc' IS NOT NULL OR ... ) ORDER BY received_at DESC LIMIT 10`.
   - O cast defensivo `(user_data #>> '{}')::jsonb` é necessário porque rows pré-deploy `ed9a490d` (T-13-013-FOLLOWUP) gravaram `user_data` como `jsonb_typeof='string'` — sem o re-cast, o `->>` retornaria NULL silenciosamente. Ver [`30-contracts/02-db-schema-conventions.md`](../30-contracts/02-db-schema-conventions.md#writes-via-hyperdrive--helper-jsonb-obrigatório-t-13-013-followup-2026-05-09).
   - Para cada linha (mais recente → mais antiga), pega o primeiro valor não-null de cada sinal **independentemente** (podem vir de eventos diferentes).
3. Mescla os valores enriquecidos em `user_data` antes do mapper. Sinal presente no evento corrente sempre vence sobre o histórico — só preenche o que está faltando. `visitor_id` enriquecido é injetado em `event.visitor_id` (coluna dedicada) e o mapper o atribui a `userData.external_id` em plano (ADR-031).
4. Quando enriquece, loga `event: 'meta_capi_browser_signals_enriched'` com flags booleanas `enriched_fbc` / `enriched_fbp` / `enriched_ip` / `enriched_ua` / `enriched_visitor_id` (sem leak do valor — apenas a presença).

**Sem filtro temporal — por design.** O lookup **não** restringe `received_at < event.received_at` nem janelas de tempo. O dispatcher pega os 10 events mais recentes do lead independentemente da ordem cronológica em relação ao evento sendo dispatchado. Justificativa:

- Cookies `_fbc`/`_fbp` do Meta têm refresh cycle longo (90 dias) — o valor "mais fresco" capturado em qualquer touchpoint do funil é o sinal mais útil para o match Meta.
- Webhooks Purchase chegam segundos a minutos depois do PageView/Lead que setou o cookie; um filtro `<` rejeitaria o cookie que acabou de ser capturado pelo PageView posterior à confirmação assíncrona do checkout (race comum em fluxos com redirect entre apex domains).
- Replays de dispatch (`POST /v1/dispatch-jobs/:id/replay`) executam horas depois do evento original — um filtro temporal cortaria todo o histórico acumulado entre a primeira execução e o replay, defeitando o propósito do replay.

A view `v_meta_capi_health` (migration `0047`) reflete o mesmo comportamento — usa `EXISTS` sem filtro `received_at` para projetar o que o dispatcher real efetivamente vai enviar (`eff_fbc = ev_fbc OR hist_fbc`, etc.). Ver [`10-architecture/07-observability.md` §"Saúde do Meta CAPI"](../10-architecture/07-observability.md#saúde-do-meta-capi-view-v_meta_capi_health).

**Trade-off conhecido.** Lead que tenha passado por dois `fbclid` diferentes em momentos distintos (ex.: clicou num anúncio em janeiro, depois noutro em maio, comprou via webhook em maio) terá o `fbc` mais recente atribuído ao Purchase. Para o caso de uso típico (workshop curto, ciclo de 7-14 dias), o ganho de EMQ supera amplamente o ruído de attribution edge case.

**Performance.** 1 SELECT por dispatch, indexado em `(workspace_id, lead_id)`. Skipado integralmente quando o evento já tem todos os 5 sinais (todos os eventos vindos do tracker.js) ou quando o lead não foi resolvido. `LIMIT 10` cobre a janela típica — o evento canônico (PageView com `utm_source=meta`) costuma estar entre os 2-3 mais recentes.

**Implicação para novos webhook adapters.** Quem está adicionando uma nova plataforma de webhook em `apps/edge/src/routes/webhooks/<provider>.ts` **não precisa** se preocupar em capturar `fbc`/`fbp`/IP/UA no payload da plataforma — basta resolver o lead via aliases (email/phone/order_id), e o orchestrator faz o enrichment automaticamente no momento do dispatch. Ver BR-DISPATCH-006. (OnProfit é exceção: o body já carrega `fbc`/`fbp` nativamente, então o enrichment só preenche IP/UA/visitor_id.)

**Implicação para análises de match quality.** O sucesso do enrichment depende de o lead ter passado por **algum** evento do tracker.js antes ou depois do webhook (PageView na LP, Lead no form, click de CTA, etc.). Lead que entra direto via webhook (ex: importação manual, lead vindo de fora do funil) não tem histórico para herdar — esses casos seguem com EMQ degradado e o Meta flagga normalmente. Validação empírica (replays de 7 Purchases Guru pós-`ba2fbe37`): match score subiu de 4-5/8 para 7/8; gap remanescente é `geo_city` quando `contact.address` da transação Guru vem vazio.

**Implicação para erasure/SAR.** Como IP/UA/`visitor_id` são propagados de events anteriores, `eraseLead` precisa zerar esses campos em **todos** os events do lead, não só no event sendo originalmente conectado ao SAR. Ver BR-PRIVACY-005.

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
