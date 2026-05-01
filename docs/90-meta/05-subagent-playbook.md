# 05 — Subagent Playbook

Protocolo operacional para rodar N subagents em paralelo no GlobalTracker.

## 1. Unidade de paralelização

**Unidade = T-ID com `parallel-safe=yes` e ownership disjunto.**

Dois T-IDs paralelos só se:
- Ambos `parallel-safe=yes`.
- Os paths em "Ownership" não se sobrepõem (ver `80-roadmap/97-ownership-matrix.md`).
- Nenhum deles toca em `docs/30-contracts/**` (mudança de contrato é serial — sozinha na onda).

## 2. Protocolo de onda

```
Para cada onda:
  1. Selecione N T-IDs Ready (status pending, depends-on completos, parallel-safe=yes, ownership disjunto).
  2. Envie em UMA mensagem com N chamadas Agent (paralelas).
  3. Aguarde TODAS terminarem.
  4. Rode `pnpm typecheck && pnpm lint && pnpm test`.
  5. Se verde:
     - Despache `globaltracker-docs-sync` para verificar divergências doc↔código.
     - Marque T-IDs como completed no sprint.
     - Atualize MEMORY.md §5 (ponto atual).
  6. Se vermelho:
     - Corrija ANTES de avançar para próxima onda.
     - Não acumule erros.
```

**Máximo recomendado por onda:** 3–5. Acima disso, contexto do orchestrator fica saturado.

## 3. Tipos de subagent (GlobalTracker)

| Subagent | Quando usar | Pode editar | Não edita |
|---|---|---|---|
| `globaltracker-schema-author` | Criar/evoluir schema Drizzle + migrations | `packages/db/schema/<mod>.ts`, `packages/db/migrations/`, `packages/db/views.sql` | `docs/30-contracts/`, `apps/**/dispatchers` |
| `globaltracker-domain-author` | Implementar BRs puras, lead resolver, attribution, idempotency | `apps/edge/src/lib/<file>.ts` (lógica de domínio sem I/O direto), `tests/unit/` | I/O direto a DB, dispatchers, schema |
| `globaltracker-edge-author` | Rotas HTTP, middleware, validação Zod nas fronteiras | `apps/edge/src/routes/**`, `apps/edge/src/middleware/**` | Lógica de domínio profunda, schema |
| `globaltracker-dispatcher-author` | Adapters out (Meta CAPI, Google Ads, GA4) | `apps/edge/src/dispatchers/<provider>/**`, fixtures | Schema, rotas |
| `globaltracker-webhook-author` | Adapters in (Hotmart, Stripe, Kiwify, etc.) | `apps/edge/src/routes/webhooks/<provider>.ts`, fixtures | Outros módulos |
| `globaltracker-tracker-author` | tracker.js front-end | `apps/tracker/**`, bundle config | Backend |
| `globaltracker-test-author` | Escrever testes (unit, integration, E2E) | `tests/**`, `tests/fixtures/**` | Código de produção |
| `globaltracker-br-auditor` | Review pré-merge (lê + reporta, não edita) | nada | nada — só lê e devolve relatório |
| `globaltracker-docs-sync` | Sincroniza doc↔código após mudanças | `docs/20-domain/`, `docs/30-contracts/07-module-interfaces.md`, `MEMORY.md §2` | Código de produção |

## 4. Ordem fixa de carga de contexto

Todo subagent carrega **nesta ordem**, parando ao primeiro que não tiver permissão de ler:

1. `docs/README.md` — entender pirâmide.
2. `AGENTS.md` (e `CLAUDE.md` se for Claude Code).
3. Arquivo do módulo-alvo: `docs/20-domain/<NN>-mod-<name>.md`.
4. BRs referenciadas pela T-ID (e somente essas — não a pasta inteira).
5. Contratos citados na T-ID.
6. A linha exata da T-ID em `docs/80-roadmap/<sprint>.md`.

**NÃO carregar:**
- O monolito `planejamento.md` (é histórico — usar fontes decompostas).
- Pastas inteiras quando uma T-ID só precisa de um arquivo.

## 5. Quando escalar para humano

Subagent **deve parar e escalar** se:

1. **Ambiguidade em BR** que afeta a T-ID e não está em `docs/50-business-rules/`.
2. **Conflito entre dois docs canônicos** (ex.: BR diz X, contrato diz Y).
3. **Necessidade de novo enum** não listado em `30-contracts/01-enums.md`.
4. **Mudança em `30-contracts/`** vinda de fora do escopo da T-ID atual.
5. **Bloqueio de stack** (item da stack não funciona conforme esperado).
6. **Conflito de ownership** (T-ID precisa editar arquivo que pertence a outro módulo).
7. **OQ aberta bloqueante** que afeta a T-ID.

