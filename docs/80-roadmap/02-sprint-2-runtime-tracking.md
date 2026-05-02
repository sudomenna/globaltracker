# Sprint 2 — Runtime de tracking confiável (parte A da Fase 2)

## Duração estimada
2-3 semanas.

## Objetivo
Tracker.js v0 + ingestion processor funcional + emissão real de `lead_token` + cookie `__ftk` + reidentificação em retornos.

## Pré-requisitos
- Sprint 1 completo (schema + endpoints fast accept funcionais). ✓
- OQ-004 (Turnstile vs honeypot) decidida → ADR-024: Cloudflare Turnstile. ✓

## Critério de aceite global

- [x] `tracker.js` build < 15 KB gz; instalação manual em LP de teste.
- [ ] Ingestion processor consome `raw_events`, normaliza, cria `events` + `lead_attribution` + `lead_stages` + `dispatch_jobs`.
- [ ] `lead_token` real emitido por `/v1/lead`; cookie `__ftk` setado e lido.
- [ ] FLOW-07 (lead retornante) E2E verde — Meta CAPI dispatch enriquecido server-side.
- [ ] Lead merge automático em FLOW-08 testado.
- [x] Bot mitigation ativa em `/v1/lead` (Turnstile — ADR-024).

---

## Onda 1 — Fundação paralela ✅ (commit c4adb3f, 2026-05-02)

**Typecheck ✓ | Lint ✓ | 329 testes ✓**

### T-2-001 — tracker.js: estrutura do pacote + init

- **Tipo:** tracker
- **Módulo:** MOD-TRACKER
- **Subagent:** globaltracker-tracker-author
- **Parallel-safe:** yes
- **Depends-on:** []
- **Ownership:** `apps/tracker/` (pacote novo)
- **DoD:** pacote `@gt/tracker` criado; entry `src/index.ts` expõe `window.Funil`; estado `loading → initialized → ready`; busca `/v1/config`; degrada silenciosamente em falha (INV-TRACKER-007).
- **Status:** ✅ COMPLETO

### T-2-002 — tracker.js: captura de cookies e attribution params

- **Tipo:** tracker
- **Módulo:** MOD-TRACKER
- **Subagent:** globaltracker-tracker-author
- **Parallel-safe:** yes (mesma onda que T-2-001, mesmo subagent)
- **Depends-on:** [T-2-001]
- **Ownership:** `apps/tracker/src/cookies.ts`, `apps/tracker/src/storage.ts`
- **DoD:** captura `_gcl_au`, `_ga`, `fbc`, `fbp`; lê `__ftk` (nunca cria — INV-TRACKER-004); persiste UTMs/click IDs em localStorage `__funil_attr`; testes INV-TRACKER-003, INV-TRACKER-004.
- **Status:** ✅ COMPLETO

### T-2-003 — tracker.js: decorate

- **Tipo:** tracker
- **Módulo:** MOD-TRACKER
- **Subagent:** globaltracker-tracker-author
- **Parallel-safe:** yes (mesma onda, mesmo subagent)
- **Depends-on:** [T-2-001]
- **Ownership:** `apps/tracker/src/decorate.ts`
- **DoD:** `Funil.decorate(selectorOrElement)` propaga attribution params + `lead_public_id` como query params em links de checkout; testes de propagação de UTMs.
- **Status:** ✅ COMPLETO

### T-2-007 — lead-resolver com merge + attribution + consent

- **Tipo:** domain
- **Módulo:** MOD-IDENTITY, MOD-ATTRIBUTION
- **Subagent:** globaltracker-domain-author
- **Parallel-safe:** yes (ownership disjunto de T-2-001..003 e T-2-009)
- **Depends-on:** []
- **Ownership:** `apps/edge/src/lib/lead-resolver.ts`, `apps/edge/src/lib/attribution.ts`, `apps/edge/src/lib/consent.ts`
- **DoD:** `resolveLeadByAliases()` com merge canônico (0/1/N matches); `recordTouches()` first/last/all; `createLeadConsent()` + `getLatestConsent()`; BRs BR-IDENTITY-001/002/003, BR-ATTRIBUTION-001/002 citadas; testes unitários e integração.
- **Status:** ✅ COMPLETO

### T-2-009 — bot mitigation: Turnstile em /v1/lead

- **Tipo:** edge
- **Módulo:** MOD-IDENTITY (endpoint `/v1/lead`)
- **Subagent:** globaltracker-edge-author
- **Parallel-safe:** yes (ownership disjunto de T-2-001..003 e T-2-007)
- **Depends-on:** []
- **Ownership:** `apps/edge/src/middleware/turnstile.ts`, `apps/edge/src/routes/lead.ts` (update), `apps/edge/src/routes/schemas/lead-payload.ts` (update), `apps/edge/wrangler.toml` (binding)
- **DoD:** middleware `verifyTurnstileToken`; bypass em `ENVIRONMENT=development`; 403 `bot_detected` sem token válido em prod; ADR-024 implementado; `TURNSTILE_SECRET_KEY` declarado em wrangler.toml.
- **Status:** ✅ COMPLETO

---

## Onda 2 — Pipeline real

**Depends-on:** Onda 1 completa.

### T-2-004 — tracker.js: identify

