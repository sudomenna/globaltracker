# 05 — API endpoints e convenções de Server Actions

## Endpoints públicos (Edge `/v1/*`)

Todos versionados sob `/v1`. Mudança breaking → `/v2` + ADR + plano de migração.

### `GET /v1/config/:launch_public_id/:page_public_id`

Retorna configuração pública sanitizada para o tracker.

| Item | Especificação |
|---|---|
| **CONTRACT-id** | `CONTRACT-api-config-v1` |
| **Auth** | `X-Funil-Site: pk_live_...` (page_token; aceita também tokens em `rotating`) |
| **Rate limit** | Por token + IP; ~60 req/min/token (ajustar) |
| **Cache** | KV 60s + ETag |
| **Response 200** | `{ event_config, pixel_policy, endpoints, schema_version, lead_token_settings: {ttl_days} }` |
| **Errors** | `401 invalid_token`, `403 origin_not_allowed`, `404 page_not_found`, `429 rate_limited`, `410 archived` |

### `POST /v1/events`

Aceita evento do tracker. Modelo fast accept.

| Item | Especificação |
|---|---|
| **CONTRACT-id** | `CONTRACT-api-events-v1` |
| **Auth** | `X-Funil-Site` (page_token) |
| **Body** | Zod schema (`EventPayloadSchema` em `packages/shared/`) com `event_id`, `schema_version`, `launch_public_id`, `page_public_id`, `event_name`, `event_time`, `lead_token?`, `lead_id?`, `visitor_id?`, `attribution`, `custom_data`, `consent` |
| **Lead identification** | `lead_token` e `lead_id` mutuamente exclusivos. Browser **deve** usar `lead_token`. `lead_id` em claro só em fluxos administrativos. |
| **Validations** | (1) Zod schema; (2) page_token válido + binding; (3) origin allowed; (4) replay protection (event_id em KV); (5) rate limit; (6) lead_token HMAC quando presente; (7) clamp event_time |
| **Server-side enrichment** | Edge lê `request.cf.{city, regionCode, postalCode, country}` (Cloudflare geo) e mescla em `payload.user_data.{geo_city, geo_region_code, geo_postal_code, geo_country}` (spread condicional — só quando presente). Cliente **não** envia esses campos. ADR-033 (Sprint 16). Também mescla `client_ip_address` / `client_user_agent` (ADR-031). |
| **Side effects** | Insert em `raw_events`; enqueue em CF Queue para ingestion processor |
| **Response 202** | `{ event_id, status: 'accepted' \| 'duplicate_accepted' \| 'rejected' }` |
| **Errors** | `400 validation_error`, `401 invalid_token`, `403 origin_not_allowed`, `429 rate_limited`, `410 archived_launch` |

### `POST /v1/lead`

Identifica/cria lead, registra consent, emite `lead_token`.

| Item | Especificação |
|---|---|
| **CONTRACT-id** | `CONTRACT-api-lead-v1` |
| **Auth** | `X-Funil-Site` |
| **Body** | `{ event_id, schema_version, launch_public_id, page_public_id, email?, phone?, name?, attribution, consent, cf_turnstile_response? }` (mín. um de email/phone) |
| **Consent** | `consent.analytics` e `consent.marketing` aceitam tanto `boolean` quanto string GA-style (`'granted'/'denied'/'unknown'`) — string é normalizada para boolean (`'granted' → true`). `consent.functional` permanece `boolean` (default `true`). Campos opcionais granulares (GA4/Meta) `ad_user_data`, `ad_personalization`, `customer_match` aceitos como string `'granted'/'denied'/'unknown'` (passthrough — `lead` handler não usa, mas evita rejeição de `.strict()`). Mesmo padrão de `EventPayloadSchema.consent` para alinhar com tracker.js que envia strings. |
| **Side effects** | (1) Insert em `raw_events`; (2) ingestion processor cria/atualiza lead via `lead_aliases`; (3) emit `lead_token`; (4) `Set-Cookie: __ftk` |
| **Response 202** | `{ lead_public_id, lead_token, expires_at, status: 'accepted' }` |
| **Set-Cookie** | `__ftk=<token>; Path=/; SameSite=Lax; Secure; Max-Age=5184000` (60d default — configurável por workspace) |
| **Errors** | `400 missing_identifier`, `400 validation_error`, `401`, `403`, `429` |

### `GET /r/:slug`

Redirector. Resolve link curto, registra clique async.

| Item | Especificação |
|---|---|
| **CONTRACT-id** | `CONTRACT-api-redirect-v1` |
| **Auth** | Nenhuma (link público) |
| **Side effects** | Enqueue `link_click` async (não bloqueia redirect) |
| **Response 302** | Redireciona para `links.destination_url` com UTMs propagados |
| **Errors** | `404 link_not_found`, `410 archived` |

### `POST /v1/webhook/:platform`

Ver `04-webhook-contracts.md`.

---

## Endpoints do Control Plane (Sprint 6+)

Endpoints internos consumidos pela UI Next.js do Control Plane (autenticação por session cookie ou API key com escopo apropriado). Detalhamento em [70-ux/](../70-ux/).

### `GET /v1/events`

Lista paginada de eventos de um lançamento. Consumida pela tab Eventos do detalhe de launch no Control Plane (T-FUNIL-003 / T-FUNIL-004).

| Item | Especificação |
|---|---|
| **CONTRACT-id** | `CONTRACT-api-events-list-cp-v1` |
| **Auth** | `auth-cp` (session MARKETER+) |
| **Query params** | `launch_id` (UUID, obrigatório), `limit` (int 1–200, default 50), `cursor` (ISO string, opcional — último `event_time` da página anterior) |
| **Workspace isolation** | Verifica que o launch pertence ao workspace autenticado antes de retornar dados |
| **Response 200** | `{ events: [...], total: number, next_cursor: string \| null }` |
| **Errors** | `400 missing_launch_id`, `403 forbidden_workspace`, `404 launch_not_found` |

