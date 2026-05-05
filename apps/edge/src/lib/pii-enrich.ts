/**
 * pii-enrich.ts — Populate `leads.email_enc / phone_enc / name_enc` ciphertexts.
 *
 * T-13-015. Wires `encryptPii` from `pii.ts` into the lead-creation pipeline so
 * admin recovery, DSAR (LGPD/GDPR right to access), and operational support
 * (looking up a lead by phone/email outside the hashed lookup path) work as
 * intended by BR-PRIVACY-004.
 *
 * Why a helper instead of patching `resolveLeadByAliases` directly: the resolver
 * is shared by /v1/lead, /v1/events, and webhook processors. Threading a
 * MasterKeyRegistry through every caller's signature is invasive. This helper
 * runs as a follow-up UPDATE after the resolver returns, isolated to callers
 * that have plaintext PII in scope and a master key configured.
 *
 * Idempotent: only writes columns currently NULL — never overwrites existing
 * ciphertexts (which would invalidate `pii_key_version` for downstream
 * decryption attempts).
 *
 * Failure mode (INV-PRIVACY-006-soft): if encryption fails or the master key
 * is missing, the lead row stays without ciphertext but with hashes — the
 * core hash-based pipeline continues to work. The helper logs and returns
 * a non-blocking result.
 */

import type { Db } from '@globaltracker/db';
import { leads } from '@globaltracker/db';
import { and, eq, isNull, or } from 'drizzle-orm';
import {
  encryptPii,
  type MasterKeyRegistry,
  type PiiKeyVersion,
} from './pii.js';
import { safeLog } from '../middleware/sanitize-logs.js';

export type EnrichLeadPiiInput = {
  email?: string;
  phone?: string; // already-normalized E.164 plaintext
  name?: string;
};

export type EnrichLeadPiiOptions = {
  leadId: string;
  workspaceId: string;
  db: Db;
  masterKeyHex?: string; // PII_MASTER_KEY_V1 from env
  currentVersion?: PiiKeyVersion;
  requestId?: string; // for log correlation
};

/**
 * Encrypt provided plaintexts and UPDATE only the *_enc columns that are still
 * NULL on the row. Hashes (`*_hash`) are not touched.
 */
export async function enrichLeadPii(
  input: EnrichLeadPiiInput,
  opts: EnrichLeadPiiOptions,
): Promise<{ ok: boolean; updated_columns: string[] }> {
  const updatedColumns: string[] = [];

  if (!input.email && !input.phone && !input.name) {
    return { ok: true, updated_columns: [] };
  }

  if (!opts.masterKeyHex) {
    // No key configured → soft-fail. Pipeline continues with hashes only.
    safeLog('warn', {
      event: 'enrich_lead_pii_skipped_no_key',
      request_id: opts.requestId,
      lead_id: opts.leadId,
      // BR-PRIVACY-001: never log plaintext PII
    });
    return { ok: false, updated_columns: [] };
  }

  const registry: MasterKeyRegistry = { 1: opts.masterKeyHex };
  const version: PiiKeyVersion = opts.currentVersion ?? 1;

  const updates: Record<string, unknown> = {};

  for (const [field, plaintext, encColumn] of [
    ['email', input.email, 'emailEnc' as const],
    ['phone', input.phone, 'phoneEnc' as const],
    ['name', input.name, 'nameEnc' as const],
  ] as const) {
    if (!plaintext) continue;
    const result = await encryptPii(
      plaintext,
      opts.workspaceId,
      registry,
      version,
    );
    if (!result.ok) {
      safeLog('error', {
        event: 'enrich_lead_pii_encrypt_failed',
        request_id: opts.requestId,
        lead_id: opts.leadId,
        field,
        error_code: result.error.code,
      });
      continue; // try the others; one failure shouldn't block the rest
    }
    updates[encColumn] = result.value.ciphertext;
    updatedColumns.push(encColumn);
  }

  if (updatedColumns.length === 0) {
    return { ok: false, updated_columns: [] };
  }

  // Always set pii_key_version so future decrypts know which master key applied.
  updates.piiKeyVersion = version;

  // Only write columns that are currently NULL — never overwrite existing
  // ciphertexts (would orphan downstream decryption that uses an older
  // pii_key_version).
  // BR-IDENTITY-005 (workspace scope) + BR-PRIVACY-004 (versioned encryption).
  await opts.db
    .update(leads)
    .set(updates)
    .where(
      and(
        eq(leads.id, opts.leadId),
        eq(leads.workspaceId, opts.workspaceId),
        // Skip if all relevant columns already encrypted (idempotent re-runs).
        or(
          isNull(leads.emailEnc),
          isNull(leads.phoneEnc),
          isNull(leads.nameEnc),
        ),
      ),
    );

  return { ok: true, updated_columns: updatedColumns };
}
