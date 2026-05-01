# AGENTS.md

> Contrato agente-agnóstico do GlobalTracker. Vale para Claude Code, Cursor, qualquer agente. Adendos específicos do Claude Code em [`CLAUDE.md`](CLAUDE.md).

## 1. Missão

GlobalTracker é uma plataforma de tracking, atribuição e dispatch server-side para Meta Ads, Google Ads, GA4 e webhooks de plataformas de venda. Você está aqui para entregar T-IDs concretas do roadmap em ondas paralelas, respeitando ownership, BRs, contratos e privacidade.

## 2. Stack canônica (não substituir sem ADR)

| Camada | Tecnologia | Versão pinada |
|---|---|---|
| Edge runtime | Cloudflare Workers + Hono | hono ≥ 4 |
| Database | Postgres (Supabase) | PG 15+ |
| ORM | Drizzle | drizzle-orm ≥ 0.30 |
| DB connection | Hyperdrive | (gerenciado) |
| Filas | Cloudflare Queues | (gerenciado, at-least-once) |
| Cache | Cloudflare KV | (gerenciado) |
| Crons | CF Cron Triggers | (gerenciado) |
| Linguagem | TypeScript | tsc ≥ 5.4, `strict: true`, `noUncheckedIndexedAccess: true` |
| Validação | Zod | ≥ 3.22 |
| Tests | Vitest + Miniflare + Playwright | vitest ≥ 1 |
| Tracker | TS vanilla | bundle < 15 KB gz |
| Frontend (Fase 4) | Next.js 15 + shadcn | ≥ 15 |
| Orchestrator (Fase 5) | Trigger.dev | ≥ 3 |
| Package manager | pnpm | ≥ 9 |

