# BR-AUDIT — Regras de audit log

Spec completa em [`30-contracts/06-audit-trail-spec.md`](../30-contracts/06-audit-trail-spec.md). Esta página tem as regras imperativas executáveis.

## BR-AUDIT-001 — `audit_log` é apenas-anexar; UPDATE e DELETE manuais bloqueados (INV-AUDIT-001)

### Status: Stable

### Enunciado
Tabela `audit_log` **NÃO PODE** receber UPDATE ou DELETE manual de qualquer role humano ou API key. Apenas:
- INSERT por sistema (`recordAuditEntry()`).
- DELETE por job de retenção (`purgeRetention()` rodando como service role).

### Enforcement
- Trigger BEFORE UPDATE/DELETE bloqueia se `current_user != 'service_role'` (ou via RLS).
- Application layer não expõe API de mutação.

### Gherkin
```gherkin
Scenario: tentativa de UPDATE bloqueada
  Given owner role
  When UPDATE audit_log SET action='other' WHERE id=X
  Then erro de trigger
  And nenhuma row alterada

Scenario: cron de retention pode deletar
  Given service_role
  When DELETE audit_log WHERE ts < now() - interval '7 years'
  Then sucesso
```

---

## BR-AUDIT-002 — `request_context` é sanitizado — sem PII em claro (INV-AUDIT-003)

### Status: Stable

### Enunciado
`audit_log.request_context` (jsonb) **NÃO PODE** conter `email`, `phone`, `name`, `ip` em claro. Apenas hashes (`ip_hash`, `ua_hash`) e identificadores (`request_id`, `actor_session_id`, `origin`).

### Enforcement
- Helper `sanitizeRequestContext()` valida e redacta.
- `recordAuditEntry()` chama sanitizer obrigatoriamente.
- Zod schema rejeita keys conhecidas como PII.

### Gherkin
```gherkin
Scenario: tentativa de gravar email em request_context
  Given request_context = { email: 'foo@bar.com', request_id: 'rid' }
  When recordAuditEntry chamado
  Then sanitizer remove email, mantém request_id
  And audit_log entry tem request_context = { request_id: 'rid' }
```

---

## BR-AUDIT-003 — Decrypt de PII gera entry mesmo se leitura falha (INV-AUDIT-005)

### Status: Stable (AUTHZ-001)

### Enunciado
Toda chamada a `decryptLeadPII()` **DEVE** gerar audit_log entry, mesmo quando:
- Leitura falha por role insuficiente (`action='read_pii_decrypted_denied'`).
- Lead está erased (`action='read_pii_decrypted_on_erased'`).
- Decryption falha por chave incorreta.

### Enforcement
- Helper `decryptLeadPII()` registra entry antes de retornar.

### Gherkin
```gherkin
Scenario: marketer tenta decrypt; entry de denied criado
  Given role=marketer
  When decryptLeadPII(L, ['email']) é chamado
  Then retorno: error 'forbidden_role'
  And audit_log entry com action='read_pii_decrypted_denied', actor_id=marketer_user

Scenario: privacy decrypta com sucesso
  Given role=privacy
  When decryptLeadPII(L, ['email']) sucesso
  Then audit_log entry com action='read_pii_decrypted', fields=['email']
  And email é retornado em claro ao caller
```

---

## BR-AUDIT-004 — Retenção 7 anos; cron purga após

### Status: Stable (ADR-014)

### Enunciado
`audit_log` rows com `ts < now() - interval '7 years'` **DEVEM** ser deletadas por cron diário. Antes de deletar, cron emite métrica de quantidade purgada.

### Enforcement
- Cron `apps/edge/src/crons/retention-purge.ts` executa diariamente.

### Gherkin
```gherkin
Scenario: cron purga rows expiradas
  Given audit_log com 1000 rows, 100 com ts > 7 anos
  When cron executa
  Then 100 rows deletadas
  And métrica audit_retention_purged=100
```
