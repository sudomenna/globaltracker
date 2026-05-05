# BR-AUDIENCE — Regras de audiences

## BR-AUDIENCE-001 — `destination_strategy` condicional para Google

### Status: Stable (ADR-012)

### Enunciado
`audiences.destination_strategy` ∈ enum:
- `meta_custom_audience` (apenas Meta)
- `google_data_manager` (default Google — Data Manager API)
- `google_ads_api_allowlisted` (Google Ads API quando token allowlisted)
- `disabled_not_eligible` (sem credenciais ou consent)

Audiences `disabled_not_eligible` **NÃO PODEM** chamar API externa. Validação no dispatcher.

### Enforcement
- Constraint check em `audiences.destination_strategy`.
- Dispatcher Audience Sync rejeita call se strategy = `disabled_not_eligible`.

### Gherkin
```gherkin
Scenario: audience disabled não chama Google
  Given audience com destination_strategy='disabled_not_eligible'
  When sync job é processado
  Then status='succeeded' com sent_additions=0, sent_removals=0
  And nenhuma chamada à Google API foi feita
```

---

## BR-AUDIENCE-002 — Lock por `audience_id + platform_resource_id` impede sync concorrente

### Status: Stable (INV-AUDIENCE-002)

### Enunciado
Não pode haver 2 `audience_sync_jobs` em status `processing` simultaneamente para mesmo `(audience_id, platform_resource_id)`. Lock pessimista (advisory lock Postgres ou Redis).

### Enforcement
- Helper `acquireSyncLock()` antes de processar.
- Lock liberado em finally (mesmo em falha).

### Gherkin
```gherkin
Scenario: 2 sync jobs concorrentes — apenas 1 processa
  Given 2 audience_sync_jobs criados para mesma audience
  When workers tentam processar simultaneamente
  Then apenas 1 adquire lock; outro fica em pending até liberação
```

---

## BR-AUDIENCE-003 — Snapshot de membros materializado para diff entre T-1 e T

### Status: Stable

### Enunciado
`audience_snapshots` + `audience_snapshot_members` armazenam estado **com membros** materializados, não apenas hash. Diff calculado como SET difference entre snapshot atual e anterior.

`query_definition` é um DSL estruturado (jsonb), **nunca SQL livre**. O DSL é validado por `AudienceQueryDefinitionSchema` (Zod) antes de qualquer avaliação ou save (INV-AUDIENCE-007). O vocabulário aceito é:

- **Canônico (T-FUNIL-040 em diante):** `stage_eq`, `stage_not`, `stage_gte`.
- **Legacy aliases (retro-compat, mesmo lifetime das condições canônicas):** `stage` (= `stage_eq`), `not_stage` (= `stage_not`).
- **Demais predicados (inalterados):** `is_icp`, `purchased`.

**Runtime contract — `stage_gte`:** quando qualquer condição usa `stage_gte`, o `query_definition` **DEVE** conter `launch_id` (UUID) no top-level. O evaluator resolve a ordem do funil a partir de `launches.funnel_blueprint.stages[].slug` na ordem posicional do array (não há campo `order`). Se `launch_id` estiver ausente, o blueprint não carregar, ou o slug-alvo não existir no blueprint, o evaluator falha com erro determinístico (`invalid_query_definition: ...`) — o sync job é marcado como `failed` e o operador corrige o `query_definition`. Não há fallback silencioso para conjunto vazio.

**Determinismo (INV-AUDIENCE-003 preservado):** para `query_definition`s escritos com vocabulário legacy (`stage` / `not_stage`), a expansão do DSL não muda o conjunto de membros nem o `snapshot_hash`. Audiences existentes não regridem após a expansão de vocabulário.

### Enforcement
- Job de geração escreve snapshot + members em transação.
- Sync job calcula diff via SQL determinístico.
- `evaluateAudience()` parseia `query_definition` com Zod antes de construir SQL; entrada inválida lança `invalid_query_definition` antes de tocar DB de leads.
- `stage_gte` sem `launch_id` no top-level → erro determinístico antes do query.

### Gherkin
```gherkin
Scenario: diff identifica adições e remoções corretamente
  Given snapshot T-1 com members={A, B, C}
  And snapshot T com members={B, C, D}
  When sync job calcula diff
  Then planned_additions=1 (D), planned_removals=1 (A)
```

```gherkin
Scenario: stage_gte resolve ordem via funnel_blueprint
  Given launch L com funnel_blueprint.stages=[
    {slug: "registered"},
    {slug: "watched_workshop"},
    {slug: "purchased_main"}
  ]
  And audience com query_definition={
    type: "builder",
    launch_id: L.id,
    all: [{stage_gte: "watched_workshop"}]
  }
  When evaluateAudience executa
  Then members inclui leads com stage IN ("watched_workshop", "purchased_main")
  And exclui leads cuja stage máxima é "registered"
```

```gherkin
Scenario: stage_gte sem launch_id falha determinístico
  Given audience com query_definition={
    type: "builder",
    all: [{stage_gte: "watched_workshop"}]
  }
  When evaluateAudience executa
  Then erro "invalid_query_definition: stage_gte requires launch_id..."
  And nenhuma query a leads é executada
```

```gherkin
Scenario: vocabulário legacy preserva snapshot_hash (INV-AUDIENCE-003)
  Given audience pré-T-FUNIL-040 com query_definition={type:"builder", all:[{stage:"registered"}]}
  When evaluateAudience executa antes e depois da expansão de vocabulário
  Then o member set é idêntico
  And snapshot_hash é idêntico
```

---

## BR-AUDIENCE-004 — Consent policy filtra membros antes do snapshot

### Status: Stable (INV-AUDIENCE-005)

### Enunciado
Audience com `consent_policy.require_customer_match=true` **DEVE** excluir leads sem `consent_customer_match='granted'` antes de gerar `audience_snapshot_members`.

### Enforcement
- Query base de avaliação inclui filtro de consent.
- `evaluateAudience()` testável com fixtures.

### Gherkin
```gherkin
Scenario: lead sem consent customer_match é excluído
  Given audience com require_customer_match=true
  And lead L com consent_customer_match='denied'
  When evaluateAudience executa
  Then L não está em members do snapshot resultante
```
