# 10 — Arquitetura

Como o sistema é construído. Decisões grandes vivem aqui e em [`../90-meta/04-decision-log.md`](../90-meta/04-decision-log.md).

| Arquivo | Conteúdo |
|---|---|
| `01-overview.md` | Diagrama de blocos + fluxo de requisição |
| `02-stack.md` | Tecnologias com versões pinadas + ADR de origem |
| `03-data-layer.md` | ORM, migrations, RLS, audit, soft-delete, jsonb |
| `04-integrations-canonical.md` | Modelo canônico + padrão de adapter |
| `05-realtime-jobs.md` | Filas, crons, idempotência, DLQ |
| `06-auth-rbac-audit.md` | Auth, 2FA, RBAC, audit log |
| `07-observability.md` | Logs, métricas, traces, correlation IDs |
| `08-nfr.md` | SLA, RPO/RTO, performance |
| `09-module-boundaries.md` | Ownership, interfaces, regra de paralelização |
| `10-testing-strategy.md` | Pirâmide, cobertura, fixtures |
| `11-migration-rollback.md` | Como evoluir e reverter banco |
