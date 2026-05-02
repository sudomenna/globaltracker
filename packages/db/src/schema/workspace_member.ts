import { index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { workspaces } from './workspace.js';

// BR-RBAC-001: Owner unique per workspace — enforced by partial unique index
// uq_workspace_members_one_active_owner_per_workspace (WHERE role='owner' AND removed_at IS NULL)

// BR-RBAC-002: Cross-workspace queries prohibited — enforced by RLS policy
// workspace_members_workspace_isolation filters by app.current_workspace_id

export const workspaceMembers = pgTable(
  'workspace_members',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    // Multi-tenant FK: on delete restrict prevents accidental workspace deletion
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'restrict' }),

    // External reference to Supabase Auth — no FK constraint (cross-service boundary)
    userId: uuid('user_id').notNull(),

    // Role enum: 'owner' | 'admin' | 'marketer' | 'operator' | 'privacy' | 'viewer'
    // chk_workspace_members_role enforces valid values
    role: text('role').notNull(),

    invitedAt: timestamp('invited_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    joinedAt: timestamp('joined_at', { withTimezone: true }),
    removedAt: timestamp('removed_at', { withTimezone: true }),
  },
  (table) => ({
    // idx_workspace_members_workspace_id for RLS + join performance
    idxWorkspaceId: index('idx_workspace_members_workspace_id').on(
      table.workspaceId,
    ),

    // idx_workspace_members_user_id for reverse lookup
    idxUserId: index('idx_workspace_members_user_id').on(table.userId),

    // idx_workspace_members_workspace_user for active membership lookup
    idxWorkspaceUser: index('idx_workspace_members_workspace_user').on(
      table.workspaceId,
      table.userId,
    ),
  }),
);

export type WorkspaceMember = typeof workspaceMembers.$inferSelect;
export type NewWorkspaceMember = typeof workspaceMembers.$inferInsert;
