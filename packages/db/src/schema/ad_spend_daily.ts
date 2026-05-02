import {
  date,
  integer,
  numeric,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { launches } from './launch.js';
import { workspaces } from './workspace.js';

// INV-COST-001: Unique key is a COALESCE expression index — not a simple constraint.
//   (workspace_id, platform, account_id, COALESCE(campaign_id,''), COALESCE(adset_id,''),
//    COALESCE(ad_id,''), granularity, date)
//   uq_ad_spend_daily_natural_key
//   NOTE: timezone is informativo and does NOT participate in the unique key.
// INV-COST-002: granularity IN ('account','campaign','adset','ad') — chk_ad_spend_daily_granularity
// INV-COST-005: currency must be a 3-char ISO 4217 code — chk_ad_spend_daily_currency_length
// BR-COST-001: spend_cents >= 0 — chk_ad_spend_daily_spend_cents_non_negative

export const adSpendDaily = pgTable('ad_spend_daily', {
  // PK: internal UUID — never exposed to browser
  id: uuid('id').primaryKey().defaultRandom(),

  // Multi-tenant anchor — RLS filters by app.current_workspace_id
  workspaceId: uuid('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'restrict' }),

  launchId: uuid('launch_id').references(() => launches.id, {
    onDelete: 'restrict',
  }),

  // Platform enum — Platform: 'meta' | 'google'
  // chk_ad_spend_daily_platform enforces valid values
  platform: text('platform').notNull(),

  // The ad account identifier from the platform
  accountId: text('account_id').notNull(),

  // Hierarchical ad targeting fields — NULL when not applicable to granularity level
  campaignId: text('campaign_id'),
  adsetId: text('adset_id'),
  adId: text('ad_id'),

  // INV-COST-002: Granularity enum — 'account' | 'campaign' | 'adset' | 'ad'
  // chk_ad_spend_daily_granularity enforces valid values
  granularity: text('granularity').notNull(),

  // The spend date (one row per day per natural key)
  date: date('date').notNull(),

  // Informativo only — does NOT participate in the unique key (INV-COST-001)
  timezone: text('timezone').notNull(),

  // INV-COST-005: ISO 4217 3-char currency code — chk_ad_spend_daily_currency_length
  currency: text('currency').notNull(),

  // BR-COST-001: spend in original platform currency, in cents — must be >= 0
  spendCents: integer('spend_cents').notNull(),

  // INV-COST-003: populated after FX lookup (spend_cents * fx_rate, rounded to int)
  // NULL until the FX normalization cron runs
  spendCentsNormalized: integer('spend_cents_normalized'),

  // FX normalisation fields — populated together when FX lookup completes
  // INV-COST-004: fx_currency corresponds to workspaces.fx_normalization_currency at write time
  fxRate: numeric('fx_rate', { precision: 18, scale: 8 }),
  // FxSource: 'ecb' | 'wise' | 'manual'
  // chk_ad_spend_daily_fx_source enforces valid values
  fxSource: text('fx_source'),
  // 3-char ISO 4217 target currency — chk_ad_spend_daily_fx_currency_length
  fxCurrency: text('fx_currency'),

  // Performance metrics
  impressions: integer('impressions').notNull().default(0),
  clicks: integer('clicks').notNull().default(0),

  // Timestamp when this row was fetched from the platform API
  fetchedAt: timestamp('fetched_at', { withTimezone: true })
    .notNull()
    .defaultNow(),

  // SHA-256 hex of the original API response payload for deduplication / audit
  sourcePayloadHash: text('source_payload_hash'),

  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type AdSpendDaily = typeof adSpendDaily.$inferSelect;
export type NewAdSpendDaily = typeof adSpendDaily.$inferInsert;
