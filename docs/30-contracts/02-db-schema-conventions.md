# 02 — Convenções de schema de banco

## Princípios

1. **Postgres é a fonte de verdade.** Drizzle gera tipos a partir do schema; nunca o contrário.
2. **Multi-tenant por linha** com `workspace_id` em toda tabela de domínio + RLS ativo.
3. **Migrations versionadas e revertíveis** (quando possível) em `packages/db/migrations/`.
4. **Sem `delete` físico** em entidades de domínio — soft-delete via `status='archived'` ou anonimização (PII via SAR).

## Naming

| Item | Padrão | Exemplo |
|---|---|---|
| Nome de tabela | `snake_case`, plural | `lead_aliases`, `dispatch_jobs` |
| Nome de coluna | `snake_case`, singular | `email_hash`, `pii_key_version` |
| Foreign key | `<entidade>_id` | `lead_id`, `workspace_id` |
| Índice | `idx_<tabela>_<colunas>` | `idx_lead_aliases_workspace_identifier` |
| Constraint unique | `uq_<tabela>_<colunas>` | `uq_workspaces_slug` |
| Constraint check | `chk_<tabela>_<descrição>` | `chk_ad_spend_daily_granularity` |
| Trigger | `trg_<tabela>_<momento>_<ação>` | `trg_audit_log_before_update_block` |
| View | `v_<descrição>` ou `<dom>_view` | `audit_log_view`, `daily_funnel_rollup` |

## Primary keys

- **Padrão:** `id uuid primary key default gen_random_uuid()` (ou `uuidv7` quando disponível para ordenação por tempo).
- **Composite PK** apenas em junction tables (ex.: `audience_snapshot_members(snapshot_id, lead_id)`).

## Multi-tenant

Toda tabela de domínio (exceto `workspaces` em si) inclui:

```sql
workspace_id uuid not null references workspaces(id) on delete restrict
```

`on delete restrict` previne deleção acidental de workspace com dados ativos. Para arquivar workspace, usar `status='archived'`.

RLS no Postgres: política padrão filtra por `current_setting('app.current_workspace_id')` em todas tabelas. Aplicação seta esse setting por request.

## Timestamps

| Coluna | Quando |
|---|---|
| `created_at timestamptz not null default now()` | Em toda tabela. |
| `updated_at timestamptz not null default now()` | Em entidades mutáveis. Trigger atualiza. |
| `deleted_at timestamptz` | Soft-delete onde aplicável (tipicamente substituído por `status='archived'` + `archived_at`). |
| Timestamps específicos do domínio (`first_seen_at`, `merged_at`, `rotated_at`) | Específicos por tabela. |

Trigger genérico para `updated_at`:

```sql
create or replace function set_updated_at() returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;
```

## Soft-delete vs hard-delete

| Caso | Ação |
|---|---|
| Workspace, Launch, Page, Audience | Soft via `status='archived'`. Manter dados para histórico. |
| Lead | Soft via `status='erased'` (após SAR) ou `status='merged'`. |
| `audit_log`, `events`, `dispatch_jobs`, `dispatch_attempts`, `link_clicks` | Apenas-anexar; purge por retenção em background job. |
| `raw_events` | Hard delete após 7 dias (retenção curta). |
| `lead_aliases` (após erasure) | Hard delete (ADR-014). |

Hard delete sempre via job de retenção, nunca via UPDATE/DELETE manual em produção.

## Tipos de dado padrões

| Conceito | Tipo Postgres |
|---|---|
| Identificador interno | `uuid` |
| Identificador público | `text` (com check de comprimento ≤ 64) |
| Hash (SHA-256) | `text` (64 hex chars) |
| Cifrado AES-GCM (base64) | `text` |
| Status / enum | `text` com constraint `check (... IN (...))` (Postgres enum types evitados — migrations dolorosas) |
| Moeda (ISO 4217) | `text` (3 chars, check) |
| Cents (preço/spend) | `integer` |
| FX rate | `numeric(18,8)` |
| Timestamps | `timestamptz` |
| JSON arbitrário | `jsonb` |
| Array de strings | `text[]` |

