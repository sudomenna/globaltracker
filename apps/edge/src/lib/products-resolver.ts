/**
 * products-resolver.ts — idempotent upsert para garantir Product row.
 *
 * BR-PRODUCT-002: produto desconhecido em webhook é auto-criado com category=NULL
 * e nome do payload. Operador depois categoriza via UI /products. Quando uma row
 * já existe, NÃO atualizamos nada — preserva category já atribuída pelo operador
 * e o `name` original (auto-criação é one-shot).
 *
 * Idempotência: SELECT-then-INSERT-ON-CONFLICT-DO-NOTHING-then-re-SELECT.
 * Postgres `RETURNING` em conflict-no-op retorna 0 linhas; o re-SELECT cobre o
 * caso de corrida em que outra transação inseriu primeiro.
 *
 * T-PRODUCTS-003.
 */

import type { Db } from '@globaltracker/db';
import { products } from '@globaltracker/db';
import { and, eq } from 'drizzle-orm';
import type { ProductCategory } from './lifecycle-rules.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ProductExternalProvider =
  | 'guru'
  | 'hotmart'
  | 'kiwify'
  | 'stripe'
  | 'manual'
  | 'onprofit';

export interface UpsertProductInput {
  workspaceId: string;
  externalProvider: ProductExternalProvider;
  externalProductId: string;
  name: string;
}

export interface UpsertProductResult {
  id: string;
  category: ProductCategory | null;
  name: string;
  /** True iff this call was the one that performed the INSERT. */
  isNew: boolean;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Returns the product row for `(workspaceId, externalProvider, externalProductId)`.
 * Auto-creates one with `category=NULL` and `status='active'` if not present.
 *
 * Never mutates an existing row — `name` and `category` are preserved as-is to
 * keep operator-assigned categorization stable (BR-PRODUCT-002).
 */
export async function upsertProduct(
  db: Db,
  input: UpsertProductInput,
): Promise<UpsertProductResult> {
  // 1. Fast path — SELECT existing.
  const existing = await db
    .select({
      id: products.id,
      category: products.category,
      name: products.name,
    })
    .from(products)
    .where(
      and(
        eq(products.workspaceId, input.workspaceId),
        eq(products.externalProvider, input.externalProvider),
        eq(products.externalProductId, input.externalProductId),
      ),
    )
    .limit(1);

  if (existing.length > 0) {
    const row = existing[0]!;
    return {
      id: row.id,
      category: row.category as ProductCategory | null,
      name: row.name,
      isNew: false,
    };
  }

  // 2. INSERT … ON CONFLICT DO NOTHING — atomic against concurrent writers.
  // BR-PRODUCT-002: category starts NULL; operator categorizes later via UI.
  const inserted = await db
    .insert(products)
    .values({
      workspaceId: input.workspaceId,
      externalProvider: input.externalProvider,
      externalProductId: input.externalProductId,
      name: input.name,
      category: null,
      status: 'active',
    })
    .onConflictDoNothing({
      target: [
        products.workspaceId,
        products.externalProvider,
        products.externalProductId,
      ],
    })
    .returning({
      id: products.id,
      category: products.category,
      name: products.name,
    });

  if (inserted.length > 0) {
    const row = inserted[0]!;
    return {
      id: row.id,
      category: row.category as ProductCategory | null,
      name: row.name,
      isNew: true,
    };
  }

  // 3. Lost the race — another transaction inserted between (1) and (2).
  // Re-SELECT to recover the canonical row deterministically.
  const reread = await db
    .select({
      id: products.id,
      category: products.category,
      name: products.name,
    })
    .from(products)
    .where(
      and(
        eq(products.workspaceId, input.workspaceId),
        eq(products.externalProvider, input.externalProvider),
        eq(products.externalProductId, input.externalProductId),
      ),
    )
    .limit(1);

  if (reread.length === 0) {
    throw new Error(
      `upsertProduct: failed to insert and re-read product workspace=${input.workspaceId} provider=${input.externalProvider} external_id=${input.externalProductId}`,
    );
  }

  const row = reread[0]!;
  return {
    id: row.id,
    category: row.category as ProductCategory | null,
    name: row.name,
    isNew: false,
  };
}