Forma de escalar:
1. Pare o trabalho.
2. Registre OQ em `docs/90-meta/03-open-questions-log.md` (formato pronto).
3. Anote em `MEMORY.md §1` como `[STACK-BLOQUEIO]` ou `[CONTRATO-BLOQUEIO]`.
4. Devolva controle ao humano com resumo do bloqueio.

## 6. Comandos de verificação obrigatórios

```bash
pnpm typecheck       # tsc --noEmit em todos pacotes
pnpm lint            # eslint
pnpm test            # vitest unit + integration
pnpm test:e2e        # playwright (apenas no fim do sprint)
pnpm db:generate     # drizzle migrations diff
pnpm build           # cf workers build (smoke)
```

DoD inclui pelo menos `typecheck` + `lint` + `test` verdes.

## 7. Comandos proibidos sem aprovação humana explícita

| Comando | Motivo |
|---|---|
| `git push -f` / `git push --force-with-lease` em `main` | Sobrescrever histórico publicado |
| `git reset --hard` | Perde trabalho não-commitado |
| `pnpm db:reset` / `drizzle-kit drop` | Apaga dados |
| `wrangler delete` em recursos prod | Desliga produção |
| Edição de `docs/30-contracts/**` em T-ID que não é tipo `contract-change` | Quebra contratos consumidos por outros módulos |
| Edição fora do ownership declarado da T-ID | Viola regra de paralelização |

## 8. Doc-sync — tabela de gatilhos

Quando você muda algo na coluna esquerda, **deve** atualizar a coluna direita no mesmo commit (ou marcar `[SYNC-PENDING]` em `MEMORY.md §2`):

| Mudou em código | Atualiza em |
|---|---|
| `packages/db/schema/<mod>.ts` | `docs/20-domain/<NN>-mod-<name>.md` (Entidades + Invariantes) |
| Função pública em `apps/edge/src/lib/<mod>/index.ts` | `docs/30-contracts/07-module-interfaces.md` |
| Novo enum em código | `docs/30-contracts/01-enums.md` |
| Novo TE-* emitido | `docs/30-contracts/03-timeline-event-catalog.md` |
| Comportamento de webhook adapter | `docs/40-integrations/<NN>-<provider>.md` |
| Nova BR aplicada em código (com `// BR-XXX:`) | Confirmar que `docs/50-business-rules/BR-<DOMAIN>.md` tem a regra |
| Nova rota HTTP | `docs/30-contracts/05-api-server-actions.md` |
| Nova migration | `docs/10-architecture/11-migration-rollback.md` (lista de migrations) |

## 9. Citação de regra em código

```ts
// BR-IDENTITY-003: aliases ativos são únicos por (workspace_id, identifier_type, identifier_hash)
const conflict = await db.select().from(leadAliases)
  .where(and(
    eq(leadAliases.workspaceId, workspaceId),
    eq(leadAliases.identifierType, type),
    eq(leadAliases.identifierHash, hash),
    eq(leadAliases.status, 'active'),
  ));
```

Toda BR aplicada em código deve ter comentário com `BR-XXX-NNN:` e razão curta. Auditor checa via grep: `grep -r "BR-IDENTITY-003" apps/`.

## 10. Quando pedir decisão ao humano (vs registrar OQ)

| Situação | Ação |
|---|---|
| Decisão técnica entre 2-3 opções equivalentes | Registrar OQ + sugerir default + aguardar |
| Decisão envolve trade-off de UX/produto | Pedir decisão imediatamente |
| Decisão envolve segurança (PII, auth) | Pedir decisão + não implementar até resposta |
| Decisão envolve dinheiro (custo de provedor, tier) | Pedir decisão imediatamente |
| Decisão tem ADR existente que parece se aplicar | Aplicar e citar ADR; se incerto, perguntar antes |

## 11. Subagents customizados disponíveis

Ver `.claude/agents/` (gerados na Fase 8 deste rollout):
- `globaltracker-schema-author.md`
- `globaltracker-domain-author.md`
- `globaltracker-edge-author.md`
- `globaltracker-dispatcher-author.md`
- `globaltracker-webhook-author.md`
- `globaltracker-tracker-author.md`
- `globaltracker-test-author.md`
- `globaltracker-br-auditor.md`
- `globaltracker-docs-sync.md`
