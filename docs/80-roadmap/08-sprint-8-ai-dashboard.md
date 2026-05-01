# Sprint 8 — IA + dashboard custom (Fase 6)

## Duração
4+ semanas.

## Objetivo
Copy/LP Generator com IA (Claude API), dashboard custom em Next.js + Supabase Realtime.

## Critério de aceite

- [ ] LP gerada por IA passa em smoke test E2E.
- [ ] Variações de copy (headline, CTA) avaliáveis em A/B test integrado ao tracker.
- [ ] Dashboard custom mostra métricas em tempo real com latência < 5s.
- [ ] Alertas automáticos para anomalias (queda de CPL, spike de erros).

## T-IDs (alto nível)
- Claude API integration para copy generation.
- LP Generator UI no Control Plane.
- Dashboard custom Next.js + Supabase Realtime.
- Alerts engine.
- **Live Event Console + Test Mode + Replay** — pré-requisito do dashboard custom realtime
  ([70-ux/12-screen-live-event-console.md](../70-ux/12-screen-live-event-console.md)).

### Observabilidade visual realtime (derivados do plano `ok-me-ajude-a-whimsical-key`)

**P0**

| T-ID hint | Spec UX | Resumo |
|---|---|---|
| `T-CP-live-event-console` | [70-ux/12-screen-live-event-console.md §1-2](../70-ux/12-screen-live-event-console.md) | Stream de eventos via Supabase Realtime |
| `T-CP-test-mode-toggle` | [70-ux/12-screen-live-event-console.md §2](../70-ux/12-screen-live-event-console.md) | Toggle de modo teste por workspace |
| `T-EDGE-test-mode-detection` | id. | Edge detecta header/cookie e propaga `events.is_test=true` |
| `T-DISPATCHERS-test-mode-routing` | id. | Dispatchers usam `test_event_code`/`debug_mode` quando `is_test=true` |

**P1**

| T-ID hint | Spec UX | Resumo |
|---|---|---|
| `T-CP-event-replay` | [70-ux/12-screen-live-event-console.md §3](../70-ux/12-screen-live-event-console.md) | Replay de evento histórico em modo teste |
| `T-SCHEMA-events-is-test` | id. | `events.is_test bool` + `dispatch_jobs.replayed_from_dispatch_job_id` |

## Pré-requisito crítico

Runtime e analytics estáveis (Sprints 1-5) antes de iniciar.
Para Live Console, Supabase Realtime deve ter sido provisionado e validado em load test (Sprint 7).
