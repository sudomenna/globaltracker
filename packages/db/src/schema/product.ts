import { sql } from 'drizzle-orm';
import {
  check,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { workspaces } from './workspace.js';

/**
 * products — catálogo por workspace.
 *
 * Auto-criado quando webhook (Guru/Hotmart/etc) traz product_id desconhecido.
 * `category` começa NULL e o operador atribui via UI; mudança de category dispara
 * recálculo de leads.lifecycle_status afetados.
 *
 * BR-PRODUCT-001: hierarquia monotônica (lifecycle nunca regride).
 * BR-PRODUCT-002: auto-criação com category=NULL quando webhook traz product novo.
 * BR-PRODUCT-003: PATCH category dispara backfill de leads afetados.
 */
export const products = pgTable(
  'products',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    category: text('category'),
    externalProvider: text('external_provider').notNull(),
    externalProductId: text('external_product_id').notNull(),
    status: text('status').notNull().default('active'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    workspaceProviderExternalIdUnique: uniqueIndex(
      'uq_products_workspace_provider_external_id',
    ).on(t.workspaceId, t.externalProvider, t.externalProductId),
    workspaceStatusIdx: index('idx_products_workspace_status').on(
      t.workspaceId,
      t.status,
    ),
    workspaceCategoryIdx: index('idx_products_workspace_category')
      .on(t.workspaceId, t.category)
      .where(sql`${t.category} IS NOT NULL`),
    categoryCheck: check(
      'chk_products_category',
      sql`${t.category} IS NULL OR ${t.category} IN (
        'ebook', 'workshop_online', 'webinar',
        'curso_online', 'curso_presencial', 'pos_graduacao', 'treinamento_online', 'evento_fisico',
        'mentoria_individual', 'mentoria_grupo', 'acompanhamento_individual'
      )`,
    ),
    statusCheck: check(
      'chk_products_status',
      sql`${t.status} IN ('active', 'archived')`,
    ),
    externalProviderCheck: check(
      'chk_products_external_provider',
      sql`${t.externalProvider} IN ('guru', 'hotmart', 'kiwify', 'stripe', 'manual')`,
    ),
    nameLengthCheck: check(
      'chk_products_name_length',
      sql`length(${t.name}) BETWEEN 1 AND 256`,
    ),
    externalProductIdLengthCheck: check(
      'chk_products_external_product_id_length',
      sql`length(${t.externalProductId}) BETWEEN 1 AND 256`,
    ),
  }),
);

export type Product = typeof products.$inferSelect;
export type NewProduct = typeof products.$inferInsert;
