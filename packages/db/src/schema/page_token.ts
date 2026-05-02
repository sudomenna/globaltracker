import { pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { pages } from './page.js';
import { workspaces } from './workspace.js';

// T-1-003: Schema MOD-PAGE — page_tokens table
//
// ADR-023: page_tokens.status ∈ {active, rotating, revoked}
//   Rotation creates a new active token while marking the old one as 'rotating' for
//   PAGE_TOKEN_ROTATION_OVERLAP_DAYS (default 14). After the overlap window, the old
//   token transitions to 'revoked'. Emergency revocation bypasses the overlap window.
//
// INV-PAGE-003: token_hash is globally unique — uq_page_tokens_token_hash
// INV-PAGE-004: each active page must have at least one token with status='active'
//   Validated at Edge service layer (cannot be a pure DB constraint)
// INV-PAGE-005: revoked tokens do not authenticate — Edge returns 401 for status='revoked'
//   Enforced at Edge (getPageByToken returns RevokedToken error when status='revoked')
//
// token_hash: SHA-256 hex of the clear token embedded in page snippets — exactly 64 hex chars.
//   Globally unique — one secret cannot belong to two pages.
//
// BR-RBAC-002: workspace_id is multi-tenant anchor; RLS enforces app.current_workspace_id

export const pageTokens = pgTable('page_tokens', {
  // PK: internal UUID — used for revocation by ID in admin operations
  id: uuid('id').primaryKey().defaultRandom(),

  // Multi-tenant anchor — BR-RBAC-002: app.current_workspace_id enforced by RLS
  workspaceId: uuid('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'restrict' }),

  // FK to pages — on delete restrict; token cannot exist without a page
  pageId: uuid('page_id')
    .notNull()
    .references(() => pages.id, { onDelete: 'restrict' }),

  // SHA-256 hex of the clear token embedded in page snippets (HTML/JavaScript)
  // INV-PAGE-003: globally unique — uq_page_tokens_token_hash
  // chk_page_tokens_token_hash_length: length must be exactly 64 (SHA-256 hex)
  tokenHash: text('token_hash').notNull(),

  // Human-readable label for operator reference (e.g., "v1 — produção", "v2 — rotação")
  label: text('label').notNull().default(''),

  // ADR-023: PageTokenStatus: 'active' | 'rotating' | 'revoked'
  //   'active'   — token is valid; used by snippets in production
  //   'rotating' — token is in overlap window; still accepted by Edge but generates legacy_token_in_use metric
  //   'revoked'  — token is invalidated; Edge returns 401 (INV-PAGE-005)
  // chk_page_tokens_status enforces valid values
  status: text('status').notNull().default('active'),

  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),

  // ADR-023: set when rotation is initiated; NULL while token is 'active'
  rotatedAt: timestamp('rotated_at', { withTimezone: true }),

  // Set when token transitions to 'revoked' (either after overlap window or emergency revocation)
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
});

export type PageToken = typeof pageTokens.$inferSelect;
export type NewPageToken = typeof pageTokens.$inferInsert;
