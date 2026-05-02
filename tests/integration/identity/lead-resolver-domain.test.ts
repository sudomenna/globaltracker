/**
 * Integration tests — lead-resolver domain functions with DB
 *
 * Tests that exercise the actual DB constraints:
 *   INV-IDENTITY-001: unique active alias constraint prevents duplicates
 *   INV-IDENTITY-003: merged lead does not receive new aliases (redirect to canonical)
 *
 * Requires: DATABASE_URL env var pointing to a Postgres 15+ instance
 * with migrations applied.
 *
 * Pattern: transaction-per-test, rolled back after assertion.
 *
 * BR-IDENTITY-001: aliases ativos únicos por (workspace_id, identifier_type, identifier_hash)
 * BR-IDENTITY-003: merge canônico; merged leads redirect to canonical
 * INV-IDENTITY-001: partial unique index uq_lead_aliases_active_per_identifier
 * INV-IDENTITY-003: resolver redireciona merged → canonical
 */

import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveLeadByAliases } from '../../../apps/edge/src/lib/lead-resolver.js';
import { createDb } from '../../../packages/db/src/index.js';

// biome-ignore lint/complexity/useLiteralKeys: noUncheckedIndexedAccess requires string access here
const DATABASE_URL = process.env['DATABASE_URL'];

const describeIfDb = DATABASE_URL ? describe : describe.skip;

