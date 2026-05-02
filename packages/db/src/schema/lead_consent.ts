import { pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { leads } from './lead.js';
import { workspaces } from './workspace.js';

// BR-CONSENT-001: Consent is recorded per lead, per finality, at a point in time.
//   This table is append-only — each row is an immutable consent record.
//   Latest row per (lead_id, finality) is the effective consent state.
//
// BR-PRIVACY-002: Consent records are tied to lead_id (internal), not PII in clear.
//
// ConsentValue per column: 'granted' | 'denied' | 'unknown'
//   'unknown' is the safe default — dispatcher checks before sending to external platforms.
//
// ConsentFinality (5 finalidades per ADR-010):
//   analytics, marketing, ad_user_data, ad_personalization, customer_match
//
// BR-DISPATCH-003 (implicit): dispatcher reads getLatestConsent() before sending to Meta/Google.

export const leadConsents = pgTable('lead_consents', {
  // PK: internal UUID
  id: uuid('id').primaryKey().defaultRandom(),

  // Multi-tenant anchor — BR-RBAC-002: RLS enforces app.current_workspace_id
  workspaceId: uuid('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'restrict' }),

  // FK to leads — on delete restrict
  leadId: uuid('lead_id')
    .notNull()
    .references(() => leads.id, { onDelete: 'restrict' }),

  // Optional reference to the event that triggered this consent record
  // NULL is valid for administrative/manual consent records
  eventId: text('event_id'),

  // ConsentValue: 'granted' | 'denied' | 'unknown'
  // chk_lead_consents_consent_analytics enforces valid values (defined in migration)
  consentAnalytics: text('consent_analytics').notNull().default('unknown'),

  // ConsentValue: 'granted' | 'denied' | 'unknown'
  // chk_lead_consents_consent_marketing enforces valid values (defined in migration)
  consentMarketing: text('consent_marketing').notNull().default('unknown'),

  // ConsentValue: 'granted' | 'denied' | 'unknown'
  // chk_lead_consents_consent_ad_user_data enforces valid values (defined in migration)
  consentAdUserData: text('consent_ad_user_data').notNull().default('unknown'),

  // ConsentValue: 'granted' | 'denied' | 'unknown'
  // chk_lead_consents_consent_ad_personalization enforces valid values (defined in migration)
  consentAdPersonalization: text('consent_ad_personalization')
    .notNull()
    .default('unknown'),

  // ConsentValue: 'granted' | 'denied' | 'unknown'
  // chk_lead_consents_consent_customer_match enforces valid values (defined in migration)
  consentCustomerMatch: text('consent_customer_match')
    .notNull()
    .default('unknown'),

  // Source of this consent record (e.g., 'tracker', 'webhook:hotmart', 'admin')
  source: text('source').notNull(),

  // Policy version at the time of consent collection (e.g., '2024-01', '2.1')
  policyVersion: text('policy_version').notNull(),

  // Timestamp of consent record creation
  ts: timestamp('ts', { withTimezone: true }).notNull().defaultNow(),
});

export type LeadConsent = typeof leadConsents.$inferSelect;
export type NewLeadConsent = typeof leadConsents.$inferInsert;
