# 10 — Testing strategy

## Pirâmide

```
        ▲
       ╱ ╲      E2E (Playwright)            ~10%
      ╱   ╲     - FLOW-* end-to-end
     ╱─────╲
    ╱       ╲   Integration (Vitest+Miniflare+DB efêmero)  ~30%
   ╱         ╲  - DB constraints, RLS, RBAC
  ╱───────────╲ - Webhook signatures
 ╱             ╲ Unit (Vitest puro)        ~60%
╱_______________╲ - Domain logic, mappers, BR
```

## Coverage alvo por camada

| Camada | Cobertura mínima | Foco |
|---|---|---|
| Domain (`apps/edge/src/lib/`) | ≥ 90% | BRs, lead resolver, dispatch, attribution |
| Mappers (`apps/edge/src/integrations/*/mapper.ts`) | ≥ 95% | Webhook payload → InternalEvent |
| RBAC (`apps/edge/src/middleware/`) | 100% | AUTHZ-* implementados |
| Routes (`apps/edge/src/routes/`) | ≥ 80% | Casos de auth + happy path |
| `packages/db/` | ≥ 80% | Schema + views |
| Tracker (`apps/tracker/`) | ≥ 85% | Cookies, decorate, identify |

CI falha PR se cobertura cair abaixo do mínimo.

## Padrões de teste

### Unit (puro)

- Sem I/O, sem DB, sem fetch.
- Funções puras: `clampEventTime`, `computeIdempotencyKey`, `normalizeEmail`, mapper `mapStripeToInternal`, etc.
- Vitest. Rápido (< 5s para suite inteira em watch).

```ts
// tests/unit/event/clamp.test.ts
import { describe, it, expect } from 'vitest';
import { clampEventTime } from '../../../apps/edge/src/lib/event-time-clamp';

describe('clampEventTime', () => {
  it('returns event_time when within window', () => {
    const eventTime = new Date('2026-05-01T20:00:00Z');
    const receivedAt = new Date('2026-05-01T20:00:30Z');
    expect(clampEventTime(eventTime, receivedAt, 300).getTime()).toBe(eventTime.getTime());
  });

  it('clamps to received_at when offset exceeds window', () => {
    const eventTime = new Date('2026-05-01T19:00:00Z');
    const receivedAt = new Date('2026-05-01T20:00:00Z');
    expect(clampEventTime(eventTime, receivedAt, 300).getTime()).toBe(receivedAt.getTime());
  });
});
```

### Integration (DB real efêmero, HMAC real)

- DB efêmero por test run (Supabase branch / Docker / Supabase CLI local).
- Cada test cria schema isolado ou rola transaction rolled-back.
- Miniflare simula CF Workers + Queues + KV em memória.

```ts
// tests/integration/event/replay-protection.test.ts
import { withTestDb } from '../../setup/db';
import { withMiniflare } from '../../setup/miniflare';

withTestDb('replay protection', async ({ db }) => {
  withMiniflare(async ({ kv }) => {
    // Test...
  });
});
```

Setup options para DB efêmero:
- **Opção A**: Supabase branch (cloud, paid, mais lento mas mais real).
- **Opção B**: Docker Postgres local + Drizzle migrations (rápido, isolado).
- **Opção C**: Supabase CLI local (`supabase start`). Recomendado para dev.

### E2E (Playwright)

- Roda contra Worker em wrangler dev + DB de staging.
- Cobertura: cada FLOW-NN tem 1 spec.
- Lento (~minutos) — roda em CI, não em pre-commit.

```ts
// tests/e2e/flow-07-returning-lead.spec.ts
test('lead retornante dispatcha InitiateCheckout com user_data enriquecido', async ({ page, request }) => {
  // 1. Cadastro inicial — recebe __ftk
  // 2. Espera 100ms (simula retorno)
  // 3. PageView com __ftk
  // 4. InitiateCheckout
  // 5. Assert dispatch_jobs Meta CAPI tem user_data com em/ph
});
```

## Padrões específicos

### Trigger DB (append-only)

```ts
// tests/integration/audit/no-update-no-delete.test.ts
withTestDb(async ({ db }) => {
  await db.insert(auditLog).values({...});
  await expect(db.update(auditLog).set({action: 'changed'}))
    .rejects.toThrow(/audit_log.*read.only/);
});
```

### Webhook idempotente (3× mesmo evento)

```ts
withTestDb(async ({ db }) => {
  for (let i = 0; i < 3; i++) {
    await fetch('/v1/webhook/stripe', { ... mesmo payload, mesma signature ... });
  }
  const events = await db.select().from(events).where(...);
  expect(events.length).toBe(1); // BR-EVENT-002 + BR-WEBHOOK-002
});
```

### RLS por papel

```ts
withTestDb(async ({ db }) => {
  await db.execute(`set local app.current_workspace_id = 'workspace1_uuid'`);
  const leads = await db.select().from(leads);
  // só leads de workspace1
  expect(leads.every(l => l.workspaceId === 'workspace1_uuid')).toBe(true);
});
```

## Fixtures

`tests/fixtures/`:
- `<provider>/<scenario>.json` — webhooks reais ou representativos sanitizados.
- `events/<event-name>.json` — payloads de tracker.
- `leads/<scenario>.json` — combinações típicas (email-only, phone-only, full, erased).

Fixtures são checked-in. Updates exigem PR com motivo.

## Definition of Done — testes

Toda T-ID com `tipo ∈ {schema, domain, integration, ui}` exige:
- [ ] Unit tests para função pura (≥ alvo de cobertura da camada).
- [ ] Integration test para DB constraint / RLS / RBAC.
- [ ] E2E test atualizado se FLOW-* afetado.
- [ ] `pnpm typecheck && pnpm lint && pnpm test` verde localmente.
- [ ] CI verde antes de merge.

## CI

GitHub Actions:

```yaml
- pnpm install
- pnpm typecheck
- pnpm lint
- pnpm test (unit + integration)
- pnpm test:e2e (em PRs marcados ou nightly)
- pnpm db:check (Drizzle migration consistency)
- pnpm build (Wrangler smoke)
```

Falha em qualquer step bloqueia merge.

## Setup local

```bash
# Setup inicial
git clone <repo>
cd globaltracker
pnpm install

# DB local (Supabase CLI)
supabase start

# Run migrations
pnpm --filter @globaltracker/db migrate

# Edge dev
cd apps/edge && wrangler dev

# Tests
pnpm test           # unit + integration
pnpm test:watch
pnpm test:e2e
pnpm test:coverage
```

## Troubleshooting

| Problema | Diagnóstico |
|---|---|
| "RLS bloqueando query inesperadamente" | Verificar `set local app.current_workspace_id` no setup do test |
| "Webhook signature falha em test" | Confirmar fixtures usam mesmo secret que setup |
| "E2E flake" | Aumentar timeout, verificar deps externas (DB de staging disponível) |
| "Cobertura caiu" | Ver coverage report — função nova sem teste; adicionar antes de merge |