Decisão em [ADR-001](docs/90-meta/04-decision-log.md#adr-001--stack-canônica). Substituir item exige novo ADR.

## 3. Convenções de repositório

### Layout

```
apps/{edge,tracker,control-plane,orchestrator,lp-templates}/
packages/{shared,db}/
tests/{unit,integration,e2e,fixtures}/
docs/{00-product,10-architecture,...,90-meta}/
.claude/agents/
```

### Naming

- Tabelas: `snake_case` plural — `lead_aliases`, `dispatch_jobs`.
- Colunas: `snake_case` — `email_hash`, `pii_key_version`.
- Funções TS: `camelCase` — `resolveLeadByAliases()`.
- Tipos TS: `PascalCase` — `LeadResolutionResult`.
- Constants: `UPPER_SNAKE` — `EVENT_TIME_CLAMP_WINDOW_SEC`.
- Identificadores em código: **inglês**.
- Documentação canônica em `docs/`: **português**.
- UI/copy: **português**.
- Conventional Commits: **inglês**.

### Camadas

```
routes/    → handlers HTTP (Hono); finos
middleware/ → auth, CORS, rate-limit, sanitize-logs
lib/       → lógica de domínio pura, sem I/O direto a DB
dispatchers/ → workers async para destinos externos
crons/     → handlers de CF Cron Triggers
```

Routes não chamam DB direto — vão por `lib/`. `lib/` recebe `db` via DI.

## 4. Protocolo de trabalho

### 4.1. Antes de editar — carga de contexto (ordem fixa)

1. `docs/README.md` — entender pirâmide.
2. `AGENTS.md` (este) + `CLAUDE.md` (se Claude Code).
3. `docs/20-domain/<NN>-mod-<name>.md` do módulo da T-ID.
4. BRs referenciadas pela T-ID (apenas as referenciadas — não a pasta inteira).
5. Contratos citados em `docs/30-contracts/`.
6. Linha exata da T-ID em `docs/80-roadmap/<sprint>.md`.

**NÃO carregar:**
- `planejamento.md` (histórico — usar fontes decompostas).
- Pastas inteiras quando T-ID precisa só de um arquivo.

### 4.2. Como adicionar agregado novo (módulo novo)

1. ADR justificando.
2. Criar `docs/20-domain/<NN>-mod-<name>.md` seguindo template.
3. Atualizar `docs/20-domain/README.md` com o novo MOD-* no mapa + grafo.
4. Atualizar `docs/90-meta/02-id-registry.md`.
5. Adicionar paths em `docs/80-roadmap/97-ownership-matrix.md`.
6. Criar T-IDs no sprint correspondente.

### 4.3. Como citar regra em código

```ts
// BR-IDENTITY-001: aliases ativos são únicos por (workspace_id, identifier_type, identifier_hash)
const conflict = await db.select()...;
```

Toda BR aplicada em código tem comentário com `BR-XXX-NNN: razão curta`. Auditor checa via grep.

## 5. Regras de ouro (12+ não-negociáveis)

1. **Não edite fora do ownership da sua T-ID.** Se precisar, pare e escale.
2. **Não toque em `docs/30-contracts/` em T-ID que não é tipo `contract-change`.** Mudança aqui é serial.
3. **Nunca persista PII em claro em logs, jsonb, payloads de erro.** Use `sanitizeLogs()` e schemas Zod restritivos.
4. **Nunca pule validação Zod em fronteiras HTTP/webhook/queue.** Endpoint sem schema é PR rejeitado.
5. **Nunca commit secret.** Use Wrangler secrets ou env. `.env*` em `.gitignore`.
6. **Nunca use `any` sem comentário com motivo.** `// eslint-disable-next-line ... reason: ...`.
7. **Nunca skip CI**. Verde em typecheck + lint + test antes de merge.
8. **Nunca crie evento sem `event_id` único + idempotência**. BR-EVENT-002.
9. **Nunca chame Meta/Google direto no request do browser.** Sempre via dispatch async.
10. **Nunca mexa em `lead_aliases` sem passar por `resolveLeadByAliases()`** — risco de quebrar merge.
11. **Nunca adicione enum sem atualizar `30-contracts/01-enums.md` + Zod.** Detectado por test.
12. **Nunca pula `recordAuditEntry()` em mutações sensíveis.** AUTHZ-012.
13. **Nunca confunda `lead_id` (interno) com `lead_public_id` (externo)**. Browser usa `lead_token`, nunca `lead_id` em claro.
14. **Nunca desabilite RLS** "porque é mais simples". Cross-workspace leak é sempre crítico.
15. **Nunca use destrutivo (drop column, push --force, db:reset) sem aprovação humana**.

## 6. Onde encontrar o quê

| Pergunta | Arquivo |
|---|---|
| O que esse produto faz? | `docs/00-product/01-brief.md` |
| Quem usa e com qual permissão? | `docs/00-product/03-personas-rbac-matrix.md` |
| Quais são os módulos e o que cada um possui? | `docs/20-domain/README.md` + arquivos do módulo |
| Qual o schema dessa tabela? | `docs/30-contracts/02-db-schema-conventions.md` + `packages/db/src/schema/` |
| Como autenticar request? | `docs/10-architecture/06-auth-rbac-audit.md` |
| Qual a regra X aplicável? | `docs/50-business-rules/BR-<DOMAIN>.md` |
| Qual o fluxo end-to-end? | `docs/60-flows/<NN>-<name>.md` |
| Por que essa decisão? | `docs/90-meta/04-decision-log.md` |
| Tem alguma dúvida aberta? | `docs/90-meta/03-open-questions-log.md` |
| O que vou fazer no sprint? | `docs/80-roadmap/<sprint>.md` |
| Qual subagent usar? | `docs/90-meta/05-subagent-playbook.md` § 3 |

## 7. Protocolo de ambiguidade

Se você encontra ambiguidade, faltam dados, ou contradição entre docs:

1. **Pare.** Não invente.
2. Registre OQ em `docs/90-meta/03-open-questions-log.md` (formato pronto).
3. Anote em `MEMORY.md §1` se for `[STACK-BLOQUEIO]` ou `[CONTRATO-BLOQUEIO]`.
4. Devolva controle ao humano com resumo do bloqueio.

## 8. Definition of Done

T-ID é considerada completa quando:

- [ ] `pnpm typecheck` verde.
- [ ] `pnpm lint` verde.
- [ ] `pnpm test` verde com cobertura alvo da camada (ver `docs/10-architecture/10-testing-strategy.md`).
- [ ] BR/INV/critério de aceite da T-ID atendido.
- [ ] Doc-sync feito no mesmo commit (ou `[SYNC-PENDING]` em `MEMORY.md §2`).
- [ ] Sem aumento silencioso de OQs (toda OQ aberta é justificada).
- [ ] PR description menciona T-ID + BRs aplicadas + arquivos editados.

Antes de marcar T-ID completa, rode `pnpm typecheck && pnpm lint && pnpm test` localmente e confirme verde.