A tab Eventos no Control Plane consome este endpoint com autorefresh a cada 10 segundos.

### `GET /v1/onboarding/state`

Retorna estado do wizard de onboarding do workspace ativo. Implementa A.1 ([70-ux/03-screen-onboarding-wizard.md](../70-ux/03-screen-onboarding-wizard.md)).

| Item | Especificação |
|---|---|
| **CONTRACT-id** | `CONTRACT-api-onboarding-state-v1` |
| **Auth** | session OWNER/ADMIN/MARKETER |
| **Response 200** | `{ started_at, completed_at, skipped_at, step_meta, step_ga4, step_launch, step_page, step_install }` |

### `PATCH /v1/onboarding/state`

Atualiza step específico. Idempotente.

| Item | Especificação |
|---|---|
| **Auth** | session OWNER/ADMIN/MARKETER |
| **Body** | `{ step: 'meta' | 'ga4' | 'launch' | 'page' | 'install', completed_at?, validated?, ... }` |
| **Response 200** | `{ onboarding_state }` |

### `GET /v1/pages/:public_id/status`

Status vivo de uma page para polling. Implementa A.3 ([70-ux/04-screen-page-registration.md](../70-ux/04-screen-page-registration.md)).

| Item | Especificação |
|---|---|
| **CONTRACT-id** | `CONTRACT-api-pages-status-v1` |
| **Auth** | session MARKETER+ |
| **Cache** | KV 5s (durante polling agressivo) |
| **Response 200** | `{ page_public_id, health_state, last_ping_at, events_today, events_last_24h, token_status, token_rotates_at, recent_issues[] }` |
| **Errors** | `404 page_not_found`, `403 forbidden_workspace` |

### `GET /v1/health/integrations`

Saúde agregada de todas integrações do workspace. Implementa B.1, B.2 ([70-ux/07-component-health-badges.md](../70-ux/07-component-health-badges.md)).

| Item | Especificação |
|---|---|
| **CONTRACT-id** | `CONTRACT-api-health-integrations-v1` |
| **Auth** | session MARKETER+ |
| **Cache** | 30s (Cache-Control max-age) |
| **Response 200** | `{ overall_state, integrations: [{ provider, state, succeeded_24h, failed_24h, skipped_24h, dlq_count, last_attempt_at }] }` |

### `GET /v1/health/workspace`

Resumo agregado do workspace inteiro. Implementa B.4 ([70-ux/07-component-health-badges.md §5](../70-ux/07-component-health-badges.md)).

| Item | Especificação |
|---|---|
| **Auth** | session MARKETER+ |
| **Response 200** | `{ overall_state, incidents: [{ severity, kind, summary, action_href }] }` |

### `POST /v1/integrations/:provider/test`

Dispara evento sintético para validar configuração. Implementa D.1 ([70-ux/05-screen-integration-health.md §3](../70-ux/05-screen-integration-health.md)).

| Item | Especificação |
|---|---|
| **CONTRACT-id** | `CONTRACT-api-integrations-test-v1` |
| **Auth** | session MARKETER+ |
| **Body** | `{ source: 'config_screen' | 'onboarding' | 'lead_timeline' }` |
| **Side effects** | Cria evento sintético com `event_name='TestEvent'`, `is_test=true`, `event_id` único; dispara dispatcher do provider em modo teste |
| **Response 200** | `{ test_id, phases: [{ name, status, latency_ms?, error? }], external_link }` |
| **Errors** | `400 integration_not_configured`, `502 upstream_error` |

### `GET /v1/integrations/:provider/attempts`

Lista paginada de `dispatch_attempts` para drill-down. Implementa B.2 ([70-ux/05-screen-integration-health.md §2](../70-ux/05-screen-integration-health.md)).

| Item | Especificação |
|---|---|
| **Auth** | session OPERATOR+ (MARKETER vê payload sanitizado) |
| **Query** | `cursor`, `limit` (max 100), `filter[status]`, `filter[event_name]`, `filter[lead_id]` |
| **Response 200** | `{ attempts: [...], next_cursor }` — payload sanitizado conforme role |

### `GET /v1/leads`

Lista paginada de leads do workspace com search multi-campo. Implementa CONTRACT-api-leads-list-v1 (ADR-034).

| Item | Especificação |
|---|---|
| **CONTRACT-id** | `CONTRACT-api-leads-list-v1` |
| **Auth** | JWT Supabase ES256 verificado via JWKS; role resolvido em `workspace_members` (autoritativo) ou fallback `app_metadata.role` |
| **Query** | `q?` (UUID/email/phone/name), `launch_public_id?`, `lifecycle?` (`contato`\|`lead`\|`cliente`\|`aluno`\|`mentorado` — Sprint 16), `cursor?` (`last_seen_at` ISO), `limit?` (default 30, max 100) |
| **Search detection** | `q` é UUID → match exato em `leads.id`; email → `hashPii(workspace, normalizedEmail)` match em `email_hash`; phone → `normalizePhone` + `hashPii` match em `phone_hash`; resto → `ILIKE %q%` em `lower(leads.name)` |
| **Response 200** | `{ items: [{ lead_public_id, display_name, display_email, display_phone, status, lifecycle_status, first_seen_at, last_seen_at }], next_cursor, role, pii_masked }` — `lifecycle_status` ∈ `LifecycleStatus` (Sprint 16) |
| **Masking (ADR-034)** | `display_email` e `display_phone` mascarados quando `role` ∈ {`operator`, `viewer`}; em claro para `owner`/`admin`/`marketer`/`privacy`. `display_name` sempre em claro (deixou de ser PII protegido). |

