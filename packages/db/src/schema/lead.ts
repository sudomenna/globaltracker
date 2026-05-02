import { pgTable, smallint, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { workspaces } from './workspace.js';

// ADR-005: NO unique constraints on email_hash or phone_hash.
//   Uniqueness of PII identifiers is managed exclusively via lead_aliases.
//   Multiple leads can share the same hash (pre-merge state).
//
// BR-PRIVACY-002: PII must be hashed before storage — *_hash columns hold SHA-256 hex.
// BR-PRIVACY-003: Sensitive PII must be encrypted — *_enc columns hold AES-256-GCM base64.
//
// INV-IDENTITY-002: erased lead has email_enc IS NULL, phone_enc IS NULL, name_enc IS NULL,
//   and all hash fields IS NULL. Enforced at service layer (eraseLead).
// INV-IDENTITY-003: merged lead does not receive new aliases or events — enforced at Edge layer.

export const leads = pgTable('leads', {
  // PK: internal UUID — never exposed to browser (browser uses lead_token)
  // BR-IDENTITY-013 (AGENTS.md rule 13): browser never receives lead_id in clear
  id: uuid('id').primaryKey().defaultRandom(),

  // Multi-tenant anchor — BR-RBAC-002: RLS enforces app.current_workspace_id
  workspaceId: uuid('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'restrict' }),

  // BR-PRIVACY-002: external_id_hash is SHA-256 of the external identifier (nullable — may be absent)
  externalIdHash: text('external_id_hash'),

  // BR-PRIVACY-002: email_hash is SHA-256 of normalized email (lowercase + trim)
  // ADR-005: NO unique constraint here — uniqueness lives in lead_aliases
  // INV-IDENTITY-007: normalization is enforced in lib/pii.ts hash() helper, not DB
  emailHash: text('email_hash'),

  // BR-PRIVACY-002: phone_hash is SHA-256 of E.164-normalized phone
  // ADR-005: NO unique constraint here — uniqueness lives in lead_aliases
  phoneHash: text('phone_hash'),

  // BR-PRIVACY-002: name_hash is SHA-256 of name (lowercase + trim)
  nameHash: text('name_hash'),

  // BR-PRIVACY-003: email_enc is AES-256-GCM encrypted value (base64)
  emailEnc: text('email_enc'),

  // BR-PRIVACY-003: phone_enc is AES-256-GCM encrypted value (base64)
  phoneEnc: text('phone_enc'),

  // BR-PRIVACY-003: name_enc is AES-256-GCM encrypted value (base64)
  nameEnc: text('name_enc'),

  // Key version for AES-256-GCM envelope encryption; used for key rotation (ADR-009)
  piiKeyVersion: smallint('pii_key_version').notNull().default(1),

  // LeadStatus: 'active' | 'merged' | 'erased'
  // INV-IDENTITY-003: 'merged' leads must not receive new aliases or events (Edge enforced)
  // INV-IDENTITY-002: 'erased' leads must have all PII fields set to NULL (SAR service enforced)
  // chk_leads_status enforces valid values (defined in migration)
  status: text('status').notNull().default('active'),

  // Self-referential FK: populated when status='merged' to point to the canonical lead
  // INV-IDENTITY-003: resolver follows this chain to reach canonical lead
  mergedIntoLeadId: uuid('merged_into_lead_id'),

  // first_seen_at: timestamp of the first event/alias associated with this lead
  firstSeenAt: timestamp('first_seen_at', { withTimezone: true })
    .notNull()
    .defaultNow(),

  // last_seen_at: timestamp of the most recent event/alias associated with this lead
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true })
    .notNull()
    .defaultNow(),

  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type Lead = typeof leads.$inferSelect;
export type NewLead = typeof leads.$inferInsert;
