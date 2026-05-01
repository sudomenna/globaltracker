# 20 — Domínio

Um arquivo por módulo/agregado. Cada um declara identidade, escopo, entidades, estados, invariantes, contratos consumidos/expostos e **ownership de código**.

## Mapa de módulos

| MOD | Nome humano | Tipo | Ownership |
|---|---|---|---|
| `MOD-WORKSPACE` | Workspace e configuração de tenant | Core | `apps/edge/src/lib/workspace.ts`, `packages/db/src/schema/workspace.ts` |
| `MOD-LAUNCH` | Lançamentos e tracking config | Core | `apps/edge/src/lib/launch.ts`, `packages/db/src/schema/launch.ts` |
| `MOD-PAGE` | Páginas e page tokens (rotação) | Core | `apps/edge/src/lib/page.ts`, `apps/edge/src/lib/page-token.ts`, `packages/db/src/schema/page.ts` |
| `MOD-IDENTITY` | Leads, aliases, merges, consents, lead tokens, PII | Core | `apps/edge/src/lib/lead-resolver.ts`, `apps/edge/src/lib/lead-token.ts`, `apps/edge/src/lib/pii.ts`, `packages/db/src/schema/lead.ts` |
| `MOD-EVENT` | Eventos, raw_events, ingestão, clamp, replay protection | Core | `apps/edge/src/routes/events.ts`, `apps/edge/src/lib/raw-events-processor.ts`, `apps/edge/src/lib/event-time-clamp.ts`, `packages/db/src/schema/event.ts` |
| `MOD-FUNNEL` | Lead stages e progressão de funil | Core | `apps/edge/src/lib/funnel.ts`, `packages/db/src/schema/funnel.ts` |
| `MOD-ATTRIBUTION` | Links, link_clicks, lead_attribution, redirector | Core | `apps/edge/src/routes/redirect.ts`, `apps/edge/src/lib/attribution.ts`, `packages/db/src/schema/attribution.ts` |
| `MOD-DISPATCH` | Dispatch jobs/attempts, idempotency, eligibility | Core | `apps/edge/src/dispatchers/**`, `packages/db/src/schema/dispatch.ts` |
| `MOD-AUDIENCE` | Audiences, snapshots, sync jobs | Core | `apps/edge/src/dispatchers/audience-sync.ts`, `packages/db/src/schema/audience.ts` |
| `MOD-COST` | ad_spend_daily, FX normalization | Supporting | `apps/edge/src/crons/cost-ingestor.ts`, `packages/db/src/schema/cost.ts` |
| `MOD-ENGAGEMENT` | Survey, ICP scoring, webinar attendance | Supporting | `apps/edge/src/lib/engagement.ts`, `packages/db/src/schema/engagement.ts` |
| `MOD-AUDIT` | audit_log (cross-cutting) | Supporting | `apps/edge/src/lib/audit.ts`, `packages/db/src/schema/audit.ts` |
| `MOD-TRACKER` | tracker.js (front-end) | Core | `apps/tracker/**` |

## Grafo de dependências (resumo)

```
MOD-WORKSPACE ◄── MOD-LAUNCH ◄── MOD-PAGE
                                    ▲
                                    │
MOD-IDENTITY ◄────── MOD-EVENT ─────┤
     ▲                  ▲            │
     │                  │            │
     │              MOD-FUNNEL       │
     │                  ▲            │
     │                  │            │
MOD-ATTRIBUTION ────────┘            │
     ▲                               │
     │                               │
MOD-DISPATCH ◄───── MOD-AUDIENCE     │
                                     │
MOD-COST ──────────► (analytics)     │
                                     │
MOD-ENGAGEMENT ──────────────────────┘
                                     
MOD-AUDIT ── (cross-cutting; consumido por todos)
MOD-TRACKER ── (cliente; consome contratos públicos do Edge)
```

Setas: A ◄── B significa "B depende de A".

## Regras de dependência

- `MOD-DISPATCH` consome `MOD-IDENTITY` e `MOD-EVENT` (lookup em `leads` para enriquecer payload CAPI).
- `MOD-ATTRIBUTION` consome `MOD-IDENTITY` (atualiza `lead_attribution`) e é consumido por `MOD-EVENT` (resolve atribuição no momento da ingestão).
- `MOD-AUDIT` é cross-cutting — qualquer módulo que muda configuração emite via interface `recordAuditEntry()`.
- Dependências circulares são proibidas. Se aparecerem, registrar OQ em `90-meta/03-open-questions-log.md`.
