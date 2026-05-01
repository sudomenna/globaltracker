# TESTING.md

> Guia operacional de testes. Estratégia detalhada em [`docs/10-architecture/10-testing-strategy.md`](docs/10-architecture/10-testing-strategy.md).

## Comandos rápidos

```bash
# Setup inicial
pnpm install
supabase start          # Postgres local

# Loops de desenvolvimento
pnpm typecheck          # tsc --noEmit em todos pacotes
pnpm lint               # eslint
pnpm test               # vitest unit + integration
pnpm test:watch         # vitest watch mode
pnpm test:coverage      # com coverage report

# Por pacote
pnpm --filter @globaltracker/edge test
pnpm --filter @globaltracker/db test

# E2E (lento — só no fim do sprint)
pnpm test:e2e
pnpm test:e2e -- --headed  # Playwright UI

# DB
pnpm db:generate        # gerar migration a partir de schema diff
pnpm db:push            # aplicar local
pnpm db:check           # validar consistency

# Build
pnpm build              # build de todos apps
pnpm --filter @globaltracker/edge dev   # wrangler dev
```

## Pirâmide

```
        ▲
       ╱ ╲      E2E (Playwright)            ~10%
      ╱   ╲     - FLOW-* end-to-end
     ╱─────╲
    ╱       ╲   Integration (Vitest+Miniflare+DB efêmero)  ~30%
   ╱         ╲  - DB constraints, RLS, RBAC, signatures
  ╱───────────╲ - Webhook idempotency
 ╱             ╲ Unit (Vitest puro)        ~60%
╱_______________╲ - Domain logic, mappers, BR
```

Detalhe em [`docs/10-architecture/10-testing-strategy.md`](docs/10-architecture/10-testing-strategy.md).

## Camada 1 — Unit (puro)

- Sem I/O, sem DB, sem fetch.
- Funções puras: `clampEventTime`, `computeIdempotencyKey`, `normalizeEmail`, mappers.
- Vitest. Rápido (< 5s para suite inteira em watch).

**Cobertura alvo:**
- `apps/edge/src/lib/`: ≥ 90%
- `apps/edge/src/integrations/*/mapper.ts`: ≥ 95%
- `apps/edge/src/middleware/`: 100%

```bash
pnpm test tests/unit/
```

## Camada 2 — Integration (DB real efêmero)

- DB efêmero por test run.
- Cada test cria schema isolado ou usa transaction rolled-back.
- Miniflare simula CF Workers + Queues + KV em memória.

**Setup de DB efêmero — opções:**

### Opção A — Supabase local CLI (recomendado para dev)

```bash
supabase start          # sobe Postgres + Realtime + outros
pnpm db:push            # aplica migrations
pnpm test tests/integration/
supabase stop           # ao terminar
```

### Opção B — Docker Postgres standalone

```bash
docker run -d --name pg-test -p 5432:5432 \
  -e POSTGRES_PASSWORD=postgres \
  postgres:15-alpine
pnpm db:push
pnpm test tests/integration/
```

### Opção C — Supabase branch (CI)

```bash
# CI cria branch automaticamente
# Usa env vars SUPABASE_BRANCH_URL
pnpm test:integration:ci
```

## Camada 3 — E2E (Playwright)

- Roda contra Worker em wrangler dev + DB de staging.
- Cobertura: cada FLOW-NN tem 1 spec.
- Lento (~minutos) — roda em CI nightly + PR marcados.

```bash
# Local
pnpm dev:edge &       # sobe Worker
pnpm test:e2e

# Headed (debug)
pnpm test:e2e -- --headed --debug

# Spec específica
pnpm test:e2e -- tests/e2e/flow-07-returning-lead.spec.ts
```

## Mapa FLOW × spec

| FLOW | Spec |
|---|---|
| FLOW-01 (instalar tracking) | `tests/e2e/flow-01-register-lp.spec.ts` |
| FLOW-02 (capturar lead) | `tests/e2e/flow-02-capture-lead.spec.ts` |
| FLOW-03 (Meta CAPI dedup) | `tests/e2e/flow-03-meta-capi-dedup.spec.ts` |
| FLOW-04 (Purchase webhook) | `tests/e2e/flow-04-purchase-webhook.spec.ts` |
| FLOW-05 (sync ICP audience) | `tests/e2e/flow-05-sync-icp.spec.ts` |
| FLOW-06 (dashboard) | (não E2E — view tests) |
| FLOW-07 (lead retornante) | `tests/e2e/flow-07-returning-lead.spec.ts` |
| FLOW-08 (merge convergente) | `tests/e2e/flow-08-merge-leads.spec.ts` |
| FLOW-09 (erasure SAR) | `tests/e2e/flow-09-erasure.spec.ts` |

## O que testar em cada sprint

Tabela completa em [`docs/80-roadmap/98-test-matrix-by-sprint.md`](docs/80-roadmap/98-test-matrix-by-sprint.md).

Resumo Sprint 1 (Fundação):
- Schema + RLS de cada módulo (constraints, isolamento).
- Helpers críticos: `pii.ts`, `lead-token.ts`, `event-time-clamp.ts`, `replay-protection.ts`.
- Endpoints fast accept retornam 202 corretamente.
- Smoke E2E (`smoke-fase-1.spec.ts`).
- Load test (`/v1/events` p95 < 50ms a 1000 req/s — RNF-001).

## Definition of Done — testes

T-ID com tipo `schema|domain|integration|ui|test` exige:
- [ ] Unit tests para função pura (≥ alvo de cobertura).
- [ ] Integration test para DB constraint / RLS / RBAC quando aplicável.
- [ ] E2E test atualizado se FLOW-* afetado.
- [ ] `pnpm typecheck && pnpm lint && pnpm test` verde localmente.
- [ ] CI verde antes de merge.

## CI

Configurado em `.github/workflows/ci.yml`:

1. `pnpm install --frozen-lockfile`
2. `pnpm typecheck`
3. `pnpm lint`
4. `pnpm test` (unit + integration)
5. `pnpm db:check`
6. `pnpm build`
7. `pnpm test:e2e` (apenas em PRs marcados ou nightly)

Falha em qualquer step → PR bloqueado.

## Troubleshooting

| Problema | Diagnóstico |
|---|---|
| RLS bloqueando query inesperadamente | Confirmar `set local app.current_workspace_id` no setup |
| Webhook signature falha em test | Verificar fixture usa mesmo secret que setup |
| E2E flake | Aumentar timeout (Playwright config); confirmar wrangler dev rodando |
| Cobertura caiu sob threshold | Coverage report em `coverage/index.html`; adicionar tests |
| `wrangler dev` não conecta ao Postgres | Hyperdrive não funciona local; usar `pg` direto em modo dev |
| Migration não aplica | `pnpm db:check` mostra diff; aplicar `pnpm db:push` ou inspecionar manual |

## Fixtures

`tests/fixtures/` é checked-in. Update exige PR com motivo. Estrutura:

```
tests/fixtures/
├── meta-capi/
│   ├── request-pageview.json
│   ├── request-lead-with-user-data.json
│   └── response-success.json
├── stripe/
│   ├── checkout-session-completed.json
│   └── signature-invalid.txt
├── hotmart/
│   └── purchase-approved.json
└── events/
    └── pageview-typical.json
```

## Performance / load testing

Para load testing (RNF-001), usar [k6](https://k6.io/) ou similar:

```bash
k6 run tests/load/events-fast-accept.ts
```

Métricas alvo:
- p50 < 20ms
- p95 < 50ms
- p99 < 100ms
- Throughput: 1000 req/s sustentados sem degradação.
