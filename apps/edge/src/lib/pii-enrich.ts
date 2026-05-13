/**
 * pii-enrich.ts — Populate `leads.email_enc / phone_enc / name_enc` ciphertexts.
 *
 * T-13-015 (initial). ADR-044 (2026-05-13) made the ciphertexts mirror the
 * **active identifier**, not just the first one captured.
 *
 * Wires `encryptPii` from `pii.ts` into the lead-creation pipeline so
 * admin recovery, DSAR (LGPD/GDPR right to access), and operational support
 * (looking up a lead by phone/email outside the hashed lookup path) work as
 * intended by BR-PRIVACY-004.
 *
 * Behavior (INV-IDENTITY-008, ADR-044):
 *   - If `*_enc` IS NULL → encrypt with current `pii_key_version` and write.
 *   - If `*_enc` IS NOT NULL → decrypt with the row's stored `pii_key_version`,
 *     compare plaintext to input. If equal → noop (idempotent). If different
 *     (re-identification: typo fix, email change, phone rotation) → re-encrypt
 *     with current `pii_key_version` and overwrite, updating `pii_key_version`
 *     to the current one.
 *   - If decrypt of the existing ciphertext fails (key gap, corruption) →
 *     skip overwrite to avoid losing recoverable plaintext. Logged.
 *
 * Failure mode (INV-PRIVACY-006-soft): if encryption fails or the master key
 * is missing, the lead row stays without ciphertext but with hashes — the
 * core hash-based pipeline continues to work. The helper logs and returns
 * a non-blocking result.
 */

import type { Db } from '@globaltracker/db';
import { leads } from '@globaltracker/db';
import { and, eq } from 'drizzle-orm';
import { safeLog } from '../middleware/sanitize-logs.js';
import {
  type MasterKeyRegistry,
  type PiiKeyVersion,
  decryptPii,
  encryptPii,
  hashPiiExternal,
  splitName,
} from './pii.js';

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

type EncField = {
  field: 'email' | 'phone' | 'name';
  plaintext: string | undefined;
  encColumn: 'emailEnc' | 'phoneEnc' | 'nameEnc';
};

