# 09 — Module boundaries e regra de paralelização

## Princípio

Cada arquivo do repositório pertence a **exatamente um módulo**. Subagent não edita fora do módulo da sua T-ID. Mudança em interface entre módulos é **breaking change** que exige ADR.

## Ownership matrix

(Versão consolidada em [`80-roadmap/97-ownership-matrix.md`](../80-roadmap/97-ownership-matrix.md) — Fase 7. Aqui é overview por módulo.)

| Módulo | Caminhos de código que possui |
|---|---|
| MOD-WORKSPACE | `packages/db/src/schema/workspace*.ts`, `apps/edge/src/lib/workspace.ts`, `apps/edge/src/lib/api-key.ts`, `apps/edge/src/middleware/auth-api-key.ts` |
| MOD-LAUNCH | `packages/db/src/schema/launch.ts`, `apps/edge/src/lib/launch.ts` |
| MOD-PAGE | `packages/db/src/schema/page*.ts`, `apps/edge/src/lib/page.ts`, `apps/edge/src/lib/page-token.ts`, `apps/edge/src/middleware/auth-public-token.ts`, `apps/edge/src/middleware/cors.ts` |
| MOD-IDENTITY | `packages/db/src/schema/lead*.ts`, `apps/edge/src/lib/lead-resolver.ts`, `apps/edge/src/lib/lead-token.ts`, `apps/edge/src/lib/pii.ts`, `apps/edge/src/lib/consent.ts`, `apps/edge/src/lib/cookies.ts`, `apps/edge/src/routes/admin/leads-erase.ts`, `apps/edge/src/lib/erasure.ts` |
| MOD-EVENT | `packages/db/src/schema/event.ts`, `packages/db/src/schema/raw_event.ts`, `apps/edge/src/routes/events.ts`, `apps/edge/src/routes/lead.ts`, `apps/edge/src/lib/raw-events-processor.ts`, `apps/edge/src/lib/event-time-clamp.ts`, `apps/edge/src/lib/replay-protection.ts`, `apps/edge/src/middleware/rate-limit.ts` |
| MOD-FUNNEL | `packages/db/src/schema/lead_stage.ts`, `apps/edge/src/lib/funnel.ts` |
| MOD-ATTRIBUTION | `packages/db/src/schema/link*.ts`, `packages/db/src/schema/lead_attribution.ts`, `apps/edge/src/lib/attribution.ts`, `apps/edge/src/routes/redirect.ts` |
| MOD-DISPATCH | `packages/db/src/schema/dispatch_*.ts`, `apps/edge/src/lib/dispatch.ts`, `apps/edge/src/lib/idempotency.ts`, `apps/edge/src/dispatchers/index.ts` |
| MOD-AUDIENCE | `packages/db/src/schema/audience*.ts`, `apps/edge/src/dispatchers/audience-sync/**`, `apps/edge/src/crons/audience-sync.ts` |
| MOD-COST | `packages/db/src/schema/ad_spend_daily.ts`, `apps/edge/src/crons/cost-ingestor.ts`, `apps/edge/src/lib/fx.ts`, `apps/edge/src/integrations/{meta-insights,google-ads-reporting,fx-rates}/**` |
| MOD-ENGAGEMENT | `packages/db/src/schema/{lead_survey_response,lead_icp_score,webinar_attendance}.ts`, `apps/edge/src/lib/engagement.ts`, `apps/edge/src/routes/webhooks/{typeform,tally,webinarjam}.ts` |
| MOD-AUDIT | `packages/db/src/schema/audit_log.ts`, `apps/edge/src/lib/audit.ts`, `apps/edge/src/crons/retention-purge.ts` |
| MOD-TRACKER | `apps/tracker/**` |

Caminhos compartilhados (todos podem ler, raros editam):
- `packages/shared/src/contracts/**` — edição **serial** (ADR + ondas isoladas).
- `apps/edge/src/index.ts` — entry point; mudanças coordenadas.
- `wrangler.toml` — config; OPERATOR.

## Interfaces públicas entre módulos

Detalhe em [`30-contracts/07-module-interfaces.md`](../30-contracts/07-module-interfaces.md).

Mudança em interface = breaking change = ADR + atualizar consumidores no mesmo PR (ou `[SYNC-PENDING]` em MEMORY.md).

## Regra de paralelização

Resumo (detalhe em [`90-meta/05-subagent-playbook.md`](../90-meta/05-subagent-playbook.md)):

1. **Onda** = 3-5 T-IDs com `parallel-safe=yes` + ownership disjunto.
2. **Mudança em `30-contracts/`** = sempre `parallel-safe=no`, sozinha na onda.
3. **Após onda**: `pnpm typecheck && pnpm lint && pnpm test` antes de avançar.

## Dependências permitidas

```
MOD-WORKSPACE (folha)
   ↑
MOD-LAUNCH ─────────► MOD-PAGE
                          ↑
   MOD-IDENTITY ◄── MOD-EVENT ◄── MOD-FUNNEL
        ↑                 ↑
        │                 │
   MOD-ATTRIBUTION ───────┘
        ↑
   MOD-DISPATCH ◄── MOD-AUDIENCE
   
   MOD-COST ──► (analytics layer)
   MOD-ENGAGEMENT ──► MOD-IDENTITY, MOD-FUNNEL
   
   MOD-AUDIT ── (cross-cutting, todos consomem)
   MOD-TRACKER ── (cliente, consome contratos públicos)
```

## Dependências proibidas

- **Circular** — qualquer ciclo é proibido. Detecção via análise estática de imports.
- **Cross-tenant** — código não pode hardcodar workspace_id.
- **Pular camadas** — Edge `routes/` não chama dispatcher direto; passa por `lib/`.
- **DB direto fora de schema layer** — `apps/edge/src/lib/` e dispatchers usam Drizzle; routes não.

## Quando duas T-IDs precisam editar o mesmo arquivo

Cenários:
1. **Mudança em `30-contracts/`**: vira T-ID `parallel-safe=no` única na onda. Todos consumidores se adaptam em ondas seguintes.
2. **Refactor cross-módulo**: criar T-ID coordenadora + sub-T-IDs em sequência (depends-on).
3. **Bug fix em arquivo de outro módulo**: criar T-ID separada e atribuir ao subagent dono daquele módulo.

## Conflito de ownership

Se T-ID precisa editar fora do ownership declarado:
1. Subagent **DEVE** parar e escalar (não força edit).
2. Registrar OQ ou criar nova T-ID para o módulo afetado.
3. Coordenar com humano se trade-off é grande.

Esse é o ponto onde paralelização pode quebrar — disciplina de ownership é essencial.

## Conformidade — verificação

- CI valida que não há imports cross-módulo proibidos (lint rule custom).
- Code review checa ownership declarado em PR description.
- `globaltracker-br-auditor` subagent revisa pré-merge.
