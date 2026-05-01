# CLAUDE.md — adendo Claude Code

> **Não duplica AGENTS.md.** Apenas adiciona o que é específico do Claude Code.

## 1. Estratégia de subagents

| Situação | Subagent recomendado |
|---|---|
| Mudança em schema Drizzle / migration | `globaltracker-schema-author` |
| Implementar BR pura, lead resolver, attribution, idempotency | `globaltracker-domain-author` |
| Rotas HTTP, middleware, validação Zod nas fronteiras | `globaltracker-edge-author` |
| Dispatcher Meta CAPI / Google Ads / GA4 | `globaltracker-dispatcher-author` |
| Webhook adapter (Hotmart/Stripe/Kiwify/etc.) | `globaltracker-webhook-author` |
| `tracker.js` front-end | `globaltracker-tracker-author` |
| Testes unit/integration/E2E | `globaltracker-test-author` |
| Review pré-merge / auditoria de BR | `globaltracker-br-auditor` |
| Sincronização doc↔código | `globaltracker-docs-sync` |
| Tarefas exploratórias / multi-domínio | `general-purpose` ou `Explore` |

Sempre prefira subagent customizado quando aplicável. Se T-ID atravessa múltiplos módulos, decompor em sub-T-IDs por subagent.

## 2. Paralelização — protocolo operacional

Resumo (detalhe em [`docs/90-meta/05-subagent-playbook.md`](docs/90-meta/05-subagent-playbook.md)):

```
Para cada onda da sprint:
  1. Selecione N T-IDs Ready (parallel-safe=yes, ownership disjunto).
  2. Despache N Agent calls em UMA mensagem (paralelo).
  3. Aguarde TODAS terminarem.
  4. pnpm typecheck && pnpm lint && pnpm test.
  5. Se verde: docs-sync, marca completed, MEMORY.md §5.
  6. Se vermelho: corrija ANTES da próxima onda.
```

Máximo: 3-5 T-IDs por onda. Mudanças em `docs/30-contracts/` = sempre serial (sozinhas na onda).

## 3. Ordem fixa de carga de contexto

Referencia [AGENTS.md §4.1](AGENTS.md#41-antes-de-editar--carga-de-contexto-ordem-fixa). Resumo:

1. `docs/README.md` → 2. `AGENTS.md` + `CLAUDE.md` → 3. arquivo do módulo-alvo → 4. BRs referenciadas → 5. contratos citados → 6. linha da T-ID.

## 4. Comandos de verificação

```bash
pnpm typecheck            # tsc --noEmit em todos pacotes
pnpm lint                 # eslint
pnpm test                 # vitest unit + integration
pnpm test:e2e             # playwright (apenas no fim do sprint)
pnpm db:generate          # drizzle migrations diff
pnpm build                # cf workers build (smoke)
```

DoD inclui pelo menos `typecheck` + `lint` + `test` verdes.

## 5. Comandos proibidos sem aprovação humana explícita

| Comando | Motivo |
|---|---|
| `git push -f` em `main` | Sobrescrever histórico publicado |
| `git reset --hard` | Perde trabalho não-commitado |
| `pnpm db:reset` / `drizzle-kit drop` | Apaga dados |
| `wrangler delete` em recursos prod | Desliga produção |
| Edição em `docs/30-contracts/**` em T-ID que não é `contract-change` | Quebra contratos consumidos |
| Edição fora do ownership declarado | Viola paralelização |
| `npm install` (em vez de pnpm) | Quebra workspace |

## 6. Skills disponíveis

(Mantenha lista atualizada quando adicionar skills custom.)

- **Built-in Claude Code**: bash, file ops, read/edit/write, ToolSearch.
- **Custom subagents** em `.claude/agents/` (lista em §1).
- **MCP servers** se configurados (não há por default).

## 7. Citação de regra em código

Toda BR aplicada em código deve ter comentário:

```ts
// BR-IDENTITY-005: lead_token tem binding obrigatório a page_token_hash
const isValid = pageTokenHashClaim === currentPageTokenHash;
```

Auditor `globaltracker-br-auditor` checa via grep antes de merge.

## 8. Quando pedir decisão ao humano

Use `AskUserQuestion` quando:
- Decisão técnica entre 2-3 opções equivalentes (sem ADR existente).
- Decisão envolve trade-off de UX/produto.
- Decisão envolve segurança (PII, auth) — não implementar até resposta.
- Decisão envolve dinheiro (custo de provedor, tier).
- Conflito entre docs canônicos.

Se decisão tem ADR existente que parece se aplicar: aplicar e citar ADR; se incerto, perguntar antes.

## 9. Interação com memória

`.claude/memory/` é cache local. **Não é canônico.** Decisões importantes migram para ADR em `docs/90-meta/04-decision-log.md`.

Em sessões longas, use `MEMORY.md §5` (raiz, não `.claude/memory/`) para registrar ponto atual de desenvolvimento — esse é compartilhado entre humanos e agentes.

## 10. Sincronização doc-sync

Tabela "código alterado → doc obrigatória" — ver [`docs/90-meta/05-subagent-playbook.md`](docs/90-meta/05-subagent-playbook.md) § 8.

Mudou comportamento? Atualize doc no mesmo commit. Se impossível, registre `[SYNC-PENDING]` em `MEMORY.md §2` com prazo (até final do sprint).

## 11. Subagents customizados disponíveis

Em `.claude/agents/`:

| Subagent | Edita | Não edita |
|---|---|---|
| `globaltracker-schema-author` | `packages/db/schema/`, migrations | `docs/30-contracts/`, dispatchers |
| `globaltracker-domain-author` | `apps/edge/src/lib/`, `tests/unit/` | I/O direto a DB, schema |
| `globaltracker-edge-author` | `apps/edge/src/routes/`, `middleware/` | Domain logic profunda, schema |
| `globaltracker-dispatcher-author` | `apps/edge/src/dispatchers/`, fixtures | Schema, rotas |
| `globaltracker-webhook-author` | `apps/edge/src/routes/webhooks/`, fixtures | Outros módulos |
| `globaltracker-tracker-author` | `apps/tracker/`, bundle config | Backend |
| `globaltracker-test-author` | `tests/`, fixtures | Código de produção |
| `globaltracker-br-auditor` | nada (read-only) | nada |
| `globaltracker-docs-sync` | `docs/20-domain/`, `30-contracts/07-module-interfaces.md`, `MEMORY.md §2` | Código de produção |

## 12. Conformidade de stack — protocolo de bloqueio

Se um item da stack não funciona conforme esperado:

```
PARE → DOCUMENTE → ESCALE
1. Pare a T-ID.
2. Documente em MEMORY.md §1 como [STACK-BLOQUEIO]:
   - Item da stack
   - Comportamento esperado
   - Comportamento observado
   - Hipótese
   - Tentativas feitas
3. Devolva controle ao humano com resumo.
```

Não tente workaround silencioso (e.g., trocar `pnpm` por `npm`, `Hyperdrive` por `pg` direto). Workarounds disfarçam o problema e quebram quando outro agente entra.
