/**
 * Unit tests for cost ingestor idempotency.
 *
 * INV-COST-006: running ingestDailySpend twice for the same date must yield
 *   the same DB state. The second run must not increase the `ingested` count
 *   on rows that already exist (upsert replaces values rather than adding).
 *
 * Strategy: mock db.insert(...).values(...).onConflictDoUpdate(...) to track
 *   calls and assert idempotent behaviour.
 */

import type { Db } from '@globaltracker/db';
import { describe, expect, it, vi } from 'vitest';
import { ingestDailySpend } from '../../../apps/edge/src/crons/cost-ingestor';

// ---------------------------------------------------------------------------
// Helpers — minimal mock factories
// ---------------------------------------------------------------------------

/**
 * Build a mock Db whose insert chain always resolves successfully.
 * Returns a spy so tests can assert how many times upsert was called.
 */
function makeMockDb() {
  const upsertSpy = vi.fn().mockResolvedValue([]);

  const onConflictDoUpdate = vi.fn().mockImplementation(() => upsertSpy());

  const values = vi.fn().mockReturnValue({ onConflictDoUpdate });

  const insert = vi.fn().mockReturnValue({ values });

  return { db: { insert } as unknown as Db, upsertSpy, values, insert };
}

/**
 * Build a minimal CostIngestorEnv for tests.
 * GT_KV is stubbed so getRateForPair never hits real network.
 */
function makeMockEnv() {
  // KV mock: always returns null (cache miss) — resolveFx will throw
  // FxRatesUnavailableError which is caught; rows get NULL normalized fields.
  const kvGet = vi.fn().mockResolvedValue(null);
  const kvPut = vi.fn().mockResolvedValue(undefined);
  const GT_KV = { get: kvGet, put: kvPut } as unknown as KVNamespace;

  return {
    GT_KV,
    META_ADS_ACCOUNT_ID: 'acct-123',
    META_ADS_ACCESS_TOKEN: 'meta-token',
    GOOGLE_ADS_CUSTOMER_ID: 'cust-456',
    GOOGLE_ADS_DEVELOPER_TOKEN: 'dev-token',
    GOOGLE_ADS_CLIENT_ID: 'client-id',
    GOOGLE_ADS_CLIENT_SECRET: 'client-secret',
    GOOGLE_ADS_REFRESH_TOKEN: 'refresh-token',
    GOOGLE_ADS_CURRENCY: 'USD',
    FX_RATES_PROVIDER: 'ecb',
  };
}

/**
 * Build a fetch mock that:
 *  - Returns a single Meta Insights row for the insights endpoint.
 *  - Returns a single Google Ads row for the searchStream endpoint.
 *  - Returns an access_token for the OAuth token endpoint.
 *  - Fails on ECB (to simulate FX unavailable → NULL normalized).
 */
