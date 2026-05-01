# Sprint 1 — Fundação de dados e contratos (Fase 1 do rollout)

## Duração estimada
2-3 semanas.

## Objetivo do sprint
Implementar schema completo (todas tabelas), migrations versionadas, contratos Zod, Edge endpoints retornando 202 via `raw_events` (modelo fast accept — ADR-004), middleware de segurança em modo inicial, helpers críticos (PII, lead-token, idempotency, event-time-clamp). Sem ingestion processor funcional ainda — esse vem no Sprint 2.

## Pré-requisitos
- Sprint 0 completo.
- Decisões D2 (visitor_id Fase 3), D3 (lead_token Fase 2), D4 (raw_events Fase 1), D5 (Trigger.dev Fase 5) confirmadas.
- OQ-007 (lead_token stateful vs stateless) decidida — sugestão: stateful para suportar revogação SAR.

## Critério de aceite global do sprint

- [ ] Todas as tabelas em `packages/db/src/schema/` conforme `30-contracts/02-db-schema-conventions.md` e modelo de dados (Seção 11 do `planejamento.md`).
- [ ] Migrations versionadas, reversíveis (com down.sql), índices declarados.
- [ ] RLS habilitado em todas tabelas de domínio.
- [ ] Endpoints `/v1/config`, `/v1/events`, `/v1/lead`, `/r/:slug` aceitam request, validam Zod, persistem em `raw_events`, retornam 202.
- [ ] Endpoint admin `/v1/admin/leads/:id` (DELETE) stub que enfileira job placeholder.
- [ ] Middleware: token público, CORS, rate-limit (modo inicial), sanitize-logs.
- [ ] Helpers: `pii.ts`, `idempotency.ts`, `lead-token.ts`, `cookies.ts`, `event-time-clamp.ts`, `replay-protection.ts`.
- [ ] Smoke test: load test 1000 req/s confirma `/v1/events` p95 < 50ms (RNF-001).
- [ ] Cobertura tests ≥ 80% em `packages/db/`, ≥ 70% em `apps/edge/src/lib/` (alvo final 90% após Sprint 2).

## Tarefas

### T-1-001 — Schema MOD-WORKSPACE + RLS

- **Tipo:** schema
- **Módulo:** MOD-WORKSPACE
- **Subagent:** globaltracker-schema-author
- **Parallel-safe:** yes
- **Depends-on:** []
- **Ownership:** `packages/db/src/schema/{workspace,workspace_member,workspace_api_key}.ts`, migration
- **Inputs:** `docs/20-domain/01-mod-workspace.md`, `docs/30-contracts/02-db-schema-conventions.md`
- **DoD:** schema + migration + RLS policy + INV-WORKSPACE-001..005 testados.

### T-1-002 — Schema MOD-LAUNCH

- **Tipo:** schema
- **Módulo:** MOD-LAUNCH
- **Parallel-safe:** yes (após T-1-001)
- **Depends-on:** [T-1-001]
- **Ownership:** `packages/db/src/schema/launch.ts`
- **DoD:** INV-LAUNCH-001..005, FK para workspace.

### T-1-003 — Schema MOD-PAGE (com page_tokens)

- **Tipo:** schema
- **Módulo:** MOD-PAGE
- **Parallel-safe:** yes (após T-1-002)
- **Depends-on:** [T-1-002]
- **Ownership:** `packages/db/src/schema/{page,page_token}.ts`
- **DoD:** INV-PAGE-001..007, ADR-023 status enum.

### T-1-004 — Schema MOD-IDENTITY (leads + aliases + merges + consents + tokens)

- **Tipo:** schema
- **Módulo:** MOD-IDENTITY
- **Parallel-safe:** yes (após T-1-001)
- **Depends-on:** [T-1-001]
- **Ownership:** `packages/db/src/schema/{lead,lead_alias,lead_merge,lead_consent,lead_token}.ts`
- **DoD:** **SEM** unique constraints em `leads.email_hash`/`phone_hash` (ADR-005); unique parcial em `lead_aliases where status='active'`; INV-IDENTITY-001..007.

