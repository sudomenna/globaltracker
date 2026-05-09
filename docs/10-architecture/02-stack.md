# 02 — Stack canônica

> Decisão de origem: [ADR-001](../90-meta/04-decision-log.md#adr-001--stack-canônica). Mudança de versão major exige novo ADR.

## Stack pinada

| Camada | Tecnologia | Versão pinada | ADR |
|---|---|---|---|
| Edge runtime | Cloudflare Workers + Hono | hono ≥ 4.x | ADR-001 |
| Database | Postgres (via Supabase managed) | PG 15+ | ADR-001 |
| ORM | Drizzle | drizzle-orm ≥ 0.30 | ADR-001 |
| DB connection | Cloudflare Hyperdrive | (gerenciado) | ADR-001 |
| Filas | Cloudflare Queues | (gerenciado, at-least-once) | ADR-001 |
| Cache / KV | Cloudflare KV | (gerenciado, **best-effort**) | ADR-001, ADR-040 |
| Crons | CF Cron Triggers | (gerenciado) | ADR-001 |
| Bundler edge | esbuild via Wrangler | wrangler ≥ 3.x | ADR-001 |
| Validação runtime | Zod | zod ≥ 3.22 | ADR-016 |
| Linguagem | TypeScript | tsc ≥ 5.4, `strict: true`, `noUncheckedIndexedAccess: true` | ADR-016 |
| Tests | Vitest + Miniflare + Playwright (E2E) | vitest ≥ 1.x | ADR-001 |
| Tracker bundle | TS vanilla via esbuild | bundle target ES2020 | — |
| Control Plane | Next.js App Router + shadcn/ui | next ≥ 15.x | ADR-001 |
| LP templates | Astro | astro ≥ 4.x | ADR-001 |
| Orchestrator (Fase 5) | Trigger.dev | trigger.dev ≥ 3.x | ADR-008 |
| Analytics | Metabase | metabase ≥ 0.50 | ADR-018 |
| Package manager | pnpm | pnpm ≥ 9 | — |
| Format | Biome (preferred) ou Prettier + ESLint | — | — |

## Itens com regra de uso obrigatória

| Item | Regra | Bloqueio que dispara escalação |
|---|---|---|
| `tsconfig.json` | `strict: true`, `noUncheckedIndexedAccess: true`, `noImplicitOverride: true` | Build com `// @ts-ignore` sem comentário justificando dispara `[STACK-BLOQUEIO]` em MEMORY.md |
| Zod | Em todas fronteiras HTTP, webhooks, queues, jsonb columns lidos | Endpoint sem schema Zod é PR rejeitado |
| `any` | Permitido apenas com `// eslint-disable` + comentário com motivo | CI falha sem justificativa |
| Drizzle migrations | Versionadas em `packages/db/migrations/` | PR sem migration para schema change rejeitado |
| Hyperdrive | Em produção, toda query Postgres do Worker passa por Hyperdrive binding (`HYPERDRIVE`). Em dev local, aceita-se `DATABASE_URL` diretamente como escape hatch (definida em `.dev.vars`, nunca commitada com senha). | Direct connection sem Hyperdrive em produção é vetada; usar `DATABASE_URL` fora de dev local dispara `[STACK-BLOQUEIO]` em MEMORY.md |
| pnpm | npm/yarn proibidos para evitar lockfile drift | CI valida `pnpm-lock.yaml` único |

## Atualização de versão major

Atualizar major version (ex.: hono 4 → 5, next 15 → 16) exige:

1. ADR explicando motivação + breaking changes esperadas.
2. Branch dedicada para evolução.
3. CI com matriz de testes vs nova versão.
4. Plano de rollback documentado.
5. Aprovação de OWNER ou ADMIN com autoridade técnica.

Updates patch e minor: livres, sob CI green.

## Alternativas proibidas sem ADR

| Não usar | Em vez de |
|---|---|
| AWS Lambda | Cloudflare Workers |
| Vercel Edge Functions | CF Workers (consistência operacional) |
| Prisma | Drizzle (typesafe + migrations) |
| BullMQ / SQS / Kafka | CF Queues no MVP; Trigger.dev para workflows |
| MongoDB / DynamoDB | Postgres (jsonb + RLS são essenciais) |
| Redis | CF KV (suficiente para casos atuais; Redis se justificado) |
| `fetch` direto a Postgres | Hyperdrive binding |
| Express / Fastify | Hono (CF Workers compat) |

## Dependências runtime — política

- Tracker: zero deps runtime (INV-TRACKER-002).
- Edge: dependências mínimas, todas auditadas (sem `node-*` nativo — incompatível com Workers).
- Backend: deps gerenciadas por workspace `pnpm`.
- `npm audit` rodando em CI; vulnerabilidades high+ bloqueiam PR.

## Estrutura do monorepo

```
globaltracker/
├── apps/
│   ├── edge/              # Cloudflare Worker
│   │   ├── src/
│   │   ├── wrangler.toml
│   │   └── tsconfig.json
│   ├── tracker/           # tracker.js bundle
│   ├── control-plane/     # Next.js (Fase 4)
│   ├── orchestrator/      # Trigger.dev (Fase 5)
│   └── lp-templates/      # Astro (Fase 5)
├── packages/
│   ├── shared/            # contracts Zod, types, helpers puros
│   └── db/                # Drizzle schema + migrations + views.sql
├── tests/
│   ├── unit/
│   ├── integration/
│   ├── e2e/
│   └── fixtures/
├── docs/                  # esta pirâmide
├── .claude/agents/        # subagents customizados
├── pnpm-workspace.yaml
├── package.json
└── README.md
```