### `GET /v1/leads/:public_id`

Sumário do lead (display_name + display_email + display_phone + status + datas).

| Item | Especificação |
|---|---|
| **Auth** | mesmo pattern de `GET /v1/leads` |
| **Response 200** | `{ lead_public_id, display_name, display_email, display_phone, status, first_seen_at, last_seen_at, role, pii_masked }` |
| **Masking** | mesma matriz de `GET /v1/leads` |
| **Errors** | `401 unauthorized`, `404 lead_not_found` |

### `POST /v1/leads/:public_id/reveal-pii`

Reveal-on-demand de email/phone para `operator` (ADR-034). Owner/admin/marketer/privacy podem chamar mas é redundante (já veem em claro). Viewer → 403.

| Item | Especificação |
|---|---|
| **CONTRACT-id** | `CONTRACT-api-leads-reveal-pii-v1` |
| **Auth** | JWT verificado; role ≠ `viewer` |
| **Body** | `{ reason: string }` (3-500 chars) |
| **Side effects** | `audit_log` row com `action='read_pii_decrypted'`, `actor_id`, `entity_type='lead'`, `entity_id=public_id`, `after={ role, fields_accessed:['email','phone'], reason, request_id }` |
| **Response 200** | `{ lead_public_id, display_email, display_phone }` (sempre em claro) |
| **Errors** | `400 invalid_body` (reason curto demais), `403 forbidden_role` (viewer; também grava `audit_log action='read_pii_decrypted_denied'`), `404 not_found`, `503 unavailable` |

### `GET /v1/leads/:public_id/summary` (Sprint 17)

Agrega estado atual do lead: stage journey, tags, attribution, consent e métricas de atividade. Consumido pelo `LeadSummaryHeader` do Control Plane.

| Item | Especificação |
|---|---|
| **CONTRACT-id** | `CONTRACT-api-leads-summary-v1` |
| **Auth** | Bearer JWT Supabase ES256 verificado via `supabaseJwtMiddleware`; workspace-scoped (mesmo pattern de `/v1/leads`) |
| **Cache** | `Cache-Control: private, max-age=15` |
| **Mount order** | Montado em `apps/edge/src/index.ts` **antes** de `leadsRoute` para evitar conflito com path param `/:public_id` |
| **Response 200** | Ver shape abaixo |
| **Errors** | `401 unauthorized`, `404 lead_not_found`, `500 internal_error` |

**Response 200:**

```json
{
  "current_stage": { "stage": "string", "since": "ISO 8601" } | null,
  "stages_journey": [{ "stage": "string", "at": "ISO 8601" }],
  "tags": [{ "tag_name": "string", "set_by": "string", "set_at": "ISO 8601" }],
  "attribution_summary": {
    "first_touch": { "utm_source": "string?", "utm_medium": "string?", "utm_campaign": "string?", "utm_content": "string?", "utm_term": "string?" } | null,
    "last_touch": { "..." } | null,
    "fbclid": "string | null",
    "gclid": "string | null"
  },
  "consent_current": {
    "analytics": true,
    "marketing": true,
    "ad_user_data": true,
    "ad_personalization": true,
    "customer_match": true,
    "updated_at": "ISO 8601"
  } | null,
  "metrics": {
    "events_total": 0,
    "dispatches_ok": 0,
    "dispatches_failed": 0,
    "dispatches_skipped": 0,
    "purchase_total_brl": 0.0,
    "last_activity_at": "ISO 8601 | null"
  }
}
```

### `GET /v1/leads/:public_id/timeline`

Timeline visual end-to-end. Implementa C.1 ([70-ux/06-screen-lead-timeline.md](../70-ux/06-screen-lead-timeline.md)).

| Item | Especificação |
|---|---|
| **CONTRACT-id** | `CONTRACT-api-leads-timeline-v1` |
| **Auth** | session MARKETER+ (sanitização varia por role) |
| **Query** | `cursor`, `limit` (default 50, max 200), `since` (ISO 8601, opcional — exclui nodes anteriores à data), `filters` (JSON: `{ types?: NodeType[], statuses?: NodeStatus[] }` — **formato anterior CSV não é mais suportado**) |
| **Response 200** | `{ nodes: [{ id, type, status, timestamp, summary, details, actions[] }], next_cursor }` |
| **Errors** | `404 lead_not_found`, `410 lead_erased` |

### `POST /v1/dispatch-jobs/:id/replay`

Re-dispatch de job em `failed`/`dead_letter`/`succeeded`/`skipped` ou replay em test mode. Implementa C.3 + E.3.

| Item | Especificação |
|---|---|
| **CONTRACT-id** | `CONTRACT-api-dispatch-replay-v1` |
| **Auth (alvo Sprint 6)** | session OPERATOR/ADMIN via JWT decodificado por middleware → `c.set('workspace_id', ...)` |
| **Auth (placeholder atual)** | `Authorization: Bearer <token>` não-vazio + header `X-Workspace-Id: <uuid>` (até Sprint 6 substituir por JWT decode real) |
| **Body** | `{ test_mode?: boolean, justification: string }` |
| **Side effects** | Cria novo `dispatch_jobs` com `replayed_from_dispatch_job_id`; emite `audit_log` action='replay_dispatch' com justification em `requestContext` |
| **Response 202** | `{ new_job_id, status: 'queued' }` |
| **Errors** | `401 unauthorized` (Bearer ausente/inválido), `404 job_not_found`, `409 not_replayable` (job em `pending`/`processing`/`retrying`) |