### T-1-005 — Schema MOD-EVENT (events + raw_events)

- **Tipo:** schema
- **Módulo:** MOD-EVENT
- **Parallel-safe:** yes (após T-1-001 a T-1-004)
- **Depends-on:** [T-1-001, T-1-002, T-1-003, T-1-004]
- **Ownership:** `packages/db/src/schema/{event,raw_event}.ts`
- **DoD:** unique `(workspace_id, event_id)`, particionamento por `received_at`, INV-EVENT-001 a 007.

### T-1-006 — Schema MOD-FUNNEL (lead_stages com unique parcial)

- **Tipo:** schema
- **Módulo:** MOD-FUNNEL
- **Parallel-safe:** yes (após T-1-004)
- **Depends-on:** [T-1-004]
- **Ownership:** `packages/db/src/schema/lead_stage.ts`

### T-1-007 — Schema MOD-ATTRIBUTION

- **Tipo:** schema
- **Módulo:** MOD-ATTRIBUTION
- **Parallel-safe:** yes (após T-1-002, T-1-004)
- **Ownership:** `packages/db/src/schema/{link,link_click,lead_attribution}.ts`

### T-1-008 — Schema MOD-DISPATCH

- **Tipo:** schema
- **Módulo:** MOD-DISPATCH
- **Parallel-safe:** yes (após T-1-005)
- **Ownership:** `packages/db/src/schema/{dispatch_job,dispatch_attempt}.ts`

### T-1-009 — Schema MOD-AUDIENCE (com snapshots)

- **Tipo:** schema
- **Módulo:** MOD-AUDIENCE
- **Parallel-safe:** yes (após T-1-004)
- **Ownership:** `packages/db/src/schema/{audience,audience_snapshot,audience_snapshot_member,audience_sync_job}.ts`

### T-1-010 — Schema MOD-COST (com FX)

- **Tipo:** schema
- **Módulo:** MOD-COST
- **Parallel-safe:** yes (após T-1-001)
- **Ownership:** `packages/db/src/schema/ad_spend_daily.ts`
- **DoD:** unique key conforme ADR-cost (sem timezone, com granularity), `spend_cents_normalized` populado em test.

### T-1-011 — Schema MOD-ENGAGEMENT

- **Tipo:** schema
- **Módulo:** MOD-ENGAGEMENT
- **Parallel-safe:** yes (após T-1-004)
- **Ownership:** `packages/db/src/schema/{lead_survey_response,lead_icp_score,webinar_attendance}.ts`

### T-1-012 — Schema MOD-AUDIT (audit_log com trigger no-update)

- **Tipo:** schema
- **Módulo:** MOD-AUDIT
- **Parallel-safe:** yes (após T-1-001)
- **Ownership:** `packages/db/src/schema/audit_log.ts` + migration com trigger BEFORE UPDATE/DELETE
- **DoD:** INV-AUDIT-001 testada (UPDATE manual falha).

### T-1-013 — Helpers críticos: PII, idempotency, event-time-clamp

- **Tipo:** domain
- **Módulo:** múltiplos (lib compartilhado)
- **Parallel-safe:** yes (após T-1-001, T-1-002 — usa workspace para HKDF)
- **Depends-on:** [T-1-001]
- **Ownership:** `apps/edge/src/lib/{pii,idempotency,event-time-clamp,replay-protection}.ts`
- **DoD:** unit tests cobrindo BR-PRIVACY-002/003/004, BR-EVENT-002/003/004; cobertura ≥ 95%.

### T-1-014 — Helpers: lead-token (HMAC) + cookies

- **Tipo:** domain
- **Módulo:** MOD-IDENTITY
- **Parallel-safe:** yes (após T-1-013)
- **Ownership:** `apps/edge/src/lib/{lead-token,cookies}.ts`
- **DoD:** unit tests cobrindo BR-IDENTITY-005, INV-IDENTITY-006.

### T-1-015 — Middleware: auth-public-token, CORS, rate-limit, sanitize-logs

