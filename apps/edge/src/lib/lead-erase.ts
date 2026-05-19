/**
 * lead-erase.ts — anonymize a lead (SAR / right-to-be-forgotten).
 *
 * Consumed by the QUEUE_DISPATCH worker on `lead_erase` messages enqueued by:
 *   - DELETE /v1/admin/leads/:lead_id (admin SAR endpoint)
 *   - POST   /v1/leads/bulk-delete   (CP bulk delete action)
 *
 * INV-IDENTITY-002: an erased lead must have email_enc, phone_enc, name_enc,
 *   email_hash, phone_hash, name_hash, email_hash_external, phone_hash_external,
 *   fn_hash, ln_hash all IS NULL — plus name (plaintext per ADR-034).
 * BR-PRIVACY-003: erasure is idempotent. Re-running on an already-erased lead
 *   is a no-op success — caller can replay safely.
 * BR-AUDIT-001: every erasure emits one audit_log row (`erase_sar_completed`).
 * BR-PRIVACY-001: no PII in logs or audit metadata.
 *
 * Out of scope (intentional):
 *   - events.user_data still contains hashed identifiers (em/ph) used by Meta
 *     CAPI dispatchers. Those hashes are SHA-256(salted) — not recoverable to
 *     PII for practical purposes. Removing them retroactively would break
 *     dispatcher idempotency for events already sent. Document gap.
 *   - lead_aliases rows are deleted (identifier_hash IS direct PII derivative).
 */

import {
  auditLog,
  leadAliases,
  leads,
  type Db,
} from '@globaltracker/db';
import { and, eq, sql } from 'drizzle-orm';

export type EraseLeadResult =
  | { ok: true; outcome: 'erased'; aliasesDeleted: number }
  | { ok: true; outcome: 'already_erased' }
  | { ok: true; outcome: 'not_found' }
  | { ok: false; error: { code: string; cause?: unknown } };

export interface EraseLeadOpts {
  /** Internal UUID (leads.id == lead_public_id per BR-IDENTITY-013). */
  leadId: string;
  /** Job id from the queue message; logged in audit metadata for traceability. */
  jobId: string;
  /** Originating request id for cross-system correlation. */
  requestId: string;
}

export async function eraseLead(
  db: Db,
  opts: EraseLeadOpts,
): Promise<EraseLeadResult> {
  const { leadId, jobId, requestId } = opts;

  // 1. Look up current status (drives idempotency + need-to-write decision).
  const existing = await db
    .select({
      id: leads.id,
      workspaceId: leads.workspaceId,
      status: leads.status,
    })
    .from(leads)
    .where(eq(leads.id, leadId))
    .limit(1);

  const row = existing[0];
  if (!row) return { ok: true, outcome: 'not_found' };
  if (row.status === 'erased') return { ok: true, outcome: 'already_erased' };

  try {
    // 2. NULL all PII columns and flip status. INV-IDENTITY-002.
    await db
      .update(leads)
      .set({
        name: null,
        nameEnc: null,
        nameHash: null,
        emailEnc: null,
        emailHash: null,
        emailHashExternal: null,
        phoneEnc: null,
        phoneHash: null,
        phoneHashExternal: null,
        fnHash: null,
        lnHash: null,
        externalIdHash: null,
        status: 'erased',
        updatedAt: new Date(),
      })
      .where(eq(leads.id, leadId));

    // 3. Delete the lead's aliases (identifier_hash is PII-derived).
    const aliasResult = await db
      .delete(leadAliases)
      .where(
        and(
          eq(leadAliases.leadId, leadId),
          eq(leadAliases.workspaceId, row.workspaceId),
        ),
      );
    // drizzle's pg delete returns `{ rowCount }` via the postgres driver.
    const aliasesDeleted =
      (aliasResult as unknown as { rowCount?: number }).rowCount ?? 0;

    // 4. Audit. BR-AUDIT-001. BR-PRIVACY-001: no PII in metadata.
    await db.insert(auditLog).values({
      workspaceId: row.workspaceId,
      actorId: 'system',
      actorType: 'system',
      action: 'erase_sar_completed',
      entityType: 'lead',
      entityId: leadId,
      // Snapshot intentionally omits the BEFORE PII — INV-AUDIT-003: no PII.
      before: { status: row.status },
      after: { status: 'erased' },
      requestContext: { request_id: requestId, job_id: jobId },
      ts: sql`now()`,
    });

    return { ok: true, outcome: 'erased', aliasesDeleted };
  } catch (err) {
    return {
      ok: false,
      error: {
        code: err instanceof Error ? err.constructor.name : 'unknown',
        cause: err,
      },
    };
  }
}
