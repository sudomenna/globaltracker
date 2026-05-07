# MOD-EVENT — Eventos, raw_events, ingestão, clamp, replay protection

## 1. Identidade

- **ID:** MOD-EVENT
- **Tipo:** Core
- **Dono conceitual:** OPERATOR (pipeline) + DOMAIN (normalização e idempotência)

## 2. Escopo

### Dentro
- `events` (canônico, imutável após insert).
- `raw_events` (modelo "fast accept", retenção 7d — ADR-004).
- Edge endpoint `/v1/events` com validação Zod, clamp de `event_time`, replay protection.
- Ingestion processor (CF Queue consumer) que normaliza `raw_events` → `events`/`leads`/`lead_stages` e cria `dispatch_jobs`.
- Idempotência por `(workspace_id, event_id)`.

### Fora
- Atribuição (`MOD-ATTRIBUTION` — chamado pelo processor).
- Resolução de identidade (`MOD-IDENTITY.resolveLeadByAliases` — chamado pelo processor).
- Dispatch para destinos (`MOD-DISPATCH`).

## 3. Entidades

### RawEvent
- `id`, `workspace_id`, `page_id`
- `payload` (jsonb com payload original)
- `headers_sanitized` (jsonb)
- `received_at`, `processed_at`
- `processing_status` (`pending` / `processed` / `failed` / `discarded`)
- `processing_error`

### Event
- `id`, `workspace_id`
- `launch_id` (opcional), `page_id` (opcional)
- `lead_id` (opcional — eventos anônimos existem)
- `visitor_id` (text — reservado em Fases 1-2; populado em Fase 3)
- `event_id` (texto — único por workspace; idempotência)
- `event_name` (PageView, Lead, Contact, ViewContent, InitiateCheckout, Purchase, custom)
- `event_source` (`tracker` / `webhook:hotmart` / `redirector` / `system`)
- `schema_version` (integer)
- `event_time` (timestamptz — pode ter sido clampado)
- `received_at`
- `attribution` (jsonb)
- `user_data` (jsonb — somente hash/IDs permitidos + IP/UA para EMQ; ver BR-PRIVACY-001, ADR-031)
  - `em`, `ph`, `external_id_hash` — hashes SHA-256 de PII normalizada
  - `fbc`, `fbp` — cookies Meta Pixel (não hashar)
  - `_gcl_au`, `client_id_ga4`, `session_id_ga4` — cookies/IDs Google
  - `external_id` — visitor_id (UUID v4 do cookie `__fvid`) em **plano**, não hasheado; Meta hashea internamente (ADR-031)
  - `client_ip_address: string | null` — IP do request (capturado do header `CF-Connecting-IP` na rota `/v1/events`); persistido em `events.userData` para EMQ em Meta CAPI / Google Enhanced Conversions (ADR-031). **NÃO** persistido em `raw_events.headers_sanitized`.
  - `client_user_agent: string | null` — User-Agent do request (capturado do header `User-Agent`); idem.
- `custom_data` (jsonb)
- `consent_snapshot` (jsonb com 5 finalidades)
- `request_context` (jsonb sanitizado)
- `processing_status` (`accepted` / `enriched` / `rejected_archived_launch` / `rejected_consent`)

## 4. Relações

- `Event N—1 Lead` (FK opcional)
- `Event N—1 Launch` (FK opcional)
- `Event N—1 Page` (FK opcional)
- `Event 1—N DispatchJob` (`MOD-DISPATCH` consome)
- `RawEvent 1—1 (Event ou rejected)` lógica (não FK direta)

## 5. Estados

### RawEvent
```
[pending] → [processed]   (sucesso)
        → [failed]      (erro recuperável; vai pra DLQ após max attempts)
        → [discarded]   (decisão consciente — ex.: workspace archived)
```

### Event
```
[accepted] → [enriched]              (após processor + dispatch jobs criados)
          → [rejected_*]             (rejeitado por motivo conhecido)
```

## 6. Transições válidas

- RawEvent: criada como `pending` pelo Edge; processada por ingestion processor.
- Event: insert direto pelo processor com `processing_status='accepted'` ou `'enriched'`.

## 7. Invariantes