- **Tipo:** edge
- **Módulo:** MOD-PAGE (token), MOD-EVENT (rate)
- **Parallel-safe:** yes (após T-1-003, T-1-013)
- **Ownership:** `apps/edge/src/middleware/{auth-public-token,cors,rate-limit,sanitize-logs}.ts`
- **DoD:** integration tests cobrindo INV-PAGE-007, BR-PRIVACY-001 (zero PII em logs).

### T-1-016 — Endpoint `/v1/config` completo

- **Tipo:** edge
- **Módulo:** MOD-PAGE
- **Parallel-safe:** yes (após T-1-015)
- **Ownership:** `apps/edge/src/routes/config.ts`
- **DoD:** retorna 200 com `event_config`; KV cache 60s + ETag; testes para 401/403/404.

### T-1-017 — Endpoint `/v1/events` modo fast accept

- **Tipo:** edge
- **Módulo:** MOD-EVENT
- **Parallel-safe:** yes (após T-1-014, T-1-015)
- **Ownership:** `apps/edge/src/routes/events.ts`
- **DoD:** valida Zod + clamp + replay protection + insere `raw_events` + 202; load test p95 < 50ms.

### T-1-018 — Endpoint `/v1/lead` modo fast accept

- **Tipo:** edge
- **Módulo:** MOD-EVENT (entry) + MOD-IDENTITY (lead emission downstream)
- **Parallel-safe:** yes (após T-1-014, T-1-015)
- **Ownership:** `apps/edge/src/routes/lead.ts`
- **DoD:** retorna 202 com `lead_token` placeholder + `Set-Cookie: __ftk` quando consent OK.

### T-1-019 — Endpoint `/r/:slug` redirector

- **Tipo:** edge
- **Módulo:** MOD-ATTRIBUTION
- **Parallel-safe:** yes (após T-1-007)
- **Ownership:** `apps/edge/src/routes/redirect.ts`
- **DoD:** 302 em < 50ms p95; `recordLinkClick` async.

### T-1-020 — Endpoint admin SAR stub

- **Tipo:** edge
- **Módulo:** MOD-IDENTITY
- **Parallel-safe:** yes (após T-1-004, T-1-012)
- **Ownership:** `apps/edge/src/routes/admin/leads-erase.ts`
- **DoD:** valida X-Confirm-Erase header, enqueue job placeholder, retorna 202; audit log entry.

### T-1-021 — Smoke test E2E em wrangler dev

- **Tipo:** test
- **Módulo:** raiz
- **Parallel-safe:** yes (após T-1-016 a T-1-020)
- **Ownership:** `tests/e2e/smoke-fase-1.spec.ts`
- **DoD:** sequência: criar workspace → criar launch → criar page (manual SQL no test) → request `/v1/config` → 200; request `/v1/events` → 202; request `/v1/lead` → 202 com `Set-Cookie`.

### T-1-022 — Load test RNF-001

- **Tipo:** test
- **Módulo:** MOD-EVENT
- **Parallel-safe:** yes (após T-1-021)
- **Ownership:** `tests/load/events-fast-accept.ts` (k6 ou similar)
- **DoD:** 1000 req/s sustentados por 1min; p95 < 50ms; zero erros 5xx; nenhum evento perdido.

## Ondas de paralelização

| Onda | T-IDs | Bloqueio |
|---|---|---|
| 1 | T-1-001 | — |
| 2 | T-1-002, T-1-004, T-1-010, T-1-012 (paralelas) | T-1-001 |
| 3 | T-1-003, T-1-006, T-1-007, T-1-009, T-1-011, T-1-013 | onda 2 |
| 4 | T-1-005, T-1-008, T-1-014 | onda 3 |
| 5 | T-1-015 | T-1-013, T-1-014 |
| 6 | T-1-016, T-1-017, T-1-018, T-1-019, T-1-020 (paralelas) | T-1-015 + onda 4 |
| 7 | T-1-021, T-1-022 (sequenciais) | onda 6 |

Total ondas: 7. Algumas T-IDs podem migrar entre ondas se ownership permitir.
