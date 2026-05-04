# 80 — Roadmap

Sprints com T-IDs e ondas de paralelização.

> Os sprints são derivados da Seção 28 do `planejamento.md` v3.0 (Plano de rollout revisado), refinada em T-IDs atômicas conforme `90-meta/05-subagent-playbook.md`.

| Arquivo | Conteúdo |
|---|---|
| `00-sprint-0-foundations.md` | Setup do monorepo, CI, fixtures, secrets |
| `01-sprint-1-fundacao-dados-contratos.md` | Fase 1 do planejamento — schema completo, contratos vazios, raw_events, fast accept |
| `02-sprint-2-runtime-tracking.md` | Fase 2A — `/v1/config`, `/v1/events`, `/v1/lead`, tracker v0, `__ftk` |
| `03-sprint-3-meta-capi-webhooks.md` | Fase 2B — Meta CAPI v1 com enriquecimento server-side, Hotmart/Kiwify/Stripe |
| `04-sprint-4-analytics-google.md` | Fase 3A — Cost ingestor com FX, Metabase views, GA4 MP, Google Conversion Upload |
| `05-sprint-5-audience-multitouch.md` | Fase 3B — Audience Meta v1 com snapshots, `visitor_id`, retroactive linking |
| `06-sprint-6-control-plane.md` | Fase 4 — UI operacional |
| `07-sprint-7-orchestrator.md` | Fase 5 — Trigger.dev jobs, LP templates, provisioning assistido |
| `08-sprint-8-ai-dashboard.md` | Fase 6 — Copy/LP Generator + dashboard custom Next.js |
| `09-sprint-9-funil-ux-hardening.md` | Funil Configurável Fase 1 — UX Hardening: expor page.role, event_config, launch.type pela UI |
| `10-sprint-10-funil-templates-scaffolding.md` | Funil Configurável Fase 2 — Templates + Scaffolding: 4 presets, blueprint, stages editáveis |
| `11-sprint-11-funil-webhook-guru.md` | Funil Configurável Fase 3 — Webhook Guru contextualizado por launch + funnel_role |
| `12-sprint-12-webhooks-hotmart-kiwify-stripe.md` | Webhooks Hotmart, Kiwify, Stripe (realocado após entrega dos funis) |
| `97-ownership-matrix.md` | Quais arquivos cada módulo possui (consolidado de todos MOD-*) |
| `98-test-matrix-by-sprint.md` | Quais testes em cada sprint, ligados a BR e FLOW |
| `99-acceptance-criteria-by-sprint.md` | Critério de aceite global por sprint |

## Protocolo de paralelização

Resumo (referência completa em [`../90-meta/05-subagent-playbook.md`](../90-meta/05-subagent-playbook.md)):

1. **Unidade de paralelização** = T-ID com `parallel-safe=yes` e ownership disjunto.
2. **Onda** = grupo de 3–5 T-IDs paralelas. Após onda, rodar `pnpm typecheck && pnpm test`.
3. **Mudança em `30-contracts/`** = sempre serial (`parallel-safe=no`, sozinha na onda).
4. **Toda T-ID** declara obrigatoriamente: tipo, módulo, parallel-safe, depends-on, ownership concreto, inputs de contexto, DoD.
