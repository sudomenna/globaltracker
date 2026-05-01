# 06 — Audit trail spec

## Princípios

1. **Apenas-anexar.** `audit_log` não aceita UPDATE nem DELETE manual (INV-AUDIT-001). Trigger ou política RLS bloqueia.
2. **Sanitização obrigatória.** `request_context` nunca contém PII em claro (INV-AUDIT-003).
3. **Cross-cutting.** Toda mutação em entidades sensíveis deve gerar entry (INV-AUDIT-004).
4. **Retenção 7 anos** (ADR-014).
5. **Separado de logs operacionais.** Logs de aplicação (Wrangler observability, métricas Workers) são distintos — eles são para debug; audit_log é para compliance e auditoria.

## Schema

```sql
audit_log (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id),
  actor_id text,             -- UUID de user, identifier de api_key, ou 'system'
  actor_type text not null,  -- 'user' | 'system' | 'api_key'
  action text not null,      -- ver lista canônica
  entity_type text not null, -- 'page' | 'page_token' | 'audience' | 'lead' | 'launch' | ...
  entity_id text not null,
  before jsonb,              -- snapshot anterior (NULL em create)
  after jsonb,               -- snapshot posterior (NULL em delete)
  ts timestamptz not null default now(),
  request_context jsonb      -- sanitized (ip_hash, ua_hash, request_id; **nunca** email/phone/name/IP em claro)
);

-- Índices recomendados:
create index idx_audit_log_workspace_ts on audit_log (workspace_id, ts desc);
create index idx_audit_log_entity on audit_log (workspace_id, entity_type, entity_id);
create index idx_audit_log_action on audit_log (workspace_id, action, ts desc);
```

## Lista canônica de actions

Ver `30-contracts/01-enums.md` (`AuditAction`). Resumo:

| Action | Quando |
|---|---|
| `create` | INSERT em entidade auditável |
| `update` | UPDATE em entidade auditável |
| `delete` | DELETE (raro — usar `archive` em vez) |
| `archive` | Status → `archived` |
| `rotate` | `page_token` rotacionado |
| `revoke` | `page_token` ou `lead_token` revogado |
| `erase_sar` | SAR/erasure executado em lead |
| `merge_leads` | Merge canônico executado |
| `read_pii_decrypted` | Decrypt de `email_enc` / `phone_enc` / `name_enc` (AUTHZ-001) |
| `sync_audience` | Audience sync job iniciado |
| `reprocess_dlq` | DLQ message reprocessada manualmente |
| `change_role` | `workspace_member.role` alterado |
| `add_member` | INSERT em `workspace_members` |
| `remove_member` | UPDATE `workspace_members.removed_at` |
| `create_api_key` | API key emitida |
| `revoke_api_key` | API key revogada |

## Eventos auditáveis (mapping cross-cutting)

INV-AUDIT-004 obriga audit log em mutações nas seguintes tabelas/cenários:

| Tabela / cenário | Action típica |
|---|---|
| `pages.event_config` (UPDATE) | `update` |
| `pages.allowed_domains` (UPDATE) | `update` |
| `pages.status` (UPDATE) | `update` ou `archive` |
| `page_tokens` (INSERT/rotate/revoke) | `create` / `rotate` / `revoke` |
| `audiences.query_definition` (UPDATE) | `update` |
| `audiences.consent_policy` (UPDATE) | `update` |
| `audiences.destination_strategy` (UPDATE) | `update` |
| `lead_consents` (INSERT) | `create` |
| `leads.status='erased'` (SAR) | `erase_sar` |
| `lead_merges` (INSERT) | `merge_leads` |
| Decrypt de PII (qualquer tabela `*_enc`) | `read_pii_decrypted` |
| `workspace_members` (CRUD) | `add_member` / `change_role` / `remove_member` |
| `workspace_api_keys` (INSERT/revoke) | `create_api_key` / `revoke_api_key` |
| Retention policy change | `update` |
| Integration credentials (criação/rotação) | `create` / `update` |
| `audience_sync_jobs` (INSERT manual ou reprocessamento) | `sync_audience` ou `reprocess_dlq` |

Tabelas **não** auditadas em `audit_log` (volume alto demais; observabilidade vai em métricas/logs):
- `events` — toda ingestão é evento, não auditoria.
- `dispatch_jobs`, `dispatch_attempts` — operacional.
- `link_clicks` — alta cardinalidade.
- `raw_events` — efêmero.
- `audit_log` em si — apenas-anexar protegido por trigger.

## Sanitização de `request_context`

```ts
type SanitizedRequestContext = {
  request_id: string;       // UUID
  ip_hash?: string;         // SHA-256 do IP (não cleartext)
  ua_hash?: string;         // SHA-256 do user-agent
  origin?: string;          // domínio (sem path/query)
  actor_session_id?: string;
};
```

Helper `sanitizeRequestContext(req): SanitizedRequestContext` em `apps/edge/src/lib/sanitize-logs.ts`. Validador rejeita keys conhecidas como PII (`email`, `phone`, `name`, `ip`).

## RLS / acesso

| Quem | Pode ler |
|---|---|
| OWNER, ADMIN | Todo `audit_log` do workspace |
| OPERATOR | Próprios `audit_log` (`actor_id = self.user_id`) + ações de sistema |
| MARKETER | Próprios + `entity_type IN ('launch','page','audience','link')` |
| PRIVACY | Todo `audit_log` (especialmente `read_pii_decrypted` e `erase_sar`) |
| VIEWER | Nada |
| API_KEY | Próprios entries (`actor_id = api_key_id`) |

Política RLS implementa essa matriz.

## View pública

```sql
create view audit_log_view as
select
  workspace_id, actor_type, action, entity_type, entity_id,
  ts, request_context
from audit_log;
-- Sem before/after no view — esses são consultados pontualmente via service auth.
```

Metabase consome `audit_log_view`, não a tabela bruta.

## Retenção

Cron diário (`apps/edge/src/crons/retention-purge.ts`):

```sql
delete from audit_log where ts < now() - interval '7 years';
```

Política de retenção pode ser ajustada por workspace via `retention_policies` (Fase 4) — mas mínimo 7 anos para conformidade.

## Performance

- INSERT é alto volume — não bloquear request principal. Pattern: `recordAuditEntry()` enfileira em queue async ou faz INSERT direto se latência aceitável.
- Queries de leitura usam índices listados acima.
- Particionamento por `ts` (mensal) considerado se volume crescer > 10M rows/ano.

## Helper API

```ts
// apps/edge/src/lib/audit.ts
export async function recordAuditEntry(input: {
  workspace_id: string;
  actor_id: string;
  actor_type: AuditActorType;
  action: AuditAction;
  entity_type: string;
  entity_id: string;
  before?: unknown;
  after?: unknown;
  request_context?: unknown;
}, ctx: Ctx): Promise<void>;
```

Lança erro se workspace_id ausente ou se `request_context` falhar sanitização.

## Test coverage

- `tests/integration/audit/no-update-no-delete.test.ts` — INV-AUDIT-001 (trigger bloqueia).
- `tests/integration/audit/sanitize-rejects-pii.test.ts` — INV-AUDIT-003.
- `tests/integration/audit/cross-cutting-coverage.test.ts` — para cada action, gera mutation real e verifica entry criada (INV-AUDIT-004 amostragem).
- `tests/integration/audit/pii-decrypt-logs.test.ts` — INV-AUDIT-005 (toda chamada `decryptLeadPII` registra entry).
- `tests/integration/audit/retention-purge.test.ts` — entries > 7 anos deletadas.