### `POST /v1/leads/:public_id/decrypt-pii`

> **Status (ADR-034):** parcialmente substituído por `POST /v1/leads/:public_id/reveal-pii` (reveal-on-demand para operator/admin/marketer com audit). O endpoint `decrypt-pii` original (PRIVACY-only com seleção granular de fields) permanece como spec futura — o uso prático hoje é coberto pelo `reveal-pii`. Implementação ainda pendente.

PRIVACY-only com seleção fina de fields. Implementa requisito de [70-ux/06-screen-lead-timeline.md §3](../70-ux/06-screen-lead-timeline.md).

| Item | Especificação |
|---|---|
| **Auth** | session PRIVACY |
| **Body** | `{ justification: string, fields: ['email' | 'phone' | 'name'] }` |
| **Side effects** | `audit_log` action='decrypt_pii' |
| **Response 200** | `{ email?, phone?, name? }` |
| **Errors** | `403 forbidden_role`, `404 lead_not_found`, `410 lead_erased` |

### `GET /v1/help/skip-reason/:reason`

Conteúdo estruturado para painel "Por que isso aconteceu?". Implementa F.3 ([70-ux/08-pattern-contextual-help.md §3](../70-ux/08-pattern-contextual-help.md)).

| Item | Especificação |
|---|---|
| **Auth** | session (qualquer role autenticado) |
| **Cache** | 1h (conteúdo estático) |
| **Response 200** | `{ key, title, probableCause, howToDiagnose[], howToFix[], whenIsNormal, externalDocs[], relatedTerms[] }` |
| **Errors** | `404 unknown_reason` |

### `POST /v1/workspace/test-mode`

Ativa/desativa test mode com TTL. Implementa E.2 ([70-ux/12-screen-live-event-console.md §2](../70-ux/12-screen-live-event-console.md)).

| Item | Especificação |
|---|---|
| **Auth** | session OPERATOR/ADMIN |
| **Body** | `{ enabled: boolean, ttl_seconds?: number (default 3600, max 7200) }` |
| **Side effects** | Escreve em KV `workspace_test_mode:<workspace_id>` com TTL; `audit_log` action='toggle_test_mode' |
| **Response 200** | `{ enabled, expires_at }` |

### `GET /v1/workspace/test-mode`

Lê estado atual + TTL restante.

| Item | Especificação |
|---|---|
| **Auth** | session MARKETER+ |
| **Response 200** | `{ enabled, expires_at: string \| null }` |

### `GET /v1/funnel-templates` (Sprint 10)

Lista templates de funil disponíveis para o workspace autenticado.

| Item | Especificação |
|---|---|
| **CONTRACT-id** | `CONTRACT-api-funnel-templates-list-v1` |
| **Auth** | `Authorization: Bearer <token>` (control-plane pattern); `DEV_WORKSPACE_ID` env como bypass em dev/test |
| **Scope** | Templates globais (`workspace_id IS NULL`) + templates workspace-scoped |
| **Response 200** | `{ templates: [{ id, slug, name, description, blueprint, is_system }] }` ordenado por `is_system DESC, name ASC` |
| **Errors** | `401 unauthorized` (Bearer ausente), `503 service_unavailable` (DB não configurado) |

### `GET /v1/funnel-templates/:slug` (Sprint 10)

Retorna detalhe de um template por slug.

| Item | Especificação |
|---|---|
| **CONTRACT-id** | `CONTRACT-api-funnel-templates-get-v1` |
| **Auth** | `Authorization: Bearer <token>` |
| **Scope** | Templates globais + workspace-scoped do workspace autenticado |
| **Response 200** | `{ template: { id, slug, name, description, blueprint, is_system } }` |
| **Errors** | `401 unauthorized`, `404 not_found` (template não encontrado ou de outro workspace), `503 service_unavailable` |

### `POST /v1/launches` (atualizado Sprint 10)

Cria um novo launch com scaffolding opcional de funil.

| Item | Especificação |
|---|---|
| **CONTRACT-id** | `CONTRACT-api-launches-create-v1` |
| **Auth** | `Authorization: Bearer <token>` |
| **Body** | `{ public_id: string (3–64), name: string, timezone?: string, config?: object, funnel_template_slug?: string }` |
| **Scaffolding** | Quando `funnel_template_slug` presente: `scaffoldLaunch()` executa de forma assíncrona via `waitUntil` (fire-and-forget); erros são logados mas não falham o response |
| **Response 201 (sem template)** | `{ launch: { id, public_id, name, timezone, status, workspace_id } }` |
| **Response 201 (com template)** | `{ launch: { id, public_id, name, timezone, status, workspace_id }, scaffolded: true }` |
| **Errors** | `400 validation_error`, `401 unauthorized`, `409 conflict` (public_id duplicado), `503 service_unavailable` |

### `GET /v1/launches` (atualizado Sprint 10)

Lista launches do workspace. Passa a incluir `funnel_blueprint` em cada objeto da resposta.

| Item | Especificação |
|---|---|
| **Auth** | `Authorization: Bearer <token>` |
| **Response 200** | `{ launches: [{ id, public_id, name, status, config, funnel_blueprint, created_at }], request_id }` — `funnel_blueprint` é `null` quando não configurado |
| **Errors** | `401 unauthorized`, `503 service_unavailable` |

### `GET /v1/launches/:public_id/leads` (Sprint 16 — T-LEADS-VIEW-002)

Lista paginada de leads que tocaram o funil de um launch (events.launch_id ou lead_stages.launch_id), com flags booleanas dinâmicas derivadas de `funnel_blueprint.leads_view`.

