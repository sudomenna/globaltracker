/**
 * routes/admin/cost-backfill.ts — POST /v1/admin/cost-backfill?date=YYYY-MM-DD
 *
 * Triggers cost ingestion for a specific date. Used for historical backfill
 * when the daily cron ran with the wrong workspace_id.
 *
 * Auth: Bearer token — same non-empty check as other admin routes.
 * INV-COST-006: ingestDailySpend is idempotent — safe to re-run.
 */

import { createDb, type Db } from '@globaltracker/db';
import { Hono } from 'hono';
import { ingestDailySpend } from '../../crons/cost-ingestor.js';
import { safeLog } from '../../middleware/sanitize-logs.js';

type AppBindings = {
  HYPERDRIVE: Hyperdrive;
  DATABASE_URL?: string;
  DEV_WORKSPACE_ID?: string;
  META_ADS_ACCOUNT_ID: string;
  META_ADS_ACCESS_TOKEN: string;
  GOOGLE_ADS_CUSTOMER_ID: string;
  GOOGLE_ADS_DEVELOPER_TOKEN: string;
  GOOGLE_ADS_CLIENT_ID: string;
  GOOGLE_ADS_CLIENT_SECRET: string;
  GOOGLE_ADS_REFRESH_TOKEN: string;
  GOOGLE_ADS_CURRENCY: string;
  FX_RATES_PROVIDER?: string;
  FX_RATES_API_KEY?: string;
  GT_KV: KVNamespace;
};

type AppEnv = { Bindings: AppBindings };

export function createCostBackfillRoute(opts?: {
  buildDb?: (env: AppBindings) => Db;
}): Hono<AppEnv> {
  const route = new Hono<AppEnv>();

  route.post('/', async (c) => {
    const requestId = crypto.randomUUID();

    const authHeader = c.req.header('Authorization');
    if (!authHeader?.startsWith('Bearer ')) {
      return c.json({ code: 'unauthorized', request_id: requestId }, 401);
    }

    const date = c.req.query('date');
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return c.json(
        { code: 'validation_error', message: 'date query param required (YYYY-MM-DD)', request_id: requestId },
        400,
      );
    }

    const db = opts?.buildDb
      ? opts.buildDb(c.env)
      : createDb(c.env.DATABASE_URL ?? c.env.HYPERDRIVE?.connectionString ?? '');

    safeLog('info', { event: 'cost_backfill_start', date, request_id: requestId });

    const result = await ingestDailySpend(date, c.env, db);

    safeLog('info', {
      event: 'cost_backfill_done',
      date,
      ingested: result.ingested,
      errors: result.errors.length,
      request_id: requestId,
    });

    return c.json(
      { date, ingested: result.ingested, errors: result.errors, request_id: requestId },
      200,
    );
  });

  return route;
}
