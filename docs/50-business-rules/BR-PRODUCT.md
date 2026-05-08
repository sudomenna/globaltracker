# BR-PRODUCT — Regras do catálogo de produtos e lifecycle do lead

> Sprint 16. Domínio MOD-PRODUCT. Cross-cutting com MOD-IDENTITY (`leads.lifecycle_status`) e MOD-LAUNCH (`launch_products`).

## BR-PRODUCT-001 — Lifecycle hierarchy é monotônica não-regressiva

### Status
Stable.

### Enunciado
`leads.lifecycle_status` segue ranking total `mentorado(4) > aluno(3) > cliente(2) > lead(1) > contato(0)`. O helper `promoteLeadLifecycle(leadId, candidate, ctx)` **só** executa UPDATE quando `rank(candidate) > rank(current)`. Promoção é idempotente; downgrade é proibido — nem operador, nem webhook, nem job de backfill pode regredir um lead.

### Motivação
- Reflete realidade do negócio: quem virou aluno não "volta" a ser apenas cliente, mesmo que reembolse uma compra futura. Reembolsos/cancelamentos são tratados via `events`/`audit`, não via downgrade de lifecycle.
- Idempotência: webhooks at-least-once (CF Queues) podem reentregar Purchase; promote idempotente impede flicker e ruído de audit.
- Race tolerance: enum total order de tamanho 5 garante que mesmo em lost-update concorrente o resultado final permanece coerente (vence o maior rank — comportamento desejado).

### Enforcement
- **Domain:** `apps/edge/src/lib/lifecycle-promoter.ts` SELECT current → comparar rank → UPDATE-only-if-changed.
- **DB:** CHECK constraint em `leads.lifecycle_status` impede valor inválido. Não há trigger que enforce monotonia (delegado ao domain).
- **Test:** `tests/unit/lib/lifecycle-promoter.test.ts` cobre 12 cenários incluindo no-op em downgrade.

### Aplica-se a
MOD-PRODUCT, MOD-IDENTITY, FLOW-04 (Purchase via webhook), `routes/lead.ts` form submit, `raw-events-processor` Lead event.

### Critérios de aceite

```gherkin
Scenario: Promoção válida cliente → aluno
  Given lead L com lifecycle_status='cliente'
  When promoteLeadLifecycle(L, 'aluno') é chamado
  Then UPDATE é executado e response { from: 'cliente', to: 'aluno', changed: true }

Scenario: Downgrade é no-op
  Given lead L com lifecycle_status='mentorado'
  When promoteLeadLifecycle(L, 'cliente') é chamado
  Then nenhum UPDATE; response { from: 'mentorado', to: 'mentorado', changed: false }

Scenario: Idempotência em valor igual
  Given lead L com lifecycle_status='lead'
  When promoteLeadLifecycle(L, 'lead') é chamado
  Then nenhum UPDATE; changed: false
```

### Citação em código
```ts
// BR-PRODUCT-001: lifecycle promote nunca regride
const candidateRank = LIFECYCLE_RANK[candidate];
const currentRank = LIFECYCLE_RANK[current];
if (candidateRank <= currentRank) return { ok: true, value: { from: current, to: current, changed: false } };
```

---

## BR-PRODUCT-002 — Produto desconhecido em webhook é auto-criado com `category=NULL`

### Status
Stable.

### Enunciado
Quando um Purchase webhook (Guru hoje; Hotmart/Kiwify/Stripe na sequência) chega com um `(external_provider, external_product_id)` que ainda não existe no catálogo do workspace, o pipeline **DEVE** auto-criar um row em `products` com:
- `name` = nome recebido no payload (fallback `external_product_id` se ausente),
- `category = NULL` ("não categorizado"),
- `status = 'active'`.

O lifecycle target derivado de `category=NULL` é `cliente` (default conservador — ver mapeamento em `lifecycle-rules.ts`). Operador re-categoriza via UI (`PATCH /v1/products/:id`), o que pode disparar BR-PRODUCT-003.

### Motivação
- Não bloquear ingestão de Purchase real esperando cadastro manual prévio do produto.
- `cliente` como default é conservador: garante que qualquer compra promove o lead pelo menos para `cliente`. Recategorização posterior pode subir para `aluno`/`mentorado` (BR-PRODUCT-001 garante monotonia).
- Preserva atribuição operacional: se operador já tinha cadastrado o produto manualmente com categoria, `upsertProduct` faz SELECT primeiro e **não** sobrescreve `category`.

