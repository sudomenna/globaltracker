import {
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { launches } from './launch.js';
import { workspaces } from './workspace.js';

// Meta Audiences Mirror — cache read-only de audiences do Meta Ads, vinculadas a launches.
//
// Associação por inferência: o edge lê campanhas Meta cujo nome começa com
// config.metaCampaignPrefix do launch, extrai as audiences usadas nos ad sets
// e armazena aqui para exibição read-only no Control Plane.
//
// INV-META-AUDIENCE-001: (workspace_id, launch_id, meta_audience_id) é único — constraint
//   uq_meta_audiences_workspace_launch_audience. Permite upsert seguro na sincronização.
// INV-META-AUDIENCE-002: apenas service role / edge escreve; workspace members só leem (RLS).
// INV-META-AUDIENCE-003: launch_id é nullable — audience pode ficar órfã se launch for deletado
//   (ON DELETE SET NULL), mas permanece no cache vinculada ao workspace.

export const metaAudiences = pgTable(
  'meta_audiences',
  {
    // PK: internal UUID — nunca exposto diretamente ao browser
    id: uuid('id').primaryKey().defaultRandom(),

    // Multi-tenant anchor — RLS filtra por app.current_workspace_id (BR-RBAC-002)
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),

    // INV-META-AUDIENCE-003: nullable — ON DELETE SET NULL preserva o cache
    // mesmo após remoção do launch associado
    launchId: uuid('launch_id').references(() => launches.id, {
      onDelete: 'set null',
    }),

    // ID do lado Meta Ads (ex: "120245013791030082")
    metaAudienceId: text('meta_audience_id').notNull(),

    // Nome da audience conforme retornado pela API Meta
    name: text('name').notNull(),

    // Tipo de audience: 'CUSTOM' | 'WEBSITE' | 'LOOKALIKE' | 'IG_BUSINESS'
    // Corresponde ao campo subtype da API Meta Custom Audiences
    subtype: text('subtype').notNull(),

    // approximate_count_upper_bound da API Meta (nullable — pode não estar disponível)
    approxCount: integer('approx_count'),

    // Código de status de entrega da Meta (200=pronto, 300=muito pequeno, etc.)
    deliveryStatusCode: integer('delivery_status_code'),

    // Descrição textual do status de entrega (nullable)
    deliveryStatusDescription: text('delivery_status_description'),

    // Timestamp da última sincronização com a API Meta
    syncedAt: timestamp('synced_at', { withTimezone: true })
      .notNull()
      .defaultNow(),

    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    // INV-META-AUDIENCE-001: unicidade por (workspace, launch, meta_audience_id)
    // Garante upsert idempotente na sincronização periódica
    uqWorkspaceLaunchAudience: unique(
      'uq_meta_audiences_workspace_launch_audience',
    ).on(table.workspaceId, table.launchId, table.metaAudienceId),
  }),
);

export type MetaAudience = typeof metaAudiences.$inferSelect;
export type NewMetaAudience = typeof metaAudiences.$inferInsert;