| Item | Especificação |
|---|---|
| **CONTRACT-id** | `CONTRACT-api-launch-leads-list-v1` |
| **Auth** | JWT Supabase (mesmo pattern do `/v1/leads` e `/v1/launches/:id/recovery`); `workspace_id` resolvido por `workspace_members` (BR-RBAC-001) — nunca via body/path |
| **Path** | `:public_id` = `launches.public_id` |
| **Query** | `limit?` (default 50, max 100), `cursor?` (ISO timestamp em `leads.created_at`), `q?` (UUID/email/phone/name — mesmo detection de `/v1/leads`), `column_filter?` (chave de coluna do `leads_view`), `stage_filter?` (slug presente em `leads_view.stage_progression`) |
| **Resolução de colunas** | Colunas vêm de `funnel_blueprint.leads_view.columns[]`. Cada coluna tem `type ∈ {tag, stage, event, any}` + `source` ou `sources[]`. Edge constrói EXISTS subqueries parametrizadas (BR-PRIVACY-001 — sem string interpolation; chaves sanitizadas para `[a-z0-9_]`). |
| **CTE `launch_leads`** | DISTINCT lead_ids com pelo menos 1 evento ou stage no launch; previne lead "alheio" aparecer. |
| **Mascaramento** | `display_email` / `display_phone` em claro para `owner`/`admin`/`marketer`/`privacy`; mascarados para `operator`/`viewer` (ADR-034 / BR-IDENTITY-006). `pii_masked` no item indica se mascaramento foi aplicado. |
| **Response 200** | `{ items: Array<{ lead_id, lead_name, display_email, display_phone, pii_masked, current_stage, current_stage_index, columns: Record<string, boolean>, last_event_at, created_at }>, next_cursor, total, leads_view, role }` |
| **`current_stage`** | Stage com maior `array_position` em `stage_progression` para o lead naquele launch (NULLS LAST → stages fora da progressão não sobrescrevem stages conhecidos). |
| **`last_event_at`** | `GREATEST(MAX(events.event_time), MAX(lead_stages.ts))` no launch. |
| **Mount order (Hono)** | Mounted **antes** de `launchesRoute` em `apps/edge/src/index.ts` para evitar que o middleware catch-all `*` de `launchesRoute` intercepte `/:public_id/leads`. |
| **Errors** | `400 validation_error` (query params, cursor inválido, column_filter/stage_filter desconhecido), `401 unauthorized`, `404 launch_not_found`, `422 leads_view_not_configured`, `422 leads_view_invalid` (Zod falhou em `funnel_blueprint.leads_view`), `500 internal_error`, `503 service_unavailable` |

### `GET /v1/launches/:public_id/recovery` (Sprint 14 — T-RECOVERY-004)

Lista paginada de eventos de recuperação (intenção de compra não-completada) para um launch. Todos os eventos vêm de `event_source = 'webhook:guru'`.

| Item | Especificação |
|---|---|
| **CONTRACT-id** | `CONTRACT-api-launch-recovery-list-v1` |
| **Auth** | JWT Supabase (mesmo pattern do `/v1/leads` e `/v1/launches/:id/leads`); `workspace_id` resolvido por `workspace_members` (BR-RBAC-001) |
| **Path** | `:public_id` = `launches.public_id` |
| **Query** | `limit?` (default 50, max 100), `cursor?` (ISO timestamp; só eventos com `event_time < cursor`), `event_type?` ∈ `InitiateCheckout` \| `OrderCanceled` \| `RefundProcessed` \| `Chargeback` (omitido = todos) |
| **Filtragem** | `events.workspace_id = $ws AND events.launch_id = $launch AND event_name IN (RECOVERY_EVENT_NAMES) AND event_source = 'webhook:guru'` (LEFT JOIN `leads` para `name`/`email_enc`/`phone_enc`/`pii_key_version`). Ordenação por `event_time DESC`. |
| **Mascaramento** | `display_email` / `display_phone` decifrados on-demand (best-effort — `null` em falha de chave); BR-PRIVACY-001 garante que plaintexts nunca aparecem em logs. |
| **Response 200** | `{ items: Array<{ event_id, event_name, event_time, lead_id, lead_name, display_email, display_phone, amount, currency, product_name }>, next_cursor, total }` — `amount`/`currency`/`product_name` extraídos de `events.custom_data` jsonb (parser defensivo contra double-encoding). |
| **Errors** | `400 validation_error` (query params, cursor inválido), `401 unauthorized`, `404 launch_not_found`, `500 internal_error`, `503 service_unavailable` |

### `PATCH /v1/launches/:id` (Sprint 10)

Atualiza `funnel_blueprint` de um launch existente (editor manual de stages).

| Item | Especificação |
|---|---|
| **CONTRACT-id** | `CONTRACT-api-launches-patch-v1` |
| **Auth** | `Authorization: Bearer <token>` |
| **Body** | `{ funnel_blueprint: Record<string, unknown> }` |
| **Workspace isolation** | WHERE `id = :id AND workspace_id = authenticated_workspace` (BR-RBAC-002) |
| **Response 200** | `{ launch: { id, public_id } }` |
| **Errors** | `400 validation_error`, `401 unauthorized`, `404 not_found` (launch não encontrado ou de outro workspace), `503 service_unavailable` |

### `GET /v1/workspace/config` (Sprint 13)

Lê a configuração JSONB `workspaces.config` do workspace autenticado. Read-only, sem audit. Consumida pela UI do Control Plane para hidratar telas de integrações (ex.: SendFlow `campaign_map`).

