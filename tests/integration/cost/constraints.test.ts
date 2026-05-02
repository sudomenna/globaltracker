/**
 * Integration tests — ad_spend_daily schema constraints
 *
 * Validates:
 *   INV-COST-001 — natural key unique via COALESCE expression index
 *                  (workspace_id, platform, account_id, COALESCE(campaign_id,''),
 *                   COALESCE(adset_id,''), COALESCE(ad_id,''), granularity, date)
 *                  timezone does NOT participate in the key.
 *   INV-COST-002 — granularity IN ('account','campaign','adset','ad')
 *   INV-COST-003 — spend_cents_normalized contract: value == round(spend_cents * fx_rate)
 *   INV-COST-005 — currency must be exactly 3 chars (ISO 4217)
 *
 * Requires: DATABASE_URL env var pointing to a Postgres 15+ instance
 * with migration 0010_ad_spend_daily_table.sql applied.
 *
 * Pattern: each test uses a transaction that is rolled back after the assertion,
 * keeping the DB clean between tests.
 */

import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// biome-ignore lint/complexity/useLiteralKeys: noUncheckedIndexedAccess requires string access here
const DATABASE_URL = process.env['DATABASE_URL'];

const describeIfDb = DATABASE_URL ? describe : describe.skip;

// ---------------------------------------------------------------------------
// Helper: insert a workspace and return its id
// ---------------------------------------------------------------------------
async function insertWorkspace(
  tx: postgres.TransactionSql,
  overrides?: { id?: string; slug?: string },
) {
  const id = overrides?.id ?? crypto.randomUUID();
  const slug =
    overrides?.slug ??
    `cost-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  await tx`SET LOCAL app.current_workspace_id = ${id}`;
  await tx`
    INSERT INTO workspaces (id, slug, name, status)
    VALUES (${id}::uuid, ${slug}, 'Cost Test WS', 'active')
  `;
  return id;
}

// ---------------------------------------------------------------------------
// Helper: minimal valid ad_spend_daily row (account-level, no campaign/adset/ad)
// ---------------------------------------------------------------------------
function baseRow(workspaceId: string) {
  return {
    workspace_id: workspaceId,
    platform: 'meta',
    account_id: 'act_123',
    campaign_id: null as string | null,
    adset_id: null as string | null,
    ad_id: null as string | null,
    granularity: 'account',
    date: '2026-01-15',
    timezone: 'America/Sao_Paulo',
    currency: 'BRL',
    spend_cents: 10000,
    impressions: 500,
    clicks: 20,
  };
}

describeIfDb('ad_spend_daily constraints', () => {
  let sql: ReturnType<typeof postgres>;

  beforeAll(() => {
    if (!DATABASE_URL) throw new Error('DATABASE_URL not set');
    sql = postgres(DATABASE_URL, { prepare: false });
  });

  afterAll(async () => {
    await sql.end();
  });

  // ---------------------------------------------------------------------------
  // INV-COST-001: Duplicate natural key (explicit NULLs) must fail
  // Two rows with the same (workspace_id, platform, account_id, NULL, NULL, NULL,
  // granularity, date) are considered duplicates via COALESCE expression index.
  // ---------------------------------------------------------------------------
  it('INV-COST-001: duplicate natural key (all NULLs for campaign/adset/ad) fails unique violation', async () => {
    await sql
      .begin(async (tx) => {
        const wsId = await insertWorkspace(tx);
        const row = baseRow(wsId);

        await tx`
          INSERT INTO ad_spend_daily
            (workspace_id, platform, account_id, campaign_id, adset_id, ad_id,
             granularity, date, timezone, currency, spend_cents)
          VALUES
            (${row.workspace_id}::uuid, ${row.platform}, ${row.account_id},
             ${row.campaign_id}, ${row.adset_id}, ${row.ad_id},
             ${row.granularity}, ${row.date}::date, ${row.timezone},
             ${row.currency}, ${row.spend_cents})
        `;

        // Second insert with identical natural key — must fail
        // INV-COST-001: uq_ad_spend_daily_natural_key rejects duplicate
        await expect(
          tx`
            INSERT INTO ad_spend_daily
              (workspace_id, platform, account_id, campaign_id, adset_id, ad_id,
               granularity, date, timezone, currency, spend_cents)
            VALUES
              (${row.workspace_id}::uuid, ${row.platform}, ${row.account_id},
               ${row.campaign_id}, ${row.adset_id}, ${row.ad_id},
               ${row.granularity}, ${row.date}::date, ${row.timezone},
               ${row.currency}, ${row.spend_cents + 500})
          `,
        ).rejects.toThrow(/uq_ad_spend_daily_natural_key/i);

        throw new Error('rollback');
      })
      .catch((e) => {
        if ((e as Error).message !== 'rollback') throw e;
      });
  });

  it('INV-COST-001: duplicate natural key with explicit empty-string-equivalent NULLs still fails', async () => {
    // The COALESCE index maps NULL → '' so two rows where one has NULL and the
    // other was inserted with the same semantics must collide.
    await sql
      .begin(async (tx) => {
        const wsId = await insertWorkspace(tx);
        const row = baseRow(wsId);

        await tx`
          INSERT INTO ad_spend_daily
            (workspace_id, platform, account_id, campaign_id, adset_id, ad_id,
             granularity, date, timezone, currency, spend_cents)
          VALUES
            (${row.workspace_id}::uuid, ${row.platform}, ${row.account_id},
             NULL, NULL, NULL,
             ${row.granularity}, ${row.date}::date, ${row.timezone},
             ${row.currency}, ${row.spend_cents})
        `;

        // Same row again — must collide via COALESCE expression
        // INV-COST-001: COALESCE(campaign_id,'') = COALESCE(NULL,'') = ''
        await expect(
          tx`
            INSERT INTO ad_spend_daily
              (workspace_id, platform, account_id, campaign_id, adset_id, ad_id,
               granularity, date, timezone, currency, spend_cents)
            VALUES
              (${row.workspace_id}::uuid, ${row.platform}, ${row.account_id},
               NULL, NULL, NULL,
               ${row.granularity}, ${row.date}::date, ${row.timezone},
               ${row.currency}, 9999)
          `,
        ).rejects.toThrow(/uq_ad_spend_daily_natural_key/i);

        throw new Error('rollback');
      })
      .catch((e) => {
        if ((e as Error).message !== 'rollback') throw e;
      });
  });

  it('INV-COST-001: different campaign_id values produce distinct rows (no unique violation)', async () => {
    await sql
      .begin(async (tx) => {
        const wsId = await insertWorkspace(tx);
        const row = baseRow(wsId);

        // Campaign-level rows require granularity='campaign'
        await tx`
          INSERT INTO ad_spend_daily
            (workspace_id, platform, account_id, campaign_id, adset_id, ad_id,
             granularity, date, timezone, currency, spend_cents)
          VALUES
            (${row.workspace_id}::uuid, ${row.platform}, ${row.account_id},
             'camp_001', NULL, NULL,
             'campaign', ${row.date}::date, ${row.timezone},
             ${row.currency}, ${row.spend_cents})
        `;

        // Different campaign_id — must succeed
        await expect(
          tx`
            INSERT INTO ad_spend_daily
              (workspace_id, platform, account_id, campaign_id, adset_id, ad_id,
               granularity, date, timezone, currency, spend_cents)
            VALUES
              (${row.workspace_id}::uuid, ${row.platform}, ${row.account_id},
               'camp_002', NULL, NULL,
               'campaign', ${row.date}::date, ${row.timezone},
               ${row.currency}, ${row.spend_cents})
          `,
        ).resolves.toBeDefined();

        throw new Error('rollback');
      })
      .catch((e) => {
        if ((e as Error).message !== 'rollback') throw e;
      });
  });

  it('INV-COST-001: same natural key but different timezone does NOT prevent unique violation', async () => {
    // timezone is informativo and excluded from the unique key.
    // Two rows with identical (workspace_id, platform, account_id, campaign_id=NULL,
    // adset_id=NULL, ad_id=NULL, granularity, date) but DIFFERENT timezone must still collide.
    await sql
      .begin(async (tx) => {
        const wsId = await insertWorkspace(tx);
        const row = baseRow(wsId);

        await tx`
          INSERT INTO ad_spend_daily
            (workspace_id, platform, account_id, campaign_id, adset_id, ad_id,
             granularity, date, timezone, currency, spend_cents)
          VALUES
            (${row.workspace_id}::uuid, ${row.platform}, ${row.account_id},
             NULL, NULL, NULL,
             ${row.granularity}, ${row.date}::date, 'America/Sao_Paulo',
             ${row.currency}, ${row.spend_cents})
        `;

        // Different timezone — but natural key is identical. Must still collide.
        // INV-COST-001: timezone is NOT in the unique key
        await expect(
          tx`
            INSERT INTO ad_spend_daily
              (workspace_id, platform, account_id, campaign_id, adset_id, ad_id,
               granularity, date, timezone, currency, spend_cents)
            VALUES
              (${row.workspace_id}::uuid, ${row.platform}, ${row.account_id},
               NULL, NULL, NULL,
               ${row.granularity}, ${row.date}::date, 'UTC',
               ${row.currency}, ${row.spend_cents})
          `,
        ).rejects.toThrow(/uq_ad_spend_daily_natural_key/i);

        throw new Error('rollback');
      })
      .catch((e) => {
        if ((e as Error).message !== 'rollback') throw e;
      });
  });

  // ---------------------------------------------------------------------------
  // INV-COST-002: granularity must be in the Granularity enum
  // ---------------------------------------------------------------------------
  it('INV-COST-002: insert with granularity="invalid" fails check constraint', async () => {
    await sql
      .begin(async (tx) => {
        const wsId = await insertWorkspace(tx);
        const row = baseRow(wsId);

        // INV-COST-002: chk_ad_spend_daily_granularity must reject 'invalid'
        await expect(
          tx`
            INSERT INTO ad_spend_daily
              (workspace_id, platform, account_id, campaign_id, adset_id, ad_id,
               granularity, date, timezone, currency, spend_cents)
            VALUES
              (${row.workspace_id}::uuid, ${row.platform}, ${row.account_id},
               NULL, NULL, NULL,
               'invalid', ${row.date}::date, ${row.timezone},
               ${row.currency}, ${row.spend_cents})
          `,
        ).rejects.toThrow(/chk_ad_spend_daily_granularity/i);

        throw new Error('rollback');
      })
      .catch((e) => {
        if ((e as Error).message !== 'rollback') throw e;
      });
  });

  it('INV-COST-002: all valid granularity values are accepted', async () => {
    const validGranularities = ['account', 'campaign', 'adset', 'ad'];

    for (const granularity of validGranularities) {
      await sql
        .begin(async (tx) => {
          const wsId = await insertWorkspace(tx);
          const row = baseRow(wsId);

          await expect(
            tx`
              INSERT INTO ad_spend_daily
                (workspace_id, platform, account_id, campaign_id, adset_id, ad_id,
                 granularity, date, timezone, currency, spend_cents)
              VALUES
                (${row.workspace_id}::uuid, ${row.platform}, ${row.account_id},
                 NULL, NULL, NULL,
                 ${granularity}, ${row.date}::date, ${row.timezone},
                 ${row.currency}, ${row.spend_cents})
            `,
          ).resolves.toBeDefined();

          throw new Error('rollback');
        })
        .catch((e) => {
          if ((e as Error).message !== 'rollback') throw e;
        });
    }
  });

  // ---------------------------------------------------------------------------
  // INV-COST-003: spend_cents_normalized contract
  // Validate that storing spend_cents_normalized = round(spend_cents * fx_rate)
  // results in the expected integer value (contract test — no cron involved).
  // ---------------------------------------------------------------------------
  it('INV-COST-003: spend_cents_normalized is stored correctly as round(spend_cents * fx_rate)', async () => {
    await sql
      .begin(async (tx) => {
        const wsId = await insertWorkspace(tx);
        const row = baseRow(wsId);
        const spendCents = 10000;
        const fxRate = '5.2'; // numeric string for Postgres
        // Expected: round(10000 * 5.2) = round(52000) = 52000
        const expectedNormalized = Math.round(spendCents * 5.2);

        const [inserted] = await tx<[{ spend_cents_normalized: number }]>`
          INSERT INTO ad_spend_daily
            (workspace_id, platform, account_id, campaign_id, adset_id, ad_id,
             granularity, date, timezone, currency, spend_cents,
             spend_cents_normalized, fx_rate, fx_source, fx_currency)
          VALUES
            (${row.workspace_id}::uuid, ${row.platform}, ${row.account_id},
             NULL, NULL, NULL,
             ${row.granularity}, ${row.date}::date, ${row.timezone},
             ${row.currency}, ${spendCents},
             ${Math.round(spendCents * 5.2)}, ${fxRate}::numeric, 'manual', 'BRL')
          RETURNING spend_cents_normalized
        `;

        // INV-COST-003: normalized value must equal round(spend_cents * fx_rate)
        expect(inserted?.spend_cents_normalized).toBe(expectedNormalized);

        throw new Error('rollback');
      })
      .catch((e) => {
        if ((e as Error).message !== 'rollback') throw e;
      });
  });

  // ---------------------------------------------------------------------------
  // INV-COST-005: currency must be exactly 3 chars (ISO 4217)
  // ---------------------------------------------------------------------------
  it('INV-COST-005: insert with currency="ABCD" (4 chars) fails check constraint', async () => {
    await sql
      .begin(async (tx) => {
        const wsId = await insertWorkspace(tx);
        const row = baseRow(wsId);

        // INV-COST-005: chk_ad_spend_daily_currency_length must reject 'ABCD'
        await expect(
          tx`
            INSERT INTO ad_spend_daily
              (workspace_id, platform, account_id, campaign_id, adset_id, ad_id,
               granularity, date, timezone, currency, spend_cents)
            VALUES
              (${row.workspace_id}::uuid, ${row.platform}, ${row.account_id},
               NULL, NULL, NULL,
               ${row.granularity}, ${row.date}::date, ${row.timezone},
               'ABCD', ${row.spend_cents})
          `,
        ).rejects.toThrow(/chk_ad_spend_daily_currency_length/i);

        throw new Error('rollback');
      })
      .catch((e) => {
        if ((e as Error).message !== 'rollback') throw e;
      });
  });

  it('INV-COST-005: insert with currency="BR" (2 chars) fails check constraint', async () => {
    await sql
      .begin(async (tx) => {
        const wsId = await insertWorkspace(tx);
        const row = baseRow(wsId);

        // INV-COST-005: currency must be exactly 3 chars
        await expect(
          tx`
            INSERT INTO ad_spend_daily
              (workspace_id, platform, account_id, campaign_id, adset_id, ad_id,
               granularity, date, timezone, currency, spend_cents)
            VALUES
              (${row.workspace_id}::uuid, ${row.platform}, ${row.account_id},
               NULL, NULL, NULL,
               ${row.granularity}, ${row.date}::date, ${row.timezone},
               'BR', ${row.spend_cents})
          `,
        ).rejects.toThrow(/chk_ad_spend_daily_currency_length/i);

        throw new Error('rollback');
      })
      .catch((e) => {
        if ((e as Error).message !== 'rollback') throw e;
      });
  });

  it('INV-COST-005: valid 3-char currencies are accepted', async () => {
    const validCurrencies = ['BRL', 'USD', 'EUR', 'GBP'];

    for (const currency of validCurrencies) {
      await sql
        .begin(async (tx) => {
          const wsId = await insertWorkspace(tx);
          const row = baseRow(wsId);

          await expect(
            tx`
              INSERT INTO ad_spend_daily
                (workspace_id, platform, account_id, campaign_id, adset_id, ad_id,
                 granularity, date, timezone, currency, spend_cents)
              VALUES
                (${row.workspace_id}::uuid, ${row.platform}, ${row.account_id},
                 NULL, NULL, NULL,
                 ${row.granularity}, ${row.date}::date, ${row.timezone},
                 ${currency}, ${row.spend_cents})
            `,
          ).resolves.toBeDefined();

          throw new Error('rollback');
        })
        .catch((e) => {
          if ((e as Error).message !== 'rollback') throw e;
        });
    }
  });

  // ---------------------------------------------------------------------------
  // BR-COST-001: spend_cents must be >= 0
  // ---------------------------------------------------------------------------
  it('BR-COST-001: negative spend_cents fails check constraint', async () => {
    await sql
      .begin(async (tx) => {
        const wsId = await insertWorkspace(tx);
        const row = baseRow(wsId);

        // BR-COST-001: chk_ad_spend_daily_spend_cents_non_negative
        await expect(
          tx`
            INSERT INTO ad_spend_daily
              (workspace_id, platform, account_id, campaign_id, adset_id, ad_id,
               granularity, date, timezone, currency, spend_cents)
            VALUES
              (${row.workspace_id}::uuid, ${row.platform}, ${row.account_id},
               NULL, NULL, NULL,
               ${row.granularity}, ${row.date}::date, ${row.timezone},
               ${row.currency}, -1)
          `,
        ).rejects.toThrow(/chk_ad_spend_daily_spend_cents_non_negative/i);

        throw new Error('rollback');
      })
      .catch((e) => {
        if ((e as Error).message !== 'rollback') throw e;
      });
  });

  // ---------------------------------------------------------------------------
  // fx_source: must be in FxSource enum when present
  // ---------------------------------------------------------------------------
  it('fx_source invalid value fails check constraint', async () => {
    await sql
      .begin(async (tx) => {
        const wsId = await insertWorkspace(tx);
        const row = baseRow(wsId);

        await expect(
          tx`
            INSERT INTO ad_spend_daily
              (workspace_id, platform, account_id, campaign_id, adset_id, ad_id,
               granularity, date, timezone, currency, spend_cents, fx_source)
            VALUES
              (${row.workspace_id}::uuid, ${row.platform}, ${row.account_id},
               NULL, NULL, NULL,
               ${row.granularity}, ${row.date}::date, ${row.timezone},
               ${row.currency}, ${row.spend_cents}, 'open_exchange')
          `,
        ).rejects.toThrow(/chk_ad_spend_daily_fx_source/i);

        throw new Error('rollback');
      })
      .catch((e) => {
        if ((e as Error).message !== 'rollback') throw e;
      });
  });
});