### Enforcement
- **Domain:** `upsertProduct` em `apps/edge/src/lib/products-resolver.ts` — SELECT → INSERT ON CONFLICT DO NOTHING → re-SELECT.
- **DB:** UNIQUE `(workspace_id, external_provider, external_product_id)` impede duplicata.
- **Default categoria:** `lifecycle-rules.ts` mapeia `NULL → 'cliente'`.

### Aplica-se a
MOD-PRODUCT, FLOW-04, `guru-raw-events-processor.ts` (e futuros adapters Hotmart/Kiwify/Stripe).

### Critérios de aceite

```gherkin
Scenario: Primeiro Purchase de produto desconhecido cria row
  Given products vazio para workspace W
  When Purchase webhook chega com external_provider='guru', external_product_id='abc', name='Workshop X'
  Then existe products row com category=NULL, status='active', name='Workshop X'
  And o lead é promovido para 'cliente' (default conservador)

Scenario: Purchase reentregue não altera categoria já atribuída
  Given products(W, 'guru', 'abc') com category='curso_online' (atribuído por operador)
  When Purchase webhook (Guru retry) chega para mesmo (provider, product_id)
  Then category permanece 'curso_online'
  And o lead é promovido para 'aluno' (mapeamento curso_online → aluno)
```

### Citação em código
```ts
// BR-PRODUCT-002: produto desconhecido em webhook entra com category=NULL; default conservador
const product = await upsertProduct(db, { workspaceId, externalProvider: 'guru', externalProductId, name });
const target = lifecycleForCategory(workspaceId, product.category); // NULL → 'cliente'
```

---

## BR-PRODUCT-003 — `PATCH /v1/products/:id` que muda `category` dispara backfill de lifecycle

### Status
Stable.

### Enunciado
Quando `PATCH /v1/products/:id` altera o campo `category`, o handler **DEVE** executar backfill: para cada lead que tem ao menos um Purchase event vinculado a esse produto (via `events.custom_data->>'product_db_id' = :id`), recalcular `lifecycle_status` via `promoteLeadLifecycle(lead_id, lifecycleForCategory(workspaceId, novaCategoria))`. Por BR-PRODUCT-001, leads que já estão acima do novo target permanecem inalterados.

A response inclui `leads_recalculated: <int>` indicando quantos leads passaram pelo helper (não necessariamente quantos mudaram).

### Motivação
- Operador frequentemente cadastra produto sem categoria (BR-PRODUCT-002) e categoriza depois — sem backfill, leads históricos ficariam com lifecycle desatualizado.
- Tornar a recategorização um único passo operacional via UI, em vez de exigir job manual.

### Enforcement
- **Domain:** handler de `PATCH /v1/products/:id` em `apps/edge/src/routes/products.ts` detecta mudança de `category` e chama backfill.
- **Audit:** `audit_log` action=`product_category_updated` com metadata `{ from, to, leads_recalculated }`.

### Aplica-se a
MOD-PRODUCT, MOD-IDENTITY.

### Critérios de aceite

```gherkin
Scenario: PATCH category dispara backfill
  Given product P com category=NULL
  And 10 leads com Purchase event vinculado a P (events.custom_data.product_db_id = P.id)
  When PATCH /v1/products/P.id { category: 'mentoria_individual' }
  Then promoteLeadLifecycle é chamado para cada um dos 10 leads com candidate='mentorado'
  And response inclui leads_recalculated: 10

Scenario: PATCH name sem mudar category não dispara backfill
  Given product P com category='curso_online' e 50 leads vinculados
  When PATCH /v1/products/P.id { name: 'Novo nome' }
  Then nenhum promoteLeadLifecycle é chamado
  And response não inclui leads_recalculated
```

### Citação em código
```ts
// BR-PRODUCT-003: mudança de category dispara backfill de lifecycle dos leads afetados
if (patch.category !== undefined && patch.category !== current.category) {
  const target = lifecycleForCategory(workspaceId, patch.category);
  for (const leadId of affectedLeadIds) {
    await promoteLeadLifecycle(db, leadId, target, ctx);
  }
}
```

---

## Aplicabilidade transversal

| Pipeline | BRs aplicáveis |
|---|---|
| `guru-raw-events-processor` Purchase | BR-PRODUCT-001, BR-PRODUCT-002 |
| `routes/lead.ts` form submit | BR-PRODUCT-001 (promove `contato → lead`) |
| `raw-events-processor` Lead event | BR-PRODUCT-001 |
| `routes/products.ts` PATCH | BR-PRODUCT-001, BR-PRODUCT-003 |
| `routes/products.ts` POST | (apenas constraints; sem promote) |
| `routes/launch-products.ts` PUT/DELETE | (apenas associação; sem promote) |
