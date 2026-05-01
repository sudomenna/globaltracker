# 03 — Timeline / domain event catalog

> Domain events emitidos pelos módulos para audit, analytics e (futuramente) integração externa via webhooks out. Diferente de `events` (eventos de tracking ingeridos do tracker/webhook). Aqui é o que **o sistema emite** sobre si mesmo.

## Convenções

- ID: `TE-<DOMAIN>-<VERB>` (verbo no past tense — "CREATED", "MERGED").
- Versionamento: `TE-...-v1`. Mudança breaking → `v2`.
- Persistência: por enquanto, não há tabela `timeline_events` dedicada — eventos são inferidos de `audit_log` + métricas. Se necessário tabela própria (Fase 4+), será spec separado.
- Retenção: alinhado com `audit_log` (7 anos) onde audit-relevant; menor onde apenas operacional.

## Catálogo

### MOD-WORKSPACE

| ID | Quando | Visibilidade | Retenção |
|---|---|---|---|
| `TE-WORKSPACE-CREATED-v1` | Insert em `workspaces` | OWNER, ADMIN | 7y |
| `TE-WORKSPACE-STATUS-CHANGED-v1` | Update em `workspaces.status` | OWNER, ADMIN | 7y |
| `TE-WORKSPACE-MEMBER-ADDED-v1` | Insert em `workspace_members` | OWNER, ADMIN | 7y |
| `TE-WORKSPACE-MEMBER-REMOVED-v1` | Update em `workspace_members.removed_at` | OWNER, ADMIN | 7y |
| `TE-WORKSPACE-API-KEY-CREATED-v1` | Insert em `workspace_api_keys` | OWNER, ADMIN, OPERATOR | 7y |
| `TE-WORKSPACE-API-KEY-REVOKED-v1` | Update em `workspace_api_keys.revoked_at` | OWNER, ADMIN, OPERATOR | 7y |

Payload (exemplo `TE-WORKSPACE-CREATED-v1`):
```ts
{
  workspace_id: string;
  slug: string;
  name: string;
  created_by_actor_id: string;
  created_at: string; // ISO timestamptz
}
```

### MOD-LAUNCH

| ID | Quando | Visibilidade | Retenção |
|---|---|---|---|
| `TE-LAUNCH-CREATED-v1` | Insert | MARKETER+ | 7y |
| `TE-LAUNCH-STATUS-CHANGED-v1` | `launches.status` mudou | MARKETER+ | 7y |
| `TE-LAUNCH-CONFIG-UPDATED-v1` | `launches.config` mudou | MARKETER+ | 7y |

### MOD-PAGE

| ID | Quando | Visibilidade | Retenção |
|---|---|---|---|
| `TE-PAGE-CREATED-v1` | Insert em `pages` | MARKETER+ | 7y |
| `TE-PAGE-STATUS-CHANGED-v1` | `pages.status` mudou | MARKETER+ | 7y |
| `TE-PAGE-CONFIG-UPDATED-v1` | `pages.event_config` mudou | MARKETER+ | 7y |
| `TE-PAGE-TOKEN-CREATED-v1` | Insert em `page_tokens` | OPERATOR+ | 7y |
| `TE-PAGE-TOKEN-ROTATED-v1` | Status `active` → `rotating` em token + criação de novo `active` | OPERATOR+ | 7y |
| `TE-PAGE-TOKEN-REVOKED-v1` | Status → `revoked` | OPERATOR+ | 7y |

### MOD-IDENTITY

| ID | Quando | Visibilidade | Retenção |
|---|---|---|---|
| `TE-LEAD-CREATED-v1` | Insert em `leads` | qualquer role com escopo | 13m (alinhado com events) |
| `TE-LEAD-UPDATED-v1` | Update em `leads` (campos não-PII) | qualquer | 13m |
| `TE-LEAD-MERGED-v1` | Insert em `lead_merges` | qualquer | 7y (audit) |
| `TE-LEAD-ERASED-v1` | `leads.status` → `erased` (SAR) | PRIVACY+ | 7y (audit) |
| `TE-LEAD-CONSENT-RECORDED-v1` | Insert em `lead_consents` | qualquer | permanente (prova de consent) |
| `TE-LEAD-TOKEN-ISSUED-v1` | Insert em `lead_tokens` | sistema | 90d |
| `TE-LEAD-TOKEN-REVOKED-v1` | Update em `lead_tokens.revoked_at` | OPERATOR+, PRIVACY+ | 7y |
| `TE-LEAD-PII-DECRYPTED-ACCESS-v1` | Decrypt PII (apenas PRIVACY/OWNER) | PRIVACY, OWNER | 7y (audit) |

Payload (exemplo `TE-LEAD-MERGED-v1`):
```ts
{
  workspace_id: string;
  canonical_lead_id: string;
  merged_lead_ids: string[];
  reason: 'email_phone_convergence' | 'manual' | 'sar';
  performed_by: string; // actor_id ou 'system'
  events_reassigned: number;
  attribution_reassigned: number;
  ts: string;
}
```

### MOD-EVENT

| ID | Quando | Visibilidade | Retenção |
|---|---|---|---|
| `TE-EVENT-INGESTED-v1` | Edge persistiu em `raw_events` | OPERATOR+ | 30d (operacional) |
| `TE-EVENT-NORMALIZED-v1` | Processor criou row em `events` | OPERATOR+ | 30d |
| `TE-EVENT-REJECTED-v1` | Processor rejeitou (consent denied, archived launch, validation) | OPERATOR+ | 30d |

