/**
 * Lead resolver — resolveLeadByAliases() with canonical merge logic.
 *
 * Implements the core identity resolution algorithm for MOD-IDENTITY.
 * All PII must be normalized + hashed before any DB lookup (BR-IDENTITY-002).
 *
 * Uses pure DI: `db` is always a parameter, never imported as singleton.
 * Compatible with Cloudflare Workers runtime (no Node.js builtins).
 *
 * BR-IDENTITY-001: aliases ativos são únicos por (workspace_id, identifier_type, identifier_hash)
 * BR-IDENTITY-002: normalizar e hashear antes de qualquer lookup
 * BR-IDENTITY-003: convergência → merge canônico (mais antigo por first_seen_at wins)
 * BR-IDENTITY-004: lead merged não recebe novos aliases ou eventos
 * INV-IDENTITY-001: partial unique index em lead_aliases (status='active')
 * INV-IDENTITY-003: resolver redireciona merged → canonical transitivamente
 * INV-IDENTITY-007: normalização canônica antes do hash
 */

import type { Db } from '@globaltracker/db';
import { leadAliases, leadMerges, leads } from '@globaltracker/db';
import { and, eq, inArray } from 'drizzle-orm';
import { hashPii, hashPiiExternal } from './pii.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };

export type ResolveLeadResult = {
  lead_id: string;
  was_created: boolean;
  merge_executed: boolean;
  merged_lead_ids: string[];
};

export type ResolveLeadError =
  | { code: 'db_error'; message: string }
  | { code: 'invalid_input'; message: string };

export type ResolvedAlias = {
  identifier_type: 'email_hash' | 'phone_hash' | 'external_id_hash';
  identifier_hash: string; // workspace-scoped SHA-256
  external_hash?: string; // pure SHA-256 para dispatchers externos (Meta CAPI, Google)
};

// ---------------------------------------------------------------------------
// Normalization helpers
// INV-IDENTITY-007: canonical normalization before hash
// BR-IDENTITY-002: email lowercase+trim; phone E.164
// ---------------------------------------------------------------------------

/**
 * Normalizes an email address to canonical form before hashing.
 * INV-IDENTITY-007: email → lowercase + trim
 */
export function normalizeEmail(email: string): string {
  // BR-IDENTITY-002: normalizar antes de hashear — email: lowercase + trim
  return email.toLowerCase().trim();
}

/**
 * Normalizes a phone number to E.164 format with Brazilian-aware reconciliation
 * of the mandatory "9" mobile prefix (Anatel mandate, 2014).
 *
 * INV-IDENTITY-007: phone → E.164.
 * INV-IDENTITY-008: BR mobile canônico = 13 dígitos `+55DD9XXXXXXXX`;
 *                   BR landline canônico = 12 dígitos `+55DDXXXXXXXX`.
 *
 * The "9 problem": since 2014 every BR mobile number gained a leading "9" after
 * the DDD area code. Some systems (SendFlow, legacy CRMs, manual exports) still
 * store the pre-2014 format without the 9. To prevent the same lead from
 * appearing under two distinct phone_hashes (form input vs webhook ingest),
 * this function reconciles both into the canonical 13-digit form.
 *
 * Heuristic: BR landline numbers NEVER start with 6, 7, 8, or 9 (Anatel rules
 * — landlines start with 2, 3, 4, or 5). Therefore an 8-digit local part
 * starting with 6-9 is unambiguously a mobile-without-9 and is reconstructed
 * by inserting a "9" between the DDD and the local part.
 *
 * Examples (all → `+5551995849212`):
 *   `+5551995849212`        E.164 canônico (mobile)
 *   `5551995849212`         digits only, country code, with 9
 *   `51995849212`           digits only, no country, with 9
 *   `5195849212`            digits only, no country, NO 9 — inserts
 *   `555195849212`          digits only, country code, NO 9 — inserts
 *   `+555195849212`         with +, country, NO 9 — inserts
 *   `(51) 99584-9212`       human format with 9
 *   `(51) 9584-9212`        human format without 9 — inserts
 *
 * Landlines (no 9 inserted, → `+555132345678`):
 *   `5132345678`            DDD 51 + landline
 *   `+555132345678`
 *   `(51) 3234-5678`
 *
 * International numbers (non-55 country code, with +) pass through with only
 * non-digit stripping; no 9-prefix logic applied.
 *
 * Idempotent: `normalizePhone(normalizePhone(x)) === normalizePhone(x)` for
 * every input where the first call returns a non-null value.
 */
