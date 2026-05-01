# BR-RBAC — Regras de autorização (AUTHZ-*)

> Regras canônicas detalhadas em [`00-product/03-personas-rbac-matrix.md`](../00-product/03-personas-rbac-matrix.md). Esta página é o "espelho executável" para implementação em código.

## BR-RBAC-001 — Cross-workspace queries são proibidas em qualquer role (AUTHZ-005)

### Status: Stable (ADR-002)

### Enunciado
Mesmo `owner` não pode ler dados de outro workspace. RLS do Postgres + filtro explícito em todo handler.

### Enforcement
- RLS policy em todas tabelas de domínio: `using (workspace_id = current_setting('app.current_workspace_id')::uuid)`.
- Application seta `set local app.current_workspace_id = '<uuid>'` no início de cada request transaction.
- Test: query sem set retorna 0 rows.

### Gherkin
```gherkin
Scenario: query sem workspace setado retorna vazio
  Given session sem app.current_workspace_id setado
  When SELECT * FROM leads
  Then 0 rows

Scenario: workspace W1 não enxerga workspace W2
  Given app.current_workspace_id = W1
  When SELECT count(*) FROM leads
  Then count = leads de W1 apenas, mesmo que W2 tenha rows
```

---

## BR-RBAC-002 — Lead PII em claro só visível por privacy/owner com audit log (AUTHZ-001)

Ver [BR-IDENTITY-006](BR-IDENTITY.md#br-identity-006--decrypt-de-pii-em-claro-exige-role-privacy-owner--audit_log).

---

## BR-RBAC-003 — Owner único por workspace (INV-WORKSPACE-003)

### Status: Stable

### Enunciado
Cada workspace tem exatamente 1 `workspace_member` com `role='owner'` e `removed_at IS NULL`. Promoção a owner exige action do owner atual.

### Enforcement
- Trigger DB ou check em service que valida na transition.

### Gherkin
```gherkin
Scenario: tentativa de promover 2º owner é rejeitada
  Given workspace com owner O1
  When admin A tenta promover user U para owner
  Then erro 'forbidden_only_owner_can_promote' (apenas O1 pode)

Scenario: O1 promove U para owner
  Given owner O1
  When O1 promove U para owner (transferência)
  Then workspace tem owner U; O1 vira admin
```

---

## BR-RBAC-004 — API key tem `scopes` declarados; operação fora retorna 403 (AUTHZ-009)

### Status: Stable

### Enunciado
Cada API key tem `scopes: text[]`. Operação fora do escopo retorna 403 + audit log de tentativa negada.

### Enforcement
- `validateApiKeyScope()` em `MOD-WORKSPACE` checa antes de qualquer operação.

### Gherkin
```gherkin
Scenario: api_key com scope events:write tenta erase lead
  Given key K com scopes=['events:write']
  When DELETE /v1/admin/leads/:id usando K
  Then 403 'insufficient_scope'
  And audit_log com action='read_pii_decrypted_denied' OU 'erase_sar_denied'
```

---

## BR-RBAC-005 — SAR/erasure exige privacy/admin com double-confirm (AUTHZ-003)

### Status: Stable (ADR-014)

### Enunciado
`DELETE /v1/admin/leads/:lead_id` exige:
1. Role `privacy` ou `admin`.
2. Header `X-Confirm-Erase: ERASE LEAD <lead_public_id>` (string exata).
3. Audit log obrigatório com action `erase_sar`.

### Enforcement
- Middleware checa role + header de confirmação antes de enqueue.

### Gherkin
```gherkin
Scenario: sem header confirm
  Given role=privacy
  When DELETE /v1/admin/leads/L sem X-Confirm-Erase
  Then 400 'missing_confirmation'

Scenario: header errado
  Given role=privacy
  When DELETE com X-Confirm-Erase: 'ERASE LEAD wrong_id'
  Then 400 'confirmation_mismatch'

Scenario: privacy + header correto
  Given role=privacy, X-Confirm-Erase válido
  Then 202; job enqueued; audit log entry created
```

---

## BR-RBAC-006 — Toda mutação em entidades sensíveis registra audit_log (AUTHZ-012)

### Status: Stable

### Enunciado
Operações em `pages.event_config`, `audiences.query_definition`, `page_tokens` (rotate/revoke), `lead_consents`, `retention_policies`, `integration_credentials` (referência), `workspace_members`, `workspace_api_keys` **DEVEM** gerar entry em `audit_log` no mesmo transaction.

### Enforcement
- Service layer chama `recordAuditEntry()` antes de commit.
- Test integration valida amostragem de cada entity_type.

### Gherkin
```gherkin
Scenario: page event_config update sem audit log
  Given page P
  When UPDATE page.event_config sem chamar recordAuditEntry
  Then test integration falha (BR-RBAC-006 violado)

Scenario: rotate page_token gera audit
  Given page_token T1 active
  When OPERATOR rotaciona
  Then audit_log entry com action='rotate', entity_type='page_token', before/after presentes
```
