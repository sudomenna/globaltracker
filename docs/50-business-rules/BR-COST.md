# BR-COST — Regras de ingestão de custos

## BR-COST-001 — Unique sem `timezone`; com `granularity` + COALESCE em campos opcionais

### Status: Stable

### Enunciado
Constraint:
```
unique (workspace_id, platform, account_id,
        coalesce(campaign_id,''), coalesce(adset_id,''), coalesce(ad_id,''),
        granularity, date)
```
`timezone` é metadata, não parte da identidade.

### Enforcement
- Constraint DB. Migration testa com NULL em campaign_id/ad_id.

### Gherkin
```gherkin
Scenario: gasto agregado em account não conflita com gasto em ad
  Given row (account=A, granularity='account', date=D, campaign=NULL, ad=NULL)
  When inserir row (account=A, granularity='ad', date=D, campaign=C, ad=AD)
  Then ambos coexistem (granularity diferente)

Scenario: timezone diferente não cria duplicata
  Given row (account=A, granularity='ad', date=D, ad=AD, timezone='America/Sao_Paulo')
  When inserir mesmo row com timezone='UTC'
  Then unique violation (timezone fora do unique)
```

---

## BR-COST-002 — `spend_cents_normalized` sempre populado após ingestão

### Status: Stable

### Enunciado
Cada row em `ad_spend_daily` **DEVE** ter `spend_cents_normalized`, `fx_rate`, `fx_source`, `fx_currency` preenchidos após cron diário. Se FX provider falhou, row é marcada com flag e cron de retry tenta no dia seguinte.

### Enforcement
- Cron `cost-ingestor.ts` valida pós-batch.
- Métrica `ad_spend_daily_unnormalized_count` alerta se > 0 após retry.

### Gherkin
```gherkin
Scenario: FX disponível → normalização aplicada
  Given gasto USD 100,00 em conta US, workspace.fx_normalization_currency=BRL, ECB rate USD/BRL=5,00
  When cron processa
  Then spend_cents=10000, spend_cents_normalized=50000, fx_rate=5.00, fx_source='ecb', fx_currency='BRL'

Scenario: FX provider falha
  Given ECB indisponível
  When cron processa
  Then row inserida com spend_cents_normalized=NULL, métrica alerta
  And cron de retry tenta no próximo dia
```

---

## BR-COST-003 — Reprocessamento retroativo quando FX é revisada

### Status: Stable

### Enunciado
Se FX provider revisar taxa antiga (raro mas acontece), `reprocessFxRetroactive(workspace_id, days_back)` **DEVE** atualizar `fx_rate` + `spend_cents_normalized` em batch. Operação é audit-logged.

### Enforcement
- Helper executável manualmente ou por cron opcional.
- Atomic UPDATE em batch.

### Gherkin
```gherkin
Scenario: reprocessamento de últimos 30 dias
  Given gastos de últimos 30d com fx_rate antiga
  When reprocessFxRetroactive(W, 30) executado
  Then todos rows atualizados com nova fx_rate
  And spend_cents_normalized recalculado
  And audit_log entry com action='fx_reprocessed'
```
