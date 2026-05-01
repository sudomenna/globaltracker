# 98 — Test matrix by sprint

> Mapeia T-ID → tipo de teste → BR coberta. Garante que cada T-ID tem teste planejado.

## Sprint 0 (Foundations)

Sprint 0 é setup; testes mínimos.

| T-ID | Test type | Cobre |
|---|---|---|
| T-0-001 | Smoke (`pnpm install` + build) | — |
| T-0-004 | Smoke (`/health` retorna 200) | — |
| T-0-006 | CI rodando | — |

## Sprint 1 (Fundação de dados e contratos)

| T-ID | MOD | Unit | Integration | E2E | BR coberta |
|---|---|---|---|---|---|
| T-1-001 | MOD-WORKSPACE | derive-crypto-key | RLS, lifecycle, owner-uniqueness | — | INV-WORKSPACE-001..005 |
| T-1-002 | MOD-LAUNCH | transitions | timezone, archived-rejects-ingestion | — | INV-LAUNCH-001..005 |
| T-1-003 | MOD-PAGE | event-config-schema | token-rotation-overlap, origin-validation, revoked-token | — | INV-PAGE-001..007 |
| T-1-004 | MOD-IDENTITY | hash-normalization, lead-resolver-{no-match,single-match,merge}, pii-encryption, lead-token-hmac, pii-key-rotation | erasure, merge-fk-update, lead-token-page-binding | — | BR-IDENTITY-001..006, BR-PRIVACY-002/003/004 |
| T-1-005 | MOD-EVENT | clamp, zod-rejects-pii-in-user-data, event-id-format | replay-protection, raw-events-durability, processor-creates-dispatch-jobs | — | BR-EVENT-001..006 |
| T-1-006 | MOD-FUNNEL | — | unique-non-recurring, recurring-allows-multiple, cross-launch-isolation | — | INV-FUNNEL-001..004 |
| T-1-007 | MOD-ATTRIBUTION | first-touch-once-per-launch, last-touch-updates | redirect-async-log, click-id-propagation | — | BR-ATTRIBUTION-001..004 |
| T-1-008 | MOD-DISPATCH | idempotency-key, backoff-jitter, skip-reason-required | at-least-once-lock, dead-letter-flow | — | BR-DISPATCH-001..005 |
| T-1-009 | MOD-AUDIENCE | dsl-zod-validation, diff-calculation | lock-concurrent-syncs, disabled-not-eligible-no-api-call, snapshot-retention, consent-filter | — | BR-AUDIENCE-001..004 |
| T-1-010 | MOD-COST | fx-normalization, granularity-coalesce | cron-idempotency, retroactive-reprocess | — | BR-COST-001..003 |
| T-1-011 | MOD-ENGAGEMENT | score-versioning | webinar-upsert, icp-creates-stage | — | INV-ENGAGEMENT-001..005 |
| T-1-012 | MOD-AUDIT | sanitize-request-context | no-update-no-delete, pii-decrypt-logged, cross-cutting-mutations-logged, retention-purge | — | BR-AUDIT-001..004 |
| T-1-013 | shared lib | (incluído em T-1-004 e T-1-005) | — | — | BR-PRIVACY-002..004, BR-EVENT-002..004 |
| T-1-014 | MOD-IDENTITY | (incluído em T-1-004) | — | — | BR-IDENTITY-005 |
| T-1-015 | middleware | — | rls.test.ts | — | BR-RBAC-001, BR-PRIVACY-001 |
| T-1-016..T-1-020 | routes | — | smoke + auth/CORS/rate-limit | — | — |
| T-1-021 | E2E | — | — | smoke-fase-1 | — |
| T-1-022 | load test | — | — | events-fast-accept (k6) | RNF-001 |

## Sprints 2-8 (skeleton)

A detalhar quando cada sprint for iniciado. Princípio: cada T-ID com BR/INV referenciada gera entry nesta matriz.

## Cobertura agregada por BR

(Atualizado a cada PR; gerado por script.)

| BR | T-IDs que cobrem | Status |
|---|---|---|
| BR-IDENTITY-001 | T-1-004 | planejado |
| BR-IDENTITY-002 | T-1-004 | planejado |
| BR-IDENTITY-003 | T-1-004 | planejado |
| BR-IDENTITY-004 | T-1-004, T-2-007 | planejado |
| BR-IDENTITY-005 | T-1-004, T-1-014, T-2-008, T-2-010 | planejado |
| BR-IDENTITY-006 | T-1-004 (parcial), T-1-020 | planejado |
| BR-PRIVACY-001 | T-1-005 (Zod), T-1-015 (logs) | planejado |
| BR-PRIVACY-002..005 | T-1-004, T-1-013, T-1-020 | planejado |
| BR-CONSENT-001..004 | T-1-005 (snapshot), T-1-013 (helper), T-2-008 (cookie+consent) | planejado |
| BR-EVENT-001..006 | T-1-005, T-1-013, T-1-017 | planejado |
| BR-DISPATCH-001..005 | T-1-008, T-3-001..009 | planejado |
| BR-ATTRIBUTION-001..004 | T-1-007, T-1-019 | planejado |
| BR-AUDIENCE-001..004 | T-1-009, T-5-001..005 | planejado |
| BR-COST-001..003 | T-1-010, T-4-001..003 | planejado |
| BR-WEBHOOK-001..004 | T-3-004..006 | planejado |
| BR-RBAC-001..006 | T-1-015 (RLS), T-1-020 (SAR auth), T-6-* (Control Plane) | planejado |
| BR-AUDIT-001..004 | T-1-012, T-1-013, T-1-020 | planejado |

## Política

Toda BR sem T-ID que cubra é red flag. Auditor (br-auditor subagent) verifica antes de marcar sprint completo.
