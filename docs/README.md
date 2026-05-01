# GlobalTracker — Documentação canônica

Esta é a fonte única da verdade do que o sistema **é**. Os arquivos da raiz (`AGENTS.md`, `CLAUDE.md`, `MEMORY.md`, `TESTING.md`) descrevem **como trabalhar**. Esta pasta descreve **o que existe**.

> Especificação técnica completa de origem: [`planejamento.md` v3.0](../planejamento.md). Esta pasta decompõe esse monólito na pirâmide spec-driven `00-90`.

## Pirâmide de fontes

| Pasta | Pergunta que responde | Quem edita |
|---|---|---|
| `00-product/` | O que o produto é, para quem, com qual objetivo | Product, validado por todos |
| `10-architecture/` | Como o sistema é construído | Arquitetura, com ADR |
| `20-domain/` | Quais são os módulos/agregados, suas invariantes | Por módulo (ownership) |
| `30-contracts/` | Quais enums, schemas, eventos, interfaces são compartilhados | **Serial** — uma T-ID por vez |
| `40-integrations/` | Quais provedores externos e como adaptam | Por adapter |
| `50-business-rules/` | Quais regras imperativas o sistema aplica | Domain authors |
| `60-flows/` | Quais jornadas E2E atravessam módulos | UX + domain |
| `70-ux/` | Como o usuário interage (telas, padrões, A11y) | UX |
| `80-roadmap/` | O que vai ser feito quando, em qual T-ID, com quais ondas | EM/Tech Lead |
| `90-meta/` | Convenções, IDs, ADRs, OQs, playbook de subagents | Tech Lead |

## Regra-mãe

```
REQ → PERSONA → MOD → BR/CONTRACT → FLOW → T-ID → TEST → CODE → DOC-SYNC
```

Nenhuma linha de código nasce sem uma T-ID. Nenhuma T-ID nasce sem módulo + BR/contrato + critério de aceite.

## Pontos de entrada por papel

| Quem você é | Comece por |
|---|---|
| Novo no time | [`00-product/01-brief.md`](00-product/01-brief.md) → [`00-product/06-glossary.md`](00-product/06-glossary.md) |
| Vai implementar uma T-ID | [`80-roadmap/`](80-roadmap/) → módulo da T-ID em `20-domain/` → BRs/contratos referenciados |
| Vai revisar código | [`50-business-rules/`](50-business-rules/) + [`30-contracts/`](30-contracts/) |
| Vai adicionar provedor | [`40-integrations/README.md`](40-integrations/README.md) (diretrizes universais) |
| Vai mexer em segurança/PII | [`50-business-rules/BR-PRIVACY.md`](50-business-rules/) + [`10-architecture/06-auth-rbac-audit.md`](10-architecture/) |
| Vai entender uma decisão | [`90-meta/04-decision-log.md`](90-meta/04-decision-log.md) |

## Princípios não-negociáveis

1. **Uma fonte única por assunto.** Nunca duplique semanticamente — referencie por ID.
2. **Contracts-first.** Congele cedo APIs, schemas, eventos, enums, interfaces.
3. **Mudança de contrato é serial.** Nunca paralela entre subagents.
4. **Ownership declarado por módulo.** Subagent não edita fora do módulo da tarefa.
5. **Ambiguidade nunca vira invenção.** Vai para [`90-meta/03-open-questions-log.md`](90-meta/03-open-questions-log.md).
6. **Doc-sync no mesmo commit.** Mudou comportamento → atualiza doc canônica.
