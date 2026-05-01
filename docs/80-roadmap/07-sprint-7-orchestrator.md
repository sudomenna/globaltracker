# Sprint 7 — Orchestrator e automação (Fase 5)

## Duração
4+ semanas.

## Objetivo
Trigger.dev jobs para LP templates, setup de tracking automatizado, provisionamento assistido de campanhas.

## Critério de aceite

- [ ] Operador deploya nova LP em < 5min via UI (Astro template + tracker pré-instalado em CF Pages).
- [ ] Job de provisionamento de campanha gera estrutura Meta/Google e pausa para aprovação humana.
- [ ] Rollback de provisioning desfaz mudanças via API.
- [ ] Audit log em cada etapa.

## T-IDs (alto nível)
- LP templates Astro.
- Trigger.dev workflow setup-tracking.
- Workflow provision-campaigns com aprovação humana.
- Rollback workflows.
- Integração com Control Plane para disparar workflows.