function makeFetchMock() {
  return vi.fn().mockImplementation(async (url: string, opts?: RequestInit) => {
    const urlStr = String(url);

    // OAuth token exchange
    if (urlStr.includes('oauth2.googleapis.com/token')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          access_token: 'access-token',
          token_type: 'Bearer',
          expires_in: 3600,
        }),
      } as Response;
    }

    // Meta Insights
    if (urlStr.includes('graph.facebook.com')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: [
            {
              spend: '10.00',
              impressions: '1000',
              clicks: '50',
              campaign_id: 'camp-1',
              adset_id: 'adset-1',
              ad_id: 'ad-1',
              date_start: '2026-05-01',
              account_currency: 'USD',
            },
          ],
          paging: {},
        }),
      } as Response;
    }

    // Google Ads searchStream
    if (urlStr.includes('googleads.googleapis.com')) {
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify([
            {
              results: [
                {
                  campaign: { id: '11' },
                  adGroup: { id: '22' },
                  metrics: {
                    costMicros: 5000000,
                    impressions: 200,
                    clicks: 10,
                  },
                  segments: { date: '2026-05-01' },
                },
              ],
            },
          ]),
      } as Response;
    }

    // ECB — simulate unavailable to force NULL normalized fields
    if (urlStr.includes('ecb.europa.eu')) {
      return {
        ok: false,
        status: 503,
        statusText: 'Service Unavailable',
        text: async () => '',
      } as Response;
    }

    throw new Error(`Unexpected fetch URL in test: ${urlStr}`);
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** No-op sleep — eliminates FX retry backoff delays in tests. */
const noopSleep = async (_ms: number): Promise<void> => {};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ingestDailySpend — INV-COST-006 idempotency', () => {
  it('first call ingests 2 rows (1 Meta + 1 Google)', async () => {
    const { db } = makeMockDb();
    const env = makeMockEnv();
    const fetchMock = makeFetchMock();

    const result = await ingestDailySpend(
      '2026-05-01',
      env,
      db,
      fetchMock as unknown as typeof fetch,
      noopSleep,
    );

    expect(result.ingested).toBe(2);
  });

  it('second call for same date also returns ingested=2 (upsert replaces, same count)', async () => {
    const { db } = makeMockDb();
    const env = makeMockEnv();
    const fetchMock = makeFetchMock();

    const first = await ingestDailySpend(
      '2026-05-01',
      env,
      db,
      fetchMock as unknown as typeof fetch,
      noopSleep,
    );
    const second = await ingestDailySpend(
      '2026-05-01',
      env,
      db,
      fetchMock as unknown as typeof fetch,
      noopSleep,
    );

    // INV-COST-006: both runs process the same source rows → same ingested count
    expect(first.ingested).toBe(second.ingested);
  });

  it('second call issues the same number of DB upserts as the first', async () => {
    const { db, insert } = makeMockDb();
    const env = makeMockEnv();
    const fetchMock = makeFetchMock();

    await ingestDailySpend(
      '2026-05-01',
      env,
      db,
      fetchMock as unknown as typeof fetch,
      noopSleep,
    );
    const callsAfterFirst = insert.mock.calls.length;

    await ingestDailySpend(
      '2026-05-01',
      env,
      db,
      fetchMock as unknown as typeof fetch,
      noopSleep,
    );
    const callsAfterSecond = insert.mock.calls.length;

    // INV-COST-006: same number of upserts in each run
    expect(callsAfterSecond - callsAfterFirst).toBe(callsAfterFirst);
  });

  it('never throws even when both platforms fail', async () => {
    const { db } = makeMockDb();
    const env = makeMockEnv();

    // Fetch mock that always fails
    const failFetch = vi.fn().mockRejectedValue(new Error('Network failure'));

    const result = await ingestDailySpend(
      '2026-05-01',
      env,
      db,
      failFetch as unknown as typeof fetch,
      noopSleep,
    );

    // INV-COST-006: never throws — errors collected
    expect(result.ingested).toBe(0);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('errors array is empty on fully successful run', async () => {
    const { db } = makeMockDb();
    const env = makeMockEnv();

    // Use fetch mock with ECB that succeeds so FX resolves
    const successFetch = vi.fn().mockImplementation(async (url: string) => {
      const urlStr = String(url);

      if (urlStr.includes('oauth2.googleapis.com/token')) {
        return {
          ok: true,
          json: async () => ({
            access_token: 'at',
            token_type: 'Bearer',
            expires_in: 3600,
          }),
        } as Response;
      }
      if (urlStr.includes('graph.facebook.com')) {
        return {
          ok: true,
          json: async () => ({ data: [], paging: {} }),
        } as Response;
      }
      if (urlStr.includes('googleads.googleapis.com')) {
        return {
          ok: true,
          text: async () => JSON.stringify([{ results: [] }]),
        } as Response;
      }
      throw new Error(`Unexpected: ${urlStr}`);
    });

    const result = await ingestDailySpend(
      '2026-05-01',
      env,
      db,
      successFetch as unknown as typeof fetch,
      noopSleep,
    );

    expect(result.errors).toHaveLength(0);
    expect(result.ingested).toBe(0); // no rows returned by mock
  });
});
