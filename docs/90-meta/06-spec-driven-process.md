# Spec-Driven Development com Subagents — Passo a passo prescritivo

> Guia operacional para um humano transformar uma ideia em um sistema implementável por múltiplos subagents em paralelo, com documentação spec-driven.
>
> Este arquivo é um **algoritmo**: cada etapa tem objetivo, arquivos a criar, **prompt assertivo** pronto para colar na IA, e critério de validação.

---

## 0. Como ler este documento

| Marcador | Significado |
|---|---|
| **TEMPLATE** | Estrutura genérica, válida para qualquer projeto. Copie literalmente. |
| **EXEMPLO (CNE-OS)** | Caso real do projeto CNE-OS. Use como referência de preenchimento, **não** como conteúdo do seu projeto. |
| **PROMPT** | Texto pronto para colar numa IA forte (Claude Opus, GPT-5, etc.). Substitua os placeholders `<...>` antes de enviar. |
| `[STACK-FIXA]` | Decisão técnica obrigatória que precisa estar clara antes da etapa rodar. |

A regra-mãe que governa tudo:

```
REQ → PERSONA → MOD → BR/CONTRACT → FLOW → T-ID → TEST → CODE → DOC-SYNC
```

Nenhuma linha de código nasce sem um T-ID. Nenhum T-ID nasce sem um módulo + uma BR/contrato + um critério de aceite.

---

## 1. Princípios fundamentais (não negociáveis)

1. **Raiz = contrato operacional. `docs/` = canônico.**
   - Raiz explica **como trabalhar** (AGENTS.md, CLAUDE.md, MEMORY.md, TESTING.md, README.md).
   - `docs/` explica **o que o sistema é**.
2. **Uma fonte única da verdade por assunto.** Nunca duplique semanticamente — referencie por ID.
3. **Contracts-first.** Congele cedo APIs, schemas, eventos, enums, erros e interfaces entre módulos.
4. **Mudança de contrato é serial.** Nunca paralela entre subagents.
5. **Contexto mínimo por tarefa.** O subagent recebe **apenas** o necessário para sua T-ID.
6. **Ownership declarado por módulo.** Subagent não edita fora do módulo da tarefa.
7. **Ambiguidade nunca vira invenção.** Vai para `docs/90-meta/03-open-questions-log.md`.
8. **MEMORY.md é volátil.** Nunca é fonte canônica — é estado de sessão e ponto de retomada.
9. **Doc-sync no mesmo commit.** Mudou comportamento → atualiza doc canônica. Se não puder, registra `[SYNC-PENDING]` em MEMORY.md.

---

## 2. Estrutura final (TEMPLATE)

Esta é a estrutura-alvo. Toda etapa abaixo cria arquivos dentro dela.

```
/README.md                  # porta de entrada
/AGENTS.md                  # contrato agente-agnóstico
/CLAUDE.md                  # adendo Claude Code
/MEMORY.md                  # memória de sessão (volátil)
/TESTING.md                 # guia operacional de testes
/docs
  /README.md                # índice mestre da documentação canônica
  /00-product               # O QUE é o produto
  /10-architecture          # COMO é construído
  /20-domain                # MÓDULOS (1 arquivo = 1 agregado)
  /30-contracts             # FONTE ÚNICA DA VERDADE (enums, schemas, eventos, interfaces)
  /40-integrations          # PROVEDORES EXTERNOS
  /50-business-rules        # BR-* — regras como contratos executáveis
  /60-flows                 # FLOW-* — jornadas E2E que atravessam módulos
  /70-ux                    # design system, IA, wireframes, acessibilidade
  /80-roadmap               # SPRINTS com T-IDs (parallel-safe + depends-on)
  /90-meta                  # convenções, ID registry, OQs, ADRs, subagent playbook
```

Cada subpasta de `docs/` tem um `README.md` que indexa seus arquivos.

---

## 3. Sistema de IDs (TEMPLATE — não negociável)

Todo artefato rastreável tem ID. Registro vivo em `docs/90-meta/02-id-registry.md`.

| Prefixo | Significado | Onde vive |
|---|---|---|
| `OBJ-<NUM>` | Objetivo de produto | `00-product/` |
| `REQ-<NUM>` | Requisito | `00-product/` (implícito ou explícito) |
| `PERSONA-<NAME>` | Persona/usuário | `00-product/` |
| `MOD-<NAME>` | Módulo/agregado | `20-domain/` |
| `INV-<MOD>-<NUM>` | Invariante de módulo | dentro do módulo |
| `BR-<DOMAIN>-<NUM>` | Regra de negócio | `50-business-rules/` |
| `CONTRACT-<TYPE>-<NAME>-v<N>` | Contrato compartilhado | `30-contracts/` |
| `TE-<KIND>` | Timeline / domain event | `30-contracts/03-timeline-event-catalog.md` |
| `FLOW-<NUM>` | Fluxo end-to-end | `60-flows/` |
| `T-<SPRINT>-<NUM>` | Tarefa atômica de execução | `80-roadmap/<sprint>.md` |
| `ADR-<NUM>` | Architectural Decision Record | `90-meta/04-decision-log.md` |
| `OQ-<NUM>` | Open Question | `90-meta/03-open-questions-log.md` |

> ⚠️ **Sobre SPEC**: este guia **não cria artefato `SPEC-XXX` separado**. A "spec" de uma feature é a soma de: módulo (`MOD-*`) + BRs (`BR-*`) + contratos (`CONTRACT-*`) + flow (`FLOW-*`) + tarefa (`T-*`). Isso evita duplicação e mantém uma só fonte por assunto.

---

## 4. Fluxo macro (visão de uma só página)

```
ETAPA 1   Brief inicial (envelope do produto)
ETAPA 2   Discovery iterativa (decisões + dúvidas + glossário)
ETAPA 3   Personas + RBAC + escopo + métricas (resto do 00-product)
ETAPA 4   Modelo de domínio (20-domain — um arquivo por agregado)
ETAPA 5   Contratos canônicos (30-contracts — enums, schema, eventos, interfaces)
ETAPA 6   Business rules (50-business-rules)
ETAPA 7   Integrações externas (40-integrations)
ETAPA 8   Fluxos E2E (60-flows)
ETAPA 9   Arquitetura técnica (10-architecture)
ETAPA 10  UX (70-ux)
ETAPA 11  Roadmap + Sprints + T-IDs (80-roadmap)
ETAPA 12  Meta (90-meta — convenções, ID registry, playbook)
ETAPA 13  Arquivos da raiz (AGENTS, CLAUDE, MEMORY, TESTING, README)
ETAPA 14  Subagents customizados (.claude/agents/*)
ETAPA 15  Loop de execução por sprint
```

