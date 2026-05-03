# 03 — Data layer

> Convenções detalhadas em [`30-contracts/02-db-schema-conventions.md`](../30-contracts/02-db-schema-conventions.md). Esta página é o overview operacional.

## ORM

**Drizzle ORM** com schema em `packages/db/src/schema/`. Migrations em `packages/db/migrations/` (Drizzle generates).

Padrão de schema:
```ts
// packages/db/src/schema/lead.ts
import { pgTable, uuid, text, timestamp, smallint } from 'drizzle-orm/pg-core';
import { workspaces } from './workspace';

export const leads = pgTable('leads', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id),
  emailHash: text('email_hash'),
  emailEnc: text('email_enc'),
  // ...
  piiKeyVersion: smallint('pii_key_version').notNull().default(1),
  status: text('status').notNull().default('active'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
```

## Postgres / Supabase

- Versão: PG 15+ (Supabase managed).
- Extensões: `pgcrypto` (gen_random_uuid), `uuid-ossp` (uuid_generate_v7 quando disponível).
- Particionamento: `events` particionada por `received_at` mensal; `link_clicks` similar se volume crescer.

## Hyperdrive

CF Worker conecta via Hyperdrive binding (`HYPERDRIVE` env). Pool gerenciado pela Cloudflare.

```ts
// apps/edge/src/lib/db.ts
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from '@globaltracker/db/schema';

export function getDb(env: Env) {
  const sql = postgres(env.HYPERDRIVE.connectionString);
  return drizzle(sql, { schema });
}
```

## RLS (Row-Level Security)

Política **dual-mode** em todas tabelas de domínio (migration `0028_rls_auth_workspace_id.sql`): aceita o workspace via GUC do Postgres **ou** via lookup do JWT do Supabase.

```sql
alter table <tabela> enable row level security;

create policy <tabela>_workspace_isolation on <tabela>
  for all
  using (
    workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid
    OR workspace_id = public.auth_workspace_id()
  )
  with check (
    workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid
    OR workspace_id = public.auth_workspace_id()
  );
```

Helper `public.auth_workspace_id()` é `SECURITY DEFINER STABLE` e resolve o workspace via `auth.uid() → workspace_members` (bypassa RLS apenas para o lookup), permitindo Server Components do control-plane operarem com `role=authenticated` sem precisar setar GUC.

Caminhos de uso:

| Caller | Como satisfaz a policy |
|---|---|
| Edge Worker (`postgres` role via Hyperdrive) | Bypassa RLS por privilégio do role; opcionalmente seta `app.current_workspace_id` para defesa em profundidade. |
| Control Plane (Supabase Server Components, role `authenticated`) | RLS ativa; `auth_workspace_id()` resolve a partir do JWT — nenhuma config adicional necessária. |
| Background jobs com workspace fixo | Setam `set local app.current_workspace_id = '<uuid>'` no início da transaction. |

`workspace_members` tem cláusula adicional `OR user_id = auth.uid()` para garantir que o usuário sempre lê a própria membership (necessário para o `auth_workspace_id()` funcionar).

Default-deny: caller sem GUC e sem JWT válido (e.g., role `anon` sem session) retorna 0 rows.

## Audit log

Tabela `audit_log` apenas-anexar (BR-AUDIT-001 — trigger bloqueia UPDATE/DELETE manual).

Helper central `recordAuditEntry()` em `apps/edge/src/lib/audit.ts` chamado por todos serviços que mutam entidades sensíveis (BR-AUDIT-006). Spec completa em [`30-contracts/06-audit-trail-spec.md`](../30-contracts/06-audit-trail-spec.md).

## Soft-delete vs hard-delete

| Caso | Estratégia |
|---|---|
| Workspace, Launch, Page, Audience | Soft via `status='archived'` |
| Lead | Soft via `status='erased'` (SAR) ou `status='merged'` |
| `audit_log`, `events`, `dispatch_jobs/attempts`, `link_clicks` | Apenas-anexar; purge por retenção em background job |
| `raw_events` | Hard delete após 7 dias (retenção curta — ADR-014) |

## jsonb

Colunas jsonb obrigatoriamente:
1. Têm schema Zod registrado em `packages/shared/src/contracts/jsonb-schemas.ts`.
2. São validadas no insert/update.
3. Não armazenam PII em claro.
4. Têm índice GIN ou expressional se queryadas frequentemente.

Exemplos:
- `events.user_data` — Zod limita keys (`em`, `ph`, `fbc`, `fbp`, `_gcl_au`, `client_id_ga4`, etc.).
- `events.consent_snapshot` — Zod exige 5 finalidades.
- `audiences.query_definition` — DSL builder validada.
- `audit_log.before` / `after` — payload arbitrário sanitizado.

## Migrations

- Geradas via `pnpm db:generate` (Drizzle).
- Aplicadas via Supabase migration runner ou `drizzle-kit push:pg`.
- Reversíveis (`up` + `down`) quando possível.
- Backwards-compat: novo campo nullable ou com default não quebra código antigo.
- Mudança destrutiva (drop column, rename) em duas fases: deprecar primeiro, remover depois.

Detalhe em [`11-migration-rollback.md`](11-migration-rollback.md).

## Conexão em testes

| Cenário | Setup |
|---|---|
| Unit test (puro) | Sem DB — funções são puras |
| Integration test | DB efêmero: opção (a) Supabase branch; (b) Docker local Postgres; (c) Supabase CLI local |
| E2E | DB de staging real ou ephemeral via Wrangler |

`tests/setup/db.ts` provê `withTestDb()` helper que cria schema isolado por test run.

## Performance

- Índices declarados em todas tabelas com queries frequentes (ver schema/*.ts).
- Particionamento ativado em `events` desde Fase 1 — purga automática de partições antigas.
- Materialized views para dashboards — refresh por cron.
- Read replicas (se Supabase oferecer) considerado em Fase 5+ se queries pesadas degradam.

## Backup e recuperação

- Supabase: PITR (Point-In-Time Recovery) habilitado — RPO ≤ 5 min (depende do plan).
- Backup logical adicional: cron mensal exporta para R2 (somente metadata; não PII).
- DR drill semestral: restaurar backup em ambiente isolado e validar.

Detalhe RPO/RTO em [`08-nfr.md`](08-nfr.md).
