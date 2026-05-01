# 02 — Problema e objetivos detalhados

Versão expandida da Seção 3 do [`01-brief.md`](01-brief.md). Cada OBJ tem critério de sucesso mensurável e ligação a RFs, BRs e métricas de Fase 1.

## Problema 1 — Configuração manual repetitiva

### Sintoma observado
A cada lançamento, time de marketing refaz: pixels, GTM, tags server-side, eventos custom, deduplicação, links de campanha, audiences, dashboards. Operação leva 1–3 dias úteis e gera configuração inconsistente entre lançamentos do mesmo cliente.

### Causa raiz
Nenhuma plataforma centraliza tracking + atribuição + dispatch + audiences + dashboards. Time mistura GTM + Meta Events Manager + Google Tag Manager + Hotmart + custom server endpoints, cada um com sua lógica de idempotência.

### Como o GlobalTracker resolve
- Configuração declarativa por lançamento (YAML em Fase 1; UI em Fase 4) que cobre tracking, links, audiences, custos, webhooks e Pixel policy.
- Tracker.js único que substitui GTM + tags custom para o caso do lançamento.
- Audiences e dashboards reutilizam pipelines internos — sem retrabalho por lançamento.

## Problema 2 — Eventos perdidos silenciosamente

### Sintoma observado
ROAS calculado em cima de dados parciais. Operador detecta, em retrospectiva, que 5–15% dos eventos browser não chegaram ao Meta CAPI; webhooks de Hotmart vieram duplicados ou faltantes; jobs Google falhavam com 5xx sem retry.

### Causa raiz
- Edge dispara para Meta/Google **durante** o request do browser, sem queue intermediária. Falha externa = evento perdido.
- Sem `event_id` derivado deterministicamente de `platform_event_id`, retries de plataforma criam duplicatas.
- Sem `dispatch_jobs` table, falhas não têm rastro auditável.

### Como o GlobalTracker resolve
- Pipeline em duas camadas: Edge persiste em `raw_events` e retorna 202; ingestion processor async normaliza; dispatcher async envia a destinos com idempotency_key e retry com backoff.
- `event_id = sha256(platform || ':' || platform_event_id)[:32]` para webhooks (ADR-019).
- `dispatch_jobs` + `dispatch_attempts` rastreiam status, retry, DLQ por destino.

## Problema 3 — Identidade fragmentada

### Sintoma observado
- Lead se cadastra com email; volta em outro device com phone-only; sistema cria lead duplicado.
- Mesma pessoa preenche form com email+phone depois — insert falha por unique constraint, sistema fica preso.
- Em retornos no mesmo device, tracker não reconhece o lead — `InitiateCheckout` vai para Meta CAPI sem `user_data` enriquecido.

### Causa raiz
- Schema com `unique (workspace_id, email_hash)` força unicidade que a realidade não respeita.
- Nenhum mecanismo de cookie assinado para reidentificação cross-session.
- Sem merge canônico, múltiplas representações do mesmo lead nunca convergem.

### Como o GlobalTracker resolve
- `lead_aliases` substitui unique constraints (ADR-005).
- `lead_merges` registra fusões auditáveis com canonical = mais antigo.
- Cookie `__ftk` com `lead_token` HMAC permite reidentificação em retornos (ADR-006).
- Dispatcher Meta CAPI faz lookup em `leads` quando `event.lead_id` está presente — enriquece `user_data` server-side sem o browser reenviar PII.

## Problema 4 — PII em logs e payloads

### Sintoma observado
Email/telefone aparecem em:
- Logs de aplicação (durante debug).
- jsonb de eventos (campo `user_data` com email em claro).
- Payloads de erro retornados ao caller.
- Logs de dispatcher (request payload completo logado em caso de falha).

### Causa raiz
Sanitização não-centralizada. Cada arquivo de log decide o que registrar. PII chega "por descuido".

### Como o GlobalTracker resolve
- Helper `pii.ts` central com `hash()`, `encrypt()`, `decrypt()` versionados.
- `events.user_data` aceita **apenas** chaves padronizadas (hash/IDs); validador Zod rejeita campos PII em claro.
- Logger estruturado redacta automaticamente campos conhecidos (`email`, `phone`, `name`, `ip`).
- IP/UA tratados como **transitórios**: usados no momento do dispatch (CAPI exige), nunca persistidos por default.
- Endpoint admin `DELETE /v1/admin/leads/:lead_id` para SAR.

## Problema 5 — Customer Match Google quebrando em 2026

### Sintoma observado
Sistemas que tratam Google como dispatcher genérico recebem `CUSTOMER_NOT_ALLOWLISTED_FOR_THIS_FEATURE` quando tentam Customer Match via Google Ads API, e silenciosamente deixam de sincronizar audiences.