Etapas 4–10 podem se sobrepor — você raramente tem o domínio totalmente fechado antes de começar contratos. A ordem é **prioridade de fonte da verdade**, não cronograma rígido.

---

## 5. ETAPA 1 — Brief inicial

**Objetivo**: limitar o escopo da conversa antes de qualquer brainstorm. Sem isso, qualquer discovery vira ficção.

**Arquivo a criar**: `docs/00-product/01-brief.md`

### TEMPLATE

```md
# 01 — Brief executivo

## 1. Nome
## 2. Em uma frase
## 3. Problema
## 4. Usuários-alvo (quem usa, quem paga, quem opera, quem administra)
## 5. Resultado esperado para a Fase 1
## 6. Objetivos principais (OBJ-001..N)
## 7. Fora de escopo da Fase 1
## 8. Restrições (prazo, orçamento, stack obrigatória, compliance, idioma/região)
## 9. Riscos iniciais
## 10. Premissas iniciais (ASSUMP-001..N)
```

### EXEMPLO (CNE-OS) — só para calibrar tom

> CNE-OS: "Sistema Operacional da CNE Educação. Substitui ferramentas externas fragmentadas. CRM multi-marca + motor comercial de ofertas + snapshots imutáveis de venda + inbox omnichannel."

### PROMPT

```
Você é um Product Manager experiente em SaaS B2B.

Tarefa: criar o arquivo `docs/00-product/01-brief.md` para o seguinte projeto.

Descrição livre do projeto:
<<COLE AQUI 3-10 PARÁGRAFOS LIVRES SOBRE O QUE QUER CONSTRUIR>>

Restrições já decididas:
- Stack obrigatória: <ex: Next.js + Supabase + Drizzle, ou "ainda não decidida">
- Prazo da Fase 1: <ex: 6 meses>
- Compliance: <ex: LGPD, ou "n/a">

Saída esperada:
- Arquivo Markdown com a estrutura abaixo.
- Cada OBJ-XXX numerado e mensurável.
- Cada ASSUMP-XXX explicitada (não escondida).
- Seção "Fora de escopo" com no mínimo 5 itens.
- Sem floreio. Linguagem técnica e direta.

Estrutura obrigatória:
[colar o TEMPLATE acima]

Antes de gerar, faça 5 perguntas que reduzam a ambiguidade do brief.
Espere minhas respostas, depois gere o arquivo final.
```

**Validação**: o brief responde "o que NÃO vou construir" tão claramente quanto "o que vou".

---

## 6. ETAPA 2 — Discovery iterativa

**Objetivo**: extrair decisões, dúvidas e termos canônicos do brief.

**Arquivos a criar**:
- `docs/90-meta/03-open-questions-log.md` — perguntas abertas (OQ-*)
- `docs/90-meta/04-decision-log.md` — decisões tomadas (ADR-*)
- `docs/00-product/06-glossary.md` — termos canônicos

### TEMPLATE — open-questions-log

```md
# Open Questions

### OQ-001 — <título imperativo>
- Origem: <onde surgiu>
- Contexto: <o que se sabe>
- Pergunta: <forma imperativa>
- Impacto se decidir errado: <BR/flow afetado>
- Status: aberta | decidida (link ADR) | descartada
```

### TEMPLATE — decision-log (ADR leve)

```md
# ADR-001 — <decisão>
- Status: aceito | superado por ADR-XXX
- Contexto:
- Decisão:
- Alternativas consideradas:
- Consequências (positivas e negativas):
- Impacta: MOD-*, CONTRACT-*, BR-*
```

### TEMPLATE — glossary

```md
# Glossário
| Termo | Definição canônica | Não confundir com |
|---|---|---|
```

### PROMPT

```
Você é um analista de produto. Vamos rodar uma discovery em rodadas.

Input: docs/00-product/01-brief.md (cole abaixo).
<<COLAR BRIEF>>

Conduza a discovery em 12 rodadas, uma por mensagem minha. Para cada rodada:
1. Faça no máximo 5 perguntas focadas.
2. Receba minhas respostas.
3. Ao final da rodada, gere:
   - decisões fechadas → entrada em `docs/90-meta/04-decision-log.md` (formato ADR leve)
   - dúvidas que sobraram → entrada em `docs/90-meta/03-open-questions-log.md`
   - termos canônicos surgidos → linha em `docs/00-product/06-glossary.md`

Rodadas:
1. Problema e contexto
2. Tipos de usuários e roles
3. Casos de uso principais
4. Casos de uso secundários
5. Jornadas críticas
6. Regras de negócio percebidas
7. Entidades centrais e relações
8. Permissões e proibições
9. Exceções e estados de erro
10. Integrações externas
11. Requisitos não funcionais (NFR)
12. Riscos e premissas

Regra: nunca invente uma resposta para mim. Se eu não responder, registre como OQ.
Comece pela rodada 1.
```

**Validação**: ao final, o glossário tem ≥20 termos, decision-log tem as decisões grandes (banco, auth, multi-tenancy, deploy), e nenhuma OQ está marcada "decidir depois sem motivo".

---

## 7. ETAPA 3 — Resto de `00-product/`

**Arquivos a criar** (espelhando o CNE-OS):
- `02-problem-goals.md` — problema + objetivos detalhados
- `03-personas-rbac-matrix.md` — personas + matriz CRUD por papel
- `04-scope-phases.md` — Fase 1, Fase 2, fora de escopo
- `05-metrics-success.md` — métricas da Fase 1
- (`06-glossary.md` já criado na etapa 2)
- `README.md` — índice da pasta

### TEMPLATE — `03-personas-rbac-matrix.md`

```md
# 03 — Personas e RBAC

## Personas
### PERSONA-<NAME>
- Quem é
- Objetivo no produto
- Frustração principal
- Frequência de uso

## Roles
### ROLE-<NAME>
- Quem assume
- Permissões
- Limitações

## Matriz CRUD
| Recurso | Guest | Member | Admin | Owner | SuperAdmin |
|---|---|---|---|---|---|
| ... | R | CRUD | CRUD | CRUD | CRUD |

## Regras de acesso (AUTHZ-*)
### AUTHZ-001 — <regra imperativa>
```

### PROMPT (uma chamada por arquivo)

```
Tarefa: gerar `docs/00-product/03-personas-rbac-matrix.md`.

Inputs:
- docs/00-product/01-brief.md (colar)
- docs/90-meta/04-decision-log.md (colar)
- docs/00-product/06-glossary.md (colar)

Saída obrigatória:
- 4 a 8 personas com formato PERSONA-<NAME>.
- Roles concretos com formato ROLE-<NAME>.
- Matriz CRUD em tabela Markdown cobrindo TODOS os recursos identificados nas rodadas 2-3 da discovery.
- Mínimo 5 regras AUTHZ-* numeradas, imperativas, citáveis em código.
- Sem floreio. Use linguagem `Sim/Não/Próprio` na matriz.

Se faltar informação para preencher uma célula, NÃO invente — registre como OQ-XXX em formato pronto para colar em `03-open-questions-log.md` e me devolva no fim da resposta.
```

