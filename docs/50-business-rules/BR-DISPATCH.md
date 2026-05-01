# BR-DISPATCH — Regras de dispatch para destinos externos

## BR-DISPATCH-001 — Idempotency key canonicalizada por destino

### Status: Stable (ADR-013)

### Enunciado
```
idempotency_key = sha256(workspace_id|event_id|destination|destination_resource_id|destination_subresource)
```
- `destination_subresource` = `pixel_id` (Meta), `conversion_action` (Google Ads), `measurement_id` (GA4 MP), `audience_id` (Customer Match).
- Constraint `unique (idempotency_key)` em `dispatch_jobs`.

### Enforcement
- Helper `computeIdempotencyKey()` puro.
- DB constraint impede duplicata.

### Gherkin
```gherkin
Scenario: mesmo evento, dois destinos: dois jobs distintos
  Given event=E
  When createDispatchJobs cria job para meta_capi (pixel=P) e ga4_mp (measurement=M)
  Then idempotency_key1 ≠ idempotency_key2

Scenario: retry do mesmo job não cria duplicata
  Given dispatch_job já existe com key=K
  When createDispatchJobs tenta com mesmo input
  Then unique violation; processor reusa job existente
```

---

## BR-DISPATCH-002 — Lock atômico antes de processar; impede duplo-processamento

### Status: Stable (INV-DISPATCH-008)

### Enunciado
Cloudflare Queues entrega at-least-once. Worker **DEVE** fazer UPDATE atômico `status='pending' → 'processing'` antes de chamar plataforma externa. Se UPDATE retornou 0 rows (job já em outro estado), worker abandona sem chamar.

### Enforcement
```ts
const updated = await db.update(dispatchJobs)
  .set({ status: 'processing', updated_at: now() })
  .where(and(eq(id, jobId), eq(status, 'pending')))
  .returning();

if (updated.length === 0) return; // outro consumer já pegou
```

### Gherkin
```gherkin
Scenario: mensagem duplicada na queue não gera 2 chamadas à API
  Given dispatch_job J em status pending
  When 2 consumers recebem mensagem para J simultaneamente
  Then apenas 1 transiciona para processing; outro abandona
  And API externa recebe apenas 1 request
```

---

## BR-DISPATCH-003 — Retry com backoff exponencial + jitter; max 5 attempts

### Status: Stable

### Enunciado
- Erro 4xx permanente (400, 403, 422): `failed`, sem retry.
- Erro 429: `retrying`, backoff exponencial.
- Erro 5xx: `retrying`, backoff exponencial.
- Timeout: `retrying`, backoff exponencial.
- `max_attempts=5` default. Após esgotar: `dead_letter`.

Backoff: `delay = 2^attempt × (1 ± 0.2 random jitter)` segundos.

### Enforcement
- Helper `computeBackoff(attempt: number): number` com Math.random.
- DLQ via CF Queue dead-letter target.

### Gherkin
```gherkin
Scenario: erro 500 → retry 5×, depois DLQ
  Given dispatcher Meta CAPI retorna 500
  When attempt 1, 2, 3, 4, 5 todos falham
  Then status='dead_letter' após attempt 5
  And next_attempt_at = NULL

Scenario: erro 400 não retry
  Given Meta retorna 400 'invalid_pixel_id'
  When dispatcher recebe response
  Then status='failed' imediato (sem retry)
```

---

## BR-DISPATCH-004 — `skipped` exige `skip_reason` não-vazio

### Status: Stable (INV-DISPATCH-004)

### Enunciado
Job com `status='skipped'` **DEVE** ter `skip_reason` preenchido. Razões canônicas:
- `consent_denied:<finality>` (BR-CONSENT-003)
- `no_user_data` (sem email/phone hash para CAPI)
- `integration_not_configured` (workspace sem credenciais)
- `no_click_id_available` (Google Conversion Upload sem gclid)
- `audience_not_eligible` (Customer Match `disabled_not_eligible`)
- `archived_launch`

### Enforcement
- Constraint check: `skip_reason IS NOT NULL when status='skipped'`.

### Gherkin
```gherkin
Scenario: skipped sem reason é rejeitado
  When tentar update dispatch_job com status='skipped' sem skip_reason
  Then check constraint violation
```

---

## BR-DISPATCH-005 — Dead letter não reprocessa automaticamente

### Status: Stable (INV-DISPATCH-003)

### Enunciado
Job em `dead_letter` **NÃO PODE** ser reenvolvido pelo retry automático. Reprocessamento exige ação humana via `requeueDeadLetter(job_id)` chamada por OPERATOR/ADMIN.

### Enforcement
- Helper `requeueDeadLetter()` audita ação em `audit_log`.
- Cron de retry ignora `dead_letter`.

### Gherkin
```gherkin
Scenario: requeue manual move dead_letter para pending
  Given dispatch_job em dead_letter
  When OPERATOR chama requeueDeadLetter(job_id)
  Then status='pending', attempt_count=0, next_attempt_at=now()
  And audit_log com action='reprocess_dlq' criado
```
