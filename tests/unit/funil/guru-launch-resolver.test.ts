/**
 * Unit tests — apps/edge/src/lib/guru-launch-resolver.ts
 *
 * T-ID: T-FUNIL-020
 *
 * Coverage targets:
 *   - Strategy 1: mapping — productId found in map, launch resolved
 *   - Strategy 1 → fallback: productId found in map but launch not in DB → falls to strategy 2
 *   - Strategy 1 → fallback: productId not in map → falls to strategy 2
 *   - Strategy 2: last_attribution — lead found by email, attribution found
 *   - Strategy 2: last_attribution — lead found by phone hint
 *   - Strategy 2: last_attribution — lead found but no attribution → falls to strategy 3
 *   - Strategy 3: none — no productId, no resolvable lead
 *   - Strategy 3: none — empty leadHints
 *   - safeLog called in all strategies (BR-AUDIT-001)
 *   - No PII emitted to safeLog (BR-PRIVACY-001)
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  resolveLaunchForGuruEvent,
} from '../../../apps/edge/src/lib/guru-launch-resolver.js';

// ---------------------------------------------------------------------------
// Mock safeLog to avoid console output and enable assertion
// ---------------------------------------------------------------------------

vi.mock('../../../apps/edge/src/middleware/sanitize-logs.js', () => ({
  safeLog: vi.fn(),
}));

// Mock pii.ts hashPii — deterministic output in tests
vi.mock('../../../apps/edge/src/lib/pii.js', () => ({
  hashPii: vi.fn(async (value: string, _workspaceId: string) => `hash:${value}`),
}));

// Import after mocking
import { safeLog } from '../../../apps/edge/src/middleware/sanitize-logs.js';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const WORKSPACE_ID = 'ws-uuid-0001';
const LAUNCH_UUID = 'launch-uuid-0001';
const LEAD_UUID = 'lead-uuid-0001';
const PRODUCT_ID = 'prod_workshop_xyz';

const WORKSPACE_CONFIG_WITH_MAP = {
  integrations: {
    guru: {
      product_launch_map: {
        [PRODUCT_ID]: {
          launch_public_id: 'lcm-maio-2026',
          funnel_role: 'workshop',
        },
        prod_main_xyz: {
          launch_public_id: 'lcm-maio-2026',
          funnel_role: 'main_offer',
        },
      },
    },
  },
};

// ---------------------------------------------------------------------------
// DB mock factory
// ---------------------------------------------------------------------------

/**
 * Builds a minimal Drizzle-shaped mock that supports method chaining.
 * Each call to db.select() returns `this` for chaining, with a final
 * `.limit()` that resolves to the provided rows.
 */