## jsonb — convenções

1. **jsonb apenas para dados sem schema fixo evolutivo.** Não usar como atalho de "vou pensar depois".
2. **Toda coluna jsonb tem schema Zod registrado em `packages/shared/src/contracts/`.** Validador roda no insert/update.
3. **Queryability:** se um campo é frequentemente consultado, criar índice GIN ou expressional:
   ```sql
   create index idx_events_user_data_email_hash
   on events using gin ((user_data->'em'));
   ```
4. **Não armazenar PII em jsonb** sem encrypt/hash.

### Writes via Hyperdrive — helper `jsonb()` obrigatório (T-13-013-FOLLOWUP, 2026-05-09)

O driver `pg-cloudflare-workers` por trás do binding `HYPERDRIVE` serializa parâmetros de bind como **text com aspas** e, ao gravar em coluna `jsonb`, Postgres aceita a string sem cast implícito. O resultado é uma row com `jsonb_typeof(col)='string'` em vez de `'object'` — operadores `->`/`->>` retornam `NULL` silenciosamente em queries SQL ad-hoc, e Drizzle só recompõe o objeto via `JSON.parse` na leitura. Sintoma observado: filtros tipo `WHERE user_data->>'fbc' IS NOT NULL` falsamente retornavam zero linhas em prod.

**Regra:** todo `db.insert(<table>).values({ <jsonb_col>: ... })` em código que rode no edge worker (`apps/edge/`) **deve** envolver o valor com o helper `jsonb()` em `apps/edge/src/lib/jsonb-cast.ts`:

```ts
import { jsonb } from '../lib/jsonb-cast.js';

await db.insert(events).values({
  // ...
  user_data: jsonb(userData),     // ✓ dollar-quoted + ::jsonb cast
  custom_data: jsonb(customData), // ✓
  attribution: jsonb(attr),       // ✓
});
```

O helper retorna um SQL fragment `$gtjsonb$<json>$gtjsonb$::jsonb` que força o cast text→jsonb antes do bind, garantindo `jsonb_typeof='object'`. Aplicado em ~58 writes em 12 arquivos do edge worker (4 raw-events-processors + `dispatch.ts` + `index.ts` + 6 webhook adapters) no commit `22db9a9` (deploy `ed9a490d`).

**Reads — parse defensivo.** Rows pré-deploy `ed9a490d` (todos `events`, `raw_events`, `dispatch_jobs` anteriores a 2026-05-09 ~05:00 UTC) ainda estão como jsonb-string. Queries que cruzam o boundary precisam de cast defensivo idempotente:

```sql
-- ad-hoc / view / migration
WHERE (user_data #>> '{}')::jsonb->>'fbc' IS NOT NULL

-- TypeScript que lê via Drizzle e pode receber string ou object
const ud = typeof row.userData === 'string'
  ? JSON.parse(row.userData) as Record<string, unknown>
  : (row.userData ?? {}) as Record<string, unknown>;
```

Helper `parseUd` em `apps/edge/src/index.ts` faz esse parse defensivo nos call sites do dispatcher Meta CAPI. View `v_meta_capi_health` (migration `0047`) usa o mesmo padrão `(col #>> '{}')::jsonb` em todas as referências a `events.user_data`.

**Tests.** `tests/helpers/jsonb-unwrap.ts` extrai o JS value original do SQL fragment dollar-quoted para que mocks de driver verifiquem o conteúdo lógico das writes sem depender do wire format.

**Backfill (futuro).** Rows legadas seguem funcionais via parse defensivo — backfill em massa (`UPDATE <table> SET <col> = (<col> #>> '{}')::jsonb WHERE jsonb_typeof(<col>)='string'`) não é urgente. Tracking em `MEMORY.md §3 / JSONB-LEGACY-ROWS-BACKFILL`.

## Audit log integration

Toda mutação em entidades sensíveis (`pages.event_config`, `audiences.query_definition`, `page_tokens`, `lead_consents`, etc.) **deve** ser acompanhada de `recordAuditEntry()` chamado pelo service layer.

