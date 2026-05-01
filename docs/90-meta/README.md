# 90 — Meta

Convenções, ID registry, decisões, dúvidas, playbook de subagents.

| Arquivo | Conteúdo |
|---|---|
| `01-doc-conventions.md` | Templates por tipo, regras de estilo |
| `02-id-registry.md` | Registro vivo de TODOS os IDs alocados |
| `03-open-questions-log.md` | OQ-* (perguntas abertas) |
| `04-decision-log.md` | ADR-* (decisões tomadas) |
| `05-subagent-playbook.md` | Protocolo operacional para rodar N subagents em paralelo |
| `06-spec-driven-process.md` | Guia metodológico genérico de spec-driven development com subagents |
| `archive/` | Material histórico (planning.md v1, planning-v3.md — input docs originais) |

## Princípios

- **`02-id-registry.md`** é a fonte de prevenção de duplicatas. Antes de criar `MOD-X` ou `BR-X-NNN`, consulte o registry.
- **`04-decision-log.md`** é apenas-anexar. Decisões superadas viram `superseded by ADR-XXX`, não removidas.
- **`03-open-questions-log.md`** classifica OQ como `bloqueante | pode esperar | descartada`. OQs bloqueantes pausam a fase do rollout afetada.
- **`MEMORY.md` (raiz)** é volátil — nunca canônico. Decisões importantes migram para ADR.