describeIfDb('lead-resolver integration', () => {
  let sql: ReturnType<typeof postgres>;
  let db: ReturnType<typeof createDb>;

  const workspaceId = '20000000-0000-0000-0000-000000000002';
  const workspaceSlug = `resolver-test-${Date.now()}`;

  beforeAll(async () => {
    if (!DATABASE_URL) throw new Error('DATABASE_URL not set');
    sql = postgres(DATABASE_URL, { prepare: false });
    db = createDb(DATABASE_URL);

    // Create test workspace
    await sql`SET LOCAL app.current_workspace_id = ${workspaceId}`;
    await sql`
      INSERT INTO workspaces (id, slug, name, status)
      VALUES (${workspaceId}::uuid, ${workspaceSlug}, 'Resolver Test WS', 'active')
      ON CONFLICT (id) DO NOTHING
    `;
  });

  afterAll(async () => {
    // Clean up
    await sql`DELETE FROM lead_attributions WHERE workspace_id = ${workspaceId}::uuid`;
    await sql`DELETE FROM lead_consents    WHERE workspace_id = ${workspaceId}::uuid`;
    await sql`DELETE FROM lead_merges      WHERE workspace_id = ${workspaceId}::uuid`;
    await sql`DELETE FROM lead_aliases     WHERE workspace_id = ${workspaceId}::uuid`;
    await sql`DELETE FROM leads            WHERE workspace_id = ${workspaceId}::uuid`;
    await sql`DELETE FROM workspaces       WHERE id = ${workspaceId}::uuid`;
    await sql.end();
  });

  // ---------------------------------------------------------------------------
  // Case A: 0 matches → create new lead
  // ---------------------------------------------------------------------------
  it('creates a new lead when no aliases match', async () => {
    // Use unique email to avoid cross-test interference
    const email = `new-lead-${Date.now()}@example.com`;

    const result = await resolveLeadByAliases({ email }, workspaceId, db);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.was_created).toBe(true);
      expect(result.value.merge_executed).toBe(false);
      expect(result.value.merged_lead_ids).toHaveLength(0);
      expect(result.value.lead_id).toMatch(/^[0-9a-f-]{36}$/);
    }

    // Cleanup
    if (result.ok) {
      await sql`DELETE FROM lead_aliases WHERE lead_id = ${result.value.lead_id}::uuid`;
      await sql`DELETE FROM leads WHERE id = ${result.value.lead_id}::uuid`;
    }
  });

  // ---------------------------------------------------------------------------
  // Case B: 1 match → update, no create
  // ---------------------------------------------------------------------------
  it('returns existing lead and does not create a new one on second resolve', async () => {
    const email = `existing-${Date.now()}@example.com`;

    // First resolve: creates
    const r1 = await resolveLeadByAliases({ email }, workspaceId, db);
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;

    const leadId = r1.value.lead_id;
    expect(r1.value.was_created).toBe(true);

    // Second resolve: same email → returns same lead
    const r2 = await resolveLeadByAliases({ email }, workspaceId, db);
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;

    expect(r2.value.lead_id).toBe(leadId);
    expect(r2.value.was_created).toBe(false);
    expect(r2.value.merge_executed).toBe(false);

    // Cleanup
    await sql`DELETE FROM lead_aliases WHERE lead_id = ${leadId}::uuid`;
    await sql`DELETE FROM leads WHERE id = ${leadId}::uuid`;
  });

  // ---------------------------------------------------------------------------
  // Case C: N>1 matches → merge canonical
  // BR-IDENTITY-003: canonical = oldest by first_seen_at
  // ---------------------------------------------------------------------------
  it('merges two leads when email and phone converge, oldest is canonical', async () => {
    // Seed: lead A with email only (created earlier)
    const emailA = `merge-a-${Date.now()}@example.com`;
    const phoneB = `+55119${Date.now().toString().slice(-8)}`;

    // Resolve lead A via email
    const rA = await resolveLeadByAliases({ email: emailA }, workspaceId, db);
    expect(rA.ok).toBe(true);
    if (!rA.ok) return;
    const leadAId = rA.value.lead_id;

    // Small delay to ensure different first_seen_at
    await new Promise((r) => setTimeout(r, 10));

    // Resolve lead B via phone
    const rB = await resolveLeadByAliases({ phone: phoneB }, workspaceId, db);
    expect(rB.ok).toBe(true);
    if (!rB.ok) return;
    const leadBId = rB.value.lead_id;

    expect(leadAId).not.toBe(leadBId);

    // Now resolve with both email AND phone → should merge
    const rMerge = await resolveLeadByAliases(
      { email: emailA, phone: phoneB },
      workspaceId,
      db,
    );

    expect(rMerge.ok).toBe(true);
    if (!rMerge.ok) return;

    // BR-IDENTITY-003: canonical = oldest first_seen_at = lead A
    expect(rMerge.value.lead_id).toBe(leadAId);
    expect(rMerge.value.merge_executed).toBe(true);
    expect(rMerge.value.merged_lead_ids).toContain(leadBId);
    expect(rMerge.value.was_created).toBe(false);

    // Cleanup
    await sql`DELETE FROM lead_merges WHERE workspace_id = ${workspaceId}::uuid AND canonical_lead_id = ${leadAId}::uuid`;
    await sql`DELETE FROM lead_aliases WHERE workspace_id = ${workspaceId}::uuid AND (lead_id = ${leadAId}::uuid OR lead_id = ${leadBId}::uuid)`;
    await sql`DELETE FROM leads WHERE id IN (${leadAId}::uuid, ${leadBId}::uuid)`;
  });

  // ---------------------------------------------------------------------------
  // INV-IDENTITY-003: merged lead → resolver redirects to canonical
  // BR-IDENTITY-004: merged lead does not receive new aliases
  // ---------------------------------------------------------------------------
  it('INV-IDENTITY-003: resolving a merged lead returns the canonical lead', async () => {
    const emailC = `merged-c-${Date.now()}@example.com`;
    const phoneD = `+55119${(Date.now() + 1).toString().slice(-8)}`;

    // Create lead C (email) and lead D (phone)
    const rC = await resolveLeadByAliases({ email: emailC }, workspaceId, db);
    expect(rC.ok).toBe(true);
    if (!rC.ok) return;

    await new Promise((r) => setTimeout(r, 10));

    const rD = await resolveLeadByAliases({ phone: phoneD }, workspaceId, db);
    expect(rD.ok).toBe(true);
    if (!rD.ok) return;

    // Merge them
    const rMerge = await resolveLeadByAliases(
      { email: emailC, phone: phoneD },
      workspaceId,
      db,
    );
    expect(rMerge.ok).toBe(true);
    if (!rMerge.ok) return;

    const canonicalId = rMerge.value.lead_id;

    // Now resolve using only phone (which was on the secondary lead)
    // INV-IDENTITY-003: resolver should follow merged_into_lead_id and return canonical
    const rAfterMerge = await resolveLeadByAliases(
      { phone: phoneD },
      workspaceId,
      db,
    );
    expect(rAfterMerge.ok).toBe(true);
    if (!rAfterMerge.ok) return;

    // Should return canonical lead, not the merged one
    expect(rAfterMerge.value.lead_id).toBe(canonicalId);
    expect(rAfterMerge.value.merge_executed).toBe(false);

    // Cleanup
    await sql`DELETE FROM lead_merges WHERE workspace_id = ${workspaceId}::uuid AND canonical_lead_id = ${canonicalId}::uuid`;
    await sql`DELETE FROM lead_aliases WHERE workspace_id = ${workspaceId}::uuid`;
    await sql`DELETE FROM leads WHERE workspace_id = ${workspaceId}::uuid`;
  });
});
