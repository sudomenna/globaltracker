# MOD-AUDIT — Audit log (cross-cutting)

## 1. Identidade

- **ID:** MOD-AUDIT
- **Tipo:** Supporting (cross-cutting — consumido por todos os módulos)
- **Dono conceitual:** PRIVACY + DOMAIN

## 2. Escopo

### Dentro
- Tabela `audit_log` append-only.
- Helper `recordAuditEntry()` chamado por todos os módulos em ações sensíveis.
- Retenção 7 anos (ADR-014).
- View `audit_log_view` para consumo em dashboards (Metabase).

### Fora
- Logs estruturados de aplicação (Wrangler observability).
- Métricas operacionais (`23-observabilidade` no `planejamento.md`).

## 3. Entidades

### AuditLog
- `id`, `workspace_id`
- `actor_id` (text — UUID de user, ou identificador de API key, ou `'system'`)
- `actor_type` (`user` / `system` / `api_key`)
- `action` (text — ex.: `create`, `update`, `delete`, `rotate`, `revoke`, `erase_sar`, `merge_leads`, `read_pii_decrypted`)
- `entity_type` (text — ex.: `page`, `page_token`, `audience`, `lead`, `launch`)
- `entity_id` (text)
- `before` (jsonb — snapshot do estado anterior; pode ser NULL para `create`)
- `after` (jsonb — snapshot do estado posterior; pode ser NULL para `delete`)
- `ts`
- `request_context` (jsonb sanitizado — IP hash, UA hash, request_id; **nunca PII**)

## 4. Relações

- `AuditLog` é apêndice — não tem FK direta a outras tabelas (entity_id é text por flexibilidade), mas é referenciada conceitualmente por todas.

## 5. Estados

Sem state machine — append-only.

## 6. Transições válidas

- INSERT pelo sistema — nunca UPDATE ou DELETE manual (AUTHZ-004).
- Purge pelo cron de retenção (após 7 anos — ADR-014).

## 7. Invariantes

- **INV-AUDIT-001 — `audit_log` não aceita UPDATE nem DELETE manual.** Trigger DB ou política RLS bloqueia. Testável.
- **INV-AUDIT-002 — `actor_type` ∈ enum.** Constraint check. Testável.
- **INV-AUDIT-003 — `request_context` é sanitizado — não contém email, phone, name, IP em claro.** Validador no helper. Testável.
- **INV-AUDIT-004 — Toda mutação em `pages.event_config`, `audiences.query_definition`, `page_tokens` (rotate/revoke), `lead_consents`, `retention_policies`, `integration_credentials` (referência) gera entry em `audit_log` (AUTHZ-012).** Testável: integration test confirma que update sem audit log é rejeitado por trigger ou layer.
- **INV-AUDIT-005 — Acesso a PII em claro (decrypt) gera entry com `action='read_pii_decrypted'`.** AUTHZ-001. Testável.

## 8. BRs relacionadas

- `BR-AUDIT-*` — em `50-business-rules/BR-AUDIT.md`.
- AUTHZ-001 (PII decrypt audit), AUTHZ-004 (read-only humano), AUTHZ-012 (cross-cutting).

## 9. Contratos consumidos

- (nenhum — `MOD-AUDIT` é folha)

## 10. Contratos expostos

- `recordAuditEntry({actor_id, actor_type, action, entity_type, entity_id, before, after, request_context}, ctx): Promise<void>`
- `getAuditLog({workspace_id, entity_type?, entity_id?, action?, ts_range}, ctx): Promise<AuditLog[]>`
- `purgeRetention(ctx): Promise<{purged: number}>` — cron.

## 11. Eventos de timeline emitidos

- (nenhum — `audit_log` é o evento por si só)

## 12. Ownership de código

**Pode editar:**
- `packages/db/src/schema/audit_log.ts`
- `packages/db/src/views/audit_log_view.sql`
- `apps/edge/src/lib/audit.ts`
- `apps/edge/src/crons/retention-purge.ts`
- `tests/unit/audit/**`
- `tests/integration/audit/**`

**Lê:**
- (nenhum — `MOD-AUDIT` é referenciado por todos, mas não depende deles)

## 13. Dependências permitidas / proibidas

**Permitidas:** `MOD-WORKSPACE` (validação de workspace).
**Proibidas:** qualquer outro módulo (cross-cutting → folha).

## 14. Test harness

- `tests/unit/audit/sanitize-request-context.test.ts` — INV-AUDIT-003.
- `tests/integration/audit/no-update-no-delete.test.ts` — INV-AUDIT-001.
- `tests/integration/audit/pii-decrypt-logged.test.ts` — INV-AUDIT-005.
- `tests/integration/audit/cross-cutting-mutations-logged.test.ts` — INV-AUDIT-004 (samples por entity_type).
- `tests/integration/audit/retention-purge.test.ts` — registros > 7 anos são deletados.
