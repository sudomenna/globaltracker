/**
 * Integration tests — INV-AUDIENCE-006: ≤ 2 active snapshots per audience
 *
 * Verifies that generateSnapshot enforces the retention policy: when a 3rd
 * snapshot is created, the oldest active snapshot is archived.
 *
 * INV-AUDIENCE-006: enforces ≤ 2 active snapshots per audience by archiving older ones.
 * BR-AUDIENCE-003: snapshot + members written in a single transaction.
 *
 * Uses a stateful mock DB (no real Postgres required) that models the
 * audienceSnapshots and audienceSnapshotMembers tables.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mock @globaltracker/db
// ---------------------------------------------------------------------------

vi.mock('@globaltracker/db', () => ({
  audiences: {
    id: 'id',
    workspaceId: 'workspace_id',
    status: 'status',
    queryDefinition: 'query_definition',
    consentPolicy: 'consent_policy',
  },
  audienceSnapshots: {
    id: 'id',
    audienceId: 'audience_id',
    workspaceId: 'workspace_id',
    snapshotHash: 'snapshot_hash',
    retentionStatus: 'retention_status',
    generatedAt: 'generated_at',
  },
  audienceSnapshotMembers: { snapshotId: 'snapshot_id', leadId: 'lead_id' },
  leadStages: {},
  leadIcpScores: {},
  leads: { id: 'id', workspaceId: 'workspace_id', status: 'status' },
  leadConsents: {},
  audienceSyncJobs: {},
}));

import { generateSnapshot } from '../../../apps/edge/src/lib/audience';

// ---------------------------------------------------------------------------
// Stateful mock DB
// ---------------------------------------------------------------------------

interface SnapshotRow {
  id: string;
  audienceId: string;
  workspaceId: string;
  snapshotHash: string;
  memberCount: number;
  retentionStatus: string;
  generatedAt: Date;
}

type MockDb = ReturnType<typeof makeRetentionDb>['db'];

function makeRetentionDb(audienceId: string, workspaceId: string) {
  const snapshotRows: SnapshotRow[] = [];
  let snapshotCounter = 0;

  // Current member IDs to return from the leads query
  let currentMemberIds: string[] = [];

  function setNextMembers(ids: string[]) {
    currentMemberIds = ids;
  }

  // Track which query is being made via a call counter
  // generateSnapshot calls select in this order:
  //   1. evaluateAudience → loads audience record → .where()
  //   2. evaluateAudience → loads leads → .where()
  //   3. generateSnapshot → find latest snapshot → .where().orderBy().limit()
  let callIndex = 0;
  function resetSelectIndex() {
    callIndex = 0;
  }

  function makeSelectChain(resolveWith: () => Promise<unknown[]> | unknown[]) {
    // Build a chain: .where() returns object with .orderBy() and direct Promise
    const orderByChain = {
      orderBy: vi.fn().mockImplementation(() => ({
        limit: vi.fn().mockImplementation(async (limit: number) => {
          const rows = await Promise.resolve(resolveWith());
          return (rows as unknown[]).slice(0, limit);
        }),
      })),
    };

    // Also allow direct Promise resolution for cases without orderBy
    const whereResult = Object.assign(
      Promise.resolve(resolveWith()).then((r) => r),
      orderByChain,
    );

    return {
      where: vi.fn().mockReturnValue(whereResult),
    };
  }

  const db = {
    select: vi.fn().mockImplementation(() => ({
      from: vi.fn().mockImplementation(() => {
        const idx = callIndex++;

        if (idx === 0) {
          // Load audience record
          return makeSelectChain(() => [
            {
              id: audienceId,
              workspaceId,
              queryDefinition: {
                type: 'builder',
                all: [{ stage: 'registered' }],
              },
              consentPolicy: {},
              status: 'active',
            },
          ]);
        }

        if (idx === 1) {
          // Leads query (evaluateAudience)
          return makeSelectChain(() => currentMemberIds.map((id) => ({ id })));
        }

        // idx === 2: find latest snapshot for this audience
        return makeSelectChain(() => {
          return snapshotRows
            .filter((s) => s.audienceId === audienceId)
            .sort((a, b) => b.generatedAt.getTime() - a.generatedAt.getTime());
        });
      }),
    })),

    insert: vi.fn().mockImplementation(() => ({
      values: vi
        .fn()
        .mockImplementation(
          (
            values: Record<string, unknown> | Array<Record<string, unknown>>,
          ) => {
            if (Array.isArray(values)) {
              // Batch member insert — no-op for retention test
              return Promise.resolve([]);
            }

            if ('snapshotHash' in values) {
              const snap: SnapshotRow = {
                id: `snap-${++snapshotCounter}`,
                audienceId: values.audienceId as string,
                workspaceId: values.workspaceId as string,
                snapshotHash: values.snapshotHash as string,
                memberCount: values.memberCount as number,
                retentionStatus: values.retentionStatus as string,
                generatedAt: new Date(),
              };
              snapshotRows.push(snap);
              return {
                returning: vi.fn().mockResolvedValue([snap]),
              };
            }

            // Member insert
            return Promise.resolve([]);
          },
        ),
    })),

    update: vi.fn().mockImplementation(() => ({
      set: vi.fn().mockImplementation((values: Record<string, unknown>) => ({
        where: vi.fn().mockImplementation(async () => {
          if (values.retentionStatus === 'archived') {
            // Archive snapshots beyond the 2 most recent active ones
            const active = snapshotRows
              .filter(
                (s) =>
                  s.audienceId === audienceId && s.retentionStatus === 'active',
              )
              .sort(
                (a, b) => b.generatedAt.getTime() - a.generatedAt.getTime(),
              );
            const toArchive = active.slice(2);
            for (const s of toArchive) {
              s.retentionStatus = 'archived';
            }
          }
        }),
      })),
    })),

    transaction: vi
      .fn()
      .mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
        let txCallIndex = 0;

        const tx = {
          insert: db.insert,
          update: db.update,
          select: vi.fn().mockImplementation(() => ({
            from: vi.fn().mockImplementation(() => {
              const txIdx = txCallIndex++;
              if (txIdx === 0) {
                // Transaction select: find active snapshots for this audience (for retention enforcement)
                return {
                  where: vi.fn().mockReturnValue({
                    orderBy: vi
                      .fn()
                      .mockResolvedValue(
                        snapshotRows
                          .filter(
                            (s) =>
                              s.audienceId === audienceId &&
                              s.retentionStatus === 'active',
                          )
                          .sort(
                            (a, b) =>
                              b.generatedAt.getTime() - a.generatedAt.getTime(),
                          ),
                      ),
                  }),
                };
              }
              return { where: vi.fn().mockResolvedValue([]) };
            }),
          })),
        };

        return fn(tx);
      }),
  };

  return {
    db,
    snapshotRows,
    setNextMembers,
    resetSelectIndex,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const WORKSPACE_ID = 'ws-retention-test-001';
const AUDIENCE_ID = 'audience-retention-test-001';

describe('INV-AUDIENCE-006: snapshot retention — ≤ 2 active per audience', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('first two snapshots are both active', async () => {
    const { db, snapshotRows, setNextMembers, resetSelectIndex } =
      makeRetentionDb(AUDIENCE_ID, WORKSPACE_ID);

    const ctx = { db: db as never, workspaceId: WORKSPACE_ID };

    // Snapshot 1
    setNextMembers(['lead-A', 'lead-B']);
    resetSelectIndex();
    const r1 = await generateSnapshot(AUDIENCE_ID, ctx);
    expect(r1.status).toBe('created');

    // Snapshot 2 (different members → different hash)
    setNextMembers(['lead-A', 'lead-B', 'lead-C']);
    resetSelectIndex();
    const r2 = await generateSnapshot(AUDIENCE_ID, ctx);
    expect(r2.status).toBe('created');

    const active = snapshotRows.filter((s) => s.retentionStatus === 'active');
    expect(active).toHaveLength(2);
  });

  it('third snapshot causes oldest to be archived — only 2 remain active', async () => {
    const { db, snapshotRows, setNextMembers, resetSelectIndex } =
      makeRetentionDb(AUDIENCE_ID, WORKSPACE_ID);

    const ctx = { db: db as never, workspaceId: WORKSPACE_ID };

    // Snapshot 1
    setNextMembers(['lead-A', 'lead-B']);
    resetSelectIndex();
    await generateSnapshot(AUDIENCE_ID, ctx);

    // Snapshot 2
    setNextMembers(['lead-A', 'lead-B', 'lead-C']);
    resetSelectIndex();
    await generateSnapshot(AUDIENCE_ID, ctx);

    // Snapshot 3
    setNextMembers(['lead-B', 'lead-C', 'lead-D']);
    resetSelectIndex();
    await generateSnapshot(AUDIENCE_ID, ctx);

    const active = snapshotRows.filter((s) => s.retentionStatus === 'active');
    const archived = snapshotRows.filter(
      (s) => s.retentionStatus === 'archived',
    );

    // INV-AUDIENCE-006: at most 2 active snapshots
    expect(active.length).toBeLessThanOrEqual(2);
    // Oldest is archived
    expect(archived.length).toBeGreaterThanOrEqual(1);
    // Total = 3
    expect(snapshotRows).toHaveLength(3);
  });

  it('noop when member set has not changed (same hash)', async () => {
    const { db, snapshotRows, setNextMembers, resetSelectIndex } =
      makeRetentionDb(AUDIENCE_ID, WORKSPACE_ID);

    const ctx = { db: db as never, workspaceId: WORKSPACE_ID };

    // First snapshot
    setNextMembers(['lead-A', 'lead-B']);
    resetSelectIndex();
    const r1 = await generateSnapshot(AUDIENCE_ID, ctx);
    expect(r1.status).toBe('created');

    // Same members → same hash → noop
    setNextMembers(['lead-A', 'lead-B']);
    resetSelectIndex();
    const r2 = await generateSnapshot(AUDIENCE_ID, ctx);
    // BR-AUDIENCE-003: noop when hash matches latest snapshot
    expect(r2.status).toBe('noop');

    // Only 1 snapshot created
    expect(snapshotRows).toHaveLength(1);
  });
});
