# AGENTS.md — Contrato base dos subagents

> **Quem você é**: um subagent. Recebeu uma T-ID de escopo fechado de um orquestrador. Você implementa **dentro do ownership que ele te entregou**, citando BRs, com doc-sync no mesmo commit.
>
> **Você NÃO** lê toda a documentação. O orquestrador já te passou no prompt o que você precisa carregar (módulo, BRs, contratos relevantes, linha da T-ID). Não fuja desse escopo.
>
> Mapa completo da doc, decision tree de subagents e protocolo de paralelização vivem em [`CLAUDE.md`](CLAUDE.md) (orquestrador) — você não precisa.

---

## 1. Stack canônica (não substituir sem ADR)

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

Decisão em [ADR-001](docs/90-meta/04-decision-log.md). Substituir item exige novo ADR.

Se a stack não funciona como esperado, **pare e registre** em `MEMORY.md §1` como `[STACK-BLOQUEIO]`. Não tente workaround silencioso.

---

## 2. Convenções de naming e layout

### Layout do repo (visão alto-nível)

```
apps/{edge,tracker,control-plane,orchestrator,lp-templates}/
packages/{shared,db}/
tests/{unit,integration,e2e,fixtures}/
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

### Camadas dentro de `apps/edge/src/`

```
routes/      → handlers HTTP (Hono); finos
middleware/  → auth, CORS, rate-limit, sanitize-logs
lib/         → lógica de domínio pura, sem I/O direto a DB
dispatchers/ → workers async para destinos externos
crons/       → handlers de CF Cron Triggers
```

`routes/` não chamam DB direto — vão por `lib/`. `lib/` recebe `db` via DI.

---

## 3. Regras de ouro (não-negociáveis)

1. **Não edite fora do ownership declarado pelo orquestrador.** Se precisar, **pare** e devolva controle.
2. **Não toque em `docs/30-contracts/`** se sua T-ID não é tipo `contract-change`. Mudança aqui é serial.
3. **Nunca persista PII em claro** em logs, jsonb, payloads de erro. Use `sanitizeLogs()` e schemas Zod restritivos.
4. **Nunca pule validação Zod** em fronteiras HTTP/webhook/queue. Endpoint sem schema é PR rejeitado.
5. **Nunca commit secret.** Use Wrangler secrets ou env. `.env*` em `.gitignore`.
6. **Nunca use `any`** sem comentário com motivo: `// eslint-disable-next-line ... reason: ...`.
7. **Nunca skip CI.** `pnpm typecheck && pnpm lint && pnpm test` verde antes de marcar T-ID completa.
8. **Nunca crie evento sem `event_id` único + idempotência** (BR-EVENT-002).
9. **Nunca chame Meta/Google direto no request do browser.** Sempre via dispatch async.
10. **Nunca mexa em `lead_aliases` sem passar por `resolveLeadByAliases()`** — risco de quebrar merge.
11. **Nunca adicione enum** sem atualizar `docs/30-contracts/01-enums.md` + Zod (detectado por test).
12. **Nunca pule `recordAuditEntry()`** em mutações sensíveis (AUTHZ-012).
13. **Nunca confunda `lead_id` (interno) com `lead_public_id` (externo).** Browser usa `lead_token`, nunca `lead_id` em claro.
14. **Nunca desabilite RLS** "porque é mais simples". Cross-workspace leak é sempre crítico.
15. **Nunca use destrutivo** (drop column, push --force, db:reset) sem aprovação humana explícita.

---

## 4. Citação de BR em código

Toda BR aplicada em código tem comentário `BR-XXX-NNN: razão curta`:

```ts
// BR-IDENTITY-001: aliases ativos são únicos por (workspace_id, identifier_type, identifier_hash)
const conflict = await db.select()...;
```

```ts
// BR-EVENT-002: event_id é único por workspace; replay protection no Edge
if (await isReplay(workspaceId, eventId, ctx)) return { status: 'duplicate_accepted' };
```

`globaltracker-br-auditor` checa via grep antes de merge — comentário ausente bloqueia PR.

---

## 5. Doc-sync no mesmo commit

Mudou comportamento de qualquer módulo? **Atualize a doc canônica no mesmo commit**. Tabela "código → doc obrigatória" em [`docs/90-meta/05-subagent-playbook.md §8`](docs/90-meta/05-subagent-playbook.md).

Se for impossível atualizar doc no mesmo commit (ex.: contrato muda, mas a doc é `30-contracts/` que sua T-ID não pode tocar), registre `[SYNC-PENDING]` em `MEMORY.md §2` com prazo (até final do sprint) e devolva ao orquestrador.

---

## 6. Protocolo de ambiguidade — pare-documente-escale

Se você encontra ambiguidade, faltam dados ou contradição entre docs:

1. **Pare.** Não invente.
2. Registre OQ em [`docs/90-meta/03-open-questions-log.md`](docs/90-meta/03-open-questions-log.md) (formato pronto no doc).
3. Anote em `MEMORY.md §1` se for `[STACK-BLOQUEIO]` ou `[CONTRATO-BLOQUEIO]`.
4. Devolva controle ao orquestrador com resumo do bloqueio.

**Nunca** invente solução para preencher gap. Subagent que inventa quebra paralelização.

---

## 7. Definition of Done

T-ID é completa quando:

- [ ] `pnpm typecheck` verde
- [ ] `pnpm lint` verde
- [ ] `pnpm test` verde com cobertura alvo da camada (ver [`docs/10-architecture/10-testing-strategy.md`](docs/10-architecture/10-testing-strategy.md))
- [ ] BR/INV/critério de aceite da T-ID atendido
- [ ] Doc-sync feito no mesmo commit (ou `[SYNC-PENDING]` em `MEMORY.md §2`)
- [ ] Sem aumento silencioso de OQs (toda OQ aberta é justificada)
- [ ] PR description menciona T-ID + BRs aplicadas + arquivos editados
- [ ] Comentário `BR-XXX-NNN:` em todo lugar onde BR é aplicada

Antes de declarar completa, rode `pnpm typecheck && pnpm lint && pnpm test` localmente e confirme verde.

---

## 8. Comandos proibidos sem aprovação humana

| Comando | Motivo |
|---|---|
| `git push -f` em `main` | Sobrescrever histórico publicado |
| `git reset --hard` | Perde trabalho não-commitado |
| `pnpm db:reset` / `drizzle-kit drop` | Apaga dados |
| `wrangler delete` em recursos prod | Desliga produção |
| Edição em `docs/30-contracts/**` em T-ID que não é `contract-change` | Quebra contratos consumidos |
| Edição fora do ownership declarado | Viola paralelização |
| `npm install` em vez de `pnpm` | Quebra workspace |

Encontrou um destes na sua T-ID? **Pare e escale.**

---

## 9. Saída esperada ao orquestrador

Ao terminar, devolva:

- **T-ID concluída**: `T-N-NNN`
- **Arquivos editados**: lista
- **BRs aplicadas**: `BR-X-NNN, ...`
- **Comandos rodados**: `pnpm typecheck/lint/test` resultado
- **OQs abertas**: se houver, com link ao OQ-NNN
- **`[SYNC-PENDING]`**: se houver doc não-atualizado
- **Próximo passo sugerido**: opcional, para o orquestrador planejar próxima onda
