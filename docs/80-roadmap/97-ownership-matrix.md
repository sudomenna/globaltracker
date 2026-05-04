# 97 — Ownership matrix

> Consolidação de paths editáveis por módulo. Subagent não edita fora do seu módulo.

## Princípio

Cada arquivo do repositório pertence a exatamente um módulo. Detalhe por módulo em `20-domain/<NN>-mod-<name>.md` § 12.

## Matriz consolidada

| Path glob | Módulo dono | Permite leitura por |
|---|---|---|
| `packages/db/src/schema/workspace*.ts` | MOD-WORKSPACE | qualquer |
| `packages/db/src/schema/launch.ts` | MOD-LAUNCH | qualquer |
| `packages/db/src/schema/page*.ts` | MOD-PAGE | qualquer |
| `packages/db/src/schema/lead*.ts` | MOD-IDENTITY | qualquer |
| `packages/db/src/schema/{event,raw_event}.ts` | MOD-EVENT | qualquer |
| `packages/db/src/schema/lead_stage.ts` | MOD-FUNNEL | qualquer |
| `packages/db/src/schema/funnel_template.ts` | MOD-FUNNEL | qualquer |
| `packages/db/src/schema/{link,link_click,lead_attribution}.ts` | MOD-ATTRIBUTION | qualquer |
| `packages/db/src/schema/dispatch_*.ts` | MOD-DISPATCH | qualquer |
| `packages/db/src/schema/audience*.ts` | MOD-AUDIENCE | qualquer |
| `packages/db/src/schema/ad_spend_daily.ts` | MOD-COST | qualquer |
| `packages/db/src/schema/{lead_survey_response,lead_icp_score,webinar_attendance}.ts` | MOD-ENGAGEMENT | qualquer |
| `packages/db/src/schema/audit_log.ts` | MOD-AUDIT | qualquer |
| `packages/db/migrations/**` | módulo cuja migration está sendo aplicada | qualquer |
| `packages/db/views.sql` | shared (operator + analytics owner) | qualquer |
| `apps/edge/src/routes/events.ts` | MOD-EVENT | qualquer |
| `apps/edge/src/routes/lead.ts` | MOD-IDENTITY (por foco principal) | MOD-EVENT (read) |
| `apps/edge/src/routes/config.ts` | MOD-PAGE | qualquer |
| `apps/edge/src/routes/redirect.ts` | MOD-ATTRIBUTION | qualquer |
| `apps/edge/src/routes/admin/leads-erase.ts` | MOD-IDENTITY | qualquer |
| `apps/edge/src/routes/webhooks/<provider>.ts` | adapter owner (geralmente assigned ao módulo que recebe — ex.: hotmart → MOD-EVENT/MOD-IDENTITY) | qualquer |
| `apps/edge/src/lib/workspace.ts`, `api-key.ts` | MOD-WORKSPACE | qualquer |
| `apps/edge/src/lib/launch.ts` | MOD-LAUNCH | qualquer |
| `apps/edge/src/lib/{page,page-token}.ts` | MOD-PAGE | qualquer |
| `apps/edge/src/lib/{lead-resolver,lead-token,pii,consent,cookies,erasure}.ts` | MOD-IDENTITY | qualquer |
| `apps/edge/src/lib/{raw-events-processor,event-time-clamp,replay-protection}.ts` | MOD-EVENT | qualquer |
| `apps/edge/src/lib/funnel.ts` | MOD-FUNNEL | qualquer |
| `apps/edge/src/lib/funnel-scaffolder.ts` | MOD-FUNNEL | qualquer |
| `apps/edge/src/lib/guru-launch-resolver.ts` | MOD-FUNNEL | qualquer |
| `apps/edge/src/routes/funnel-templates.ts` | MOD-FUNNEL | qualquer |
| `apps/edge/src/routes/workspace-config.ts` | MOD-WORKSPACE | qualquer |
| `packages/shared/src/schemas/funnel-blueprint.ts` | MOD-FUNNEL | qualquer |
| `apps/control-plane/src/lib/page-role-defaults.ts` | MOD-PAGE | qualquer |
| `apps/control-plane/src/app/(app)/launches/[id]/funnel/**` | MOD-FUNNEL | qualquer |
| `apps/edge/src/lib/attribution.ts` | MOD-ATTRIBUTION | qualquer |
| `apps/edge/src/lib/{dispatch,idempotency}.ts` | MOD-DISPATCH | qualquer |
| `apps/edge/src/lib/fx.ts` | MOD-COST | qualquer |
| `apps/edge/src/lib/engagement.ts` | MOD-ENGAGEMENT | qualquer |
| `apps/edge/src/lib/audit.ts` | MOD-AUDIT | qualquer |
| `apps/edge/src/middleware/auth-public-token.ts` | MOD-PAGE | qualquer |
| `apps/edge/src/middleware/auth-api-key.ts` | MOD-WORKSPACE | qualquer |
| `apps/edge/src/middleware/cors.ts` | MOD-PAGE | qualquer |
| `apps/edge/src/middleware/rate-limit.ts` | MOD-EVENT (também usado por outros) | qualquer |
| `apps/edge/src/middleware/sanitize-logs.ts` | MOD-AUDIT (cross-cutting) | qualquer |
| `apps/edge/src/dispatchers/meta-capi/**` | MOD-DISPATCH (com Meta como provider) | qualquer |
| `apps/edge/src/dispatchers/{ga4-mp,google-ads-conversion,google-enhanced-conversions}/**` | MOD-DISPATCH | qualquer |
| `apps/edge/src/dispatchers/audience-sync/**` | MOD-AUDIENCE | qualquer |
| `apps/edge/src/integrations/<provider>/**` | adapter owner | qualquer |
| `apps/edge/src/crons/**` | varia por cron (cost → MOD-COST; audience → MOD-AUDIENCE; retention → MOD-AUDIT) | qualquer |
| `apps/tracker/**` | MOD-TRACKER | qualquer |
| `apps/control-plane/**` (Fase 4) | varia por feature (organizar por módulo: `apps/control-plane/app/(app)/launches/` → MOD-LAUNCH) | qualquer |
| `apps/orchestrator/**` (Fase 5) | shared (operator + tech lead) | qualquer |
| `apps/lp-templates/**` (Fase 5) | shared | qualquer |
| **`docs/30-contracts/**`** | **SERIAL** — qualquer mudança vira T-ID com `parallel-safe=no` | qualquer |
| `docs/20-domain/<file>` | módulo dono daquele file | qualquer |
| `docs/50-business-rules/<file>` | domain author do domínio relevante | qualquer |
| `docs/40-integrations/<file>` | integration author | qualquer |
| `tests/unit/<mod>/**` | módulo correspondente | qualquer |
| `tests/integration/<mod>/**` | módulo correspondente | qualquer |
| `tests/e2e/**` | shared (test author) | qualquer |
| `tests/fixtures/<provider>/**` | integration author do provider | qualquer |
| `.github/workflows/**` | OPERATOR | qualquer |
| `wrangler.toml`, `package.json`, `pnpm-workspace.yaml` | OPERATOR | qualquer |

## Regra de quebra de paralelização

Se 2 T-IDs precisam editar mesmo arquivo:
- Mover uma para wave seguinte.
- Ou consolidar em uma T-ID maior.
- Nunca duas T-IDs `parallel-safe=yes` editando mesmo path.

## Mudança de ownership

Mover ownership de path entre módulos exige:
1. ADR.
2. Atualizar este arquivo.
3. Atualizar `20-domain/<NN>-mod-<source>.md` § 12 e `<NN>-mod-<target>.md` § 12.
4. Refactor de imports onde aplicável.
