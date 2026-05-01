# BR-PRIVACY — Regras de privacidade e PII

## BR-PRIVACY-001 — PII em claro nunca é persistida em logs ou jsonb não-criptografado

### Status: Stable

### Enunciado
Email, telefone, nome e IP em claro **NÃO PODEM** aparecer em: `events.user_data`, `events.request_context`, `dispatch_attempts.request_payload_sanitized`, `dispatch_attempts.response_payload_sanitized`, logs estruturados, ou qualquer payload retornado a caller externo.

### Enforcement
- Zod schema de `user_data` permite apenas chaves canônicas (`em`, `ph`, `fbc`, `fbp`, `_gcl_au`, `client_id_ga4`, `external_id_hash`); rejeita `email`, `phone`, `name`.
- Helper `sanitizeRequestContext()` redacta automaticamente.
- Helper `sanitizeDispatchPayload()` redacta antes de gravar `dispatch_attempts`.
- Logger global tem redact list pré-configurada.

### Aplica-se a
MOD-EVENT, MOD-DISPATCH, MOD-AUDIT, todas as integrações.

### Critério de aceite (Gherkin)
```gherkin
Scenario: payload de tracker com email em user_data é rejeitado
  Given POST /v1/events com user_data: { email: "foo@bar.com" }
  When Edge valida com Zod
  Then retorna 400 com error_code='validation_error_user_data_pii'
```

### Citação em código
```ts
// BR-PRIVACY-001: PII em claro proibida em user_data
const userData = userDataSchema.parse(input.user_data); // rejeita 'email', 'phone'
```

---

## BR-PRIVACY-002 — IP e User Agent são transitórios — nunca persistidos em claro por default

### Status: Stable

### Enunciado
IP e UA brutos podem ser usados no momento do dispatch (Meta CAPI exige `client_ip_address` e `client_user_agent` não-hashados — Seção 15 do planejamento). Mas **NÃO PODEM** ser persistidos em `events`, `link_clicks`, `dispatch_jobs` em claro. Apenas `ip_hash` e `ua_hash` (SHA-256) são persistidos.

### Enforcement
- `link_clicks.ip_hash`/`ua_hash` são tipo `text` sem coluna correspondente em claro.
- Edge mantém IP/UA in-memory durante request e descarta após dispatch enqueue.

### Critério de aceite
```gherkin
Scenario: link click registra hashes
  Given GET /r/abc com IP=1.2.3.4, UA="Mozilla..."
  When redirector grava link_clicks
  Then ip_hash = sha256("1.2.3.4"), ua_hash = sha256("Mozilla..."), nada em claro
```

### Citação
```ts
// BR-PRIVACY-002: IP/UA transitórios — apenas hash persistido
```

---

## BR-PRIVACY-003 — PII enc usa AES-256-GCM com chave derivada por workspace via HKDF

### Status: Stable (ADR-009)

### Enunciado
`leads.email_enc`, `phone_enc`, `name_enc` **DEVEM** ser criptografados com AES-256-GCM. Chave **DEVE** ser derivada via `HKDF(PII_MASTER_KEY_V{n}, salt=workspace_id, info='pii')`. Versão da chave é gravada em `leads.pii_key_version`.

### Enforcement
- Helper `encrypt()`, `decrypt()` em `apps/edge/src/lib/pii.ts`.
- Validador rejeita escrita sem `pii_key_version` setado.

### Critério de aceite
```gherkin
Scenario: encrypt/decrypt round-trip
  Given workspace_id=W, PII_MASTER_KEY_V1
  When encrypt("foo@bar.com", W) → ciphertext
  And decrypt(ciphertext, W) → "foo@bar.com"
  Then sucesso, pii_key_version=1

Scenario: chave de workspace1 não decrypta de workspace2
  Given encrypt em W1 → ciphertext
  When decrypt(ciphertext, W2)
  Then falha com 'decryption_failed'
```

### Citação
```ts
// BR-PRIVACY-003: AES-GCM com chave derivada por workspace
```

---

## BR-PRIVACY-004 — `pii_key_version` permite rotação sem downtime via lazy re-encryption

### Status: Stable

### Enunciado
Cada row com PII enc carrega `pii_key_version`. Sistema **DEVE** suportar leitura de versões antigas (até `MIN_SUPPORTED_PII_KEY_VERSION`) e escrever sempre na versão corrente (`PII_KEY_VERSION` env). Re-encryption acontece lazy on read (ou batch background opcional).

### Enforcement
- Helper `decrypt()` lê `pii_key_version` do row e seleciona chave correta.
- Helper `encrypt()` usa sempre versão corrente.
- Cron opcional `pii-reencrypt.ts` faz batch quando configurado.

### Critério de aceite
```gherkin
Scenario: leitura com versão antiga
  Given row com pii_key_version=1, ciphertext criptografado com K1
  And PII_KEY_VERSION env atual = 2
  When decrypt(row)
  Then sucesso (usa K1)

Scenario: lazy re-encryption
  Given row com pii_key_version=1
  When update do row (qualquer mutação)
  Then row é re-encrypted com K2 e pii_key_version atualizada
```

### Citação
```ts
// BR-PRIVACY-004: pii_key_version habilita rotação lazy
```

---

## BR-PRIVACY-005 — SAR/erasure anonimiza events, attribution, link_clicks; preserva agregados

### Status: Stable (ADR-014, RF-029)

### Enunciado
`eraseLead(lead_id)` **DEVE**: zerar `leads.email_enc/phone_enc/name_enc/email_hash/phone_hash`, `leads.status='erased'`, remover `lead_aliases` correspondentes, anonimizar campos PII em `events.user_data` (mas preservar event count/timing para agregados), zerar `events.request_context.ip_hash/ua_hash`, anonimizar `lead_attribution` (preserva campos não-identificadores). Job é idempotente.

### Enforcement
- Endpoint `DELETE /v1/admin/leads/:lead_id` enqueue job.
- Worker `apps/edge/src/lib/erasure.ts` executa com transaction.
- `audit_log` com `action='erase_sar'` registra.

### Critério de aceite
```gherkin
Scenario: SAR completa em < 60s para lead com 100k events
  Given lead L com 100k events, 50 link_clicks, 5 lead_attribution
  When DELETE /v1/admin/leads/:L como privacy
  Then job termina em < 60s
  And leads.status='erased', email_enc IS NULL
  And events.user_data não contém em/ph/external_id_hash
  And lead_attribution.fbclid/gclid preservados; identificadores zerados
  And lead_aliases para L removidos
  And audit_log entry created
  And idempotente: chamar 2x retorna 200 sem reprocessar
```

### Citação
```ts
// BR-PRIVACY-005: erasure SAR anonimiza, preserva agregados
```
