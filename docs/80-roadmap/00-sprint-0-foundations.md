# Sprint 0 — Foundations

## Duração estimada
1 semana.

## Objetivo do sprint
Setup técnico do monorepo, CI, secrets, ambiente de dev. Sem código de domínio — apenas fundação operacional.

## Pré-requisitos
- Decisões D1-D5 confirmadas (já feitas).
- Conta Cloudflare + Supabase + GitHub repository criados.
- Secret rotação inicial: `PII_MASTER_KEY_V1`, `LEAD_TOKEN_HMAC_SECRET` gerados.

## Critério de aceite global do sprint

- [ ] `pnpm install && pnpm typecheck && pnpm lint && pnpm test` rodando local.
- [ ] CI verde em PR de exemplo.
- [ ] Wrangler dev funciona em `apps/edge`.
- [ ] Supabase local (CLI) com migration zero aplicada.
- [ ] Documentação `AGENTS.md` + `CLAUDE.md` em pé.
- [ ] `.claude/agents/` populado.

## Tarefas

### T-0-001 — Inicializar monorepo pnpm com workspaces

- **Tipo:** infra
- **Módulo alvo:** raiz
- **Subagent recomendado:** general-purpose
- **Parallel-safe:** no (fundacional)
- **Depends-on:** nenhum
- **Ownership:** raiz
  - `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `.gitignore`
- **Inputs de contexto:** `docs/10-architecture/02-stack.md`
- **DoD:**
  - [ ] `pnpm install` resolve com sucesso.
  - [ ] Workspaces resolvidos: `apps/*`, `packages/*`.
  - [ ] `tsc --noEmit` em raiz passa (sem código ainda).

### T-0-002 — Criar `packages/shared` com Zod base

- **Tipo:** schema
- **Módulo alvo:** todos (compartilhado)
- **Subagent recomendado:** globaltracker-domain-author
- **Parallel-safe:** yes (após T-0-001)
- **Depends-on:** [T-0-001]
- **Ownership:**
  - `packages/shared/package.json`
  - `packages/shared/src/contracts/enums.ts` (extrair de `30-contracts/01-enums.md`)
  - `packages/shared/src/contracts/types.ts`
- **DoD:**
  - [ ] Enums todos exportados conforme `01-enums.md`.
  - [ ] Tipos básicos (`Result`, `Ctx`, `ActorRef`, etc.) exportados.
  - [ ] Build limpo.

### T-0-003 — Criar `packages/db` com Drizzle setup vazio

- **Tipo:** schema
- **Módulo alvo:** todos
- **Subagent recomendado:** globaltracker-schema-author
- **Parallel-safe:** yes (após T-0-001)
- **Depends-on:** [T-0-001]
- **Ownership:**
  - `packages/db/package.json`
  - `packages/db/drizzle.config.ts`
  - `packages/db/src/schema/index.ts` (vazio, exports placeholder)
  - `packages/db/migrations/` (empty)
- **DoD:**
  - [ ] `drizzle-kit generate` executa.
  - [ ] Build limpo.

### T-0-004 — Criar `apps/edge` com Hono base

- **Tipo:** infra
- **Módulo alvo:** MOD-EVENT (placeholder)
- **Subagent recomendado:** globaltracker-edge-author
- **Parallel-safe:** yes (após T-0-001)
- **Depends-on:** [T-0-001, T-0-002]
- **Ownership:**
  - `apps/edge/package.json`
  - `apps/edge/wrangler.toml`
  - `apps/edge/src/index.ts` (Hono app com `GET /health` retornando 200)
- **DoD:**
  - [ ] `wrangler dev` sobe local.
  - [ ] `curl localhost:8787/health` retorna 200 OK.

### T-0-005 — Setup Supabase local + migration zero

- **Tipo:** infra
- **Módulo alvo:** raiz
- **Subagent recomendado:** globaltracker-schema-author
- **Parallel-safe:** yes (após T-0-003)
- **Depends-on:** [T-0-003]
- **Ownership:**
  - `supabase/config.toml`
  - `packages/db/migrations/0000_initial.sql` (apenas extensions: `pgcrypto`, `uuid-ossp`)
- **DoD:**
  - [ ] `supabase start` sobe Postgres local.
  - [ ] `pnpm db:push` aplica migration zero.
  - [ ] Connection from Wrangler dev via Hyperdrive emulator funciona (ou bypass com pg client local em dev).

### T-0-006 — CI no GitHub Actions

- **Tipo:** infra
- **Módulo alvo:** raiz
- **Subagent recomendado:** general-purpose
- **Parallel-safe:** yes (após T-0-001)
- **Depends-on:** [T-0-001]
- **Ownership:**
  - `.github/workflows/ci.yml`
- **DoD:**
  - [ ] CI roda: `pnpm install`, `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build` em cada PR.
  - [ ] Branch protection rule em `main` exige CI verde.

### T-0-007 — `AGENTS.md`, `CLAUDE.md`, `MEMORY.md`, `TESTING.md`, `README.md`

- **Tipo:** docs
- **Módulo alvo:** raiz
- **Subagent recomendado:** globaltracker-docs-sync
- **Parallel-safe:** yes (após T-0-001)
- **Depends-on:** [T-0-001]
- **Ownership:** raiz (5 arquivos)
- **Inputs:** `docs/00-product/`, `docs/10-architecture/`, `docs/90-meta/05-subagent-playbook.md`
- **DoD:**
  - [ ] AGENTS.md ≥ 12 regras de ouro.
  - [ ] CLAUDE.md adendo (não duplica AGENTS).
  - [ ] MEMORY.md template com seções §0-§6.
  - [ ] TESTING.md com comandos rápidos.

### T-0-008 — Subagents customizados em `.claude/agents/`

- **Tipo:** infra
- **Módulo alvo:** raiz
- **Subagent recomendado:** general-purpose
- **Parallel-safe:** yes (após T-0-007)
- **Depends-on:** [T-0-007]
- **Ownership:** `.claude/agents/*.md`
- **DoD:**
  - [ ] 9 subagents (lista em `90-meta/05-subagent-playbook.md` §11).
  - [ ] Cada um tem frontmatter YAML válido.
  - [ ] Ownership concreto declarado em cada.

## Ondas de paralelização

| Onda | T-IDs | Bloqueio |
|---|---|---|
| 1 | T-0-001 | nenhum |
| 2 | T-0-002, T-0-003, T-0-004, T-0-006 (paralelas) | depende de T-0-001 |
| 3 | T-0-005, T-0-007 | T-0-003, T-0-004 |
| 4 | T-0-008 | T-0-007 |
