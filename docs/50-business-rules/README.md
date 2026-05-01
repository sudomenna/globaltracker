# 50 — Business Rules

BRs como contratos executáveis. Cada arquivo agrupa regras de um domínio.

| Arquivo | Domínio |
|---|---|
| `BR-IDENTITY.md` | Resolução de leads, aliases, merge |
| `BR-PRIVACY.md` | PII, consent, retenção, erasure (LGPD/GDPR) |
| `BR-CONSENT.md` | Política de consent por finalidade e bloqueios de dispatch |
| `BR-EVENT.md` | Ingestão, idempotência, replay, clamp de event_time |
| `BR-DISPATCH.md` | Eligibility, retry, DLQ, idempotency_key |
| `BR-ATTRIBUTION.md` | First-touch / last-touch, propagação de identidade |
| `BR-AUDIENCE.md` | Snapshot, diff, consent policy, locks |
| `BR-COST.md` | Currency normalization (FX), granularity, retroatividade |
| `BR-WEBHOOK.md` | Signature, idempotência, association priority |
| `BR-RBAC.md` | Permissões e autorização (AUTHZ-*) |
| `BR-AUDIT.md` | O que auditar, retenção 7 anos |

## Formato obrigatório

Cada BR tem:
- ID `BR-<DOMAIN>-<NUM>` único.
- Enunciado em **uma frase imperativa** ("DEVE", "NÃO PODE").
- Motivação (link para OBJ-* ou risco).
- Camada de enforcement (DB constraint / trigger / função pura / UI).
- Aplica-se a (MOD-*, FLOW-*, SCREEN-*).
- Critérios de aceite em Gherkin (mín. 1 happy path + 2 edge cases).
- Mensagem de erro recomendada.
- Snippet de citação em código (`// BR-XXX-001: razão curta`).