export function normalizePhone(phone: string): string | null {
  // BR-IDENTITY-002: normalizar antes de hashear — phone: E.164
  const hasPlus = phone.trimStart().startsWith('+');
  const digits = phone.replace(/\D/g, '');

  if (digits.length === 0) return null;

  // Reconstruct BR mobile-without-9 when DDD + 8-digit local part starts with 6-9.
  // `dd` and `local` are the post-country-code parts (DDD + local subscriber number).
  function reconcileBr(dd: string, local: string): string {
    if (local.length === 8 && /^[6-9]/.test(local)) {
      // Legacy mobile without 9 → insert 9 to canonicalize.
      return `+55${dd}9${local}`;
    }
    return `+55${dd}${local}`;
  }

  if (hasPlus) {
    if (digits.startsWith('55')) {
      const rest = digits.slice(2);
      if (rest.length === 11) {
        // 13 total: BR mobile canônico (DDD + 9 + 8 dígitos)
        return `+55${rest}`;
      }
      if (rest.length === 10) {
        // 12 total: DDD + 8 dígitos — pode ser landline ou mobile-sem-9
        return reconcileBr(rest.slice(0, 2), rest.slice(2));
      }
      // BR country code mas comprimento fora do padrão (defensivo: passa cru)
      return `+${digits}`;
    }
    // Outro país: preserva sem mexer no 9-prefix
    return `+${digits}`;
  }

  // Sem +: assume BR
  if (digits.length === 13 && digits.startsWith('55')) {
    // 55 + DDD + 9 + 8 dígitos (canônico mobile)
    return `+${digits}`;
  }
  if (digits.length === 12 && digits.startsWith('55')) {
    // 55 + DDD + 8 dígitos: landline ou mobile-sem-9
    const rest = digits.slice(2);
    return reconcileBr(rest.slice(0, 2), rest.slice(2));
  }
  if (digits.length === 11) {
    // DDD + 9 + 8 dígitos (mobile canônico sem country code)
    return `+55${digits}`;
  }
  if (digits.length === 10) {
    // DDD + 8 dígitos: mesma lógica do branch hadPlus+10
    return reconcileBr(digits.slice(0, 2), digits.slice(2));
  }

  // Comprimento não reconhecido (curto demais, ou >13 sem +)
  return null;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Follows the merged_into_lead_id chain until reaching a non-merged canonical lead.
 * INV-IDENTITY-003: resolver redireciona qualquer match para merged_into_lead_id
 */
async function resolveCanonical(leadId: string, db: Db): Promise<string> {
  let current = leadId;
  // Guard against infinite loops (max depth = 20)
  for (let depth = 0; depth < 20; depth++) {
    const rows = await db
      .select({
        status: leads.status,
        mergedIntoLeadId: leads.mergedIntoLeadId,
      })
      .from(leads)
      .where(eq(leads.id, current))
      .limit(1);

    const row = rows[0];
    if (!row) break;
    if (row.status !== 'merged' || !row.mergedIntoLeadId) break;
    current = row.mergedIntoLeadId;
  }
  return current;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Resolves (or creates) a lead from one or more identity signals.
 *
 * Algorithm:
 *   0 aliases match  → create new lead + aliases
 *   1 alias matches  → update last_seen_at; ensure all provided identifiers are aliased
 *   N>1 matches      → merge canônico (oldest first_seen_at wins); aliases moved; merged leads status='merged'
 *
 * BR-IDENTITY-001: unique active alias per (workspace_id, identifier_type, identifier_hash)
 * BR-IDENTITY-002: normalize before hash
 * BR-IDENTITY-003: merge canônico N>1
 * BR-IDENTITY-004: merged lead → redirect to canonical
 * INV-IDENTITY-003: resolver follows merged_into_lead_id transitively
 */
export async function resolveLeadByAliases(
  input: { email?: string; phone?: string; external_id?: string },
  workspace_id: string,
  db: Db,
): Promise<Result<ResolveLeadResult, ResolveLeadError>> {
  // Validate at least one identifier provided
  if (!input.email && !input.phone && !input.external_id) {
    return {
      ok: false,
      error: {
        code: 'invalid_input',
        message:
          'At least one identifier (email, phone, or external_id) is required',
      },
    };
  }

  try {
    // ------------------------------------------------------------------
    // Step 1: Normalize and hash each provided identifier
    // BR-IDENTITY-002: normalizar antes de hashear
    // INV-IDENTITY-007: normalização canônica antes do hash
    // ------------------------------------------------------------------
    const resolvedAliases: ResolvedAlias[] = [];

    if (input.email) {
      const normalized = normalizeEmail(input.email);
      // BR-IDENTITY-002: normalizar antes de hashear
      const hash = await hashPii(normalized, workspace_id);
      const externalHash = await hashPiiExternal(normalized);
      resolvedAliases.push({
        identifier_type: 'email_hash',
        identifier_hash: hash,
        external_hash: externalHash,
      });
    }

    if (input.phone) {
      const normalized = normalizePhone(input.phone);
      if (!normalized) {
        return {
          ok: false,
          error: {
            code: 'invalid_input',
            message:
              'phone_normalization_failed: could not convert phone to E.164',
          },
        };
      }
      // BR-IDENTITY-002: normalizar antes de hashear
      const hash = await hashPii(normalized, workspace_id);
      const externalHash = await hashPiiExternal(normalized);
      resolvedAliases.push({
        identifier_type: 'phone_hash',
        identifier_hash: hash,
        external_hash: externalHash,
      });
    }

    if (input.external_id) {
      // external_id: no normalization beyond trim
      const normalized = input.external_id.trim();
      const hash = await hashPii(normalized, workspace_id);
      resolvedAliases.push({
        identifier_type: 'external_id_hash',
        identifier_hash: hash,
      });
    }

    // ------------------------------------------------------------------
    // Step 2: Find active aliases matching any of the provided identifiers
    // BR-IDENTITY-001: aliases ativos únicos por (workspace_id, identifier_type, identifier_hash)
    // ------------------------------------------------------------------
    const matchingAliases = await db
      .select({
        id: leadAliases.id,
        leadId: leadAliases.leadId,
        identifierType: leadAliases.identifierType,
        identifierHash: leadAliases.identifierHash,
      })
      .from(leadAliases)
      .where(
        and(
          eq(leadAliases.workspaceId, workspace_id),
          eq(leadAliases.status, 'active'),
          inArray(
            leadAliases.identifierHash,
            resolvedAliases.map((a) => a.identifier_hash),
          ),
        ),
      );

    // Collect unique lead IDs from matching aliases
    // INV-IDENTITY-003: follow merged_into_lead_id transitively to reach canonical
    const rawLeadIds = [...new Set(matchingAliases.map((a) => a.leadId))];

    // Resolve each match transitively (handles pre-existing merged leads)
    const canonicalLeadIds = await Promise.all(
      rawLeadIds.map((id) => resolveCanonical(id, db)),
    );
    const uniqueCanonicalIds = [...new Set(canonicalLeadIds)];

    // ------------------------------------------------------------------
    // Case A: 0 matches → create new lead + aliases
    // ------------------------------------------------------------------
    if (uniqueCanonicalIds.length === 0) {
      return await createNewLead(resolvedAliases, workspace_id, db);
    }

    // ------------------------------------------------------------------
    // Case B: 1 match → update last_seen_at; upsert missing aliases
    // ------------------------------------------------------------------
    if (uniqueCanonicalIds.length === 1) {
      // biome-ignore lint/style/noNonNullAssertion: guarded by length === 1 check above
      const leadId = uniqueCanonicalIds[0]!;
      return await updateExistingLead(
        leadId,
        resolvedAliases,
        workspace_id,
        db,
      );
    }

    // ------------------------------------------------------------------
    // Case C: N>1 matches → merge canônico
    // BR-IDENTITY-003: convergência → merge canônico (mais antigo por first_seen_at wins)
    // ------------------------------------------------------------------
    return await mergeLeads(
      uniqueCanonicalIds as string[],
      resolvedAliases,
      workspace_id,
      db,
    );
  } catch (err) {
    return {
      ok: false,
      error: {
        code: 'db_error',
        message: err instanceof Error ? err.message : 'Unknown database error',
      },
    };
  }
}

// ---------------------------------------------------------------------------
// Case A: create new lead + aliases
// ---------------------------------------------------------------------------

async function createNewLead(
  resolvedAliases: ResolvedAlias[],
  workspace_id: string,
  db: Db,
): Promise<Result<ResolveLeadResult, ResolveLeadError>> {
  const now = new Date();

  // Extract hashes for denormalized columns — enables dispatcher eligibility checks
  // without a join to lead_aliases on every dispatch.
  const emailAlias = resolvedAliases.find(
    (a) => a.identifier_type === 'email_hash',
  );
  const phoneAlias = resolvedAliases.find(
    (a) => a.identifier_type === 'phone_hash',
  );

  // Insert new lead row
  const inserted = await db
    .insert(leads)
    .values({
      workspaceId: workspace_id,
      status: 'active',
      firstSeenAt: now,
      lastSeenAt: now,
      emailHash: emailAlias?.identifier_hash ?? null,
      phoneHash: phoneAlias?.identifier_hash ?? null,
      emailHashExternal: emailAlias?.external_hash ?? null, // T-OPB-003a: pure SHA-256 para dispatchers externos
      phoneHashExternal: phoneAlias?.external_hash ?? null, // T-OPB-003a: pure SHA-256 para dispatchers externos
    })
    .returning({ id: leads.id });

  const newLead = inserted[0];
  if (!newLead) {
    return {
      ok: false,
      error: { code: 'db_error', message: 'Failed to insert new lead' },
    };
  }

  // Insert aliases for all provided identifiers
  // BR-IDENTITY-001: only inserting once per identifier — no conflict expected for brand-new lead
  if (resolvedAliases.length > 0) {
    await db.insert(leadAliases).values(
      resolvedAliases.map((a) => ({
        workspaceId: workspace_id,
        identifierType: a.identifier_type,
        identifierHash: a.identifier_hash,
        leadId: newLead.id,
        source: 'form_submit' as const,
        status: 'active' as const,
        ts: now,
      })),
    );
  }

  return {
    ok: true,
    value: {
      lead_id: newLead.id,
      was_created: true,
      merge_executed: false,
      merged_lead_ids: [],
    },
  };
}

// ---------------------------------------------------------------------------
// Case B: update existing lead's last_seen_at; add any missing aliases
// ---------------------------------------------------------------------------

async function updateExistingLead(
  leadId: string,
  resolvedAliases: ResolvedAlias[],
  workspace_id: string,
  db: Db,
): Promise<Result<ResolveLeadResult, ResolveLeadError>> {
  const now = new Date();

  // Update last_seen_at + denormalized hash columns if newly provided.
  const emailAlias = resolvedAliases.find(
    (a) => a.identifier_type === 'email_hash',
  );
  const phoneAlias = resolvedAliases.find(
    (a) => a.identifier_type === 'phone_hash',
  );
  await db
    .update(leads)
    .set({
      lastSeenAt: now,
      updatedAt: now,
      ...(emailAlias ? { emailHash: emailAlias.identifier_hash } : {}),
      ...(phoneAlias ? { phoneHash: phoneAlias.identifier_hash } : {}),
      ...(emailAlias?.external_hash
        ? { emailHashExternal: emailAlias.external_hash }
        : {}), // T-OPB-003a: pure SHA-256 para dispatchers externos
      ...(phoneAlias?.external_hash
        ? { phoneHashExternal: phoneAlias.external_hash }
        : {}), // T-OPB-003a: pure SHA-256 para dispatchers externos
    })
    .where(and(eq(leads.id, leadId), eq(leads.workspaceId, workspace_id)));

  // Find which aliases already exist for this lead (active)
  const existingAliases = await db
    .select({
      identifierHash: leadAliases.identifierHash,
      identifierType: leadAliases.identifierType,
    })
    .from(leadAliases)
    .where(
      and(
        eq(leadAliases.leadId, leadId),
        eq(leadAliases.workspaceId, workspace_id),
        eq(leadAliases.status, 'active'),
      ),
    );

  const existingSet = new Set(
    existingAliases.map((a) => `${a.identifierType}:${a.identifierHash}`),
  );

  // Insert only new aliases that don't exist yet
  // BR-IDENTITY-001: aliases ativos são únicos — skip if already present
  const newAliases = resolvedAliases.filter(
    (a) => !existingSet.has(`${a.identifier_type}:${a.identifier_hash}`),
  );

  if (newAliases.length > 0) {
    await db.insert(leadAliases).values(
      newAliases.map((a) => ({
        workspaceId: workspace_id,
        identifierType: a.identifier_type,
        identifierHash: a.identifier_hash,
        leadId: leadId,
        source: 'form_submit' as const,
        status: 'active' as const,
        ts: now,
      })),
    );
  }

  return {
    ok: true,
    value: {
      lead_id: leadId,
      was_created: false,
      merge_executed: false,
      merged_lead_ids: [],
    },
  };
}

// ---------------------------------------------------------------------------
// Case C: merge N>1 leads; canonical = oldest by first_seen_at
// BR-IDENTITY-003: convergência → merge canônico (mais antigo wins)
// ---------------------------------------------------------------------------

async function mergeLeads(
  leadIds: string[],
  resolvedAliases: ResolvedAlias[],
  workspace_id: string,
  db: Db,
): Promise<Result<ResolveLeadResult, ResolveLeadError>> {
  const now = new Date();

  // Fetch all lead rows to determine canonical (oldest first_seen_at)
  const leadRows = await db
    .select({
      id: leads.id,
      firstSeenAt: leads.firstSeenAt,
      status: leads.status,
      workspaceId: leads.workspaceId,
    })
    .from(leads)
    .where(
      and(inArray(leads.id, leadIds), eq(leads.workspaceId, workspace_id)),
    );

  if (leadRows.length < 2) {
    // Degraded case: concurrent modification or data issue; fall back to single
    // biome-ignore lint/style/noNonNullAssertion: guarded by leadIds.length >= 1 (caller ensures at least 2)
    const fallbackId = leadIds[0]!;
    return updateExistingLead(fallbackId, resolvedAliases, workspace_id, db);
  }

  // BR-IDENTITY-003: canonical = lead with the smallest first_seen_at (oldest)
  const sorted = [...leadRows].sort(
    (a, b) => a.firstSeenAt.getTime() - b.firstSeenAt.getTime(),
  );
  // biome-ignore lint/style/noNonNullAssertion: guarded by leadRows.length >= 2 check above
  const canonical = sorted[0]!;
  const toMerge = sorted.slice(1);
  const mergedLeadIds = toMerge.map((l) => l.id);

  // For each lead being merged:
  //   1. Mark its active aliases as 'superseded'
  //   2. Insert new active aliases on the canonical (avoiding duplicates)
  //   3. Set lead status='merged', merged_into_lead_id=canonical.id
  //   4. Insert lead_merges row

  for (const secondary of toMerge) {
    // Get all active aliases of secondary lead
    const secondaryAliases = await db
      .select({
        id: leadAliases.id,
        identifierType: leadAliases.identifierType,
        identifierHash: leadAliases.identifierHash,
      })
      .from(leadAliases)
      .where(
        and(
          eq(leadAliases.leadId, secondary.id),
          eq(leadAliases.workspaceId, workspace_id),
          eq(leadAliases.status, 'active'),
        ),
      );

    // Mark secondary aliases as 'superseded'
    // BR-IDENTITY-001: superseded allows same identifier to become active on canonical
    if (secondaryAliases.length > 0) {
      await db
        .update(leadAliases)
        .set({ status: 'superseded' })
        .where(
          and(
            eq(leadAliases.leadId, secondary.id),
            eq(leadAliases.workspaceId, workspace_id),
            eq(leadAliases.status, 'active'),
          ),
        );
    }

    // Get existing active aliases on canonical to avoid re-inserting duplicates
    const canonicalAliases = await db
      .select({
        identifierType: leadAliases.identifierType,
        identifierHash: leadAliases.identifierHash,
      })
      .from(leadAliases)
      .where(
        and(
          eq(leadAliases.leadId, canonical.id),
          eq(leadAliases.workspaceId, workspace_id),
          eq(leadAliases.status, 'active'),
        ),
      );

    const canonicalSet = new Set(
      canonicalAliases.map((a) => `${a.identifierType}:${a.identifierHash}`),
    );

    // Re-create secondary's aliases on canonical (only if not already present)
    const aliasesToMove = secondaryAliases.filter(
      (a) => !canonicalSet.has(`${a.identifierType}:${a.identifierHash}`),
    );

    if (aliasesToMove.length > 0) {
      await db.insert(leadAliases).values(
        aliasesToMove.map((a) => ({
          workspaceId: workspace_id,
          identifierType: a.identifierType,
          identifierHash: a.identifierHash,
          leadId: canonical.id,
          source: 'merge' as const,
          status: 'active' as const,
          ts: now,
        })),
      );
    }

    // Mark secondary lead as merged
    // INV-IDENTITY-003: merged lead does not receive new aliases or events
    await db
      .update(leads)
      .set({
        status: 'merged',
        mergedIntoLeadId: canonical.id,
        updatedAt: now,
      })
      .where(
        and(eq(leads.id, secondary.id), eq(leads.workspaceId, workspace_id)),
      );

    // Insert lead_merges audit row
    // BR-IDENTITY-003: merge must be recorded in lead_merges for audit purposes
    await db.insert(leadMerges).values({
      workspaceId: workspace_id,
      canonicalLeadId: canonical.id,
      mergedLeadId: secondary.id,
      reason: 'email_phone_convergence',
      performedBy: 'system',
      beforeSummary: {
        canonical: { id: canonical.id, first_seen_at: canonical.firstSeenAt },
        merged: { id: secondary.id, first_seen_at: secondary.firstSeenAt },
      },
      afterSummary: {
        canonical_id: canonical.id,
        merged_ids: mergedLeadIds,
        merged_at: now,
      },
      mergedAt: now,
    });
  }

  // Update canonical lead's last_seen_at
  await db
    .update(leads)
    .set({ lastSeenAt: now, updatedAt: now })
    .where(
      and(eq(leads.id, canonical.id), eq(leads.workspaceId, workspace_id)),
    );

  // Add any new identifier aliases from the current request onto canonical
  await updateExistingLead(canonical.id, resolvedAliases, workspace_id, db);

  return {
    ok: true,
    value: {
      lead_id: canonical.id,
      was_created: false,
      merge_executed: true,
      merged_lead_ids: mergedLeadIds,
    },
  };
}
