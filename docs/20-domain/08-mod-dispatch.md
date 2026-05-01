# MOD-DISPATCH — Dispatch jobs e attempts

## 1. Identidade

- **ID:** MOD-DISPATCH
- **Tipo:** Core
- **Dono conceitual:** OPERATOR (pipeline) + DOMAIN (eligibility e idempotency)

## 2. Escopo

### Dentro
- `dispatch_jobs` por evento × destino com idempotency_key canonicalizada (ADR-013).
- `dispatch_attempts` registrando cada tentativa.
- Retry com backoff exponencial + jitter; DLQ após `max_attempts`.
- Eligibility check (consent, user_data mínimo, integration configurada).
- Skip explícito com `skip_reason` quando pré-condição não atendida.
- Dispatchers por destino: `apps/edge/src/dispatchers/{meta-capi,ga4-mp,google-conversion-upload,google-enhanced-conversions,audience-sync}/`.

### Fora
- Implementação interna de cada dispatcher (cada um tem seu sub-módulo em `40-integrations/`).
- Audience batch logic (`MOD-AUDIENCE`).

## 3. Entidades

### DispatchJob
- `id`, `workspace_id`
- `event_id` (FK para `events`)
- `destination` (`meta_capi` / `ga4_mp` / `google_ads_conversion` / `google_enhancement` / `audience_sync`)
- `destination_account_id`
- `destination_resource_id` (pixel_id / measurement_id / customer_id / audience_id)
- `destination_subresource` (NULL / conversion_action / etc.)
- `idempotency_key` (único)
- `status` (`pending` / `processing` / `succeeded` / `retrying` / `failed` / `skipped` / `dead_letter`)
- `eligibility_reason`, `skip_reason`
- `attempt_count`, `max_attempts` (default 5)
- `next_attempt_at`
- `created_at`, `updated_at`

### DispatchAttempt
- `id`, `workspace_id`, `dispatch_job_id`
- `attempt_number`
- `status` (`succeeded` / `retryable_failure` / `permanent_failure`)
- `request_payload_sanitized`, `response_payload_sanitized`
- `response_status`
- `error_code`, `error_message`
- `started_at`, `finished_at`

## 4. Relações

- `DispatchJob N—1 Event`
- `DispatchJob 1—N DispatchAttempt`

## 5. Estados (DispatchJob)

```
[pending] → [processing] → [succeeded]
                       → [retrying] → [processing] → ... (até max_attempts)
                                                  → [dead_letter]
                       → [permanent_failure → failed]
                       → [skipped] (não-elegível)
```

## 6. Transições válidas

| De | Para | Quando |
|---|---|---|
| (criação) | `pending` | Ingestion processor cria após normalizar evento. |
| `pending` | `processing` | Worker pega job da queue. |
| `processing` | `succeeded` | Plataforma retornou 2xx. |
| `processing` | `retrying` | 429 ou 5xx; agenda `next_attempt_at` com backoff. |
| `processing` | `failed` | 4xx permanente (400, 403, 422). |
| `processing` | `skipped` | Pré-condição falhou (consent denied, user_data insuficiente, integration não configurada). |
| `retrying` | `processing` | Quando `next_attempt_at` chega. |
| `retrying` | `dead_letter` | `attempt_count >= max_attempts`. |

## 7. Invariantes

- **INV-DISPATCH-001 — `idempotency_key` é único globalmente.** `unique` constraint. Garante que mesmo evento × destino não dispara 2×. Testável.
- **INV-DISPATCH-002 — `idempotency_key` deriva exatamente de `sha256(workspace_id|event_id|destination|destination_resource_id|destination_subresource)` (ADR-013).** Testável: função pura.
- **INV-DISPATCH-003 — Job em `dead_letter` não é re-processado automaticamente.** Reprocessamento é manual via UI/script. Testável.
- **INV-DISPATCH-004 — `skipped` carrega `skip_reason` não-vazio.** Validador. Testável.
- **INV-DISPATCH-005 — `attempt_count` em DispatchJob = `count(*)` em DispatchAttempt.** Testável (assertion).
- **INV-DISPATCH-006 — Eventos sem consent exigido pelo destino geram job `skipped` com `skip_reason='consent_denied'`, não `failed`.** BR-CONSENT-* + BR-DISPATCH-*. Testável.
- **INV-DISPATCH-007 — Backoff respeita jitter aleatório de ±20% sobre `2^attempt_count` segundos.** Testável (mock random).
- **INV-DISPATCH-008 — Lock atômico antes de processar — duas mensagens da queue para o mesmo job não geram dois requests à plataforma.** Cloudflare Queues at-least-once + lock por `dispatch_job.status='processing'`. Testável.

## 8. BRs relacionadas

- `BR-DISPATCH-*` — em `50-business-rules/BR-DISPATCH.md`.
- `BR-CONSENT-*` — bloqueio de dispatch por finalidade.

## 9. Contratos consumidos

- `MOD-EVENT` (event como input).
- `MOD-IDENTITY.getLatestConsent()` ou usa `event.consent_snapshot`.
- `MOD-IDENTITY` (lookup em `leads` para enriquecer payload).
- `40-integrations/*` (cada provedor expõe `dispatch()`).

## 10. Contratos expostos

- `createDispatchJobs(event, ctx): Promise<DispatchJob[]>` — ingestion processor cria jobs após normalizar evento.
- `processDispatchJob(job_id, ctx): Result<DispatchAttempt, ProcessingError>`
- `markDeadLetter(job_id, reason, ctx): Promise<void>`
- `requeueDeadLetter(job_id, ctx): Result<void, NotInDeadLetter>` — reprocessamento manual.

## 11. Eventos de timeline emitidos

- `TE-DISPATCH-CREATED`
- `TE-DISPATCH-SUCCEEDED`
- `TE-DISPATCH-FAILED`
- `TE-DISPATCH-SKIPPED`
- `TE-DISPATCH-DEAD-LETTER`

## 12. Ownership de código

**Pode editar:**
- `packages/db/src/schema/dispatch_job.ts`
- `packages/db/src/schema/dispatch_attempt.ts`
- `apps/edge/src/lib/dispatch.ts` (orquestração comum)
- `apps/edge/src/lib/idempotency.ts`
- `apps/edge/src/dispatchers/index.ts` (registry de dispatchers)
- `tests/unit/dispatch/**`
- `tests/integration/dispatch/**`

**Lê:**
- `apps/edge/src/dispatchers/*` (executados por workers; não editados aqui — são `MOD-DISPATCH` na fronteira de `40-integrations/`).

## 13. Dependências permitidas / proibidas

**Permitidas:** `MOD-EVENT`, `MOD-IDENTITY`, `MOD-LAUNCH`, `MOD-AUDIT`.
**Proibidas:** `MOD-AUDIENCE` consome `MOD-DISPATCH` (audience sync vira dispatch jobs), não o contrário.

## 14. Test harness

- `tests/unit/dispatch/idempotency-key.test.ts` — INV-DISPATCH-002 (função pura).
- `tests/unit/dispatch/backoff-jitter.test.ts` — INV-DISPATCH-007.
- `tests/unit/dispatch/skip-reason-required.test.ts` — INV-DISPATCH-004.
- `tests/integration/dispatch/at-least-once-lock.test.ts` — INV-DISPATCH-008 (mensagem duplicada na queue não gera 2 chamadas).
- `tests/integration/dispatch/dead-letter-flow.test.ts` — após max_attempts, vai para DLQ.