- **INV-EVENT-001 — `(workspace_id, event_id)` é único em `events`.** `unique` constraint. Testável.
- **INV-EVENT-002 — Edge clampa `event_time` quando `abs(event_time - received_at) > EVENT_TIME_CLAMP_WINDOW_SEC`.** Testável: payload com `event_time = "2020-01-01"` e `received_at = "2026-05-01"` resulta em `event_time = received_at`.
- **INV-EVENT-003 — Replay com mesmo `event_id` em janela de 7 dias retorna idempotente sem novo insert.** Testável: KV cache verifica `event_id`; se existe, retorna `{status: "duplicate_accepted"}`.
- **INV-EVENT-004 — `events.user_data` rejeita campos PII em claro.** Zod schema permite só `{em, ph, fbc, fbp, _gcl_au, client_id_ga4, session_id_ga4, external_id_hash, client_ip_address, client_user_agent, ...}` — não `email`, `phone`, `name`. `client_ip_address` e `client_user_agent` são permitidos para EMQ outbound (BR-PRIVACY-001, ADR-031). Testável.
- **INV-EVENT-005 — Edge persiste em `raw_events` antes de retornar 202.** Testável: kill -9 do worker durante request não gera `raw_events` aceito do lado do cliente (cliente recebe erro de network, não 202).
- **INV-EVENT-006 — `consent_snapshot` é populado em todo evento.** Mesmo que `unknown` para todos. Testável.
- **INV-EVENT-007 — Eventos com `lead_token` válido têm `lead_id` resolvido pelo processor.** Testável: integration test FLOW-07.

## 8. BRs relacionadas

- `BR-EVENT-*` — em `50-business-rules/BR-EVENT.md`.
- `BR-CONSENT-*`.
- `BR-DISPATCH-*`.

## 9. Contratos consumidos

- `MOD-IDENTITY.resolveLeadByAliases()` — pelo processor.
- `MOD-IDENTITY.validateLeadToken()` — pelo Edge.
- `MOD-IDENTITY.getLatestConsent()` — pelo dispatcher (mas snapshot já é capturado em `events.consent_snapshot`).
- `MOD-LAUNCH.requireActiveLaunch()` — pelo processor.
- `MOD-PAGE.getPageByToken()` — pelo Edge.
- `MOD-ATTRIBUTION.recordTouches()` — pelo processor.
- `MOD-AUDIT.recordAuditEntry()` — em casos sensíveis (eventos anonimizados via SAR).

## 10. Contratos expostos

- `acceptRawEvent(payload, headers, ctx): Result<{event_id, status}, ValidationError | RateLimited | DuplicateAccepted>`
- `processRawEvent(raw_event_id, ctx): Result<{event_id, dispatch_jobs_created}, ProcessingError>`
- `clampEventTime(event_time, received_at, window_sec): timestamptz`
- `isReplay(workspace_id, event_id, ctx): Promise<boolean>`
- `markReplayProtectionSeen(workspace_id, event_id, ctx): Promise<void>`

## 11. Eventos de timeline emitidos

- `TE-EVENT-INGESTED`
- `TE-EVENT-NORMALIZED` (quando processor cria `events` row)
- `TE-EVENT-REJECTED`

## 12. Ownership de código

**Pode editar:**
- `packages/db/src/schema/event.ts`
- `packages/db/src/schema/raw_event.ts`
- `apps/edge/src/routes/events.ts`
- `apps/edge/src/lib/raw-events-processor.ts`
- `apps/edge/src/lib/event-time-clamp.ts`
- `apps/edge/src/lib/replay-protection.ts`
- `apps/edge/src/middleware/rate-limit.ts` (cobre `/v1/events`)
- `tests/unit/event/**`
- `tests/integration/event/**`

**Lê:**
- `apps/edge/src/lib/lead-resolver.ts`
- `apps/edge/src/lib/lead-token.ts`
- `apps/edge/src/lib/page.ts`
- `apps/edge/src/lib/attribution.ts`

## 13. Dependências permitidas / proibidas

**Permitidas:** `MOD-WORKSPACE`, `MOD-LAUNCH`, `MOD-PAGE`, `MOD-IDENTITY`, `MOD-ATTRIBUTION`, `MOD-AUDIT`.
**Proibidas:** `MOD-DISPATCH` (consome MOD-EVENT, não o contrário).

## 14. Test harness

- `tests/unit/event/clamp.test.ts` — INV-EVENT-002 com matriz de offsets.
- `tests/unit/event/zod-rejects-pii-in-user-data.test.ts` — INV-EVENT-004.
- `tests/unit/event/event-id-format.test.ts` — formato esperado, hashes determinísticos.
- `tests/integration/event/fast-accept-latency.test.ts` — RNF-001 em load test (1000 req/s).
- `tests/integration/event/replay-protection.test.ts` — INV-EVENT-003.
- `tests/integration/event/raw-events-durability.test.ts` — INV-EVENT-005 (kill simulation).
- `tests/integration/event/processor-creates-dispatch-jobs.test.ts` — pipeline E2E sem dispatcher real.
