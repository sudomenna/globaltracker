# 01 — Convenções de documentação

## Estilo geral

- **Idioma:** português para conteúdo conceitual e prosa; **inglês** para identificadores de código (nomes de tabelas, funções, enums).
- **Tom:** direto, técnico, sem floreio. "DEVE", "NÃO PODE" são preferíveis a "deveria", "geralmente".
- **Emojis:** proibidos em docs canônicas. Permitidos apenas em diagramas explicativos quando agregam valor.
- **Comentários em código:** explicar **por quê**, não **o quê**. `// BR-IDENTITY-003: phone_hash precisa ser único globalmente` — sim. `// hash phone` — não.
- **Datas:** sempre absolutas (`2026-05-01`), nunca relativas (`semana passada`).

## Naming

| Tipo | Padrão | Exemplo |
|---|---|---|
| Arquivo de seção `00-product` | `NN-kebab-case.md` | `03-personas-rbac-matrix.md` |
| Arquivo de módulo `20-domain` | `NN-mod-name.md` | `04-mod-identity.md` |
| Arquivo de BR | `BR-DOMAIN.md` agrupando `BR-DOMAIN-NNN` | `BR-IDENTITY.md` |
| Arquivo de flow | `NN-flow-kebab.md` | `07-returning-lead-initiate-checkout.md` |
| Arquivo de sprint | `NN-sprint-N-tema.md` | `02-sprint-2-runtime-tracking.md` |
| Tabela SQL | `snake_case` plural | `lead_aliases` |
| Coluna SQL | `snake_case` | `email_hash`, `pii_key_version` |
| Função TypeScript | `camelCase` | `resolveLeadByAliases()` |
| Tipo TypeScript | `PascalCase` | `LeadResolutionResult` |
| Constant em código | `UPPER_SNAKE` | `EVENT_TIME_CLAMP_WINDOW_SEC` |
| ENUM TS | `PascalCase` enum, `UPPER_SNAKE` valores | `enum DispatchStatus { PENDING, PROCESSING, SUCCEEDED }` |

## Templates por tipo

### Módulo de domínio (`20-domain/<NN>-mod-<name>.md`)

```md
# MOD-<NAME> — <Nome humano>

## 1. Identidade
## 2. Escopo (dentro/fora)
## 3. Entidades (campos conceituais, não DDL)
## 4. Relações
## 5. Estados (state machine)
## 6. Transições válidas
## 7. Invariantes (INV-MOD-NNN)
## 8. BRs relacionadas (link para 50-business-rules)
## 9. Contratos consumidos
## 10. Contratos expostos
## 11. Eventos de timeline emitidos (TE-*)
## 12. Ownership de código (paths concretos)
## 13. Dependências permitidas / proibidas
## 14. Test harness
```

### BR (`50-business-rules/BR-<DOMAIN>.md` — agrupa N regras)

```md
## BR-<DOMAIN>-001 — <enunciado imperativo curto>

### Status
Stable | Draft | Superseded

### Enunciado
<frase imperativa única>

### Motivação
### Enforcement (camada + pseudocódigo/DDL)
### Aplica-se a (MOD-*, FLOW-*, SCREEN-*)
### Critérios de aceite (Gherkin)
Scenario: happy path
  Given ...
  When ...
  Then ...

Scenario: edge case
  ...

### Mensagem de erro recomendada
### Citação em código
```

### Flow (`60-flows/<NN>-<nome>.md`)

```md
# FLOW-NNN — <nome>

## Gatilho
## Atores (PERSONA-*)
## UC-* envolvidos
## SCREEN-* relacionados
## MOD-* atravessados
## CONTRACT-* envolvidos
## BRs aplicadas
## Fluxo principal (passos numerados, determinísticos)
## Fluxos alternativos (A1, A2, ...)
## Pós-condições
## TE-* emitidos
## Erros previstos (link para contratos de erro)
## Casos de teste E2E sugeridos
```

### ADR (`90-meta/04-decision-log.md` — uma seção por ADR)

```md
## ADR-NNN — <decisão imperativa>

### Status
Aceito | Superado por ADR-XXX

### Contexto
### Decisão
### Alternativas consideradas
### Consequências
- Positivas: ...
- Negativas: ...

### Impacta
MOD-* / CONTRACT-* / BR-*
```

### OQ (`90-meta/03-open-questions-log.md` — uma seção por OQ)

```md
## OQ-NNN — <título imperativo>

- Origem:
- Contexto:
- Pergunta:
- Impacto se decidir errado:
- Status: aberta | decidida (link ADR) | descartada
- Classificação: bloqueante | pode esperar
```

### T-ID (`80-roadmap/<sprint>.md` — entrada de sprint)

```md
### T-<N>-NNN — <título imperativo>
- **Tipo:** schema | domain | integration | ui | test | infra | docs
- **Módulo alvo:** MOD-<NAME>
- **Subagent recomendado:** globaltracker-<role>-author | general-purpose
- **Parallel-safe:** yes | no
- **Depends-on:** [T-N-XXX, ...]
- **Ownership (pode editar):**
  - <paths concretos>
- **Não pode editar:**
  - docs/30-contracts/** (salvo se tipo=contract-change)
- **Inputs de contexto:**
  - docs/20-domain/<file>
  - docs/50-business-rules/BR-<DOMAIN>.md
  - docs/30-contracts/<file>
  - linha deste arquivo
- **DoD:**
  - [ ] typecheck limpo
  - [ ] testes unit/integration/E2E
  - [ ] cobertura alvo
  - [ ] doc-sync (atualizou ou registrou [SYNC-PENDING])
```

## Citação cruzada

- Ao citar outra doc canônica, use markdown link relativo: `[BR-IDENTITY-001](../50-business-rules/BR-IDENTITY.md#br-identity-001)`.
- Ao citar regra em código, use comentário com ID: `// BR-IDENTITY-001: aliases ativos são únicos por (workspace, identifier_hash)`.
- Ao citar uma OQ aberta no código (workaround temporário), use `// TODO[OQ-NNN]:` com link para o log.

## Doc-sync

Mudou comportamento de código? Atualize a doc canônica **no mesmo commit**. Se impossível (refactor grande, doc não está pronta), registre `[SYNC-PENDING]` em `MEMORY.md §2`. Sync pendings têm prazo: até o final do sprint.
