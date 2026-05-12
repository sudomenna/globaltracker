/**
 * scripts/maintenance/replay-cart-abandonment.ts
 *
 * Replays failed cart_abandonment raw_events that got stuck because
 * the original handleCartAbandonment() was missing QUEUE_EVENTS.send().
 *
 * What this script does:
 *   1. Finds raw_events with processing_status='failed' whose payload has
 *      _onprofit_event_type='InitiateCheckout' (i.e. cart_abandonment events).
 *   2. (dry-run) Prints a summary.
 *   3. (apply)   Resets each row to 'pending', then enqueues to CF Queue via
 *                REST API with platform='onprofit' so the consumer routes to
 *                processOnprofitRawEvent instead of the generic processor.
 *
 * Usage:
 *   tsx scripts/maintenance/replay-cart-abandonment.ts            # dry-run
 *   tsx scripts/maintenance/replay-cart-abandonment.ts --apply    # writes
 *
 * Required env (from .env.local):
 *   DATABASE_URL              — Postgres connection string
 *   CLOUDFLARE_API_TOKEN      — CF API token with Queues:Write permission
 *
 * Hard-coded from wrangler.toml:
 *   CLOUDFLARE_ACCOUNT_ID = 118836e4d3020f5666b2b8e5ddfdb222
 *   QUEUE_NAME             = gt-events
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import postgres from 'postgres';

// Load .env.local from repo root
const envPath = resolve(process.cwd(), '.env.local');
try {
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
} catch { /* no .env.local — rely on process.env */ }

const APPLY = process.argv.includes('--apply');
const DATABASE_URL = process.env.DATABASE_URL;
const CF_TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const CF_ACCOUNT_ID = '118836e4d3020f5666b2b8e5ddfdb222';
const QUEUE_NAME = 'gt-events';

if (!DATABASE_URL) {
  console.error('Missing DATABASE_URL');
  process.exit(1);
}
if (APPLY && !CF_TOKEN) {
  console.error('Missing CLOUDFLARE_API_TOKEN (required for --apply)');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function getCFQueueId(): Promise<string> {
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/queues?name=${QUEUE_NAME}`,
    { headers: { Authorization: `Bearer ${CF_TOKEN}` } },
  );
  const body = await res.json() as { result?: { queue_id: string; queue_name: string }[]; success?: boolean };
  if (!body.success || !body.result?.length) {
    throw new Error(`CF queue not found: ${QUEUE_NAME} — ${JSON.stringify(body)}`);
  }
  return body.result[0].queue_id;
}

async function cfQueueSendBatch(
  queueId: string,
  messages: Array<{ raw_event_id: string; workspace_id: string; platform: string }>,
): Promise<void> {
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/queues/${queueId}/messages/batch`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${CF_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messages: messages.map((m) => ({
          body: m,
          content_type: 'json',
        })),
      }),
    },
  );
  const body = await res.json() as { success?: boolean; errors?: unknown[] };
  if (!body.success) {
    throw new Error(`CF queue send failed: ${JSON.stringify(body)}`);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const sql = postgres(DATABASE_URL!, { max: 3 });

  const rows = await sql<{
    id: string;
    workspace_id: string;
    received_at: Date;
    processing_error: string | null;
    payload: Record<string, unknown>;
  }[]>`
    SELECT id, workspace_id, received_at, processing_error, payload
    FROM raw_events
    WHERE processing_status IN ('failed', 'pending')
      AND (payload ->> '_onprofit_event_type') = 'InitiateCheckout'
      AND (payload ->> 'status') = 'CART_ABANDONED'
    ORDER BY received_at ASC
  `;

  console.log(`\nFound ${rows.length} failed cart_abandonment raw_events`);
  if (rows.length === 0) {
    console.log('Nothing to replay.');
    await sql.end();
    return;
  }

  // Summary table
  for (const row of rows) {
    const email = (row.payload?.customer as Record<string, unknown> | undefined)?.email ?? '?';
    const launchId = row.payload?.launch_id ?? '(unresolved)';
    console.log(
      `  ${row.id}  received=${row.received_at.toISOString()}  launch=${launchId}  email_preview=${String(email).slice(0, 4)}***  err=${row.processing_error ?? '—'}`,
    );
  }

  if (!APPLY) {
    console.log('\n[dry-run] Pass --apply to replay.\n');
    await sql.end();
    return;
  }

  // -------------------------------------------------------------------------
  // Apply: get CF queue ID, reset rows, enqueue
  // -------------------------------------------------------------------------

  console.log('\nFetching CF queue ID...');
  const queueId = await getCFQueueId();
  console.log(`Queue ID: ${queueId}`);

  // Process in batches of 50 (CF queue batch limit)
  const BATCH_SIZE = 50;
  let replayed = 0;
  let errored = 0;

  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);

    // Reset to 'pending' first (idempotent on re-run: if enqueue fails below we
    // can re-run the script and the row will be pending but not in queue — the
    // outbox poller won't help since it sends without platform, but re-running
    // this script with --apply will pick them up again)
    await sql`
      UPDATE raw_events
      SET processing_status = 'pending',
          processing_error = NULL
      WHERE id = ANY(${sql.array(batch.map((r) => r.id))}::uuid[])
    `;
    console.log(`  Reset ${batch.length} rows to pending`);

    // Enqueue to CF queue with platform='onprofit'
    try {
      await cfQueueSendBatch(
        queueId,
        batch.map((r) => ({
          raw_event_id: r.id,
          workspace_id: r.workspace_id,
          platform: 'onprofit',
        })),
      );
      replayed += batch.length;
      console.log(`  Enqueued batch [${i}..${i + batch.length - 1}] ✓`);
    } catch (err) {
      errored += batch.length;
      console.error(`  Enqueue failed for batch [${i}..${i + batch.length - 1}]:`, err);
    }
  }

  console.log(`\nDone. replayed=${replayed} errored=${errored}\n`);
  await sql.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
