/**
 * Unit tests — attribution: last-touch is updated on each conversion
 *
 * Uses a mock DB (no real database connection).
 *
 * BR-ATTRIBUTION-002: last-touch atualizado a cada conversão
 * INV-ATTRIBUTION-005: first = first event; last = last conversion event
 */

import { describe, expect, it, vi } from 'vitest';
import { recordTouches } from '../../../apps/edge/src/lib/attribution';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const WORKSPACE_ID = 'ws-00000000-0000-0000-0000-000000000001';
const LEAD_ID = 'lead-00000000-0000-0000-0000-000000000001';
const LAUNCH_ID = 'launch-00000000-0000-0000-0000-000000000001';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('last-touch update behavior', () => {
  it('sets last_updated=true when last-touch upsert succeeds', async () => {
    let insertCount = 0;
    const db = {
      insert: vi.fn().mockImplementation(() => {
        insertCount++;
        const idx = insertCount;
        return {
          values: vi.fn().mockReturnValue({
            onConflictDoNothing: vi.fn().mockReturnValue({
              returning: vi.fn().mockResolvedValue(idx === 1 ? [] : []),
            }),
            onConflictDoUpdate: vi.fn().mockReturnValue({
              returning: vi
                .fn()
                .mockResolvedValue(
                  idx === 2
                    ? [{ id: 'last-touch-id', updatedAt: new Date() }]
                    : [],
                ),
            }),
          }),
        };
      }),
    } as unknown as Parameters<typeof recordTouches>[1];

    const result = await recordTouches(
      {
        lead_id: LEAD_ID,
        launch_id: LAUNCH_ID,
        workspace_id: WORKSPACE_ID,
        attribution: {
          utm_source: 'google',
          utm_medium: 'cpc',
          utm_campaign: 'retargeting',
        },
        event_time: new Date('2024-04-01T12:00:00Z'),
      },
      db,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      // BR-ATTRIBUTION-002: last-touch updated
      expect(result.value.last_updated).toBe(true);
    }
  });

  it('INV-ATTRIBUTION-005: event_time passed to ts column for ordering', async () => {
    const capturedValues: Array<Record<string, unknown>> = [];

    const db = {
      insert: vi.fn().mockImplementation(() => ({
        values: vi.fn().mockImplementation((vals: Record<string, unknown>) => {
          capturedValues.push(vals);
          return {
            onConflictDoNothing: vi.fn().mockReturnValue({
              returning: vi.fn().mockResolvedValue([{ id: 'first' }]),
            }),
            onConflictDoUpdate: vi.fn().mockReturnValue({
              returning: vi
                .fn()
                .mockResolvedValue([{ id: 'last', updatedAt: new Date() }]),
            }),
          };
        }),
      })),
    } as unknown as Parameters<typeof recordTouches>[1];

    const eventTime = new Date('2024-05-15T08:30:00Z');

    await recordTouches(
      {
        lead_id: LEAD_ID,
        launch_id: LAUNCH_ID,
        workspace_id: WORKSPACE_ID,
        attribution: { utm_source: 'email', utm_campaign: 'newsletter' },
        event_time: eventTime,
      },
      db,
    );

    // INV-ATTRIBUTION-005: ts column should carry event_time (not now())
    // All 3 inserts (first, last, all) should use the event_time
    expect(capturedValues).toHaveLength(3);
    for (const vals of capturedValues) {
      expect(vals.ts).toBe(eventTime);
    }
  });

  it('all-touch is always inserted regardless of first/last conflict', async () => {
    const touchTypes: string[] = [];

    const db = {
      insert: vi.fn().mockImplementation(() => ({
        values: vi.fn().mockImplementation((vals: Record<string, unknown>) => {
          touchTypes.push(vals.touchType as string);
          return {
            onConflictDoNothing: vi.fn().mockReturnValue({
              returning: vi.fn().mockResolvedValue([]),
            }),
            onConflictDoUpdate: vi.fn().mockReturnValue({
              returning: vi.fn().mockResolvedValue([]),
            }),
          };
        }),
      })),
    } as unknown as Parameters<typeof recordTouches>[1];

    await recordTouches(
      {
        lead_id: LEAD_ID,
        launch_id: LAUNCH_ID,
        workspace_id: WORKSPACE_ID,
        attribution: { utm_source: 'organic' },
        event_time: new Date(),
      },
      db,
    );

    // Must create first, last, AND all
    expect(touchTypes).toContain('first');
    expect(touchTypes).toContain('last');
    expect(touchTypes).toContain('all');
  });

  it('attribution params are passed to the insert values', async () => {
    const capturedValues: Array<Record<string, unknown>> = [];

    const db = {
      insert: vi.fn().mockImplementation(() => ({
        values: vi.fn().mockImplementation((vals: Record<string, unknown>) => {
          capturedValues.push(vals);
          return {
            onConflictDoNothing: vi.fn().mockReturnValue({
              returning: vi.fn().mockResolvedValue([{ id: 'f' }]),
            }),
            onConflictDoUpdate: vi.fn().mockReturnValue({
              returning: vi
                .fn()
                .mockResolvedValue([{ id: 'l', updatedAt: new Date() }]),
            }),
          };
        }),
      })),
    } as unknown as Parameters<typeof recordTouches>[1];

    const fbclid = 'AbCdEfGh12345';

    await recordTouches(
      {
        lead_id: LEAD_ID,
        launch_id: LAUNCH_ID,
        workspace_id: WORKSPACE_ID,
        attribution: {
          utm_source: 'facebook',
          utm_medium: 'paid',
          fbclid,
          fbc: '_fb.1.123456.AbCdEfGh12345',
        },
        event_time: new Date(),
      },
      db,
    );

    // Check that fbclid was passed through to the insert
    const firstInsert = capturedValues[0];
    expect(firstInsert?.fbclid).toBe(fbclid);
  });
});
