/**
 * Unit tests — attribution: first-touch is created once per (lead_id, launch_id)
 *
 * Uses a mock DB (no real database connection).
 *
 * BR-ATTRIBUTION-001: first-touch único por (workspace_id, lead_id, launch_id)
 * BR-ATTRIBUTION-002: last-touch atualizado a cada conversão
 * INV-ATTRIBUTION-001: partial unique indexes enforce uniqueness
 * INV-ATTRIBUTION-006: new launch → new first-touch
 */

import { describe, expect, it, vi } from 'vitest';
import { recordTouches } from '../../../apps/edge/src/lib/attribution';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const WORKSPACE_ID = 'ws-00000000-0000-0000-0000-000000000001';
const LEAD_ID = 'lead-00000000-0000-0000-0000-000000000001';
const LAUNCH_A = 'launch-00000000-0000-0000-0000-aaaaaaaaaaaa';
const LAUNCH_B = 'launch-00000000-0000-0000-0000-bbbbbbbbbbbb';

const ATTRIBUTION_A = {
  utm_source: 'facebook',
  utm_medium: 'paid',
  utm_campaign: 'launch-a-2024',
};

// ---------------------------------------------------------------------------
// Mock DB factory
// ---------------------------------------------------------------------------

function makeDb(opts: { firstCreated?: boolean; lastUpdated?: boolean } = {}) {
  const { firstCreated = true, lastUpdated = true } = opts;

  let insertCallCount = 0;

  const db = {
    insert: vi.fn().mockImplementation(() => {
      insertCallCount++;
      const idx = insertCallCount;

      return {
        values: vi.fn().mockReturnValue({
          onConflictDoNothing: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue(
              // idx=1 is first-touch
              idx === 1 && firstCreated ? [{ id: 'attr-first' }] : [],
            ),
          }),
          onConflictDoUpdate: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue(
              // idx=2 is last-touch
              idx === 2 && lastUpdated
                ? [{ id: 'attr-last', updatedAt: new Date() }]
                : [],
            ),
          }),
          // idx=3 is all-touch (no returning needed)
        }),
      };
    }),
  } as unknown as Parameters<typeof recordTouches>[1];

  return { db, getInsertCallCount: () => insertCallCount };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('recordTouches', () => {
  it('returns invalid_input when required fields missing', async () => {
    const { db } = makeDb();
    const result = await recordTouches(
      {
        lead_id: '',
        launch_id: LAUNCH_A,
        workspace_id: WORKSPACE_ID,
        attribution: ATTRIBUTION_A,
        event_time: new Date(),
      },
      db,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('invalid_input');
    }
  });

  it('returns first_created=true when first-touch is new', async () => {
    const { db } = makeDb({ firstCreated: true, lastUpdated: true });

    const result = await recordTouches(
      {
        lead_id: LEAD_ID,
        launch_id: LAUNCH_A,
        workspace_id: WORKSPACE_ID,
        attribution: ATTRIBUTION_A,
        event_time: new Date('2024-03-01T10:00:00Z'),
      },
      db,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      // BR-ATTRIBUTION-001: first_created=true when new
      expect(result.value.first_created).toBe(true);
      expect(result.value.last_updated).toBe(true);
    }
  });

  it('returns first_created=false when first-touch already exists (conflict → do nothing)', async () => {
    // BR-ATTRIBUTION-001: ON CONFLICT DO NOTHING → 0 rows returned → first_created=false
    const { db } = makeDb({ firstCreated: false, lastUpdated: true });

    const result = await recordTouches(
      {
        lead_id: LEAD_ID,
        launch_id: LAUNCH_A,
        workspace_id: WORKSPACE_ID,
        attribution: { utm_source: 'google', utm_medium: 'cpc' },
        event_time: new Date('2024-03-02T10:00:00Z'),
      },
      db,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      // BR-ATTRIBUTION-001: first-touch unchanged on conflict
      expect(result.value.first_created).toBe(false);
      // BR-ATTRIBUTION-002: last-touch updated
      expect(result.value.last_updated).toBe(true);
    }
  });

  it('creates 3 insert calls (first + last + all)', async () => {
    const { db, getInsertCallCount } = makeDb();

    const result = await recordTouches(
      {
        lead_id: LEAD_ID,
        launch_id: LAUNCH_A,
        workspace_id: WORKSPACE_ID,
        attribution: ATTRIBUTION_A,
        event_time: new Date(),
      },
      db,
    );

    expect(result.ok).toBe(true);
    // 3 inserts: first, last, all
    expect(getInsertCallCount()).toBe(3);
  });

  it('INV-ATTRIBUTION-006: new launch creates independent first-touch', async () => {
    // Lead already has first-touch in LAUNCH_A → LAUNCH_B should create fresh first-touch
    const insertRows: Array<{ touchType: string; launchId: string }> = [];

    const db = {
      insert: vi.fn().mockImplementation(() => ({
        values: vi.fn().mockImplementation((vals: Record<string, unknown>) => {
          insertRows.push({
            touchType: vals.touchType as string,
            launchId: vals.launchId as string,
          });
          return {
            onConflictDoNothing: vi.fn().mockReturnValue({
              returning: vi.fn().mockResolvedValue([{ id: 'new-first' }]),
            }),
            onConflictDoUpdate: vi.fn().mockReturnValue({
              returning: vi
                .fn()
                .mockResolvedValue([{ id: 'new-last', updatedAt: new Date() }]),
            }),
          };
        }),
      })),
    } as unknown as Parameters<typeof recordTouches>[1];

    const result = await recordTouches(
      {
        lead_id: LEAD_ID,
        launch_id: LAUNCH_B, // Different launch
        workspace_id: WORKSPACE_ID,
        attribution: { utm_source: 'google', utm_campaign: 'launch-b' },
        event_time: new Date(),
      },
      db,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      // INV-ATTRIBUTION-006: new launch → first_created=true
      expect(result.value.first_created).toBe(true);
    }
    // Verify first-touch was attempted for LAUNCH_B
    const firstTouchInsert = insertRows.find((r) => r.touchType === 'first');
    expect(firstTouchInsert?.launchId).toBe(LAUNCH_B);
  });
});