| Item | Especificação |
|---|---|
| **CONTRACT-id** | `CONTRACT-api-workspace-config-get-v1` |
| **Auth** | `Authorization: Bearer <token>`; `workspace_id` vem do contexto de auth (BR-RBAC-002) — nunca do body/query |
| **Side effects** | Nenhum (read-only — sem audit) |
| **Parse** | Defensivo: aceita `workspaces.config` como `string` (double-stringified legado) ou `object` JSONB cru |
| **Response 200** | `{ config: <full_config_object>, request_id }` |
| **Errors** | `401 unauthorized` (Bearer ausente/inválido), `503 service_unavailable` (DB não configurado) |

**Exemplo de response:**

```json
{
  "config": {
    "integrations": {
      "guru": { "product_launch_map": { "...": "..." } },
      "meta": { "pixel_id": "...", "capi_token": "..." }
    },
    "sendflow": {
      "campaign_map": {
        "abc123": { "launch": "wkshop-cs-jun26", "stage": "wpp_joined", "event_name": "Contact" }
      }
    }
  },
  "request_id": "..."
}
```

### `PATCH /v1/workspace/config` (Sprint 11; semântica `null=tombstone` adicionada Sprint 13)

Atualiza subcampos da configuração de integrações do workspace (JSONB `workspace.config`). Merge seguro via SELECT→JS deep-merge→UPDATE (não usa `||` SQL — bug de encoding no CF Worker driver).

| Item | Especificação |
|---|---|
| **CONTRACT-id** | `CONTRACT-api-workspace-config-patch-v1` |
| **Auth** | `Authorization: Bearer <token>` (OPERATOR ou ADMIN); `workspace_id` vem do contexto de auth — nunca do body |
| **Body** | Objeto parcial de `workspace.config`, validado via Zod `.strict()`. Campos aceitos: `integrations.guru.product_launch_map` (objeto `Record<string, { launch_public_id: string, funnel_role: string }>`); `sendflow.campaign_map` (objeto `Record<campaignId, { launch: string, stage: string, event_name: string } \| null>`). Campos extras (não declarados no schema) → 400 |
| **Merge** | Deep-merge: campos não enviados no body não são sobrescritos. Arrays são substituídos (não mergeados). |
| **Semântica `null=tombstone`** | `null` em qualquer chave do body — em qualquer profundidade — é interpretado como **tombstone**: a chave correspondente é **deletada** do JSONB armazenado. Aplica-se genericamente (não só a `sendflow`). Permite remover entries de `Record<>` sem precisar reenviar o map inteiro. Implementação no `deepMerge`: `else if (patchVal === null) delete result[key]`. |
| **Side effects** | UPDATE em `workspaces.config`; `audit_log` action=`workspace_config_updated`, metadata=`{ fields_updated: string[] }` (apenas chaves do body, sem valores — BR-PRIVACY-001) |
| **Response 200** | `{ config: <merged_config> }` — retorna o config completo pós-merge |
| **Errors** | `400 validation_error` (Zod falhou ou campo extra enviado), `401 unauthorized` (Bearer ausente/inválido), `500 internal_error` (falha no DB), `503 service_unavailable` (DB não configurado) |

**Exemplo de body — adicionar entry em `sendflow.campaign_map`:**

```json
{
  "sendflow": {
    "campaign_map": {
      "abc123": {
        "launch": "wkshop-cs-jun26",
        "stage": "wpp_joined",
        "event_name": "Contact"
      }
    }
  }
}
```

**Exemplo de body — remover (tombstone) uma entry específica:**

```json
{
  "sendflow": {
    "campaign_map": {
      "abc123": null
    }
  }
}
```

> Após este PATCH, a chave `abc123` deixa de existir em `sendflow.campaign_map`. Outras entries do map são preservadas.

**Exemplo de body — adicionar Guru product map:**

```json
{
  "integrations": {
    "guru": {
      "product_launch_map": {
        "prod_workshop_xyz": {
          "launch_public_id": "lcm-maio-2026",
          "funnel_role": "workshop"
        }
      }
    }
  }
}
```

### `GET /v1/integrations/sendflow/credentials` (Sprint 13)

Lê metadados não-sensíveis do `sendflow_sendtok` (token compartilhado SendFlow ↔ Edge). **Nunca** devolve o valor cru — apenas presença, prefixo e tamanho, para a UI do CP renderizar masking informativo (BR-PRIVACY-001).

| Item | Especificação |
|---|---|
| **CONTRACT-id** | `CONTRACT-api-integrations-sendflow-credentials-get-v1` |
| **Auth** | `Authorization: Bearer <token>`; `workspace_id` vem do contexto de auth |
| **Side effects** | Nenhum (read-only — sem audit) |
| **Response 200** | `{ has_sendtok: boolean, prefix: string \| null, length: number \| null, request_id }` — `prefix` = primeiros 4 chars do token; ambos `null` quando `has_sendtok=false` |
| **Errors** | `401 unauthorized`, `503 service_unavailable` |

**Exemplo de response (token cadastrado):**

```json
{
  "has_sendtok": true,
  "prefix": "shpz",
  "length": 64,
  "request_id": "..."
}
```

**Exemplo de response (sem token):**

```json
{
  "has_sendtok": false,
  "prefix": null,
  "length": null,
  "request_id": "..."
}
```

### `PATCH /v1/integrations/sendflow/credentials` (Sprint 13)

Cadastra ou atualiza o `sendflow_sendtok` em `workspace_integrations` via upsert (`onConflictDoUpdate` em `workspace_id`). Audit grava apenas metadados (`length`, `prefix`) — nunca o valor cru (BR-PRIVACY-001).

