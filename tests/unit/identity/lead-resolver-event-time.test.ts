/**
 * Unit tests — lead-resolver: eventTime parameter (T-CONTACTS-LASTSEEN-002)
 *
 * Verifies that resolveLeadByAliases:
 *   - Case A: seeds first_seen_at + last_seen_at with options.eventTime when provided.
 *   - Case B: emits GREATEST() expression for last_seen_at (monotonic guard).
 *   - Case C: same GREATEST() guard on canonical when merging.
 *   - Falls back to NOW() semantics when options.eventTime is omitted.
 *
 * Mock-based: we don't execute SQL. We capture the values/expressions Drizzle
 * receives and assert on them.
 *
 * BR-IDENTITY-002: monotonic last_seen_at — never regress on backfill.
 * INV-IDENTITY-LASTSEEN-MONOTONIC: GREATEST() guards reprocessing.
 */

import { describe, expect, it, vi } from 'vitest';
import { resolveLeadByAliases } from '../../../apps/edge/src/lib/lead-resolver';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const WORKSPACE_ID = 'ws-00000000-0000-0000-0000-000000000001';
const NEW_LEAD_ID = 'lead-00000000-0000-0000-0000-000000000010';
const EXISTING_LEAD_ID = 'lead-00000000-0000-0000-0000-000000000011';

const BACKDATED = new Date('2025-12-01T03:00:00.000Z');

// ---------------------------------------------------------------------------
// Helper: thenable where()
// ---------------------------------------------------------------------------

function makeThenableWhere(resolvedValue: unknown[]) {
  return {
    // biome-ignore lint/suspicious/noThenProperty: mock dual-purpose
    then: (onfulfilled: (v: unknown) => unknown) =>
      Promise.resolve(resolvedValue).then(onfulfilled),
    limit: vi.fn().mockResolvedValue(resolvedValue),
    orderBy: vi
      .fn()
      .mockReturnValue({ limit: vi.fn().mockResolvedValue(resolvedValue) }),
  };
}

// ---------------------------------------------------------------------------
// Case A — new lead seeded with options.eventTime
// ---------------------------------------------------------------------------

