/**
 * Unit tests — lead-resolver: Case B (1 match → update last_seen_at)
 *
 * Uses a mock DB (no real database connection).
 *
 * BR-IDENTITY-001: aliases ativos únicos
 * INV-IDENTITY-003: merged lead → redirect to canonical
 * INV-IDENTITY-007: normalização canônica antes do hash
 */

import { describe, expect, it, vi } from 'vitest';
import { resolveLeadByAliases } from '../../../apps/edge/src/lib/lead-resolver';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const WORKSPACE_ID = 'ws-00000000-0000-0000-0000-000000000001';
const EXISTING_LEAD_ID = 'lead-00000000-0000-0000-0000-000000000002';

// ---------------------------------------------------------------------------
// Helper: thenable where() that also has limit()
// The resolver uses .where() directly (no limit) for alias lookups,
// and .where().limit(1) for lead status lookups.
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
// Tests
// ---------------------------------------------------------------------------

describe('resolveLeadByAliases — 1 match', () => {
  it('returns existing lead_id with was_created=false, merge_executed=false', async () => {
    // Select call sequence:
    // 1. Find active aliases matching input → 1 alias for EXISTING_LEAD_ID
    // 2. resolveCanonical(EXISTING_LEAD_ID) → status=active (not merged)
    // 3. updateExistingLead → existing aliases on canonical → same alias already there
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
                  ? // Active aliases matching input: 1 match
                    [
                      {
                        id: 'alias-001',
                        leadId: EXISTING_LEAD_ID,
                        identifierType: 'email_hash',
                        identifierHash: 'somehash',
                      },
                    ]
                  : idx === 2
                    ? // resolveCanonical: lead status → active
                      [{ status: 'active', mergedIntoLeadId: null }]
                    : // updateExistingLead: existing aliases → alias already present
                      [
                        {
                          identifierType: 'email_hash',
                          identifierHash: 'somehash',
                        },
                      ],
              ),
            ),
          }),
        };
      }),
      update: vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([]),
        }),
      }),
      insert: vi.fn().mockReturnValue({
        values: vi.fn().mockResolvedValue([]),
      }),
    } as unknown as Parameters<typeof resolveLeadByAliases>[2];

    const result = await resolveLeadByAliases(
      { email: 'existing@example.com' },
      WORKSPACE_ID,
      db,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.was_created).toBe(false);
      expect(result.value.merge_executed).toBe(false);
      expect(result.value.merged_lead_ids).toHaveLength(0);
      // lead_id should be the existing lead's canonical ID
      expect(result.value.lead_id).toBe(EXISTING_LEAD_ID);
    }
  });

  it('follows merged_into_lead_id transitively (INV-IDENTITY-003)', async () => {
    // Scenario: alias → lead B (status='merged', merged_into_lead_id = lead A)
    // Resolver must return lead A, not lead B
    const CANONICAL_LEAD_ID = 'lead-canonical-000000000000001';

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
                  ? // Active aliases matching input → lead B
                    [
                      {
                        id: 'alias-B',
                        leadId: 'lead-B',
                        identifierType: 'email_hash',
                        identifierHash: 'hash-of-email',
                      },
                    ]
                  : idx === 2
                    ? // resolveCanonical for lead B → merged into A
                      [
                        {
                          status: 'merged',
                          mergedIntoLeadId: CANONICAL_LEAD_ID,
                        },
                      ]
                    : idx === 3
                      ? // resolveCanonical for canonical A → active
                        [{ status: 'active', mergedIntoLeadId: null }]
                      : // updateExistingLead: existing aliases on canonical (empty → will add)
                        [],
              ),
            ),
          }),
        };
      }),
      update: vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([]),
        }),
      }),
      insert: vi.fn().mockReturnValue({
        values: vi.fn().mockResolvedValue([]),
      }),
    } as unknown as Parameters<typeof resolveLeadByAliases>[2];

    const result = await resolveLeadByAliases(
      { email: 'foo@example.com' },
      WORKSPACE_ID,
      db,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      // INV-IDENTITY-003: resolver redireciona para canonical
      expect(result.value.lead_id).toBe(CANONICAL_LEAD_ID);
      expect(result.value.was_created).toBe(false);
      expect(result.value.merge_executed).toBe(false);
    }
  });
});
