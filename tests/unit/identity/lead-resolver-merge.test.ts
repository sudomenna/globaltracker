/**
 * Unit tests — lead-resolver: Case C (N>1 matches → canonical merge)
 *
 * Uses a mock DB (no real database connection).
 *
 * BR-IDENTITY-003: convergência → merge canônico (mais antigo por first_seen_at wins)
 * INV-IDENTITY-001: aliases superseded before moving to canonical
 * INV-IDENTITY-003: merged lead does not receive new aliases
 */

import { describe, expect, it, vi } from 'vitest';
import { resolveLeadByAliases } from '../../../apps/edge/src/lib/lead-resolver';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const WORKSPACE_ID = 'ws-00000000-0000-0000-0000-000000000001';

// Lead A: older (canonical candidate)
const LEAD_A_ID = 'lead-00000000-0000-0000-0000-aaaaaaaaaaaa';
const LEAD_A_FIRST_SEEN = new Date('2024-01-01T00:00:00Z');

// Lead B: newer (will be merged into A)
const LEAD_B_ID = 'lead-00000000-0000-0000-0000-bbbbbbbbbbbb';
const LEAD_B_FIRST_SEEN = new Date('2024-03-01T00:00:00Z');

// ---------------------------------------------------------------------------
// Helper: thenable where() that also has limit()
// ---------------------------------------------------------------------------

function makeThenableWhere(resolvedValue: unknown[]) {
  return {
    // biome-ignore lint/suspicious/noThenProperty: mock needs to be both awaitable and chainable
    then: (onfulfilled: (v: unknown) => unknown) =>
      Promise.resolve(resolvedValue).then(onfulfilled),
    limit: vi.fn().mockResolvedValue(resolvedValue),
    orderBy: vi.fn().mockReturnValue({
      limit: vi.fn().mockResolvedValue(resolvedValue),
    }),
  };
}

// ---------------------------------------------------------------------------
// Mock DB for N>1 merge scenario
//
// Select call sequence (with email + phone input):
//   1. Find active aliases → 2 aliases (A email, B phone)
//   2. resolveCanonical(LEAD_A) → active
//   3. resolveCanonical(LEAD_B) → active
//   4. mergeLeads: fetch lead rows by IDs → A + B with firstSeenAt
//   5. mergeLeads: active aliases of LEAD_B (secondary) → [phone_hash]
//   6. mergeLeads: existing active aliases on canonical (LEAD_A) → [email_hash]
//   7. updateExistingLead (final): existing aliases on canonical → both present
// ---------------------------------------------------------------------------

function makeMergeDb() {
  const insertedRows: Array<{ values: unknown }> = [];
  const updatedRows: Array<{ set: unknown }> = [];

  let selectCallIdx = 0;

  const db = {
    select: vi.fn().mockImplementation(() => {
      selectCallIdx++;
      const idx = selectCallIdx;

      return {
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue(
            makeThenableWhere(
              idx === 1
                ? [
                    {
                      id: 'alias-A-email',
                      leadId: LEAD_A_ID,
                      identifierType: 'email_hash',
                      identifierHash: 'hash-email',
                    },
                    {
                      id: 'alias-B-phone',
                      leadId: LEAD_B_ID,
                      identifierType: 'phone_hash',
                      identifierHash: 'hash-phone',
                    },
                  ]
                : idx === 2
                  ? [{ status: 'active', mergedIntoLeadId: null }]
                  : idx === 3
                    ? [{ status: 'active', mergedIntoLeadId: null }]
                    : idx === 4
                      ? [
                          {
                            id: LEAD_A_ID,
                            firstSeenAt: LEAD_A_FIRST_SEEN,
                            status: 'active',
                            workspaceId: WORKSPACE_ID,
                          },
                          {
                            id: LEAD_B_ID,
                            firstSeenAt: LEAD_B_FIRST_SEEN,
                            status: 'active',
                            workspaceId: WORKSPACE_ID,
                          },
                        ]
                      : idx === 5
                        ? [
                            {
                              id: 'alias-B-phone',
                              identifierType: 'phone_hash',
                              identifierHash: 'hash-phone',
                            },
                          ]
                        : idx === 6
                          ? [
                              {
                                identifierType: 'email_hash',
                                identifierHash: 'hash-email',
                              },
                            ]
                          : [
                              {
                                identifierType: 'email_hash',
                                identifierHash: 'hash-email',
                              },
                              {
                                identifierType: 'phone_hash',
                                identifierHash: 'hash-phone',
                              },
                            ],
            ),
          ),
        }),
      };
    }),

    update: vi.fn().mockImplementation(() => ({
      set: vi.fn().mockImplementation((setValues) => ({
        where: vi.fn().mockImplementation(() => {
          updatedRows.push({ set: setValues });
          return Promise.resolve([]);
        }),
      })),
    })),

    insert: vi.fn().mockImplementation(() => ({
      values: vi.fn().mockImplementation((vals) => {
        insertedRows.push({ values: vals });
        return Promise.resolve([]);
      }),
    })),
  } as unknown as Parameters<typeof resolveLeadByAliases>[2];

  return { db, insertedRows, updatedRows };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('resolveLeadByAliases — N>1 merge', () => {
  it('returns canonical lead (oldest first_seen_at) as lead_id', async () => {
    const { db } = makeMergeDb();

    const result = await resolveLeadByAliases(
      { email: 'foo@example.com', phone: '+5511999990000' },
      WORKSPACE_ID,
      db,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      // BR-IDENTITY-003: lead A is canonical (oldest first_seen_at)
      expect(result.value.lead_id).toBe(LEAD_A_ID);
      expect(result.value.merge_executed).toBe(true);
      expect(result.value.was_created).toBe(false);
      expect(result.value.merged_lead_ids).toContain(LEAD_B_ID);
      expect(result.value.merged_lead_ids).toHaveLength(1);
    }
  });

  it('calls update to mark secondary lead as merged', async () => {
    const { db, updatedRows } = makeMergeDb();

    await resolveLeadByAliases(
      { email: 'foo@example.com', phone: '+5511999990000' },
      WORKSPACE_ID,
      db,
    );

    // INV-IDENTITY-003: secondary lead must be marked 'merged'
    const mergeUpdate = updatedRows.find(
      (r) =>
        typeof r.set === 'object' &&
        r.set !== null &&
        'status' in (r.set as object) &&
        (r.set as Record<string, unknown>).status === 'merged',
    );
    expect(mergeUpdate).toBeDefined();
  });

  it('inserts a lead_merges audit row', async () => {
    const { db, insertedRows } = makeMergeDb();

    await resolveLeadByAliases(
      { email: 'foo@example.com', phone: '+5511999990000' },
      WORKSPACE_ID,
      db,
    );

    // BR-IDENTITY-003: merge must be recorded in lead_merges
    expect(insertedRows.length).toBeGreaterThan(0);
    const mergeRow = insertedRows.find((r) => {
      const vals = r.values as Record<string, unknown>;
      return vals && 'canonicalLeadId' in vals;
    });
    expect(mergeRow).toBeDefined();
    if (mergeRow) {
      const vals = mergeRow.values as Record<string, unknown>;
      expect(vals.canonicalLeadId).toBe(LEAD_A_ID);
      expect(vals.mergedLeadId).toBe(LEAD_B_ID);
      expect(vals.performedBy).toBe('system');
    }
  });
});