Repita o padrão para `02-problem-goals.md`, `04-scope-phases.md`, `05-metrics-success.md`.

**Validação**: a matriz CRUD não tem célula vazia. Cada AUTHZ é citável (`// AUTHZ-003: support não altera financeiro`).

---

## 8. ETAPA 4 — Modelo de domínio (`docs/20-domain/`)

**Objetivo**: um arquivo por **agregado/módulo**. Cada um declara: identidade, escopo, entidades, estados, invariantes, contratos consumidos/expostos, **ownership de código**.

**Arquivos a criar**:
- `docs/20-domain/README.md` — mapa de módulos + grafo de dependências
- `docs/20-domain/<NN>-<nome>.md` — um por agregado

### TEMPLATE — módulo de domínio

```md
# MOD-<name> — <Nome humano>

## 1. Identidade
- ID: MOD-<name>
- Tipo: Core | Supporting | Generic
- Dono conceitual: <equipe/persona>

## 2. Escopo
### Dentro
### Fora

## 3. Entidades
### <Entidade>
Campos conceituais (não DDL):
- id
- ...

## 4. Relações
## 5. Estados (state machine)
## 6. Transições válidas
## 7. Invariantes (INV-MOD-NNN)
## 8. BRs relacionadas (links para 50-business-rules)
## 9. Contratos consumidos
## 10. Contratos expostos
## 11. Eventos de timeline emitidos (TE-*)
## 12. Ownership de código
- Arquivos que possui (pode editar):
  - <ex: lib/db/schema/<mod>.ts, lib/domain/<mod>/**, app/(app)/<mod>/**>
- Arquivos que lê (não edita):
  - <ex: lib/domain/auth/index.ts>
## 13. Dependências permitidas / proibidas
## 14. Test harness
- tests/unit/<mod>/**
- tests/integration/<mod>/**
- tests/e2e/<mod>/**
```

### EXEMPLO (CNE-OS) — mapa parcial

> 15 módulos: MOD-ORG, MOD-CONTACT, MOD-MERGE, MOD-TIMELINE, MOD-INBOX, MOD-TICKET, MOD-CAMPAIGN, MOD-FUNNEL, MOD-CATALOG, MOD-OFFER, MOD-TRANSACTION, MOD-ENTITLEMENT, MOD-BILLING, MOD-REFUND, MOD-AUTOMATION.

### PROMPT (loop, um módulo por vez)

```
Você é arquiteto de domínio (DDD).

Tarefa: gerar `docs/20-domain/<NN>-<nome>.md` para o módulo MOD-<NAME>.

Inputs (cole):
- docs/00-product/01-brief.md
- docs/00-product/03-personas-rbac-matrix.md
- docs/00-product/06-glossary.md
- docs/90-meta/04-decision-log.md
- Lista atual de módulos já criados em `docs/20-domain/README.md` (cole se existir)

Restrições:
- Use o TEMPLATE de módulo de domínio (não invente seções novas).
- Ownership de código deve apontar paths concretos compatíveis com a stack: <ex: Next.js App Router → app/(app)/<mod>/, lib/db/schema/<mod>.ts, lib/domain/<mod>/**>.
- Invariantes (INV-*) devem ser executáveis (testáveis com vitest).
- Liste contratos consumidos/expostos como referência por ID; NÃO os defina aqui — eles vivem em 30-contracts/.
- Se faltar dado, registre OQ-XXX no fim da resposta. Não invente.

Ao terminar, atualize também `docs/20-domain/README.md` adicionando uma linha do módulo na tabela de mapa e atualize o grafo ASCII de dependências.
```

**Validação**: cada módulo tem ownership concreto (paths reais de arquivo) e ≥3 invariantes testáveis.

---

## 9. ETAPA 5 — Contratos canônicos (`docs/30-contracts/`)

**Regra de ouro**: edição aqui é **sempre serial**. Nunca dois subagents em paralelo.

**Arquivos a criar** (espelhando CNE-OS):
- `01-enums.md` — todos os enums (status, tipos, papéis)
- `02-db-schema-conventions.md` — naming, timestamps, soft-delete, audit, jsonb
- `03-timeline-event-catalog.md` — TE-* (payload, emissor, visibilidade)
- `04-webhook-contracts.md` — idempotência, retry, DLQ por provedor
- `05-api-server-actions.md` — convenções de Server Actions + zod + erros
- `06-audit-trail-spec.md` — o que auditar, formato, retenção
- `07-module-interfaces.md` — assinaturas públicas entre módulos
- `README.md` — índice + processo serial de mudança

### TEMPLATE — `07-module-interfaces.md` (a peça mais crítica)

```md
# Interfaces públicas entre módulos

Cada módulo expõe um conjunto fechado de funções TypeScript que outros módulos consomem.
Mudança aqui = breaking change → exige ADR.

## MOD-<name>

### `<funcaoExportada>(input: InputType, ctx: Ctx): Result<Output, DomainError>`
- Quando chamar:
- Garantias:
- Erros possíveis:
- BR aplicada:
- Idempotência:
```

### PROMPT (gera todos os contratos numa única passada serial)

```
Tarefa: gerar a pasta `docs/30-contracts/` completa.

Inputs (colar todos):
- docs/00-product/* (todos)
- docs/20-domain/* (todos os MOD-*)
- docs/90-meta/04-decision-log.md
- Stack pinada: <colar a tabela de stack do brief / técnico>

Saída esperada (gere os 7 arquivos abaixo, na ordem):
1. 01-enums.md — TODOS os enums citados em qualquer doc de domínio. Formato: nome, valores, descrição, módulo dono.
2. 02-db-schema-conventions.md — naming (snake_case singular), PK (UUID v7), timestamps (created_at/updated_at), soft-delete, audit_log append-only, padrões jsonb.
3. 03-timeline-event-catalog.md — TE-* por tipo: payload Zod-shape, emissor, visibilidade, retenção.
4. 04-webhook-contracts.md — por provedor: header de assinatura, idempotência (campo UNIQUE), retry policy, DLQ.
5. 05-api-server-actions.md — convenção `Result<T,E>`, validação zod, formato de erro, idempotência opt-in.
6. 06-audit-trail-spec.md — eventos auditáveis, schema de audit_log, retenção, RLS.
7. 07-module-interfaces.md — assinaturas TypeScript públicas de CADA módulo de 20-domain.

Regras:
- Zero invenção. Se um enum/evento não foi citado em nenhum doc, registre OQ-XXX.
- Cada contrato versionado com `v1` no nome (CONTRACT-api-projects-v1, CONTRACT-event-X-v1).
- README da pasta deve dizer: "edição é serial, mudança exige ADR + atualização de consumidores".
```

