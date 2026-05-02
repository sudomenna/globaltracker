import { index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { workspaces } from './workspace.js';

// BR-RBAC-002: Cross-workspace queries prohibited — enforced by RLS policy
// workspace_api_keys_workspace_isolation filters by app.current_workspace_id

// INV-WORKSPACE-005: revoked_at IS NOT NULL means key is revoked — auth check at Edge layer

export const workspaceApiKeys = pgTable(
  'workspace_api_keys',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    // Multi-tenant FK: on delete restrict prevents accidental workspace deletion
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'restrict' }),

    name: text('name').notNull(),

    // SHA-256 hex of the raw secret — 64 hex chars
    // chk_workspace_api_keys_key_hash_length enforces length = 64
    // uq_workspace_api_keys_key_hash enforces global uniqueness
    keyHash: text('key_hash').notNull().unique(),

    // Array of scope strings: 'events:write', 'leads:erase', etc.
    scopes: text('scopes').array().notNull().default([]),

    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),

    // INV-WORKSPACE-005: nullable — null means active; not null means revoked
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (table) => ({
    // idx_workspace_api_keys_workspace_id for RLS + list queries
    idxWorkspaceId: index('idx_workspace_api_keys_workspace_id').on(
      table.workspaceId,
    ),

    // idx_workspace_api_keys_key_hash for auth lookup by hash
    idxKeyHash: index('idx_workspace_api_keys_key_hash').on(table.keyHash),
  }),
);

export type WorkspaceApiKey = typeof workspaceApiKeys.$inferSelect;
export type NewWorkspaceApiKey = typeof workspaceApiKeys.$inferInsert;
