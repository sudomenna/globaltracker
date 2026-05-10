/**
 * Unit tests — transaction-aggregator.ts
 *
 * BR-DISPATCH-007: Purchase events with same transaction_group_id represent
 * the same commercial transaction; dispatchers must consolidate `value` to
 * avoid fragmenting ROAS in platform bidding algorithms.
 * BR-PRIVACY-001: no PII in any log line (verified by absence of email/phone
 * in helper calls — not tested here, only aggregation logic).
 *
 * Scenarios:
 *   TC-AGG-01: group with 3 events → returns correct sum
 *   TC-AGG-02: transactionGroupId null → returns currentEventAmount without DB query
 *   TC-AGG-03: group with 1 event (no OBs) → isAggregated=false
 *   TC-AGG-04: DB failure → degrades gracefully to currentEventAmount
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { aggregatePurchaseValueByGroup } from '../../../apps/edge/src/lib/transaction-aggregator.js';

// ---------------------------------------------------------------------------
// Mock DB factory
//
// Drizzle query chain used by aggregatePurchaseValueByGroup:
//   db.select({ total, count }).from(events).where(and(...))
// We return a chainable object that resolves with the given rows.
// ---------------------------------------------------------------------------

function createMockDb(opts: {
  rows?: Array<{ total: string; count: string }>;
  shouldThrow?: boolean;
}) {
  const selectMock = vi.fn();

  const chainResult = opts.shouldThrow
    ? Promise.reject(new Error('DB connection refused'))
    : Promise.resolve(opts.rows ?? []);

  // Drizzle chain: .select().from().where() → Promise
  const whereMock = vi.fn(() => chainResult);
  const fromMock = vi.fn(() => ({ where: whereMock }));
  selectMock.mockReturnValue({ from: fromMock });

  const db = { select: selectMock } as unknown as Parameters<
    typeof aggregatePurchaseValueByGroup
  >[0]['db'];

  return { db, selectMock, fromMock, whereMock };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('aggregatePurchaseValueByGroup', () => {
  const WORKSPACE_ID = 'ws-agg-test-0000-0000-000000000001';
  const GROUP_ID = 'abcdef1234567890abcdef1234567890';

  beforeEach(() => {
    vi.clearAllMocks();
  });

  // --------------------------------------------------------------------------
  // TC-AGG-01
  // --------------------------------------------------------------------------

  describe('TC-AGG-01: group with 3 events → returns correct sum', () => {
    it(
      'BR-DISPATCH-007: aggregatedAmount = sum of all Purchase events in group,' +
        ' eventCount=3, isAggregated=true',
      async () => {
        const { db } = createMockDb({
          rows: [{ total: '597', count: '3' }],
        });

        const result = await aggregatePurchaseValueByGroup({
          db,
          workspaceId: WORKSPACE_ID,
          transactionGroupId: GROUP_ID,
          currentEventAmount: 297,
        });

        expect(result.aggregatedAmount).toBe(597);
        expect(result.eventCount).toBe(3);
        expect(result.isAggregated).toBe(true);
      },
    );
  });

  // --------------------------------------------------------------------------
  // TC-AGG-02
  // --------------------------------------------------------------------------

  describe('TC-AGG-02: transactionGroupId null → returns currentEventAmount, no DB query', () => {
    it(
      'when transactionGroupId is null the helper returns currentEventAmount' +
        ' without hitting the DB (isAggregated=false)',
      async () => {
        const { db, selectMock } = createMockDb({ rows: [] });

        const result = await aggregatePurchaseValueByGroup({
          db,
          workspaceId: WORKSPACE_ID,
          transactionGroupId: null,
          currentEventAmount: 297,
        });

        expect(result.aggregatedAmount).toBe(297);
        expect(result.isAggregated).toBe(false);
        // DB must NOT have been queried
        expect(selectMock).not.toHaveBeenCalled();
      },
    );

    it('transactionGroupId undefined also short-circuits without DB query', async () => {
      const { db, selectMock } = createMockDb({ rows: [] });

      const result = await aggregatePurchaseValueByGroup({
        db,
        workspaceId: WORKSPACE_ID,
        transactionGroupId: undefined,
        currentEventAmount: 150,
      });

      expect(result.aggregatedAmount).toBe(150);
      expect(result.isAggregated).toBe(false);
      expect(selectMock).not.toHaveBeenCalled();
    });
  });

  // --------------------------------------------------------------------------
  // TC-AGG-03
  // --------------------------------------------------------------------------

  describe('TC-AGG-03: group with 1 event (no order bumps) → isAggregated=false', () => {
    it('single-event group: returns amount from DB row, eventCount=1, isAggregated=false', async () => {
      const { db } = createMockDb({
        rows: [{ total: '297', count: '1' }],
      });

      const result = await aggregatePurchaseValueByGroup({
        db,
        workspaceId: WORKSPACE_ID,
        transactionGroupId: GROUP_ID,
        currentEventAmount: 297,
      });

      expect(result.aggregatedAmount).toBe(297);
      expect(result.eventCount).toBe(1);
      expect(result.isAggregated).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // TC-AGG-04
  // --------------------------------------------------------------------------

  describe('TC-AGG-04: DB failure → degrades gracefully, never throws', () => {
    it(
      'when DB select throws, returns currentEventAmount and isAggregated=false' +
        ' without propagating the error',
      async () => {
        const { db } = createMockDb({ shouldThrow: true });

        // Must NOT throw
        const result = await aggregatePurchaseValueByGroup({
          db,
          workspaceId: WORKSPACE_ID,
          transactionGroupId: GROUP_ID,
          currentEventAmount: 199,
        });

        expect(result.aggregatedAmount).toBe(199);
        expect(result.eventCount).toBe(1);
        expect(result.isAggregated).toBe(false);
      },
    );
  });

  // --------------------------------------------------------------------------
  // Edge case: DB returns empty rows (defensive branch)
  // --------------------------------------------------------------------------

  describe('edge case: DB returns 0 rows → falls back to currentEventAmount', () => {
    it('count=0 branch returns currentEventAmount, isAggregated=false', async () => {
      const { db } = createMockDb({ rows: [{ total: '0', count: '0' }] });

      const result = await aggregatePurchaseValueByGroup({
        db,
        workspaceId: WORKSPACE_ID,
        transactionGroupId: GROUP_ID,
        currentEventAmount: 99,
      });

      expect(result.aggregatedAmount).toBe(99);
      expect(result.isAggregated).toBe(false);
    });
  });
});