**Validação**: nenhum enum/evento aparece em código de domínio sem estar listado aqui. Toda interface pública de `20-domain/` aparece em `07-module-interfaces.md`.

---

## 10. ETAPA 6 — Business Rules (`docs/50-business-rules/`)

**Objetivo**: BRs como contratos executáveis. Cada BR tem enunciado imperativo, motivação, camada de enforcement, contrato TS/SQL e casos de teste.

**Arquivos a criar**:
- `BR-<DOMAIN>.md` — um por domínio (agrupa BR-<DOMAIN>-001..N)
- `README.md` — índice

### TEMPLATE — BR

```md
# BR-<DOMAIN> — <Nome do domínio>

## BR-<DOMAIN>-001 — <enunciado imperativo curto>

### Status
Stable | Draft | Superseded

### Enunciado
<frase imperativa única — "O sistema DEVE...">

### Motivação
<por quê — referência a OBJ ou risco>

### Enforcement
- Camada: DB constraint | trigger | função pura | UI
- Implementação esperada: <pseudocódigo ou DDL>

### Aplica-se a
- MOD-*
- SCREEN-*
- FLOW-*

### Critérios de aceite (Gherkin)
Scenario: <happy path>
  Given ...
  When ...
  Then ...

Scenario: <edge case>
  ...

### Mensagem de erro recomendada
<texto exato exibido ao usuário>

### Citação em código
// BR-<DOMAIN>-001: <razão curta>
```

### PROMPT

```
Tarefa: gerar `docs/50-business-rules/BR-<DOMAIN>.md` agrupando todas as regras do domínio <DOMAIN>.

Inputs:
- docs/20-domain/<NN>-<nome>.md (módulo do domínio)
- docs/30-contracts/01-enums.md
- docs/30-contracts/03-timeline-event-catalog.md
- docs/00-product/03-personas-rbac-matrix.md
- docs/90-meta/04-decision-log.md

Restrições:
- Cada BR tem ID único BR-<DOMAIN>-NNN.
- Enunciado em UMA frase imperativa. Nada de "deveria"; use "DEVE/NÃO PODE".
- Critérios de aceite em Gherkin, mínimo 1 happy path + 2 edge cases.
- Toda BR aponta MOD-*, SCREEN-* e FLOW-* afetados (mesmo que algum ainda não exista — declare TBD).
- Se a regra exige enum não listado em 30-contracts/01-enums.md, registre OQ-XXX. Não invente enum.

Mínimo de 3 BRs por domínio. Domínios típicos a cobrir: identity, merge, rbac, audit, idempotency, decisão de motor (se aplicável), imutabilidade de venda (se aplicável), reembolso, renovação.
```

**Validação**: cada `BR-*` é citada em ao menos um módulo (20-domain) e tem ao menos um teste planejado em `80-roadmap/98-test-matrix-by-sprint.md`.

---

## 11. ETAPA 7 — Integrações externas (`docs/40-integrations/`)

Pule esta etapa se não houver integração externa.

**Arquivos a criar**:
- `<NN>-<provedor>.md` — um por provedor
- `README.md` — diretrizes universais (idempotência, DLQ, retry, credenciais via env)

### TEMPLATE — integração

```md
# <Provedor>

## Papel no sistema
## Eventos consumidos (in)
| Evento externo | Mapeia para | Idempotência key |
|---|---|---|

## Eventos emitidos (out)
| Ação interna | Chamada externa |
|---|---|

## Mapping canônico
<tabela ou pseudocódigo do mapper>

## Idempotência
<campo UNIQUE, comportamento em duplicata>

## Assinatura / autenticação
<HMAC, header, validação>

## Retry & DLQ
<política — N tentativas, backoff, destino DLQ>

## Credenciais
<env vars, rotação>

## Fixtures de teste
<onde ficam, formato>
```

### PROMPT

```
Tarefa: gerar `docs/40-integrations/<NN>-<provedor>.md`.

Inputs:
- docs/00-product/01-brief.md (seção Restrições/Integrações)
- docs/20-domain/<MOD que consome>.md
- docs/30-contracts/04-webhook-contracts.md
- Documentação oficial do provedor: <colar URL ou trecho>

Saída: arquivo seguindo o TEMPLATE de integração.
Idempotência é OBRIGATÓRIA. Eventos não mapeáveis vão para DLQ.
Adapter deve viver em `lib/integrations/<provider>/` com: handleWebhook(), mapToInternal(), fixtures de teste.
```

---

## 12. ETAPA 8 — Fluxos E2E (`docs/60-flows/`)

**Objetivo**: documentar comportamentos que **atravessam módulos**. Cada FLOW-NNN gera 1 spec Playwright.

### TEMPLATE — flow

```md
# FLOW-NNN — <nome>

## Gatilho
## Atores
## Casos de uso envolvidos (UC-*)
## Telas relacionadas (SCREEN-*)
## Módulos atravessados (MOD-*)
## Contratos envolvidos
## BRs aplicadas

## Fluxo principal (passos numerados, determinísticos)
1. ...
2. ...

## Fluxos alternativos
### A1 — <título>
### A2 — <título>

## Pós-condições
## Eventos de timeline emitidos
## Erros previstos (links para erros do contrato)
## Casos de teste E2E esperados
```

### PROMPT

```
Tarefa: gerar `docs/60-flows/<NN>-<nome>.md` para o flow FLOW-<NUM>.

Inputs:
- docs/20-domain/* (todos os MOD-* atravessados)
- docs/50-business-rules/* (todas as BR-* aplicadas)
- docs/30-contracts/03-timeline-event-catalog.md
- docs/30-contracts/05-api-server-actions.md
- docs/00-product/03-personas-rbac-matrix.md

Restrições:
- Passos NUMERADOS e determinísticos. Sem "talvez", "geralmente".
- Cada erro tem link para o contrato de erro em 30-contracts.
- Mínimo 2 fluxos alternativos (caminhos infelizes).
- Mínimo 3 casos de teste E2E sugeridos.
```

**Validação**: cada flow é referenciado por ao menos 1 T-ID em 80-roadmap.

---

## 13. ETAPA 9 — Arquitetura técnica (`docs/10-architecture/`)