export async function enrichLeadPii(
  input: EnrichLeadPiiInput,
  opts: EnrichLeadPiiOptions,
): Promise<{ ok: boolean; updated_columns: string[] }> {
  const updatedColumns: string[] = [];

  if (!input.email && !input.phone && !input.name) {
    return { ok: true, updated_columns: [] };
  }

  if (!opts.masterKeyHex) {
    safeLog('warn', {
      event: 'enrich_lead_pii_skipped_no_key',
      request_id: opts.requestId,
      lead_id: opts.leadId,
      // BR-PRIVACY-001: never log plaintext PII
    });
    return { ok: false, updated_columns: [] };
  }

  const registry: MasterKeyRegistry = { 1: opts.masterKeyHex };
  const currentVersion: PiiKeyVersion = opts.currentVersion ?? 1;

  // Fetch current ciphertexts + the row's pii_key_version. Required to decide
  // whether to re-encrypt (ADR-044: ciphertexts mirror active identifier).
  const currentRows = await opts.db
    .select({
      emailEnc: leads.emailEnc,
      phoneEnc: leads.phoneEnc,
      nameEnc: leads.nameEnc,
      piiKeyVersion: leads.piiKeyVersion,
    })
    .from(leads)
    .where(
      and(eq(leads.id, opts.leadId), eq(leads.workspaceId, opts.workspaceId)),
    )
    .limit(1);

  if (currentRows.length === 0) {
    safeLog('error', {
      event: 'enrich_lead_pii_lead_not_found',
      request_id: opts.requestId,
      lead_id: opts.leadId,
    });
    return { ok: false, updated_columns: [] };
  }
  const current = currentRows[0]!;
  const rowVersion: PiiKeyVersion = current.piiKeyVersion ?? currentVersion;

  const updates: Record<string, unknown> = {};

  const fields: EncField[] = [
    { field: 'email', plaintext: input.email, encColumn: 'emailEnc' },
    { field: 'phone', plaintext: input.phone, encColumn: 'phoneEnc' },
    { field: 'name', plaintext: input.name, encColumn: 'nameEnc' },
  ];

  for (const { field, plaintext, encColumn } of fields) {
    if (!plaintext) continue;
    const currentCiphertext = current[encColumn];

    // INV-IDENTITY-008 / ADR-044: if a ciphertext already exists, decrypt and
    // compare. Skip write when plaintext matches (idempotent re-run). Re-encrypt
    // only when plaintext diverges (active identifier changed).
    if (currentCiphertext) {
      const decrypted = await decryptPii(
        currentCiphertext,
        opts.workspaceId,
        registry,
        rowVersion,
      );
      if (decrypted.ok && decrypted.value === plaintext) {
        continue; // no-op: ciphertext already matches input
      }
      if (!decrypted.ok) {
        // Conservative: do not overwrite recoverable plaintext with a value we
        // cannot compare against. Operator must rotate master key or backfill
        // before this field can be re-encrypted.
        safeLog('warn', {
          event: 'enrich_lead_pii_decrypt_failed_skip_overwrite',
          request_id: opts.requestId,
          lead_id: opts.leadId,
          field,
          error_code: decrypted.error.code,
        });
        continue;
      }
      // decrypted.ok === true && decrypted.value !== plaintext → proceed
    }

    const result = await encryptPii(
      plaintext,
      opts.workspaceId,
      registry,
      currentVersion,
    );
    if (!result.ok) {
      safeLog('error', {
        event: 'enrich_lead_pii_encrypt_failed',
        request_id: opts.requestId,
        lead_id: opts.leadId,
        field,
        error_code: result.error.code,
      });
      continue; // one failure shouldn't block the rest
    }
    updates[encColumn] = result.value.ciphertext;
    updatedColumns.push(encColumn);
  }

  if (Object.keys(updates).length > 0) {
    // Always set pii_key_version to the current one when writing — the new
    // ciphertexts were encrypted with `currentVersion`. Mixed-version rows
    // (some columns at v1, some at v2 within the same row) are not supported.
    updates.piiKeyVersion = currentVersion;

    // BR-IDENTITY-005 (workspace scope) + BR-PRIVACY-004 (versioned encryption)
    // + ADR-044 (ciphertext mirrors active identifier).
    await opts.db
      .update(leads)
      .set(updates)
      .where(
        and(
          eq(leads.id, opts.leadId),
          eq(leads.workspaceId, opts.workspaceId),
        ),
      );
  }

  // T-OPB-003b: Populate fn_hash / ln_hash from plaintext name (pure SHA-256 for Meta/Google).
  // ADR-034: also populate `leads.name` plaintext for ILIKE search.
  // This UPDATE is unconditional — always reflects latest known name.
  // BR-PRIVACY-002: only hash + plaintext name persist; raw email/phone stay encrypted.
  if (input.name) {
    const { first, last } = splitName(input.name);
    const fnHashVal = first ? await hashPiiExternal(first) : null;
    const lnHashVal = last ? await hashPiiExternal(last) : null;

    await opts.db
      .update(leads)
      .set({
        name: input.name, // ADR-034: plaintext for search
        ...(fnHashVal ? { fnHash: fnHashVal } : {}),
        ...(lnHashVal ? { lnHash: lnHashVal } : {}),
      })
      .where(
        and(
          eq(leads.id, opts.leadId),
          eq(leads.workspaceId, opts.workspaceId),
        ),
      );
    if (!updatedColumns.includes('name')) updatedColumns.push('name');
    if (fnHashVal && !updatedColumns.includes('fnHash')) {
      updatedColumns.push('fnHash');
    }
    if (lnHashVal && !updatedColumns.includes('lnHash')) {
      updatedColumns.push('lnHash');
    }
  }

  // `ok: true` even when updatedColumns is empty — that means an idempotent
  // no-op (plaintext already matches current ciphertext). `ok: false` only on
  // fatal errors (no key, lead not found), surfaced above with explicit returns.
  return { ok: true, updated_columns: updatedColumns };
}