### MOD-FUNNEL

| ID | Quando | Visibilidade | Retenção |
|---|---|---|---|
| `TE-LEAD-STAGE-RECORDED-v1` | Insert em `lead_stages` | MARKETER+ | 13m |
| `TE-LEAD-STAGE-DUPLICATE-IGNORED-v1` | Tentativa de stage não-recorrente já existente | OPERATOR+ | 30d |

### MOD-ATTRIBUTION

| ID | Quando | Visibilidade | Retenção |
|---|---|---|---|
| `TE-LINK-CLICKED-v1` | Insert em `link_clicks` | MARKETER+ | 13m |
| `TE-FIRST-TOUCH-RECORDED-v1` | Insert em `lead_attribution where touch_type='first'` | MARKETER+ | 13m |
| `TE-LAST-TOUCH-UPDATED-v1` | Insert/Update em `lead_attribution where touch_type='last'` | MARKETER+ | 13m |

### MOD-DISPATCH

| ID | Quando | Visibilidade | Retenção |
|---|---|---|---|
| `TE-DISPATCH-CREATED-v1` | Insert em `dispatch_jobs` | OPERATOR+ | 90d |
| `TE-DISPATCH-SUCCEEDED-v1` | Status → `succeeded` | OPERATOR+ | 90d |
| `TE-DISPATCH-FAILED-v1` | Status → `failed` | OPERATOR+ | 90d |
| `TE-DISPATCH-SKIPPED-v1` | Status → `skipped` (com `skip_reason`) | OPERATOR+ | 90d |
| `TE-DISPATCH-DEAD-LETTER-v1` | Status → `dead_letter` | OPERATOR+, ADMIN+ | 90d (alerta) |

Payload (exemplo `TE-DISPATCH-SKIPPED-v1`):
```ts
{
  workspace_id: string;
  dispatch_job_id: string;
  event_id: string;
  destination: DispatchDestination;
  skip_reason: string; // 'consent_denied' | 'no_user_data' | 'integration_not_configured' | 'no_click_id_available' | ...
  ts: string;
}
```

### MOD-AUDIENCE

| ID | Quando | Visibilidade | Retenção |
|---|---|---|---|
| `TE-AUDIENCE-CREATED-v1` | Insert em `audiences` | MARKETER+ | 7y |
| `TE-AUDIENCE-SNAPSHOT-GENERATED-v1` | Insert em `audience_snapshots` | OPERATOR+ | 30d |
| `TE-AUDIENCE-SYNC-SUCCEEDED-v1` | Sync job → `succeeded` | MARKETER+ | 90d |
| `TE-AUDIENCE-SYNC-FAILED-v1` | Sync job → `failed` | OPERATOR+, MARKETER+ | 90d |

### MOD-COST

| ID | Quando | Visibilidade | Retenção |
|---|---|---|---|
| `TE-COST-INGESTED-v1` | Cron rodou e atualizou `ad_spend_daily` | OPERATOR+ | 30d |
| `TE-COST-FX-REPROCESSED-v1` | Reprocessamento retroativo de FX | OPERATOR+ | 90d |
| `TE-COST-INGESTION-FAILED-v1` | Cron falhou | OPERATOR+ (alerta) | 90d |

### MOD-ENGAGEMENT

| ID | Quando | Visibilidade | Retenção |
|---|---|---|---|
| `TE-SURVEY-COMPLETED-v1` | Insert em `lead_survey_responses` | MARKETER+ | 13m |
| `TE-ICP-SCORED-v1` | Insert em `lead_icp_scores` | MARKETER+ | 13m |
| `TE-WEBINAR-JOINED-v1` | Insert em `webinar_attendance` | MARKETER+ | 13m |
| `TE-WEBINAR-WATCHED-MARKER-v1` | Update em `webinar_attendance.max_watch_marker` | MARKETER+ | 13m |

---

## Schema unificado de evento

Todo TE-* tem envelope:

```ts
{
  te_id: string; // 'TE-LEAD-MERGED-v1'
  workspace_id: string;
  occurred_at: string; // ISO timestamptz
  payload: Record<string, unknown>; // shape específico do TE
  emitted_by: string; // 'system' ou actor_id
  correlation_id?: string; // request_id para correlacionar com logs
}
```

Validador Zod compartilhado em `packages/shared/src/contracts/timeline-events.ts`.

## Webhooks out (Fase 4+)

Quando Control Plane permitir registrar webhook out, operador escolhe quais TE-* receber. Sistema dispara HTTP POST com:
- Header `X-GlobalTracker-Signature` (HMAC do body com secret do webhook).
- Header `X-GlobalTracker-Event` (ex.: `TE-LEAD-MERGED-v1`).
- Body = envelope acima.

Detalhe completo na pasta `40-integrations/` quando webhooks out forem implementados.

## Política de evolução

- Adicionar campo opcional ao payload: backward-compatible — mantém versão `v1`.
- Adicionar campo obrigatório, remover campo, mudar tipo: breaking — bumpar para `v2`. Consumidores antigos continuam recebendo `v1` durante janela de migração.