**Arquivos a criar** (espelhando CNE-OS):
- `01-overview.md` — diagrama de blocos + fluxo de requisição
- `02-stack.md` — tecnologias com versões pinadas + justificativa
- `03-data-layer.md` — ORM, migrations, RLS, audit, soft-delete, jsonb
- `04-integrations-canonical.md` — modelo canônico interno + padrão de adapter
- `05-realtime-jobs.md` — realtime, jobs, idempotência
- `06-auth-rbac-audit.md` — auth, 2FA, RBAC, audit
- `07-observability.md` — logs, métricas, traces, correlation IDs
- `08-nfr.md` — SLA, RPO/RTO, performance
- `09-module-boundaries.md` — ownership, interfaces, regra da paralelização
- `10-testing-strategy.md` — Vitest + Playwright + fixtures + pirâmide
- `11-migration-rollback.md` — como evoluir e reverter banco
- `README.md`

### PROMPT — `02-stack.md` (o mais sensível)

```
Tarefa: gerar `docs/10-architecture/02-stack.md`.

Inputs:
- docs/00-product/01-brief.md (seção Restrições)
- docs/90-meta/04-decision-log.md (ADRs de stack)
- Stack desejada: <colar a lista decidida>

Restrições:
- Cada item da stack tem: tecnologia, versão pinada, justificativa em 1-2 linhas, ADR de origem.
- Inclua tabela "Itens com regra de uso obrigatória" — para cada um, descreva regra e CONDIÇÃO de bloqueio que dispara escalonamento ao humano.
- Inclua seção "Atualização de versão major" exigindo ADR.
- Inclua seção "Alternativas proibidas sem ADR".
```

### PROMPT — `10-testing-strategy.md`

```
Tarefa: gerar `docs/10-architecture/10-testing-strategy.md`.

Inputs:
- docs/10-architecture/02-stack.md
- docs/20-domain/* (lista de módulos)
- docs/50-business-rules/* (BRs que precisam de teste)

Saída esperada:
- Pirâmide de testes: unit (puro, sem I/O) → integration (DB real efêmero, HMAC real) → E2E (Playwright).
- Cobertura alvo por camada: domain ≥90%, mappers ≥95%, RBAC 100%.
- Padrões de teste:
  - Trigger DB (append-only)
  - Webhook idempotente (3× evento = 1 transação)
  - RLS por papel
- Setup de DB efêmero: opções A (branch), B (Docker local), C (CLI local).
- Definition of Done: typecheck + lint + test verde.
```

Repita o padrão para os outros arquivos da pasta.

---

## 14. ETAPA 10 — UX (`docs/70-ux/`)

**Arquivos a criar**:
- `01-design-system-tokens.md` — cores, tipografia, espaçamento, raios (integração shadcn ou equivalente)
- `02-information-architecture.md` — sidebar, rotas, command palette, breadcrumbs
- `03-screen-<nome>.md` — uma por tela crítica (wireframe ASCII + estados)
- `09-interaction-patterns.md` — realtime, notificações, formulários, erro/loading/empty
- `10-accessibility.md` — WCAG, teclado, foco

### TEMPLATE — `03-screen-<nome>.md`

```md
# SCREEN-<NN> — <nome>

## Objetivo
## Personas que acessam (PERSONA-*)
## Casos de uso (UC-*)
## Flow relacionado (FLOW-*)

## Layout (wireframe ASCII)
+-------------------+
| ...               |
+-------------------+

## Componentes principais
## Ações possíveis
## Estados
- Estado inicial
- Loading
- Empty
- Erro de validação
- Sucesso
- Erro de servidor

## Validações
## Mensagens de erro
## BRs aplicadas
## Eventos de analytics
## Permissões (links AUTHZ-*)
## Observações de UX (acessibilidade, segurança)
```

### PROMPT

```
Tarefa: gerar `docs/70-ux/03-screen-<nome>.md`.

Inputs:
- docs/00-product/03-personas-rbac-matrix.md
- docs/60-flows/<flow correspondente>.md
- docs/50-business-rules/* (BRs aplicáveis)
- docs/70-ux/01-design-system-tokens.md (se já existir)

Restrições:
- Wireframe em ASCII (não pseudo-imagem).
- Lista de estados deve incluir TODOS os estados visíveis (mínimo: inicial, loading, empty, erro, sucesso).
- Cada mensagem de erro vem de uma BR ou de um contrato de erro de 30-contracts.
- Cada ação aponta a Server Action ou endpoint que invoca.
```

---

## 15. ETAPA 11 — Roadmap, Sprints e T-IDs (`docs/80-roadmap/`)

Esta etapa é **central** para execução paralela. Vai gerar a documentação dos sprints.

**Arquivos a criar**:
- `00-sprint-0-foundations.md` — setup
- `01-sprint-<N>-<tema>.md` — um por sprint
- `97-ownership-matrix.md` — quais arquivos cada módulo possui (consolidado de todos os MOD-*)
- `98-test-matrix-by-sprint.md` — quais testes em cada sprint
- `99-acceptance-criteria-by-sprint.md` — critério de aceite por sprint
- `README.md` — mapa de sprints + protocolo de paralelização

### TEMPLATE — `<NN>-sprint-<N>-<tema>.md`

```md
# Sprint <N> — <Tema>

## Duração estimada
## Objetivo do sprint
## Pré-requisitos (sprints/T-IDs anteriores)
## Critério de aceite global do sprint
- [ ] ...

## Tarefas

### T-<N>-001 — <título imperativo>
- **Tipo**: schema | domain | integration | ui | test | infra | docs
- **Módulo alvo**: MOD-<name>
- **Subagent recomendado**: <ex: cne-domain-author | general-purpose>
- **Parallel-safe**: yes | no
- **Depends-on**: [T-<N>-XXX, ...]
- **Ownership** (arquivos que pode editar):
  - lib/db/schema/<mod>.ts
  - lib/domain/<mod>/**
- **Não pode editar**: docs/30-contracts/** (salvo se tipo=contract-change, e nesse caso parallel-safe=no)
- **Inputs de contexto**:
  - docs/20-domain/<NN>-<nome>.md
  - docs/50-business-rules/BR-<...>.md
  - docs/30-contracts/01-enums.md (se aplicável)
  - linha deste arquivo
- **Critério de aceite (DoD)**:
  - [ ] typecheck limpo
  - [ ] testes unit/integration/E2E exigidos pela camada
  - [ ] cobertura alvo da camada (10-architecture/10-testing-strategy.md)
  - [ ] doc-sync (atualizou docs/20-domain/<...> ou registrou [SYNC-PENDING])

### T-<N>-002 ...

## Ondas de paralelização sugeridas

| Onda | T-IDs em paralelo | Bloqueio |
|---|---|---|
| 1 | T-<N>-001, T-<N>-002, T-<N>-003 | nenhuma |
| 2 | T-<N>-004, T-<N>-005 | depende da onda 1 |
| 3 | T-<N>-006 (serial — toca contrato) | depende da onda 2 |
```