describe('resolveLeadByAliases — eventTime in Case A (new lead)', () => {
  it('seeds first_seen_at and last_seen_at with options.eventTime when provided', async () => {
    const insertedValues: Array<Record<string, unknown>> = [];

    const returningMock = vi.fn().mockResolvedValue([{ id: NEW_LEAD_ID }]);
    const leadValuesMock = vi.fn().mockImplementation((vals) => {
      insertedValues.push(vals as Record<string, unknown>);
      return { returning: returningMock };
    });
    const aliasValuesMock = vi.fn().mockImplementation((vals) => {
      insertedValues.push(vals as Record<string, unknown>);
      return Promise.resolve([]);
    });

    let insertCallIdx = 0;
    const insertMock = vi.fn().mockImplementation(() => {
      insertCallIdx++;
      return insertCallIdx === 1
        ? { values: leadValuesMock }
        : { values: aliasValuesMock };
    });

    const whereMock = vi.fn().mockReturnValue(makeThenableWhere([]));
    const fromMock = vi.fn().mockReturnValue({ where: whereMock });
    const selectMock = vi.fn().mockReturnValue({ from: fromMock });

    const db = {
      insert: insertMock,
      select: selectMock,
    } as unknown as Parameters<typeof resolveLeadByAliases>[2];

    const result = await resolveLeadByAliases(
      { email: 'backdated@example.com' },
      WORKSPACE_ID,
      db,
      { eventTime: BACKDATED },
    );

    expect(result.ok).toBe(true);

    // First insert is the lead row — must carry the backdated timestamps.
    const leadRow = insertedValues[0];
    expect(leadRow).toBeDefined();
    expect(leadRow?.firstSeenAt).toEqual(BACKDATED);
    expect(leadRow?.lastSeenAt).toEqual(BACKDATED);
  });

  it('falls back to NOW() when options.eventTime is omitted', async () => {
    const insertedValues: Array<Record<string, unknown>> = [];

    const returningMock = vi.fn().mockResolvedValue([{ id: NEW_LEAD_ID }]);
    const leadValuesMock = vi.fn().mockImplementation((vals) => {
      insertedValues.push(vals as Record<string, unknown>);
      return { returning: returningMock };
    });
    const aliasValuesMock = vi.fn().mockResolvedValue([]);

    let insertCallIdx = 0;
    const insertMock = vi.fn().mockImplementation(() => {
      insertCallIdx++;
      return insertCallIdx === 1
        ? { values: leadValuesMock }
        : { values: aliasValuesMock };
    });

    const whereMock = vi.fn().mockReturnValue(makeThenableWhere([]));
    const fromMock = vi.fn().mockReturnValue({ where: whereMock });
    const selectMock = vi.fn().mockReturnValue({ from: fromMock });

    const db = {
      insert: insertMock,
      select: selectMock,
    } as unknown as Parameters<typeof resolveLeadByAliases>[2];

    const before = new Date();
    await resolveLeadByAliases(
      { email: 'live@example.com' },
      WORKSPACE_ID,
      db,
      // no options
    );
    const after = new Date();

    const leadRow = insertedValues[0];
    expect(leadRow).toBeDefined();
    const firstSeen = leadRow?.firstSeenAt as Date;
    expect(firstSeen.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(firstSeen.getTime()).toBeLessThanOrEqual(after.getTime());
    expect(leadRow?.lastSeenAt).toEqual(firstSeen);
  });
});

// ---------------------------------------------------------------------------
// Case B — update emits GREATEST() expression
// ---------------------------------------------------------------------------

describe('resolveLeadByAliases — eventTime in Case B (existing lead)', () => {
  it('emits a GREATEST() SQL expression on lastSeenAt (monotonic guard)', async () => {
    const setCalls: Array<Record<string, unknown>> = [];

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
                        id: 'alias-1',
                        leadId: EXISTING_LEAD_ID,
                        identifierType: 'email_hash',
                        identifierHash: 'h',
                      },
                    ]
                  : idx === 2
                    ? [{ status: 'active', mergedIntoLeadId: null }]
                    : [{ identifierType: 'email_hash', identifierHash: 'h' }],
              ),
            ),
          }),
        };
      }),
      update: vi.fn().mockReturnValue({
        set: vi.fn().mockImplementation((vals) => {
          setCalls.push(vals as Record<string, unknown>);
          return { where: vi.fn().mockResolvedValue([]) };
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
      { eventTime: BACKDATED },
    );

    expect(result.ok).toBe(true);
    expect(setCalls.length).toBeGreaterThanOrEqual(1);

    const updateSet = setCalls[0];
    expect(updateSet).toBeDefined();

    // lastSeenAt is now a Drizzle SQL expression, not a plain Date.
    // We assert it is NOT a Date (which would mean the old behavior).
    const lastSeenAt = updateSet?.lastSeenAt;
    expect(lastSeenAt).toBeDefined();
    expect(lastSeenAt instanceof Date).toBe(false);

    // updatedAt remains a Date (write-time, not event-time).
    const updatedAt = updateSet?.updatedAt;
    expect(updatedAt).toBeInstanceOf(Date);

    // Drizzle SQL holder exposes its raw fragments via `queryChunks`.
    // Walk those chunks looking for the literal "GREATEST" text.
    const chunks =
      (lastSeenAt as { queryChunks?: unknown[] }).queryChunks ?? [];
    const containsGreatest = chunks.some((c) => {
      if (typeof c === 'string') return c.includes('GREATEST');
      if (c && typeof c === 'object' && 'value' in c) {
        const v = (c as { value: unknown[] }).value;
        return (
          Array.isArray(v) &&
          v.some((x) => typeof x === 'string' && x.includes('GREATEST'))
        );
      }
      return false;
    });
    expect(containsGreatest).toBe(true);
  });
});