### Causa raiz
Google anunciou em 2026-03 ([referência](https://ads-developers.googleblog.com/2026/03/changes-to-customer-match-support-in.html)) que Customer Match para novos adotantes via Google Ads API não é aceito a partir de abril/2026. Recomendação oficial: Data Manager API.

### Como o GlobalTracker resolve
- `audiences.destination_strategy` é discriminator: `google_data_manager` (default), `google_ads_api_allowlisted` (para tokens já elegíveis), `disabled_not_eligible` (sem credenciais ou consent).
- Sistema não promete o que não pode entregar — operador vê estado claro de cada audience.

---

## Objetivos detalhados

### OBJ-001 — Tracking confiável e auditável

**Critério de sucesso (Fase 1):** 100% dos eventos aceitos pelo Edge são persistidos em `raw_events` antes do 202. Em ambiente de testes, kill -9 do worker durante request comprovadamente não gera evento aceito.

**Critério de sucesso (Fase 2):** 100% dos eventos normalizados geram `dispatch_jobs` apropriados; cada job termina em estado terminal (`succeeded`/`failed`/`skipped`/`dead_letter`) — nunca fica `pending` indefinidamente. Métrica `dispatch_jobs_in_pending_state_for > 24h` deve ser 0.

**RFs ligados:** RF-008, RF-009, RF-010.
**BRs:** BR-EVENT-*, BR-DISPATCH-*.

### OBJ-002 — Identidade unificada de retorno

**Critério de sucesso (Fase 2):** Em teste E2E (FLOW-07), lead que retorna após 5 dias em mesma origem dispara `InitiateCheckout` que chega ao Meta CAPI com `em` e `ph` populados a partir de `leads`, sem que o browser tenha reenviado PII no request.

**RFs ligados:** RF-024, RF-025, RF-026.
**BRs:** BR-IDENTITY-*, BR-CONSENT-*.

### OBJ-003 — Atribuição correta por lançamento

**Critério de sucesso (Fase 2):** First-touch e last-touch persistidos em `lead_attribution` para 100% dos leads cadastrados; granularidade `(account_id, campaign_id, adset_id, ad_id, creative_id, placement)` capturada quando macros estão configurados nos links.

**Critério de sucesso (Fase 3):** Dashboard CPL/CPA por anúncio mostra valores não-nulos para campanhas com tracking ativo > 7 dias.

**RFs:** RF-002, RF-007.
**BRs:** BR-ATTRIBUTION-*.

### OBJ-004 — Privacidade por design

**Critério de sucesso (Fase 1):** Test suite confirma que nenhum log estruturado contém `email`, `phone`, `name`, `ip` em claro. Helper `sanitize-logs.ts` é a única forma de logar payloads de request/response.

**Critério de sucesso (Fase 2):** Endpoint `DELETE /v1/admin/leads/:lead_id` anonimiza PII em < 60 segundos para lead com até 100k eventos. `audit_log` registra a ação.

**RFs:** RF-006, RF-029.
**BRs:** BR-PRIVACY-*, RNF-006, RNF-013.

### OBJ-005 — Consent granular e auditável

**Critério de sucesso (Fase 2):** Cada evento em `events` carrega `consent_snapshot` (jsonb com 5 campos). Dispatcher consulta snapshot e marca job como `skipped` com `skip_reason='consent_denied'` quando consent exigido pelo destino está `denied` ou `unknown`.

**RFs:** RF-006.
**BRs:** BR-CONSENT-*.

### OBJ-006 — Conformidade futura com Customer Match Google

**Critério de sucesso (Fase 3):** `audience_sync_jobs` para audience com `destination_strategy='disabled_not_eligible'` nunca chama Google API. Audiences com `google_data_manager` usam Data Manager API; com `google_ads_api_allowlisted` usam Google Ads API com check de elegibilidade pré-call.

**RFs:** RF-018.
**BRs:** BR-AUDIENCE-*.

### OBJ-007 — Operação multi-tenant escalável

**Critério de sucesso (Fase 1):** `workspace_id` em 100% das tabelas de domínio. RLS ativo no Postgres. Test suite confirma que query sem `WHERE workspace_id` falha por RLS.

**Critério de sucesso (Fase 2):** Rate limit por workspace ativo (RNF-011). Workspace problemático não esgota quota global.

**RFs:** RF-001.
**BRs:** BR-RBAC-*.

### OBJ-008 — Latência de ingestão sub-50ms p95

**Critério de sucesso (Fase 1):** Em teste de carga local (1000 req/s sustentados), `/v1/events` p95 < 50ms, p99 < 100ms.

**RNF:** RNF-001.

---

## Métricas de sucesso da Fase 1

Métricas operacionais a monitorar ao final da Fase 1, antes de avançar para Fase 2:

| Métrica | Meta inicial | Onde monitorar |
|---|---|---|
| Cobertura de testes em `apps/edge/src/lib/` | ≥ 90% | Vitest report |
| Cobertura de testes em `packages/db/` | ≥ 80% | Vitest report |
| Migrations versionadas e reversíveis | 100% | Drizzle CI |
| Endpoints documentados em Zod | 100% | Schema diff vs `30-contracts/` |
| Smoke test do Worker em CI | passa em < 30s | GitHub Actions |
| `raw_events` persiste em < 50ms p95 | OK | Wrangler observability |
| Logs sanitizados (zero PII) | OK | grep test em fixtures |

Métricas de produto da Fase 1 são limitadas — Fase 1 entrega fundação, não produto operável. Métricas de produto reais começam na Fase 2.