INV-AUDIT-004 garante isso por integration test. Trigger DB pode bloquear update sem audit log (decisão de implementação na Fase 1).

## Migrations

### Convenções

- Arquivos: `packages/db/migrations/<timestamp>_<description>.sql` (Drizzle-generated).
- **Sempre testáveis em ambiente efêmero** (Docker local ou Supabase branch).
- **Reversíveis** quando possível (`up` e `down` separados).
- **Backwards-compatible** sempre que possível: novo campo `nullable` ou com default não quebra código antigo.
- **Mudanças destrutivas** (drop column, rename) requerem migration em duas fases:
  1. Adicionar nova estrutura, deprecar antiga, código usa nova.
  2. Drop da antiga após confirmação de que ninguém usa.

### Tipos de migration

| Tipo | Reversível? | Exemplo |
|---|---|---|
| Add column nullable | Sim | `alter table leads add column visitor_id text;` |
| Add column not null with default | Sim (drop) | `alter table leads add column pii_key_version smallint not null default 1;` |
| Add index | Sim | `create index ... ;` |
| Add constraint | Parcialmente | Pode falhar em dados existentes — testar antes. |
| Drop column | Não (sem backup) | Fazer só após deprecação. |
| Rename column | Sim (rename de volta) | Quebra código durante deploy — usar two-phase. |
| Add table | Sim (drop) | Tabela nova é sempre seguro. |

## Constraints obrigatórias

| Tipo | Regra |
|---|---|
| `not null` | Toda coluna que não pode ser NULL (a maioria). NULL apenas quando semanticamente significa "ausente". |
| `default` | Para `created_at`, `updated_at`, status iniciais. |
| `references ... on delete restrict` | Default. Evita deleção acidental. `on delete cascade` apenas em junction tables (ex.: `audience_snapshot_members`). |
| `check` | Para enums (lista de valores válidos), ranges numéricos (`spend_cents >= 0`), comprimentos (`length(slug) between 3 and 64`). |
| `unique` | Para `slug`, `public_id` por escopo, `token_hash`. |

## Particionamento

`events` é particionada por tempo (`created_at` ou `received_at`):

```sql
create table events (
  -- ...
) partition by range (received_at);

create table events_2026_05 partition of events
  for values from ('2026-05-01') to ('2026-06-01');
```

Cron mensal cria partição do mês seguinte. Retenção de 13 meses purga partições antigas.

## RLS — política padrão (dual-mode desde migration `0028`)

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

Dois caminhos válidos:

1. **GUC explícita** — application seta `set local app.current_workspace_id = '<uuid>'` no início da transaction (usado pelo Edge Worker e jobs).
2. **JWT-derivado** — função `public.auth_workspace_id()` (`SECURITY DEFINER STABLE`) faz `SELECT workspace_id FROM workspace_members WHERE user_id = auth.uid() LIMIT 1`. Usado pelos Server Components do control-plane via role `authenticated` do Supabase.

Caller sem GUC setada **e** sem JWT válido retorna zero linhas (default-deny preservado).

`workspace_members_workspace_isolation` tem cláusula adicional `OR user_id = auth.uid()` (necessária para o lookup de `auth_workspace_id()` não cair em loop de RLS). Detalhe operacional em [`10-architecture/03-data-layer.md`](../10-architecture/03-data-layer.md#rls-row-level-security) e [`10-architecture/06-auth-rbac-audit.md`](../10-architecture/06-auth-rbac-audit.md#rls-row-level-security).

## Convenção de testes

| Teste | Onde |
|---|---|
| Schema valida via Zod | `tests/unit/contracts/<nome>.test.ts` |
| Migrations rodam clean em DB efêmero | `tests/integration/db/migrations.test.ts` |
| RLS bloqueia cross-workspace | `tests/integration/db/rls.test.ts` |
| Constraints rejeitam inválidos | `tests/integration/db/constraints.test.ts` |
| Trigger updated_at | `tests/integration/db/triggers.test.ts` |