function makeMockDb(options: {
  workspaceConfig?: object | null;
  launchRow?: { id: string } | null;
  aliasRow?: { leadId: string } | null;
  attributionRow?: { launchId: string } | null;
}) {
  const callLog: string[] = [];

  function makeChain(finalRows: unknown[]) {
    return {
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      orderBy: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue(finalRows),
    };
  }

  let selectCallCount = 0;

  const db = {
    _callLog: callLog,
    select: vi.fn(() => {
      selectCallCount++;

      // Call order:
      //   1st select → workspaces config
      //   2nd select → launches (by public_id)
      //   3rd+ select → lead_aliases (looped per hash)
      //   last select → lead_attributions

      if (selectCallCount === 1) {
        // workspaces query
        const row =
          options.workspaceConfig !== undefined
            ? [{ config: options.workspaceConfig }]
            : [];
        return makeChain(row);
      }

      if (selectCallCount === 2) {
        // launches query
        const row = options.launchRow ? [options.launchRow] : [];
        return makeChain(row);
      }

      if (selectCallCount >= 3 && options.aliasRow !== undefined) {
        // lead_aliases query (may be called multiple times for multiple hashes)
        const row = options.aliasRow ? [options.aliasRow] : [];
        return makeChain(row);
      }

      // lead_attributions query
      if (options.attributionRow !== undefined) {
        const row = options.attributionRow ? [options.attributionRow] : [];
        return makeChain(row);
      }

      return makeChain([]);
    }),
  };

  return db as unknown as import('@globaltracker/db').Db;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('resolveLaunchForGuruEvent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // Strategy 1: mapping
  // -------------------------------------------------------------------------

  describe('strategy: mapping', () => {
    it('returns launch_id and funnel_role when productId is in the map and launch found in DB', async () => {
      const db = makeMockDb({
        workspaceConfig: WORKSPACE_CONFIG_WITH_MAP,
        launchRow: { id: LAUNCH_UUID },
      });

      const result = await resolveLaunchForGuruEvent({
        workspaceId: WORKSPACE_ID,
        productId: PRODUCT_ID,
        leadHints: {},
        db,
      });

      expect(result.strategy).toBe('mapping');
      expect(result.launch_id).toBe(LAUNCH_UUID);
      expect(result.funnel_role).toBe('workshop');
    });

    it('emits safeLog with strategy=mapping and no PII fields', async () => {
      const db = makeMockDb({
        workspaceConfig: WORKSPACE_CONFIG_WITH_MAP,
        launchRow: { id: LAUNCH_UUID },
      });

      await resolveLaunchForGuruEvent({
        workspaceId: WORKSPACE_ID,
        productId: PRODUCT_ID,
        leadHints: { email: 'user@example.com', phone: '+5511999999999' },
        db,
      });

      expect(safeLog).toHaveBeenCalledOnce();
      const [level, entry] = (safeLog as ReturnType<typeof vi.fn>).mock.calls[0] as [string, Record<string, unknown>];
      expect(level).toBe('info');
      expect(entry.event).toBe('guru_launch_resolved');
      expect(entry.strategy).toBe('mapping');
      // No PII — BR-PRIVACY-001
      expect(entry.email).toBeUndefined();
      expect(entry.phone).toBeUndefined();
    });

    it('falls through to last_attribution when productId in map but launch not found in DB', async () => {
      // First call (workspaces) returns config with map
      // Second call (launches) returns nothing → launch_id not found
      // Third call (lead_aliases) returns alias with lead
      // Fourth call (attributions) returns attribution
      let callCount = 0;
      const mockDb = {
        select: vi.fn(() => {
          callCount++;
          const rows: unknown[] = (() => {
            if (callCount === 1) return [{ config: WORKSPACE_CONFIG_WITH_MAP }];
            if (callCount === 2) return []; // launch not found
            if (callCount === 3) return [{ leadId: LEAD_UUID }];
            return [{ launchId: LAUNCH_UUID }]; // attributions
          })();
          return {
            from: vi.fn().mockReturnThis(),
            where: vi.fn().mockReturnThis(),
            orderBy: vi.fn().mockReturnThis(),
            limit: vi.fn().mockResolvedValue(rows),
          };
        }),
      } as unknown as import('@globaltracker/db').Db;

      const result = await resolveLaunchForGuruEvent({
        workspaceId: WORKSPACE_ID,
        productId: PRODUCT_ID,
        leadHints: { email: 'user@example.com' },
        db: mockDb,
      });

      expect(result.strategy).toBe('last_attribution');
      expect(result.launch_id).toBe(LAUNCH_UUID);
      expect(result.funnel_role).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // Strategy 2: last_attribution
  // -------------------------------------------------------------------------

  describe('strategy: last_attribution', () => {
    it('returns launch_id when productId not in map but lead found by email', async () => {
      // productId not in map → skip strategy 1 (no workspaces query needed if productId absent)
      // Actually productId is provided but not in map — workspaces is still queried
      let callCount = 0;
      const mockDb = {
        select: vi.fn(() => {
          callCount++;
          const rows: unknown[] = (() => {
            if (callCount === 1) return [{ config: { integrations: { guru: { product_launch_map: {} } } } }];
            if (callCount === 2) return [{ leadId: LEAD_UUID }];
            return [{ launchId: LAUNCH_UUID }];
          })();
          return {
            from: vi.fn().mockReturnThis(),
            where: vi.fn().mockReturnThis(),
            orderBy: vi.fn().mockReturnThis(),
            limit: vi.fn().mockResolvedValue(rows),
          };
        }),
      } as unknown as import('@globaltracker/db').Db;

      const result = await resolveLaunchForGuruEvent({
        workspaceId: WORKSPACE_ID,
        productId: 'unknown_product',
        leadHints: { email: 'user@example.com' },
        db: mockDb,
      });

      expect(result.strategy).toBe('last_attribution');
      expect(result.launch_id).toBe(LAUNCH_UUID);
      expect(result.funnel_role).toBeNull();
    });

    it('uses phone hint when email is absent', async () => {
      // productId is null → strategy 1 is skipped entirely
      // call 1 → lead_aliases (phone hash lookup) → returns alias
      // call 2 → lead_attributions → returns attribution
      let callCount = 0;
      const mockDb = {
        select: vi.fn(() => {
          callCount++;
          const rows: unknown[] = (() => {
            if (callCount === 1) return [{ leadId: LEAD_UUID }]; // alias by phone
            return [{ launchId: LAUNCH_UUID }]; // attribution
          })();
          return {
            from: vi.fn().mockReturnThis(),
            where: vi.fn().mockReturnThis(),
            orderBy: vi.fn().mockReturnThis(),
            limit: vi.fn().mockResolvedValue(rows),
          };
        }),
      } as unknown as import('@globaltracker/db').Db;

      const result = await resolveLaunchForGuruEvent({
        workspaceId: WORKSPACE_ID,
        productId: null,
        leadHints: { phone: '+5511999990000' },
        db: mockDb,
      });

      expect(result.strategy).toBe('last_attribution');
      expect(result.launch_id).toBe(LAUNCH_UUID);
    });

    it('uses visitorId hint when email and phone are absent', async () => {
      let callCount = 0;
      const mockDb = {
        select: vi.fn(() => {
          callCount++;
          const rows: unknown[] = (() => {
            if (callCount === 1) return [{ leadId: LEAD_UUID }]; // alias by visitorId
            return [{ launchId: LAUNCH_UUID }]; // attribution
          })();
          return {
            from: vi.fn().mockReturnThis(),
            where: vi.fn().mockReturnThis(),
            orderBy: vi.fn().mockReturnThis(),
            limit: vi.fn().mockResolvedValue(rows),
          };
        }),
      } as unknown as import('@globaltracker/db').Db;

      const result = await resolveLaunchForGuruEvent({
        workspaceId: WORKSPACE_ID,
        productId: undefined,
        leadHints: { visitorId: 'visitor-abc-123' },
        db: mockDb,
      });

      expect(result.strategy).toBe('last_attribution');
      expect(result.launch_id).toBe(LAUNCH_UUID);
    });

    it('falls to strategy=none when lead found but has no attribution', async () => {
      let callCount = 0;
      const mockDb = {
        select: vi.fn(() => {
          callCount++;
          const rows: unknown[] = (() => {
            if (callCount === 1) return [{ leadId: LEAD_UUID }]; // alias by email
            return []; // no attributions
          })();
          return {
            from: vi.fn().mockReturnThis(),
            where: vi.fn().mockReturnThis(),
            orderBy: vi.fn().mockReturnThis(),
            limit: vi.fn().mockResolvedValue(rows),
          };
        }),
      } as unknown as import('@globaltracker/db').Db;

      const result = await resolveLaunchForGuruEvent({
        workspaceId: WORKSPACE_ID,
        productId: null,
        leadHints: { email: 'no-attribution@example.com' },
        db: mockDb,
      });

      expect(result.strategy).toBe('none');
      expect(result.launch_id).toBeNull();
    });

    it('emits safeLog with strategy=last_attribution and no PII', async () => {
      let callCount = 0;
      const mockDb = {
        select: vi.fn(() => {
          callCount++;
          const rows: unknown[] = (() => {
            if (callCount === 1) return [{ leadId: LEAD_UUID }];
            return [{ launchId: LAUNCH_UUID }];
          })();
          return {
            from: vi.fn().mockReturnThis(),
            where: vi.fn().mockReturnThis(),
            orderBy: vi.fn().mockReturnThis(),
            limit: vi.fn().mockResolvedValue(rows),
          };
        }),
      } as unknown as import('@globaltracker/db').Db;

      await resolveLaunchForGuruEvent({
        workspaceId: WORKSPACE_ID,
        productId: undefined,
        leadHints: { email: 'user@example.com' },
        db: mockDb,
      });

      expect(safeLog).toHaveBeenCalledOnce();
      const [, entry] = (safeLog as ReturnType<typeof vi.fn>).mock.calls[0] as [string, Record<string, unknown>];
      expect(entry.strategy).toBe('last_attribution');
      expect(entry.email).toBeUndefined();
      expect(entry.phone).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // Strategy 3: none
  // -------------------------------------------------------------------------

  describe('strategy: none', () => {
    it('returns none when productId is null and leadHints is empty', async () => {
      const mockDb = {
        select: vi.fn().mockReturnThis(),
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        orderBy: vi.fn().mockReturnThis(),
        limit: vi.fn().mockResolvedValue([]),
      } as unknown as import('@globaltracker/db').Db;

      const result = await resolveLaunchForGuruEvent({
        workspaceId: WORKSPACE_ID,
        productId: null,
        leadHints: {},
        db: mockDb,
      });

      expect(result.strategy).toBe('none');
      expect(result.launch_id).toBeNull();
      expect(result.funnel_role).toBeNull();
    });

    it('returns none when productId is undefined and all hints are null', async () => {
      const mockDb = {
        select: vi.fn().mockReturnThis(),
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        orderBy: vi.fn().mockReturnThis(),
        limit: vi.fn().mockResolvedValue([]),
      } as unknown as import('@globaltracker/db').Db;

      const result = await resolveLaunchForGuruEvent({
        workspaceId: WORKSPACE_ID,
        productId: undefined,
        leadHints: { email: null, phone: null, visitorId: null },
        db: mockDb,
      });

      expect(result.strategy).toBe('none');
      expect(result.launch_id).toBeNull();
    });

    it('emits safeLog with strategy=none and no PII', async () => {
      const mockDb = {
        select: vi.fn().mockReturnThis(),
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        orderBy: vi.fn().mockReturnThis(),
        limit: vi.fn().mockResolvedValue([]),
      } as unknown as import('@globaltracker/db').Db;

      await resolveLaunchForGuruEvent({
        workspaceId: WORKSPACE_ID,
        productId: null,
        leadHints: {},
        db: mockDb,
      });

      expect(safeLog).toHaveBeenCalledOnce();
      const [level, entry] = (safeLog as ReturnType<typeof vi.fn>).mock.calls[0] as [string, Record<string, unknown>];
      expect(level).toBe('info');
      expect(entry.event).toBe('guru_launch_resolved');
      expect(entry.strategy).toBe('none');
      expect(entry.launch_id).toBeNull();
      // No PII — BR-PRIVACY-001
      expect(entry.email).toBeUndefined();
      expect(entry.phone).toBeUndefined();
    });

    it('returns none when no lead found by any hint', async () => {
      let callCount = 0;
      const mockDb = {
        select: vi.fn(() => {
          callCount++;
          return {
            from: vi.fn().mockReturnThis(),
            where: vi.fn().mockReturnThis(),
            orderBy: vi.fn().mockReturnThis(),
            limit: vi.fn().mockResolvedValue([]), // no rows for aliases
          };
        }),
      } as unknown as import('@globaltracker/db').Db;

      const result = await resolveLaunchForGuruEvent({
        workspaceId: WORKSPACE_ID,
        productId: null,
        leadHints: { email: 'unknown@example.com' },
        db: mockDb,
      });

      expect(result.strategy).toBe('none');
      expect(result.launch_id).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // BR-AUDIT-001 — safeLog always called regardless of strategy
  // -------------------------------------------------------------------------

  describe('BR-AUDIT-001: safeLog always called', () => {
    it('calls safeLog exactly once per invocation (mapping)', async () => {
      const db = makeMockDb({
        workspaceConfig: WORKSPACE_CONFIG_WITH_MAP,
        launchRow: { id: LAUNCH_UUID },
      });

      await resolveLaunchForGuruEvent({
        workspaceId: WORKSPACE_ID,
        productId: PRODUCT_ID,
        leadHints: {},
        db,
      });

      expect(safeLog).toHaveBeenCalledOnce();
    });

    it('calls safeLog exactly once per invocation (none)', async () => {
      const mockDb = {
        select: vi.fn().mockReturnThis(),
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        orderBy: vi.fn().mockReturnThis(),
        limit: vi.fn().mockResolvedValue([]),
      } as unknown as import('@globaltracker/db').Db;

      await resolveLaunchForGuruEvent({
        workspaceId: WORKSPACE_ID,
        productId: null,
        leadHints: {},
        db: mockDb,
      });

      expect(safeLog).toHaveBeenCalledOnce();
    });
  });
});
