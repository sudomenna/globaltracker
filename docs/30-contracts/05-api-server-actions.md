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
| **Side effects** | Insert em `raw_events`; enqueue em CF Queue para ingestion processor |
| **Response 202** | `{ event_id, status: 'accepted' \| 'duplicate_accepted' \| 'rejected' }` |
| **Errors** | `400 validation_error`, `401 invalid_token`, `403 origin_not_allowed`, `429 rate_limited`, `410 archived_launch` |

### `POST /v1/lead`

Identifica/cria lead, registra consent, emite `lead_token`.

| Item | Especificação |
|---|---|
| **CONTRACT-id** | `CONTRACT-api-lead-v1` |
| **Auth** | `X-Funil-Site` |
| **Body** | `{ event_id, schema_version, launch_public_id, page_public_id, email?, phone?, name?, attribution, consent }` (mín. um de email/phone) |
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

### `GET /v1/leads/:public_id/timeline`

Timeline visual end-to-end. Implementa C.1 ([70-ux/06-screen-lead-timeline.md](../70-ux/06-screen-lead-timeline.md)).

| Item | Especificação |
|---|---|
| **CONTRACT-id** | `CONTRACT-api-leads-timeline-v1` |
| **Auth** | session MARKETER+ (sanitização varia por role) |
| **Query** | `cursor`, `limit` (default 50, max 200), `filter[type]`, `filter[status]` |
| **Response 200** | `{ nodes: [{ id, type, status, timestamp, summary, details, actions[] }], next_cursor }` |
| **Errors** | `404 lead_not_found`, `410 lead_erased` |

### `POST /v1/dispatch-jobs/:id/replay`

Re-dispatch de job em `failed`/`dead_letter` ou replay em test mode. Implementa C.3 + E.3.

| Item | Especificação |
|---|---|
| **CONTRACT-id** | `CONTRACT-api-dispatch-replay-v1` |
| **Auth** | session OPERATOR/ADMIN |
| **Body** | `{ test_mode?: boolean, justification: string }` |
| **Side effects** | Cria novo `dispatch_jobs` com `replayed_from_dispatch_job_id`; emite `audit_log` action='replay_dispatch' com justification |
| **Response 202** | `{ new_job_id, status: 'queued' }` |
| **Errors** | `404 job_not_found`, `409 not_replayable` (job em pending/processing) |

### `POST /v1/leads/:public_id/decrypt-pii`

PRIVACY-only. Decrypt PII com audit. Implementa requisito de [70-ux/06-screen-lead-timeline.md §3](../70-ux/06-screen-lead-timeline.md).

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
