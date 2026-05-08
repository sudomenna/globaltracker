# MOD-PRODUCT — Catálogo de produtos e associação produto ↔ lançamento

## 1. Identidade

- **ID:** MOD-PRODUCT
- **Tipo:** Supporting (cross-cutting; alimenta MOD-IDENTITY via `lifecycle_status` e MOD-LAUNCH via `launch_products`)
- **Dono conceitual:** MARKETER (categoriza produtos) + DOMAIN (regras de promoção)
- **Sprint de origem:** Sprint 16 (commits `cf66e83`, `0fb5ca6`)

## 2. Escopo

### Dentro
- Catálogo `products` por workspace, com identificadores externos (`external_provider`, `external_product_id`) e categoria canônica.
- Promoção de `leads.lifecycle_status` baseada em `products.category` via `promoteLeadLifecycle` (BR-PRODUCT-001).
- Auto-criação de produto a partir de Purchase webhook (Guru hoje; Hotmart/Kiwify/Stripe na sequência) com `category=NULL` para classificação posterior pelo operador (BR-PRODUCT-002).
- Relação tipada `launch_products` que vincula 1 produto a 1 launch com um `launch_role` em `{main_offer, main_order_bump, bait_offer, bait_order_bump}` (substitui o legacy free-string `workspaces.config.integrations.guru.product_launch_map` — ADR-037).

### Fora
- Tabela editável `lifecycle_rules` (planejada — FUTURE-001 / ADR-036). MVP usa hardcoded em `apps/edge/src/lib/lifecycle-rules.ts`, mas a função `lifecycleForCategory(workspaceId, category)` já recebe `workspaceId` para migração futura sem rewrite dos callers.
- UI de cadastro de produto (`apps/control-plane/src/app/(app)/products/**`) — tratada como frontend genérico, não escopo de domain author.
- Catalogação fina de bumps/upsells dentro de uma compra individual (Sprint futuro).

## 3. Entidades

### Product (`packages/db/src/schema/product.ts`, migration `0042`)
- `id` (uuid pk)
- `workspace_id` (uuid, FK)
- `name` (text)
- `category` (text NULL — CHECK aceita 11 valores canônicos de `ProductCategory` ou NULL)
- `external_provider` (`ProductExternalProvider` — `guru`/`hotmart`/`kiwify`/`stripe`/`manual`)
- `external_product_id` (text — id do produto na plataforma de origem; em `manual` o operador define livremente)
- `status` (`ProductStatus` — `active`/`archived`)
- `created_at`, `updated_at`

UNIQUE: `(workspace_id, external_provider, external_product_id)`. RLS: padrão `workspace_isolation` (ver `0028`).

### LaunchProduct (`packages/db/src/schema/launch_product.ts`, migration `0043`)
- `id` (uuid pk)
- `workspace_id` (uuid, FK)
- `launch_id` (uuid, FK → `launches.id`)
- `product_id` (uuid, FK → `products.id`)
- `launch_role` (`LaunchProductRole`)
- `created_at`, `updated_at`

UNIQUE: `(launch_id, product_id)` — um produto ocupa exatamente um role por launch. RLS: `workspace_isolation`.

## 4. Relações

- `Product N—1 Workspace`
- `Product 1—N LaunchProduct`
- `LaunchProduct N—1 Launch`
- `Product 1—N Event` (via `events.custom_data->>'product_db_id'` injetado no processor — não é FK formal, mas é a chave usada para `purchase_count`/`affected_leads` aggregates).

## 5. Estados

```
Product:    [active] ↔ [archived]
LaunchProduct: (sem máquina de estados — apenas presente/ausente; role pode ser atualizado)
```

## 6. Transições válidas (Product)

| De | Para | Quem |
|---|---|---|
| `active` | `archived` | `owner`/`admin` via `PATCH /v1/products/:id` |
| `archived` | `active` | `owner`/`admin` via `PATCH /v1/products/:id` |

## 7. Invariantes

- **INV-PRODUCT-001 — Identificação externa única por workspace.** Constraint `UNIQUE (workspace_id, external_provider, external_product_id)`. Testável.
- **INV-PRODUCT-002 — Categoria é NULL ou pertence ao enum canônico.** CHECK constraint em `products.category`. Testável.
- **INV-PRODUCT-003 — Um produto ocorre uma vez por launch.** UNIQUE `(launch_id, product_id)` em `launch_products`. Testável.
- **INV-PRODUCT-004 — `lifecycle_status` é monotônico.** `promoteLeadLifecycle` só executa UPDATE quando `rank(candidate) > rank(current)`. Testável (`tests/unit/lib/lifecycle-promoter.test.ts`).

## 8. BRs relacionadas

- `BR-PRODUCT-001` — Lifecycle hierarchy é monotônica.
- `BR-PRODUCT-002` — Produto desconhecido em webhook é auto-criado com `category=NULL`.
- `BR-PRODUCT-003` — `PATCH /v1/products/:id` que muda `category` dispara backfill de leads afetados.

(Detalhe em `docs/50-business-rules/BR-PRODUCT.md`.)

## 9. Contratos consumidos