| Item | Especificação |
|---|---|
| **CONTRACT-id** | `CONTRACT-api-integrations-sendflow-credentials-patch-v1` |
| **Auth** | `Authorization: Bearer <token>`; `workspace_id` vem do contexto de auth |
| **Body** | `{ sendtok: string }` validado via Zod `.strict()`. `sendtok` ∈ `[16, 200]` chars |
| **Side effects** | Upsert em `workspace_integrations.sendflow_sendtok`; `audit_log` action=`workspace_sendflow_sendtok_updated`, metadata=`{ length, prefix }` (sem valor cru) |
| **Response 200** | `{ has_sendtok: true, prefix, length, request_id }` (mesmo shape do GET) |
| **Errors** | `400 validation_error` (Zod falhou — fora do range, campo extra), `401 unauthorized`, `503 service_unavailable` |

**Exemplo de body:**

```json
{
  "sendtok": "shpz_abcdefghijklmnopqrstuvwxyz0123456789"
}
```

**Exemplo de response:**

```json
{
  "has_sendtok": true,
  "prefix": "shpz",
  "length": 40,
  "request_id": "..."
}
```

### `GET /v1/products` (Sprint 16)

Lista paginada do catálogo de produtos do workspace. Implementa MOD-PRODUCT.

| Item | Especificação |
|---|---|
| **CONTRACT-id** | `CONTRACT-api-products-list-v1` |
| **Auth** | `Authorization: Bearer <JWT Supabase>`; role ≥ `viewer` para listar |
| **Query** | `status?` (`active`\|`archived`; default `active`), `q?` (busca em `name` ILIKE), `category?` (valor canônico de `ProductCategory` ou `uncategorized` para filtrar `category IS NULL`), `cursor?` (ISO `created_at`), `limit?` (default 50, max 200) |
| **Response 200** | `{ items: [{ id, name, category, external_provider, external_product_id, status, created_at, purchase_count, affected_leads }], next_cursor }` — `purchase_count` e `affected_leads` calculados via correlated subquery em `events.custom_data->>'product_db_id'` |
| **CORS** | `cpCors` aplicado em `/v1/products/*` (Sprint 16) |
| **Errors** | `400 invalid_query`, `401 unauthorized`, `503 service_unavailable` |

### `POST /v1/products` (Sprint 16)

Cria produto manualmente (operador cadastra antes do primeiro Purchase webhook chegar).

| Item | Especificação |
|---|---|
| **CONTRACT-id** | `CONTRACT-api-products-create-v1` |
| **Auth** | role `owner` ou `admin` (BR-RBAC-001) |
| **Body** | `{ name: string (1–200), external_provider: ProductExternalProvider, external_product_id: string (1–200), category?: ProductCategory \| null, status?: 'active' \| 'archived' }` (Zod `.strict`) |
| **Side effects** | INSERT em `products`; `audit_log` action=`product_created` |
| **Response 201** | `{ product: { id, name, category, external_provider, external_product_id, status, created_at } }` |
| **Errors** | `400 validation_error`, `401`, `403 forbidden_role`, `409 conflict` (UNIQUE `(workspace_id, external_provider, external_product_id)` violado), `503` |

### `PATCH /v1/products/:id` (Sprint 16)

Atualiza atributos editáveis de um produto. Quando `category` muda, dispara backfill de `lifecycle_status` para todos os leads com Purchase event vinculado (BR-PRODUCT-003).

| Item | Especificação |
|---|---|
| **CONTRACT-id** | `CONTRACT-api-products-patch-v1` |
| **Auth** | role `owner` ou `admin` |
| **Body** | `{ name?, category? (incluindo `null` para descategorizar), external_provider?, external_product_id?, status? }` (Zod `.strict` + refine at-least-one) |
| **Side effects** | UPDATE em `products`. Se `category` mudou: `promoteLeadLifecycle` re-executado para cada lead afetado. `audit_log` action=`product_updated` (e `product_category_updated` quando `category` mudou). |
| **Response 200** | `{ product: {...}, leads_recalculated?: number }` — `leads_recalculated` presente apenas quando `category` mudou |
| **Errors** | `400 validation_error`, `401`, `403`, `404 not_found`, `409 conflict` (UNIQUE viola), `503` |

### `GET /v1/launches/:launch_public_id/products` (Sprint 16)

Lista produtos associados a um launch com seus respectivos `launch_role`. Implementa relação `launch_products` (ADR-037).

| Item | Especificação |
|---|---|
| **CONTRACT-id** | `CONTRACT-api-launch-products-list-v1` |
| **Auth** | role ≥ `viewer` |
| **Workspace isolation** | Resolve `launch_id` via `(workspace_id, public_id)` antes de qualquer JOIN |
| **Response 200** | `{ items: [{ product_id, launch_role, name, category, external_provider, external_product_id }] }` (JOIN com `products`) |
| **CORS** | `cpCors` aplicado em `/v1/launches/*` (Sprint 16) |
| **Errors** | `401`, `404 launch_not_found`, `503` |

### `PUT /v1/launches/:launch_public_id/products/:product_id` (Sprint 16)

Upsert da associação `launch_products` com `launch_role` tipado (substitui o legacy `funnel_role` free-string em `workspaces.config.integrations.guru.product_launch_map`).

| Item | Especificação |
|---|---|
| **CONTRACT-id** | `CONTRACT-api-launch-products-upsert-v1` |
| **Auth** | role `owner` ou `admin` |
| **Body** | `{ launch_role: LaunchProductRole }` (`main_offer` \| `main_order_bump` \| `bait_offer` \| `bait_order_bump`) |
| **Side effects** | INSERT … ON CONFLICT (`launch_id`, `product_id`) DO UPDATE SET `launch_role`. UNIQUE garante 1 produto por launch. `audit_log` action=`launch_product_set`. |
| **Response 200** | `{ launch_product: { launch_id, product_id, launch_role } }` |
| **Errors** | `400 validation_error`, `401`, `403`, `404 launch_not_found` ou `404 product_not_found`, `503` |

