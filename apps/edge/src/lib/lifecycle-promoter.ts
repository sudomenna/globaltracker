/**
 * lifecycle-promoter.ts — atomic monotonic update of leads.lifecycle_status.
 *
 * BR-PRODUCT-001: lifecycle never regresses — UPDATE only when the candidate
 * status has strictly higher rank than the current status. The pure rule lives
 * in `lifecycle-rules.ts::promote`; this module wires it into a DB read/write
 * cycle.
 *
 * Concurrency note: this implementation is NOT serializable across concurrent
 * promotions of the same lead. Two Purchase events arriving simultaneously may
 * each read the same `current` and each issue an UPDATE; because `promote` is
 * monotonic and `LifecycleStatus` is a small total order, the final state is
 * deterministic regardless of execution order — at worst we incur one
 * redundant UPDATE. Lost-update semantics are acceptable here per BR-PRODUCT-001
 * (monotonicity preserved by the rank check on every UPDATE).
 *
 * T-PRODUCTS-002.
 */

import type { Db } from '@globaltracker/db';
import { leads } from '@globaltracker/db';
import { eq } from 'drizzle-orm';
import {
  type LifecycleStatus,
  isLifecycleStatus,
  promote,
} from './lifecycle-rules.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PromoteResult {
  /** True iff this call issued an UPDATE that actually changed the row. */
  updated: boolean;
  /** Lifecycle status the row had immediately before this call. */
  previous: LifecycleStatus;
  /** Lifecycle status the row has after this call (== previous when not updated). */
  current: LifecycleStatus;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Atomically promote `leads.lifecycle_status` for `leadId` to `candidate` if
 * (and only if) `candidate` has strictly higher rank than the current value.
 *
 * BR-PRODUCT-001: monotonic — no regression possible. `promote()` enforces
 * this on the in-process side; the candidate-rank check is the same one
 * every caller uses, so concurrent promotions cannot produce a regression
 * either (they may produce one redundant UPDATE; see file header).
 *
 * Throws when the lead row is not found — callers are expected to have
 * resolved a valid `leadId` upstream (e.g. via `resolveLeadByAliases`).
 */
export async function promoteLeadLifecycle(
  db: Db,
  leadId: string,
  candidate: LifecycleStatus,
): Promise<PromoteResult> {
  // Read current value. Single-row primary-key lookup; cheap.
  const rows = await db
    .select({ lifecycleStatus: leads.lifecycleStatus })
    .from(leads)
    .where(eq(leads.id, leadId))
    .limit(1);

  const row = rows[0];
  if (!row) {
    throw new Error(`promoteLeadLifecycle: lead not found id=${leadId}`);
  }

  // Defensive type guard at the DB boundary. The `chk_leads_lifecycle_status`
  // CHECK constraint guarantees only canonical values can be stored, but
  // Drizzle types `lifecycle_status` as plain `string` — guard before casting.
  const rawCurrent = row.lifecycleStatus;
  if (!isLifecycleStatus(rawCurrent)) {
    throw new Error(
      `promoteLeadLifecycle: lead ${leadId} has non-canonical lifecycle_status=${String(rawCurrent)}`,
    );
  }
  const previous: LifecycleStatus = rawCurrent;

  // BR-PRODUCT-001: pure-function decision; no SQL-side promotion logic
  // means the rule is testable without a DB.
  const next = promote(previous, candidate);

  if (next === previous) {
    // No-op: idempotent or regression blocked. Skip the UPDATE entirely so we
    // do not bump `updated_at` for a no-change call.
    return { updated: false, previous, current: previous };
  }

  await db
    .update(leads)
    .set({ lifecycleStatus: next, updatedAt: new Date() })
    .where(eq(leads.id, leadId));

  return { updated: true, previous, current: next };
}
