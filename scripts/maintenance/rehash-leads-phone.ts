/**
 * scripts/maintenance/rehash-leads-phone.ts
 *
 * MAINTENANCE-ONLY — runs out-of-band, NOT part of any deploy.
 *
 * Re-hashes `leads.phone_hash` and `lead_alias.identifier_hash` (where
 * `identifier_type='phone_hash'`) using the upgraded BR-aware `normalizePhone`
 * (T-13-014). Useful only if leads were created BEFORE T-13-014 was deployed
 * and their phone_enc plaintext, when re-normalized, produces a different hash
 * than what's stored — meaning subsequent webhook lookups (e.g., SendFlow)
 * would fail to find them.
 *
 * Usage:
 *   tsx scripts/maintenance/rehash-leads-phone.ts --dry-run    # default
 *   tsx scripts/maintenance/rehash-leads-phone.ts --apply      # writes
 *
 * Required environment:
 *   DATABASE_URL                  — Postgres connection string
 *   PII_MASTER_KEY_V1             — hex 32-byte AES-GCM master key (matches
 *                                   the key stored in Cloudflare Worker secrets
 *                                   at the time the leads were encrypted)
 *
 * Why this is a stub: production decryption uses Cloudflare Worker `crypto.subtle`
 * inside the Edge runtime. To run from Node, we'd need to either reimport the
 * pii.ts decryption (requires pulling Worker bindings) or replicate the AES-GCM
 * decrypt logic with Node's `crypto.subtle` (compatible API since Node 16).
 *
 * Filling in the TODO below is straightforward — about 30 lines of code — but
 * intentionally deferred: the script only matters if dry-run reports candidates,
 * and we don't yet know if any exist in production. Run the dry-run query first
 * to find out.
 *
 * Reference: `apps/edge/src/lib/pii.ts:221` (`decryptPii`).
 */

import { Client } from 'pg';
import { normalizePhone } from '../../apps/edge/src/lib/lead-resolver';

const DATABASE_URL = process.env.DATABASE_URL;
const APPLY = process.argv.includes('--apply');

if (!DATABASE_URL) {
  console.error('ERROR: DATABASE_URL is required.');
  process.exit(1);
}

async function main(): Promise<void> {
  const client = new Client({ connectionString: DATABASE_URL });
  await client.connect();

  // Step 1: count candidates (leads with phone_enc) by workspace.
  const candidateCount = await client.query<{ workspace_id: string; n: string }>(
    `SELECT workspace_id, COUNT(*)::text AS n
       FROM leads
      WHERE phone_enc IS NOT NULL AND status != 'erased'
      GROUP BY workspace_id`,
  );

  console.log('=== Candidates by workspace ===');
  for (const row of candidateCount.rows) {
    console.log(`  ${row.workspace_id}: ${row.n} leads with encrypted phone`);
  }
  const total = candidateCount.rows.reduce((acc, r) => acc + Number(r.n), 0);
  console.log(`Total: ${total} leads to inspect.\n`);

  if (total === 0) {
    console.log('Nothing to do. Exiting.');
    await client.end();
    return;
  }

  // Step 2: TODO — for each candidate:
  //   a) decrypt phone_enc using same AES-GCM logic as apps/edge/src/lib/pii.ts:221
  //      (Node 16+ has compatible `webcrypto.subtle.decrypt`).
  //   b) re-normalize via the new normalizePhone (already imported above).
  //   c) re-hash via SHA-256 of `${workspaceId}:${normalized}`.
  //   d) compare to leads.phone_hash; if different, plan UPDATE on leads + lead_alias.
  //   e) in --apply mode: run UPDATEs inside a transaction per workspace; otherwise
  //      log the diff (workspace_id, lead_id, old_hash, new_hash).
  //
  // Sketch of the SHA-256 hash for verification (without decrypting):
  //   const hash = require('node:crypto')
  //     .createHash('sha256')
  //     .update(`${workspaceId}:${normalizedPhone}`)
  //     .digest('hex');

  console.log('Decrypt + rehash loop is not implemented yet (intentional stub).');
  console.log('Dry-run mode:', !APPLY);
  console.log('See TODO in source; reference: apps/edge/src/lib/pii.ts:221.');
  // Keep exit code 0 — the count above is already useful operational output.

  // Use the imported normalizePhone to silence "unused import" — it's the
  // actual transformation that the unimplemented loop above will apply.
  void normalizePhone;

  await client.end();
}

main().catch((err) => {
  console.error('Maintenance script failed:', err);
  process.exit(1);
});
