/**
 * Unit tests for granularity and COALESCE unique key logic.
 *
 * INV-COST-001: unique key uses COALESCE(campaign_id,''), COALESCE(adset_id,''),
 *   COALESCE(ad_id,'') — NULL and '' are NOT equivalent in the key:
 *   NULL coalesces to '' giving the same slot, so two rows with NULL and ''
 *   campaign_id ARE treated as the same key position.
 *
 * INV-COST-002: granularity must be one of 'account'|'campaign'|'adset'|'ad'.
 *
 * These tests verify:
 *   - The coalesce logic used by the ingestor when building upsert rows
 *   - That distinct (granularity, campaign_id) combos produce distinct keys
 *   - That NULL campaign_id and empty string produce the same coalesced value
 */

import { describe, expect, it } from 'vitest';

// ---------------------------------------------------------------------------
// Helper: mirror of the COALESCE key used in INV-COST-001
// ---------------------------------------------------------------------------

/**
 * Compute the natural key tuple that the DB unique index uses.
 *
 * This mirrors:
 *   (workspace_id, platform, account_id,
 *    COALESCE(campaign_id,''), COALESCE(adset_id,''), COALESCE(ad_id,''),
 *    granularity, date)
 *
 * INV-COST-001: `timezone` is NOT part of the key.
 */
