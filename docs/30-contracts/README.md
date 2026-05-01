# 30 — Contratos canônicos

> **REGRA CRÍTICA:** edição nesta pasta é **sempre serial**. Nenhuma T-ID que toca em `docs/30-contracts/**` pode ter `parallel-safe=yes`. Mudança aqui exige ADR + atualização de consumidores no mesmo PR (ou marcação `[SYNC-PENDING]` em `MEMORY.md`).

| Arquivo | Conteúdo |
|---|---|
| `01-enums.md` | Todos os enums (status, tipos, papéis) com módulo dono |
| `02-db-schema-conventions.md` | Naming, PK, timestamps, soft-delete, audit, jsonb |
| `03-timeline-event-catalog.md` | TE-* (payload, emissor, visibilidade, retenção) |
| `04-webhook-contracts.md` | Por provedor: assinatura, idempotência, retry, DLQ |
| `05-api-server-actions.md` | `Result<T,E>`, validação Zod, erros, idempotência |
| `06-audit-trail-spec.md` | Eventos auditáveis, schema, retenção, RLS |
| `07-module-interfaces.md` | Assinaturas TypeScript públicas de cada MOD-* |

## Versionamento

Cada contrato tem versão no nome: `CONTRACT-api-events-v1`, `CONTRACT-event-lead-v1`. Mudança incompatível exige `v2` + ADR + plano de migração.