### `DELETE /v1/launches/:launch_public_id/products/:product_id` (Sprint 16)

Remove associação `launch_products` (não apaga `products`).

| Item | Especificação |
|---|---|
| **Auth** | role `owner` ou `admin` |
| **Side effects** | DELETE em `launch_products`; `audit_log` action=`launch_product_unset` |
| **Response 204** | (vazio) |
| **Errors** | `401`, `403`, `404`, `503` |

> **Nota Hono — ordem de mount (Sprint 16):** `/v1/launches/:launch_public_id/products/*` é montado em `apps/edge/src/index.ts` **antes** de `launchesRoute`. Caso contrário o middleware do `launchesRoute` (auth Bearer-only) intercepta e quebra o JWT pattern. Ver commit `0fb5ca6`.

### `DELETE /v1/admin/leads/:lead_id`

SAR/erasure. Auth restrita.

| Item | Especificação |
|---|---|
| **CONTRACT-id** | `CONTRACT-api-admin-leads-erase-v1` |
| **Auth** | Control Plane session (cookie) ou API key com escopo `leads:erase` |
| **Authz** | role `privacy` ou `admin` (AUTHZ-003) |
| **Side effects** | Enqueue job de anonimização. Não-bloqueante. |
| **Response 202** | `{ job_id, status: 'queued' }` |
| **Errors** | `401`, `403 forbidden_role`, `404 lead_not_found`, `409 already_erased` |

---

## Convenção `Result<T, E>`

Todas as funções de domínio que podem falhar de forma esperada retornam `Result`:

```ts
type Result<T, E> =
  | { ok: true; value: T }
  | { ok: false; error: E };
```

Erros esperados são modelados como `Result.ok=false`; exceções são reservadas para falhas inesperadas (bug, indisponibilidade externa total).

### Padrão de erro

```ts
type DomainError = {
  code: string;        // 'invalid_token', 'consent_denied', 'lead_not_found'
  message: string;     // texto técnico para log
  http_status?: number; // sugestão de mapeamento
  details?: unknown;   // payload sanitizado para debug
};
```

`code` é estável (parte do contrato); `message` pode evoluir.

## Validação Zod

Toda fronteira HTTP/webhook/queue valida com Zod **antes** de tocar em lógica de domínio.

```ts
import { z } from 'zod';

export const EventPayloadSchema = z.object({
  event_id: z.string().min(1).max(64),
  schema_version: z.literal(1),
  launch_public_id: z.string(),
  page_public_id: z.string(),
  event_name: z.string(),
  event_time: z.string().datetime(),
  lead_token: z.string().optional(),
  lead_id: z.string().uuid().optional(),
  visitor_id: z.string().optional(),
  attribution: AttributionSchema.default({}),
  custom_data: z.record(z.unknown()).default({}),
  consent: ConsentSchema,
}).strict()
  .refine((d) => !(d.lead_token && d.lead_id), { message: 'lead_token and lead_id are mutually exclusive' });
```

`.strict()` rejeita campos desconhecidos — princípio de least surprise.

## Idempotência opt-in (Server Actions)

Operações idempotent-por-natureza (CREATE de evento já tem `event_id`; UPDATE de status com mesma transition) declaram `idempotent: true`. Operações com side effects externos (dispatch a Meta/Google) usam `idempotency_key` (ADR-013).

## Headers comuns

| Header | Uso |
|---|---|
| `X-Funil-Site` | page_token público — `/v1/config`, `/v1/events`, `/v1/lead` |
| `X-Request-Id` | request_id (UUID) gerado pelo Edge se ausente; propagado em logs e responses |
| `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset` | Em respostas de rotas com rate limit |
| `X-Schema-Version` | Em responses, ecoa schema_version aceita |

## Tabela de status codes

| Status | Quando |
|---|---|
| `200 OK` | GET sucesso (`/v1/config`) |
| `202 Accepted` | POST aceito async (`/v1/events`, `/v1/lead`, admin SAR) |
| `302 Found` | Redirect (`/r/:slug`) |
| `400 Bad Request` | Validação Zod, payload inválido, `event_id` malformado |
| `401 Unauthorized` | Token inválido ou ausente |
| `403 Forbidden` | Token válido mas escopo errado, origem não permitida, role insuficiente |
| `404 Not Found` | Página, lead, link não encontrado |
| `409 Conflict` | Lead já erased em outra request, transition inválida |
| `410 Gone` | Workspace/launch archived |
| `429 Too Many Requests` | Rate limit |
| `500 Internal Server Error` | Falha não esperada — log + alerta |

`5xx` deve ser raro em prod; provedores webhook fazem retry, então erro 5xx custa retry desnecessário.

## CORS

`/v1/config`, `/v1/events`, `/v1/lead` aceitam origem listada em `pages.allowed_domains` (match por sufixo — `cliente.com` permite `*.cliente.com`).

`Access-Control-Allow-Origin`: ecoa Origin se permitido; senão omitido.
`Access-Control-Allow-Methods`: `GET, POST, OPTIONS`.
`Access-Control-Allow-Headers`: `Content-Type, X-Funil-Site, X-Request-Id`.

## OpenAPI / docs

Specs OpenAPI 3.1 geradas a partir dos schemas Zod em `packages/shared/`. Publicadas em `docs/api/` (build artifact, não checked in).

## Política de evolução

- Adicionar campo opcional ao body: backward-compatible — mantém `schema_version` (1).
- Adicionar campo obrigatório, mudar tipo, remover campo, mudar shape de erro: breaking — bumpar `schema_version` ou criar `/v2` (depende do escopo).
- Adicionar endpoint novo: opt-in para clientes; não impacta `v1`.