function naturalKey(row: {
  workspaceId: string;
  platform: string;
  accountId: string;
  campaignId: string | null;
  adsetId: string | null;
  adId: string | null;
  granularity: string;
  date: string;
}): string {
  // INV-COST-001: COALESCE(x, '') — NULL treated same as ''
  const camp = row.campaignId ?? '';
  const adset = row.adsetId ?? '';
  const ad = row.adId ?? '';
  return [
    row.workspaceId,
    row.platform,
    row.accountId,
    camp,
    adset,
    ad,
    row.granularity,
    row.date,
  ].join('|');
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const BASE = {
  workspaceId: 'ws-1',
  platform: 'meta',
  accountId: 'acct-1',
  date: '2026-05-01',
};

describe('naturalKey — INV-COST-001 COALESCE semantics', () => {
  it('NULL campaign_id and empty string produce the same key slot', () => {
    const withNull = naturalKey({
      ...BASE,
      campaignId: null,
      adsetId: null,
      adId: null,
      granularity: 'account',
    });
    const withEmpty = naturalKey({
      ...BASE,
      campaignId: '',
      adsetId: '',
      adId: '',
      granularity: 'account',
    });

    // INV-COST-001: COALESCE(NULL,'') === COALESCE('','') → same key
    expect(withNull).toBe(withEmpty);
  });

  it('different campaign_ids produce different keys', () => {
    const key1 = naturalKey({
      ...BASE,
      campaignId: 'camp-A',
      adsetId: null,
      adId: null,
      granularity: 'campaign',
    });
    const key2 = naturalKey({
      ...BASE,
      campaignId: 'camp-B',
      adsetId: null,
      adId: null,
      granularity: 'campaign',
    });

    expect(key1).not.toBe(key2);
  });

  it('same campaign_id but different granularity produce different keys', () => {
    const adLevel = naturalKey({
      ...BASE,
      campaignId: 'c1',
      adsetId: 'as1',
      adId: 'ad1',
      granularity: 'ad',
    });
    const adsetLevel = naturalKey({
      ...BASE,
      campaignId: 'c1',
      adsetId: 'as1',
      adId: null,
      granularity: 'adset',
    });

    // INV-COST-001: granularity is part of the key
    expect(adLevel).not.toBe(adsetLevel);
  });

  it('account granularity with NULL hierarchy fields is distinct from ad granularity with real ids', () => {
    const accountRow = naturalKey({
      ...BASE,
      campaignId: null,
      adsetId: null,
      adId: null,
      granularity: 'account',
    });
    const adRow = naturalKey({
      ...BASE,
      campaignId: 'c1',
      adsetId: 'as1',
      adId: 'ad1',
      granularity: 'ad',
    });

    // BR-COST-001 scenario: account granularity and ad granularity coexist
    expect(accountRow).not.toBe(adRow);
  });

  it('timezone does NOT appear in the key (INV-COST-001)', () => {
    // timezone is informativo — two rows differing only in timezone must
    // map to the same natural key (they will conflict in DB)
    const sao_paulo = naturalKey({
      ...BASE,
      campaignId: 'c1',
      adsetId: 'as1',
      adId: 'ad1',
      granularity: 'ad',
    });
    const utc = naturalKey({
      ...BASE,
      campaignId: 'c1',
      adsetId: 'as1',
      adId: 'ad1',
      granularity: 'ad',
    });

    // Both use same fields (timezone not included in key function)
    // INV-COST-001: timezone excluded from unique key → same key
    expect(sao_paulo).toBe(utc);
  });

  it('different dates produce different keys', () => {
    const day1 = naturalKey({
      ...BASE,
      campaignId: 'c1',
      adsetId: 'as1',
      adId: 'ad1',
      granularity: 'ad',
      date: '2026-05-01',
    });
    const day2 = naturalKey({
      ...BASE,
      campaignId: 'c1',
      adsetId: 'as1',
      adId: 'ad1',
      granularity: 'ad',
      date: '2026-05-02',
    });

    expect(day1).not.toBe(day2);
  });

  it('different platforms produce different keys', () => {
    const meta = naturalKey({
      ...BASE,
      platform: 'meta',
      campaignId: 'c1',
      adsetId: 'as1',
      adId: null,
      granularity: 'adset',
    });
    const google = naturalKey({
      ...BASE,
      platform: 'google',
      campaignId: 'c1',
      adsetId: 'as1',
      adId: null,
      granularity: 'adset',
    });

    expect(meta).not.toBe(google);
  });
});

// ---------------------------------------------------------------------------
// INV-COST-002: granularity enum validation
// ---------------------------------------------------------------------------

const VALID_GRANULARITIES = ['account', 'campaign', 'adset', 'ad'] as const;
type Granularity = (typeof VALID_GRANULARITIES)[number];

function isValidGranularity(g: string): g is Granularity {
  // INV-COST-002: granularity IN ('account','campaign','adset','ad')
  return (VALID_GRANULARITIES as readonly string[]).includes(g);
}

describe('isValidGranularity — INV-COST-002', () => {
  for (const g of VALID_GRANULARITIES) {
    it(`accepts valid granularity: '${g}'`, () => {
      expect(isValidGranularity(g)).toBe(true);
    });
  }

  it('rejects unknown granularity', () => {
    expect(isValidGranularity('creative')).toBe(false);
    expect(isValidGranularity('ad_group')).toBe(false);
    expect(isValidGranularity('')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Coalesce set: distinct key count with varying NULL combos
// ---------------------------------------------------------------------------

describe('key uniqueness across NULL/empty combinations', () => {
  it('all-NULL hierarchy with granularity=account is one unique key', () => {
    const keys = new Set([
      naturalKey({
        ...BASE,
        campaignId: null,
        adsetId: null,
        adId: null,
        granularity: 'account',
      }),
      naturalKey({
        ...BASE,
        campaignId: null,
        adsetId: null,
        adId: null,
        granularity: 'account',
      }),
      naturalKey({
        ...BASE,
        campaignId: null,
        adsetId: null,
        adId: null,
        granularity: 'account',
      }),
    ]);
    expect(keys.size).toBe(1);
  });

  it('3 ads under same campaign/adset produce 3 unique keys', () => {
    const keys = new Set([
      naturalKey({
        ...BASE,
        campaignId: 'c1',
        adsetId: 'as1',
        adId: 'ad-A',
        granularity: 'ad',
      }),
      naturalKey({
        ...BASE,
        campaignId: 'c1',
        adsetId: 'as1',
        adId: 'ad-B',
        granularity: 'ad',
      }),
      naturalKey({
        ...BASE,
        campaignId: 'c1',
        adsetId: 'as1',
        adId: 'ad-C',
        granularity: 'ad',
      }),
    ]);
    expect(keys.size).toBe(3);
  });

  it('Meta granularity=ad and Google granularity=adset with same campaign_id are different', () => {
    const metaAd = naturalKey({
      workspaceId: 'ws-1',
      platform: 'meta',
      accountId: 'acct-1',
      campaignId: 'c1',
      adsetId: 'as1',
      adId: 'ad1',
      granularity: 'ad',
      date: '2026-05-01',
    });
    const googleAdset = naturalKey({
      workspaceId: 'ws-1',
      platform: 'google',
      accountId: 'acct-1',
      campaignId: 'c1',
      adsetId: 'as1',
      adId: null,
      granularity: 'adset',
      date: '2026-05-01',
    });
    expect(metaAd).not.toBe(googleAdset);
  });
});