- `MOD-WORKSPACE.requireActiveWorkspace()`
- `MOD-IDENTITY.resolveLeadByAliases()` (no caller — pipeline de Purchase)
- `MOD-AUDIT.recordAuditEntry()` (em mutações)

## 10. Contratos expostos

- `upsertProduct({workspace_id, external_provider, external_product_id, name}): Result<Product>` — idempotente. SELECT → INSERT ON CONFLICT DO NOTHING → re-SELECT, preservando `category` previamente atribuída pelo operador. (`apps/edge/src/lib/products-resolver.ts`)
- `lifecycleForCategory(workspace_id, category): LifecycleStatus` — mapeia categoria (ou NULL) para target. Recebe `workspace_id` para migração futura para tabela `lifecycle_rules` (ADR-036). (`apps/edge/src/lib/lifecycle-rules.ts`)
- `promoteLeadLifecycle(lead_id, candidate, ctx): Result<{from, to, changed}>` — SELECT current → comparar rank → UPDATE-only-if-changed. Idempotente e race-tolerant em pequena enum total order. (`apps/edge/src/lib/lifecycle-promoter.ts`)
- `getLaunchProducts(launch_id): Result<LaunchProduct[]>` — usado por `guru-launch-resolver.ts` Strategy 0.

## 11. Eventos de timeline emitidos

Não emite TE-* dedicados nesta versão; consumidores observam mudança via `audit_log` (`product_created`, `product_updated`, `product_category_updated`, `launch_product_set`, `launch_product_unset`) e via mudança de `lead.lifecycle_status` (visível em `MOD-IDENTITY` timeline).

## 12. Pontos de integração

- `apps/edge/src/lib/guru-raw-events-processor.ts` — Purchase event auto-cria product (`category=NULL`), injeta `product_db_id` em `events.custom_data`, e dispara `promoteLeadLifecycle(lead_id, lifecycleForCategory(category))`.
- `apps/edge/src/routes/lead.ts` — form submit promove `contato → lead` após `resolveLeadByAliases` (não-fatal; INV-PRIVACY-006-soft).
- `apps/edge/src/lib/raw-events-processor.ts` — Lead event do tracker idem.
- `apps/edge/src/lib/guru-launch-resolver.ts` — Strategy 0 consulta `launch_products` (JOIN `products` via `external_provider`+`external_product_id`); legacy `workspaces.config.integrations.guru.product_launch_map` mantido como fallback Strategy 1 durante migração.
- (Futuro) Hotmart/Kiwify/Stripe webhook adapters — replicar `upsertProduct` + `promoteLeadLifecycle` no Purchase handler.

## 13. Ownership de código

**Pode editar:**
- `packages/db/src/schema/product.ts`
- `packages/db/src/schema/launch_product.ts`
- `packages/db/migrations/0042_products_and_lifecycle_status.sql`
- `packages/db/migrations/0043_launch_products.sql`
- `apps/edge/src/lib/lifecycle-rules.ts`
- `apps/edge/src/lib/lifecycle-promoter.ts`
- `apps/edge/src/lib/products-resolver.ts`
- `apps/edge/src/routes/products.ts`
- `apps/edge/src/routes/launch-products.ts`
- `tests/unit/lib/lifecycle-rules.test.ts`
- `tests/unit/lib/lifecycle-promoter.test.ts`
- `tests/unit/lib/products-resolver.test.ts`

**Lê:**
- `apps/edge/src/lib/workspace.ts`
- `apps/edge/src/lib/audit.ts`
- `apps/edge/src/lib/lead-resolver.ts` (para chamar `promoteLeadLifecycle` após resolver)

## 14. Dependências permitidas / proibidas

**Permitidas:** `MOD-WORKSPACE`, `MOD-IDENTITY` (escreve `leads.lifecycle_status`), `MOD-AUDIT`, `MOD-LAUNCH` (FK em `launch_products`).
**Proibidas:** `MOD-DISPATCH`, `MOD-AUDIENCE` (não devem depender de produto; consomem leads).

## 15. Test harness

- `tests/unit/lib/lifecycle-rules.test.ts` — INV-PRODUCT-002 (categoria → lifecycle target).
- `tests/unit/lib/lifecycle-promoter.test.ts` — INV-PRODUCT-004 (monotonia + idempotência).
- `tests/unit/lib/products-resolver.test.ts` — INV-PRODUCT-001 (UNIQUE) + idempotência de `upsertProduct`.

## 16. FUTURE / pendências

- **FUTURE-001 (ADR-036)** — Migrar `lifecycle-rules.ts` hardcoded para tabela `lifecycle_rules` editável por workspace. A assinatura `lifecycleForCategory(workspaceId, category)` já está pronta para isso (recebe `workspaceId` desde Sprint 16).
- **FUTURE-002** — Replicar `upsertProduct` + `promoteLeadLifecycle` em Hotmart/Kiwify/Stripe webhook handlers (hoje só Guru).
- **FUTURE-003** — Deprecar e remover `workspaces.config.integrations.guru.product_launch_map` quando todos os workspaces tiverem `launch_products` populado (hoje migração feita só para CNE). Strategy 1 fallback em `guru-launch-resolver.ts` pode ser removida.
