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
import { launches } from './launch.js';
import { products } from './product.js';
import { workspaces } from './workspace.js';

/**
 * launch_products — assoc product↔launch com papel tipado.
 *
 * Substitui workspaces.config.integrations.guru.product_launch_map (legacy).
 * launch_role enum estrito:
 *   - main_offer        — produto principal do funil (curso/oferta backend)
 *   - main_order_bump   — cross-sell na main_offer
 *   - bait_offer        — isca de baixo ticket (workshop, ebook gratuito-pago)
 *   - bait_order_bump   — cross-sell na bait_offer
 */
export const launchProducts = pgTable(
  'launch_products',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    launchId: uuid('launch_id')
      .notNull()
      .references(() => launches.id, { onDelete: 'cascade' }),
    productId: uuid('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'cascade' }),
    launchRole: text('launch_role').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    launchProductUnique: uniqueIndex('uq_launch_products_launch_product').on(
      t.launchId,
      t.productId,
    ),
    workspaceIdx: index('idx_launch_products_workspace').on(t.workspaceId),
    launchIdx: index('idx_launch_products_launch').on(t.launchId),
    productIdx: index('idx_launch_products_product').on(t.productId),
    launchRoleCheck: check(
      'chk_launch_products_launch_role',
      sql`${t.launchRole} IN ('main_offer', 'main_order_bump', 'bait_offer', 'bait_order_bump')`,
    ),
  }),
);

export type LaunchProduct = typeof launchProducts.$inferSelect;
export type NewLaunchProduct = typeof launchProducts.$inferInsert;