### TEMPLATE — `97-ownership-matrix.md`

```md
# Ownership Matrix

## Princípio
Cada arquivo do repositório pertence a exatamente um módulo. Subagent não edita fora.

## Matriz

| Path glob | Módulo dono | Permite leitura por |
|---|---|---|
| lib/db/schema/contact.ts | MOD-CONTACT | qualquer |
| lib/domain/contact/** | MOD-CONTACT | qualquer |
| app/(app)/contacts/** | MOD-CONTACT | MOD-INBOX, MOD-FUNNEL (read-only) |
| docs/30-contracts/** | (serial — qualquer mudança vira tarefa não-parallel-safe) | qualquer |
```

### TEMPLATE — `98-test-matrix-by-sprint.md`

```md
# Test Matrix by Sprint

| Sprint | T-ID | MOD | Unit | Integration | E2E | BR coberta | Status |
|---|---|---|---|---|---|---|---|
| 1 | T-1-01 | MOD-CONTACT | identity.test.ts (8 casos) | duplicate-merge.test.ts | FLOW-01 | BR-IDENTITY-001..003 | pending |
```

### PROMPT — gerar um sprint completo

```
Você é um Engineering Manager preparando um sprint para execução paralela por subagents.

Tarefa: gerar `docs/80-roadmap/<NN>-sprint-<N>-<tema>.md`.

Inputs (cole todos):
- docs/20-domain/* (módulos relevantes)
- docs/30-contracts/* (todos)
- docs/50-business-rules/* (BRs do tema)
- docs/60-flows/* (flows do tema)
- docs/10-architecture/09-module-boundaries.md
- docs/10-architecture/10-testing-strategy.md
- docs/80-roadmap/<sprint anterior>.md (se existir)
- docs/80-roadmap/97-ownership-matrix.md (se existir)

Restrições:
- Quebre o sprint em T-IDs ATÔMICAS. Cada T-ID deve caber em UM PR.
- Para cada T-ID, declare obrigatoriamente: tipo, módulo, parallel-safe (yes/no), depends-on, ownership concreto (paths), inputs de contexto (lista de docs específicos), DoD.
- T-IDs que tocam `docs/30-contracts/**` SÃO sempre parallel-safe=no.
- Agrupe T-IDs em ondas de paralelização (3-5 por onda recomendado).
- Toda T-ID aponta a BR/FLOW que justifica sua existência.
- Critério de aceite global do sprint amarra resultados de testes (FLOW-X verde, X% cobertura).

Ao terminar, ATUALIZE TAMBÉM:
- docs/80-roadmap/97-ownership-matrix.md (linhas novas)
- docs/80-roadmap/98-test-matrix-by-sprint.md (linhas novas para os T-IDs)
- docs/80-roadmap/99-acceptance-criteria-by-sprint.md (entrada do sprint)
- docs/80-roadmap/README.md (linha do sprint na tabela mestre)
- docs/90-meta/02-id-registry.md (T-IDs registrados)
```

### EXEMPLO (CNE-OS) — sprints reais

> Sprint 0 (Foundations) → Sprint 1-2 (CRM Core) → Sprint 3-4 (Inbox+Tickets) → Sprint 5 (Marketing+Funnels) → Sprint 6-7 (Offer Engine) → Sprint 8 (Snapshot+DG+Refund) → Sprint 9 (Subscriptions) → Sprint 10 (Analytics) → Sprint 11 (Automations) → Sprint 12 (UI gaps).
>
> Cada um tem 5–30 T-IDs, com média de 3–5 ondas.

**Validação do sprint**:
- Toda T-ID tem `parallel-safe` declarado.
- Nenhum par de T-IDs `parallel-safe=yes` na mesma onda edita o mesmo arquivo.
- Mudanças em `30-contracts/` são SEMPRE seriais (parallel-safe=no, sozinha na onda).

---

## 16. ETAPA 12 — Meta (`docs/90-meta/`)

**Arquivos a criar**:
- `01-doc-conventions.md` — templates por tipo, regras de estilo
- `02-id-registry.md` — registro vivo de TODOS os IDs
- `03-open-questions-log.md` — (já criado)
- `04-decision-log.md` — (já criado)
- `05-subagent-playbook.md` — protocolo operacional para rodar N subagents em paralelo
- `archive/` — material histórico (PRD original, drafts antigos)

### TEMPLATE — `05-subagent-playbook.md`

```md
# Subagent Playbook

## 1. Unidade de paralelização
Unidade = T-ID com parallel-safe=yes.

## 2. Protocolo de onda
1. Pegue N T-IDs Ready com arquivos disjuntos (consultar 97-ownership-matrix).
2. Despache em paralelo (1 mensagem com N chamadas Agent).
3. Aguarde TODAS terminarem.
4. Rode `pnpm typecheck && pnpm test`.
5. Se verde → próxima onda. Se vermelho → corrigir antes.

## 3. Máximo recomendado por onda: 3-5.

## 4. Tipos de subagent
| Subagent | Quando usar | Pode editar | Não edita |
|---|---|---|---|
| schema-author | criar/evoluir schema + migration | lib/db/schema/<mod>.ts, supabase/migrations | docs/30-contracts/ |
| domain-author | implementar BR-* puras | lib/domain/<mod>/** | I/O, DB direto |
| integration-author | adapter de webhook | lib/integrations/<provider>/** | domain |
| ui-author | telas + Server Actions | app/(app)/<mod>/**, components/<mod>/** | DB direto |
| test-author | escrever testes | tests/** | código de produção |
| br-auditor | review pré-merge | nada (só lê + reporta) | nada |
| docs-sync | sincroniza doc↔código | docs/20-domain, docs/30-contracts/07 | código |

## 5. Ordem fixa de carga de contexto
1. docs/README.md
2. AGENTS.md (+ CLAUDE.md se Claude)
3. Arquivo do módulo-alvo
4. BRs referenciadas
5. Contratos citados
6. Linha da T-ID no sprint

## 6. Quando escalar para humano
- Ambiguidade em BR
- Conflito entre dois docs canônicos
- Necessidade de novo enum
- Bloqueio de stack
- Mudança em 30-contracts vinda de outro módulo
```

### PROMPT — `02-id-registry.md`

```
Tarefa: gerar `docs/90-meta/02-id-registry.md` consolidando TODOS os IDs já criados.

Inputs: docs/** (toda a documentação atual).

Saída: tabelas separadas por prefixo (OBJ, REQ, PERSONA, MOD, BR, INV, CONTRACT, TE, FLOW, T, ADR, OQ).
Cada linha: ID | Nome | Documento canônico | Status.
Detecte duplicatas e reporte no fim.
```

---

## 17. ETAPA 13 — Arquivos da raiz

**Arquivos a criar**:

### `README.md`
Porta de entrada. Aponta humanos para `docs/README.md` e agentes para `AGENTS.md`. Lista stack e princípios.

### `AGENTS.md` (contrato agente-agnóstico)

```md
# AGENTS.md

## 1. Missão
## 2. Stack canônica (não substituir sem ADR)
## 3. Convenções de repositório (layout, naming, camadas)
## 4. Protocolo de trabalho
   4.1. Antes de editar (carga de contexto)
   4.2. Como adicionar agregado novo
   4.3. Como citar regra em código (// BR-XXX:)
## 5. Regras de ouro ("não faça") — mín. 12 itens
## 6. Onde encontrar o quê (tabela de perguntas → arquivo)
## 7. Protocolo de ambiguidade (registrar OQ)
## 8. Critério de "pronto" por tarefa (typecheck + lint + test + DoD)
```

### `CLAUDE.md` (adendo Claude Code — apenas o que difere de AGENTS.md)

```md
# CLAUDE.md

## 1. Estratégia de subagents (tabela: situação → subagent nativo ou customizado)
## 2. Paralelização — protocolo operacional (T-IDs em ondas)
## 3. Ordem fixa de carga de contexto (referencia AGENTS.md §4.1)
## 4. Comandos de verificação (pnpm typecheck/lint/test/test:e2e/db:generate)
## 5. Comandos proibidos sem aprovação (push -f, reset --hard, db reset, drop)
## 6. Skills disponíveis
## 7. Citação de regra em código
## 8. Quando pedir decisão ao humano
## 9. Interação com memória (.claude/memory/)
## 10. Sincronização de doc-sync (regra do mesmo commit + [SYNC-PENDING])
## 11. Subagents customizados disponíveis (ver .claude/agents/)
## 12. Conformidade de stack (protocolo de bloqueio: pare → MEMORY.md → escalone)
```

### `MEMORY.md` (volátil — estado de sessão)

```md
# MEMORY.md

## §0 Feedback operacional
## §1 Bloqueios e pendências de stack [STACK-BLOQUEIO]
## §2 Divergências doc ↔ código [SYNC-PENDING]
## §3 Modelo de negócio (decisões do usuário)
## §4 Estado dos Sprints — fontes canônicas
## §5 Ponto atual de desenvolvimento
   - Sprint atual
   - Último commit
   - Migrations aplicadas
   - Como retomar em novo contexto (1-N passos)
## §6 Ambiente operacional
```

### `TESTING.md`

```md
# TESTING.md

## Comandos rápidos
## Pirâmide (referencia 10-architecture/10-testing-strategy.md)
## Camada 1 — Unit (regras, padrões, fixtures, cobertura alvo)
## Camada 2 — Integration (DB real, HMAC real, padrões de trigger e webhook)
## Camada 3 — E2E (mapa FLOW × spec)
## O que testar em cada sprint (tabela resumo de 80-roadmap/98-test-matrix-by-sprint.md)
## Definition of Done (testes)
## Setup de DB para integration (3 opções)
## CI
## Troubleshooting
```

### PROMPT — gerar AGENTS.md

```
Tarefa: gerar `AGENTS.md`.

Inputs:
- docs/README.md
- docs/00-product/* (todos)
- docs/10-architecture/02-stack.md
- docs/10-architecture/09-module-boundaries.md
- docs/20-domain/README.md
- docs/30-contracts/README.md
- docs/50-business-rules/README.md
- docs/80-roadmap/README.md
- docs/90-meta/01-doc-conventions.md
- docs/90-meta/05-subagent-playbook.md (se já existir)

Restrições:
- Use a estrutura das 8 seções listadas.
- Stack na §2 deve ser tabela com tecnologia + versão pinada.
- §5 Regras de ouro: NUNCA menos que 12 itens. Cada um imperativo ("Não faça X").
- §6 deve ter ≥ 8 perguntas frequentes mapeadas.
- §8 DoD: typecheck + lint + test + critério de aceite + sem aumento silencioso de OQs.
```

### PROMPT — gerar CLAUDE.md

```
Tarefa: gerar `CLAUDE.md` (NÃO duplica AGENTS.md — só adiciona).

Inputs:
- AGENTS.md
- docs/90-meta/05-subagent-playbook.md
- Lista de subagents customizados em .claude/agents/* (cole nomes e descrições)

Restrições:
- §1 tabela: "situação → subagent". Se houver subagent customizado, prefira-o ao genérico.
- §5 Comandos proibidos: liste ≥ 6 comandos com motivo.
- §10 doc-sync: tabela "código alterado → doc obrigatória".
- §12: protocolo PARE-DOCUMENTE-ESCALE quando item da stack está bloqueado.
```

---

## 18. ETAPA 14 — Subagents customizados (`.claude/agents/`)

Crie um subagent customizado para cada papel recorrente do roadmap. Isso evita re-explicar contexto em cada T-ID.

### TEMPLATE — agente customizado (formato Claude Code)

```yaml
---
name: <prefix>-<role>-author
description: <1 frase — quando invocar>
tools: Read, Edit, Write, Bash, Grep, Glob
---

Você é o subagent <ROLE> do projeto <NOME>.

## Ownership
Edita APENAS:
- <paths concretos>

NÃO edita:
- docs/30-contracts/** (salvo se a tarefa explicitamente é contract-change)
- arquivos fora do módulo da T-ID

## Ordem obrigatória de carga de contexto
1. docs/README.md
2. AGENTS.md
3. CLAUDE.md
4. docs/20-domain/<módulo da T-ID>.md
5. BRs referenciadas
6. docs/30-contracts/<contratos citados>
7. linha da T-ID em docs/80-roadmap/<sprint>.md

## Saída esperada
- <artefato 1>
- <artefato 2>
- typecheck + test verde

## Quando parar e escalar
- Ambiguidade em BR
- Necessidade de novo enum
- Edição fora do ownership
```

### EXEMPLO (CNE-OS) — 7 subagents

> `cne-schema-author`, `cne-domain-author`, `cne-integration-author`, `cne-ui-author`, `cne-test-author`, `cne-br-auditor`, `cne-docs-sync`.

### PROMPT

```
Tarefa: gerar `.claude/agents/<nome>.md` para o papel <ROLE>.

Inputs:
- docs/90-meta/05-subagent-playbook.md (tabela "tipos de subagent")
- AGENTS.md §3 (camadas + naming)
- docs/10-architecture/09-module-boundaries.md

Saída: arquivo seguindo o TEMPLATE de agente customizado.
- Frontmatter YAML com name, description, tools.
- Ownership com paths concretos da stack do projeto.
- Ordem de carga de contexto idêntica ao playbook.
- Critério de "parar e escalar" mínimo 4 condições.
```

---

## 19. ETAPA 15 — Loop de execução de sprint

Com toda a documentação acima pronta, o desenvolvimento executa em loop:

```
Para cada sprint:
  Para cada onda de paralelização do sprint:
    1. Selecione T-IDs da onda (parallel-safe=yes, ownership disjunto)
    2. Para cada T-ID:
       a. Monte context packet:
          - docs/20-domain/<MOD>.md
          - BRs referenciadas
          - contratos citados
          - linha da T-ID no sprint
       b. Despache subagent customizado correspondente
       c. Subagent: lê contexto → testes → código → typecheck → test
    3. Aguarde TODAS as T-IDs da onda terminarem
    4. Rode `pnpm typecheck && pnpm lint && pnpm test`
    5. Se verde:
       - despache `docs-sync` para varrer divergências
       - marque T-IDs como completed
       - registre estado em MEMORY.md §5
    6. Se vermelho:
       - corrija ANTES de avançar
  Ao final do sprint:
    - rode E2E (`pnpm test:e2e`)
    - atualize 99-acceptance-criteria-by-sprint.md (marque [x])
    - registre em MEMORY.md §4 que sprint X está concluído
    - ADR de qualquer decisão grande tomada no sprint
```

### PROMPT — kickoff de onda

```
Você é o orchestrator do sprint <N>, onda <K>.

T-IDs da onda (todas parallel-safe=yes, ownership disjunto):
- T-<N>-NNN: <título>
- T-<N>-NNN: <título>
- T-<N>-NNN: <título>

Para cada T-ID:
1. Confirme leitura do context packet listado em `docs/80-roadmap/<sprint>.md`.
2. Confirme ownership concreto.
3. Implemente testes ANTES do código.
4. Implemente código mínimo para os testes passarem.
5. Rode `pnpm typecheck && pnpm test -- <escopo>`.
6. Se verde, registre em MEMORY.md §5 e devolva controle.

Não toque em arquivo fora do ownership da SUA T-ID. Se precisar, registre OQ e pare.
```

---

## 20. Antipadrões a evitar

```
1. PRD monolítico sem IDs
2. Tela sem caso de uso / sem persona
3. Regra de negócio duplicada em vários docs
4. T-ID sem módulo + BR + critério de aceite
5. Subagent alterando contrato sem ADR
6. Dependência circular entre módulos
7. Banco modelado antes do domínio fechar
8. Implementação iniciada com SPEC ainda Draft
9. Mudança arquitetural sem ADR
10. Eventos sem schema versionado
11. Testes sem ligação com BR ou flow
12. Documentos órfãos fora do índice mestre
13. Context packet grande demais (entrega o repo inteiro)
14. MEMORY.md tratado como fonte canônica
15. docs/90-meta/archive/ usado como regra atual
16. Edição em 30-contracts/ paralela com outras T-IDs
17. AGENTS.md e CLAUDE.md repetindo conteúdo (CLAUDE.md só adiciona)
18. Workaround silencioso de stack (npm em vez de pnpm, fetch em vez de Server Action) sem registrar [STACK-BLOQUEIO]
```

---

## 21. Checklist de qualidade (antes de iniciar implementação)

```
[ ] Brief existe e responde "fora de escopo" claramente
[ ] Glossário cobre ≥ 20 termos
[ ] Personas + RBAC com matriz CRUD sem células vazias
[ ] Cada MOD-* tem ownership concreto + invariantes testáveis
[ ] 30-contracts/* completo: enums, schemas, eventos, interfaces, webhooks, audit, server actions
[ ] BRs cobrem todas as regras citadas em domínio (zero "TBD")
[ ] FLOWS-* têm passos numerados e fluxos alternativos
[ ] 02-stack.md pinado com ADRs
[ ] 10-testing-strategy.md define cobertura alvo por camada
[ ] Sprint atual tem T-IDs com: tipo, módulo, parallel-safe, depends-on, ownership, DoD
[ ] 97-ownership-matrix.md cobre todos os paths editáveis
[ ] 98-test-matrix-by-sprint.md amarra T-ID → teste → BR
[ ] 99-acceptance-criteria-by-sprint.md tem critério de aceite global
[ ] AGENTS.md tem ≥ 12 regras de ouro
[ ] CLAUDE.md NÃO duplica AGENTS.md
[ ] MEMORY.md tem §5 "Ponto atual de desenvolvimento"
[ ] TESTING.md tem comandos prontos
[ ] Subagents customizados criados em .claude/agents/
[ ] ID Registry consolidado e sem duplicatas
[ ] OQs abertas estão classificadas (bloqueante / pode esperar)
```

---

## 22. Diferenciador final — TEMPLATE vs EXEMPLO

| O que é universal (TEMPLATE) | O que foi específico do CNE-OS (EXEMPLO) |
|---|---|
| Pirâmide `00-90` em `docs/` | Os 15 módulos (MOD-CONTACT, MOD-OFFER, etc.) |
| Sistema de IDs (BR, FLOW, TE, T, ADR, OQ, MOD) | Stack: Next.js 15 + Supabase + Drizzle + Inngest + shadcn |
| Estrutura dos 5 arquivos da raiz | Layout `app/(app)/`, `lib/domain/`, `lib/integrations/`, `inngest/` |
| Princípios (contracts-first, doc-sync, ownership, OQ) | Subagents `cne-*` (7 especializados) |
| Templates de TEMPLATE (módulo, BR, flow, screen, T-ID, ADR) | Sprints: 0 → 12 com temas específicos (CRM, Inbox, Offer Engine, etc.) |
| Fluxo macro (15 etapas) | Convenção de naming em PT-BR para sprints |
| Loop de execução de sprint (ondas) | `[SYNC-PENDING]` e `[STACK-BLOQUEIO]` em MEMORY.md |
| Tabela de subagents (papéis) | TE-* específicos (TE-SALE-APPROVED, TE-AUTOMATION-EXECUTED, etc.) |

**Regra ao adaptar para outro projeto**:
1. **Copie literalmente** tudo na coluna esquerda.
2. **Substitua** tudo na coluna direita pelos equivalentes do seu projeto.
3. **Não invente colunas novas** sem ADR — significa que sua estrutura está fugindo do padrão.

---

## 23. Frase-guia

```
Nunca implemente algo que não esteja ligado a um requisito, uma persona,
um módulo, uma BR ou contrato, um flow, um teste e uma T-ID.
```

Versão operacional:

```
REQ → PERSONA → MOD → BR/CONTRACT → FLOW → T-ID → TEST → CODE → DOC-SYNC
```

Se em qualquer ponto da cadeia faltar um elo, **pare e registre uma OQ** antes de continuar. Esse é o único caminho seguro para que múltiplos subagents trabalhem em paralelo sem quebrar a coerência do sistema.
