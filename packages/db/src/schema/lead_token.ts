import { pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { leads } from './lead.js';
import { workspaces } from './workspace.js';

// ADR-006: lead_token is stateful — stored in DB to support SAR revocation.
//   Browser receives only the clear token (never lead_id).
//   BR-IDENTITY-013 (AGENTS.md rule 13): browser never receives lead_id in clear.
//
// INV-IDENTITY-006: A lead token is valid only when the page_token_hash matches
//   the current or rotating page_token on the page.
//   Validated at Edge by validateLeadToken() — prevents token theft across pages.
//
// token_hash: SHA-256 of the clear token issued to browser — exactly 64 hex chars.
//   UNIQUE globally — one clear token cannot belong to two leads.
//
// page_token_hash: SHA-256 of the page_token bound to this lead_token at issuance.
//   Prevents token reuse on a different page (INV-IDENTITY-006).

export const leadTokens = pgTable('lead_tokens', {
  // PK: internal UUID — used for revocation by ID in admin operations
  id: uuid('id').primaryKey().defaultRandom(),

  // Multi-tenant anchor — BR-RBAC-002: RLS enforces app.current_workspace_id
  workspaceId: uuid('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'restrict' }),

  // FK to leads — on delete restrict
  leadId: uuid('lead_id')
    .notNull()
    .references(() => leads.id, { onDelete: 'restrict' }),

  // SHA-256 hex of the clear token stored in browser cookie (__ftk)
  // chk_lead_tokens_token_hash_length: length must be exactly 64 (SHA-256 hex)
  // uq_lead_tokens_token_hash: globally unique — same secret cannot map to two leads
  tokenHash: text('token_hash').notNull().unique(),

  // SHA-256 hex of the page_token active at issuance — binding for INV-IDENTITY-006
  // chk_lead_tokens_page_token_hash_length: length must be exactly 64
  pageTokenHash: text('page_token_hash').notNull(),

  // Timestamp when this token was issued
  issuedAt: timestamp('issued_at', { withTimezone: true })
    .notNull()
    .defaultNow(),

  // Timestamp after which this token is no longer valid for authentication
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),

  // Timestamp when this token was explicitly revoked (SAR, manual, or security)
  // NULL = not revoked; validateLeadToken() checks this before accepting token
  revokedAt: timestamp('revoked_at', { withTimezone: true }),

  // Timestamp of most recent use — for analytics and sliding expiry (future)
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
});

export type LeadToken = typeof leadTokens.$inferSelect;
export type NewLeadToken = typeof leadTokens.$inferInsert;
