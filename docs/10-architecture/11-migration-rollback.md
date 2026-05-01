# 11 — Migration e rollback

## Princípios

1. **Versionadas em `packages/db/migrations/`** — Drizzle gera, humano revisa.
2. **Reversíveis quando possível** — `up.sql` + `down.sql` separados.
3. **Backwards-compatible quando possível** — novo campo nullable ou com default não quebra código antigo.
4. **Mudanças destrutivas em duas fases** — adicionar antes, remover depois.
5. **Testadas em DB efêmero antes do merge** — CI roda migration up → down → up.
6. **Aplicadas com transaction quando seguro** — concurrent index creation fora de transaction.

## Tipos de migration

### Adicionar coluna nullable

Seguro. Backwards-compat OK.

```sql
-- up
alter table leads add column visitor_id text;

-- down
alter table leads drop column visitor_id;
```

### Adicionar coluna NOT NULL com default

Seguro. Backfill via default.

```sql
-- up
alter table leads add column pii_key_version smallint not null default 1;

-- down
alter table leads drop column pii_key_version;
```

### Adicionar índice (concorrente)

Sem lock prolongado.

```sql
-- up
create index concurrently idx_lead_aliases_active
  on lead_aliases (workspace_id, identifier_type, identifier_hash)
  where status = 'active';

-- down
drop index concurrently if exists idx_lead_aliases_active;
```

Fora de transaction (`statement_timeout` precisa ser alto). Drizzle migration runner lida.

### Adicionar constraint

Risco se dados existentes não atendem. Two-phase recomendado:

Fase 1:
```sql
alter table workspaces add constraint chk_currency
  check (fx_normalization_currency in ('BRL','USD','EUR'))
  not valid;  -- não valida rows existentes ainda
```

Fase 2 (após backfill manual):
```sql
alter table workspaces validate constraint chk_currency;
```

### Drop column (destrutivo)

Two-phase:

Fase 1: Stop writing — código deploya com coluna marcada deprecated em comments. Cron de backfill move dados para nova estrutura se aplicável.

Fase 2 (após N sprints sem código tocar):
```sql
alter table leads drop column legacy_field;
```

Deletar coluna sem backup é irreversível em produção. Snapshot DB antes.

### Rename column

Two-phase:

```sql
-- Fase 1: adicionar nova
alter table leads add column new_name text;
-- backfill
update leads set new_name = old_name where old_name is not null;
-- código novo lê new_name; código antigo lê old_name (ainda preenchida via trigger)

-- Fase 2 (após código todo migrado):
alter table leads drop column old_name;
```

### Particionamento

`events` é particionada por mês. Cron mensal cria partição do mês seguinte:

```sql
create table events_2026_06 partition of events
  for values from ('2026-06-01') to ('2026-07-01');
```

Migration para criar partição é "data migration" — aplicada por cron, não em build deploy.

## Drizzle workflow

```bash
# Fazer mudança em packages/db/src/schema/<file>.ts

# Gerar migration
pnpm db:generate

# Output: packages/db/migrations/<timestamp>_descriptor.sql
# Revisar, ajustar manualmente se necessário (e.g., concurrent indexes)

# Aplicar local
pnpm db:push

# Aplicar staging/prod via CD pipeline
```

## CI gates

CI roda em DB efêmero:
1. Aplica todas migrations da branch base.
2. Aplica migration nova (up).
3. Roda test integration.
4. (Se reversível) Aplica down.
5. Re-aplica up.
6. Roda test integration novamente.

Se qualquer step falha, PR rejeitado.

## Deploy de migration em produção

1. **Pre-deploy check**:
   - Migration testada em staging.
   - Backup confirmado (Supabase PITR garante automaticamente).
   - Time on-call notificado.

2. **Deploy**:
   - Aplicar migration ANTES do deploy de código novo (regra: schema change → code change, nunca o contrário).
   - Para mudanças concurrent (índice), executar em janela de baixo tráfego.

3. **Post-deploy**:
   - Smoke test contra produção.
   - Monitorar métricas por 1h.
   - Documento `[SYNC-PENDING]` em MEMORY.md se doc não foi atualizada.

## Rollback de migration

| Tipo | Reversível? | Como |
|---|---|---|
| Add column nullable | Sim | drop column |
| Add column NOT NULL | Sim | drop column (perde dados na coluna nova) |
| Add index | Sim | drop index (sem perda) |
| Add constraint | Sim | drop constraint |
| Drop column | **Não** sem backup | PITR restore |
| Rename column | Two-phase reversível | drop nova, restaurar via two-phase reverso |
| Drop table | **Não** | PITR restore |

Para mudanças irreversíveis, política: **manter feature flag** que desabilita código novo e mantém código antigo funcional até confirmar estabilidade. Só então aplicar drop.

## Disaster recovery

| Cenário | Resposta | RTO |
|---|---|---|
| Worker rollback (deploy ruim) | `wrangler deployments list` + rollback | < 5 min |
| Migration corrompeu dados | Supabase PITR para timestamp pré-migration | < 1h (RPO 5 min) |
| DB total loss | Restore do último backup logical (R2) | < 4h |
| KV inconsistência (replay protection) | Recriar KV namespace, aceitar duplicatas durante 7d | < 30 min |
| Queue messages perdidas | DLQ inspecionar; reprocessar via admin endpoint | < 2h |

## Histórico de migrations (mantido por humano)

`docs/10-architecture/migrations-log.md` (a criar quando tiver 10+ migrations) — descrição humana de migrations notáveis com motivo + impacto. Drizzle migration files têm timestamp e descriptor mas explicação humana ajuda em troubleshooting tardio.

## Checklist por PR de migration

- [ ] Migration revisada em SQL puro (não confiar 100% em Drizzle generation).
- [ ] Reversível (down.sql) ou justificativa de irreversibilidade.
- [ ] Concurrent index quando aplicável.
- [ ] CI verde em up/down/up cycle.
- [ ] Test integration cobrindo nova estrutura.
- [ ] Doc `30-contracts/02-db-schema-conventions.md` atualizada se naming/pattern mudou.
- [ ] ADR se mudança grande (drop column, rename, particionamento).
