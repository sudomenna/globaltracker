# Sprint 6 — Control Plane UI (Fase 4 do rollout)

## Duração
3 semanas.

## Objetivo
Next.js 15 App Router com UI operacional para todas funcionalidades atualmente acessíveis via YAML/API.

## Critério de aceite

- [ ] Marketer cria lançamento end-to-end via UI sem YAML.
- [ ] CRUD de pages, links, audiences, integrations.
- [ ] Page token rotation via UI com janela de overlap visível.
- [ ] SAR/erasure UI com double-confirm.
- [ ] Audit log viewer com filtros.
- [ ] Multi-workspace operacional (até então MVP rodava 1 workspace).
- [ ] RBAC plenamente implementado (todos 7 roles + AUTHZ-001..012).
- [ ] 2FA obrigatório para owner/admin/privacy.

## T-IDs (alto nível)
~30 T-IDs cobrindo telas SCREEN-* + auth + RBAC + onboarding + observabilidade visual.

### Onboarding & UX visual (derivados de [`docs/90-meta/04-decision-log.md`](../90-meta/04-decision-log.md) ADR — plano `ok-me-ajude-a-whimsical-key`)

**P0 — must-have**

| T-ID hint | Spec UX | Resumo |
|---|---|---|
| `T-CP-onboarding-wizard` | [70-ux/03-screen-onboarding-wizard.md](../70-ux/03-screen-onboarding-wizard.md) | Wizard 5 passos (Meta + GA4 + launch + page + verificar) |
| `T-CP-page-snippet-status` | [70-ux/04-screen-page-registration.md](../70-ux/04-screen-page-registration.md) | Snippet com status vivo (polling) |
| `T-CP-health-badge-component` | [70-ux/07-component-health-badges.md](../70-ux/07-component-health-badges.md) | Componente reutilizável de saúde |
| `T-CP-sidebar-health-badges` | id. + [70-ux/02-information-architecture.md](../70-ux/02-information-architecture.md) | Badges agregados na sidebar |
| `T-CP-integration-health-card` | [70-ux/05-screen-integration-health.md](../70-ux/05-screen-integration-health.md) | Card de saúde por integração |
| `T-CP-lead-timeline` | [70-ux/06-screen-lead-timeline.md](../70-ux/06-screen-lead-timeline.md) | Timeline visual end-to-end por lead |
| `T-CP-skip-copy-deck` | [70-ux/11-copy-deck-skip-messages.md](../70-ux/11-copy-deck-skip-messages.md) | Mensagens humanizadas para skip/erro |

**P1**

| T-ID hint | Spec UX | Resumo |
|---|---|---|
| `T-CP-page-diagnostics` | [70-ux/04-screen-page-registration.md §4](../70-ux/04-screen-page-registration.md) | Diagnóstico contextualizado (origin_not_allowed etc.) |
| `T-CP-page-health-badge` | [70-ux/07-component-health-badges.md §4](../70-ux/07-component-health-badges.md) | Badge por page |
| `T-CP-workspace-health-header` | [70-ux/07-component-health-badges.md §5](../70-ux/07-component-health-badges.md) | Badge no header + painel de incidentes |
| `T-CP-timeline-authz` | [70-ux/06-screen-lead-timeline.md §3](../70-ux/06-screen-lead-timeline.md) | Sanitização de payload por role |
| `T-CP-redispatch-ui` | [70-ux/06-screen-lead-timeline.md §4](../70-ux/06-screen-lead-timeline.md) | Re-dispatch from UI |
| `T-CP-integration-test-event` | [70-ux/05-screen-integration-health.md §3](../70-ux/05-screen-integration-health.md) | Disparar evento de teste |
| `T-CP-deep-links-helper` | [70-ux/05-screen-integration-health.md §4](../70-ux/05-screen-integration-health.md) | Helper de deep-links Meta/GA4/Google Ads |
| `T-CP-help-tooltips` | [70-ux/08-pattern-contextual-help.md §1](../70-ux/08-pattern-contextual-help.md) | Tooltips em campos técnicos |

**P2**

| T-ID hint | Spec UX | Resumo |
|---|---|---|
| `T-CP-glossary-page` | [70-ux/08-pattern-contextual-help.md §2](../70-ux/08-pattern-contextual-help.md) | `/help/glossary` |
| `T-CP-why-failed-panel` | [70-ux/08-pattern-contextual-help.md §3](../70-ux/08-pattern-contextual-help.md) | Painel "Por que isso aconteceu?" |

### Backend support (mesma sprint)

- `T-EDGE-pages-status-endpoint` — `GET /v1/pages/:public_id/status` (polling)
- `T-EDGE-health-endpoints` — `GET /v1/health/integrations`, `/workspace`
- `T-EDGE-integration-test-endpoint` — `POST /v1/integrations/:provider/test`
- `T-EDGE-onboarding-state-endpoint` — `GET/PATCH /v1/onboarding/state`
- `T-EDGE-redispatch-endpoint` — `POST /v1/dispatch-jobs/:id/replay` (audit log)
- `T-EDGE-help-skip-reason-endpoint` — `GET /v1/help/skip-reason/:reason`
- `T-SCHEMA-onboarding-state` — `workspaces.onboarding_state jsonb`