- **Tipo:** tracker
- **Módulo:** MOD-TRACKER
- **Subagent:** globaltracker-tracker-author
- **Parallel-safe:** yes
- **Depends-on:** [T-2-001]
- **Ownership:** `apps/tracker/src/index.ts` (update), `apps/tracker/src/state.ts` (update)
- **DoD:** `Funil.identify({lead_token})` armazena token em state; INV-TRACKER-008 (recusa `lead_id` em claro); testes.

### T-2-005 — tracker.js: page (PageView)

- **Tipo:** tracker
- **Módulo:** MOD-TRACKER
- **Subagent:** globaltracker-tracker-author
- **Parallel-safe:** yes (mesmo subagent que T-2-004)
- **Depends-on:** [T-2-001]
- **Ownership:** `apps/tracker/src/index.ts` (update), `apps/tracker/src/api-client.ts` (update)
- **DoD:** `Funil.page()` envia PageView a `/v1/events` com attribution params + `lead_token` se disponível; auto-disparo no init se `event_config.auto_pageview === true`.

### T-2-011 — tracker.js: pixel-coexist policy enforcement

- **Tipo:** tracker
- **Módulo:** MOD-TRACKER
- **Subagent:** globaltracker-tracker-author
- **Parallel-safe:** yes (mesmo subagent)
- **Depends-on:** [T-2-001, T-2-005]
- **Ownership:** `apps/tracker/src/pixel-coexist.ts` (novo)
- **DoD:** quando `pixel_policy === 'browser_and_server_managed'`, garantir mesmo `event_id` no Pixel browser e CAPI server (INV-TRACKER-006); testes `pixel-coexist.test.ts`.

### T-2-006 — ingestion processor real

- **Tipo:** domain
- **Módulo:** MOD-EVENT
- **Subagent:** globaltracker-domain-author
- **Parallel-safe:** yes (ownership disjunto de T-2-004..011)
- **Depends-on:** [T-2-007]
- **Ownership:** `apps/edge/src/lib/raw-events-processor.ts` (novo)
- **DoD:** CF Queue consumer lê `raw_events` com `status='pending'`; chama `resolveLeadByAliases()`, `recordTouches()`, cria `events` + `lead_stages` + `dispatch_jobs`; marca `raw_events.processing_status='processed'`; idempotência via `event_id`; testes de integração.
- **BRs:** BR-EVENT-001, BR-EVENT-002, BR-IDENTITY-003.
- **INVs:** INV-EVENT-001 (dedup), INV-EVENT-003 (replay), INV-EVENT-007 (lead_token → lead_id resolvido).

### T-2-008 + T-2-010 — lead_token real + middleware validação

- **Tipo:** edge (+ domain para extend lead-token.ts)
- **Módulo:** MOD-IDENTITY
- **Subagent:** globaltracker-edge-author
- **Parallel-safe:** yes (ownership disjunto de tracker e T-2-006)
- **Depends-on:** [T-2-007]
- **Ownership:** `apps/edge/src/lib/lead-token.ts` (extend: `issueLeadToken()`), `apps/edge/src/routes/lead.ts` (update: chamar issueLeadToken + Set-Cookie `__ftk`), `apps/edge/src/middleware/lead-token-validate.ts` (novo)
- **DoD (T-2-008):** `issueLeadToken(lead_id, page_token_hash, ttl_days, db)` cria row em `lead_tokens`; `/v1/lead` chama após `resolveLeadByAliases()`; `Set-Cookie: __ftk` emitido se `consent.functional === true`; token retornado no body.
- **DoD (T-2-010):** middleware `validateLeadTokenMiddleware` lê `__ftk` do cookie, chama `validateLeadToken()`, injeta `lead_id` no context Hono; aplica em `/v1/events`.
- **BRs:** BR-IDENTITY-005, INV-IDENTITY-006 (page_token_hash binding).

---

## Onda 3 — E2E verde

**Depends-on:** Onda 2 completa + typecheck/lint/test verdes.

### T-2-012 — E2E FLOW-02, FLOW-07, FLOW-08

- **Tipo:** test
- **Módulo:** MOD-EVENT, MOD-IDENTITY, MOD-ATTRIBUTION
- **Subagent:** globaltracker-test-author
- **Parallel-safe:** yes (isolado)
- **Depends-on:** [T-2-004, T-2-005, T-2-006, T-2-008, T-2-010]
- **Ownership:** `tests/integration/e2e/` (ou `tests/e2e/`)
- **DoD:**
  - FLOW-02: captura lead via `/v1/lead` → ingestion processor → `events` + `lead_attribution` + `dispatch_jobs` criados.
  - FLOW-07: lead retornante com `__ftk` válido → evento com `lead_id` resolvido via token.
  - FLOW-08: dois leads com mesmo email convergem → merge automático; aliases movidos para canonical.
- **Critério global do sprint:** todos os 3 flows verdes no ambiente de integração.

---

## Notas de implementação

- **T-2-006 (processor) não chama dispatcher real** — cria `dispatch_jobs` com `status='pending'` e encerra. O dispatcher real vem no Sprint 3.
- **`apps/tracker/` já existe** após Onda 1 — Onda 2 apenas adiciona módulos ao pacote existente.
- **`issueLeadToken` em T-2-008** precisa de `page_token_hash`: leia da `lead_tokens` spec em `docs/20-domain/04-mod-identity.md §3` para o binding correto.
- **Honeypot** (campo `<input name="website" style="display:none">`) está no backlog para sprint posterior — não implementar aqui (ADR-024).
