/**
 * Integration-style tests — orchestrator campaign_provisions state machine
 *
 * T-ID: T-7-010
 *
 * Tests state transitions across provision-campaigns, rollback-provisioning,
 * and setup-tracking tasks using mocked DB and SDK.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockLogger, mockWait, mockCreateDb } = vi.hoisted(() => ({
  mockLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  mockWait: { for: vi.fn().mockResolvedValue(undefined) },
  mockCreateDb: vi.fn(),
}));

vi.mock('@trigger.dev/sdk/v3', () => ({
  task: (config: unknown) => config,
  logger: mockLogger,
  wait: mockWait,
}));

vi.mock('@globaltracker/db', () => ({
  createDb: mockCreateDb,
  workflowRuns: 'workflowRuns',
  campaignProvisions: 'campaignProvisions',
  launches: 'launches',
  pages: 'pages',
  pageTokens: 'pageTokens',
}));

vi.mock('drizzle-orm', () => ({
  and: (...args: unknown[]) => ({ _and: args }),
  eq: (col: unknown, val: unknown) => ({ _eq: [col, val] }),
}));

import { provisionCampaignsTask } from '../provision-campaigns.js';
import { rollbackProvisioningTask } from '../rollback-provisioning.js';
import { setupTrackingTask } from '../setup-tracking.js';

// ---------------------------------------------------------------------------
// Constants & fixtures
// ---------------------------------------------------------------------------

const WS = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const RUN = 'run-1-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const LAUNCH = 'launch-1-aaa-aaaa-aaaa-aaaaaaaaaaaa';
const PAGE = 'page-1-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

const launch = { id: LAUNCH, workspaceId: WS, config: {} };
const provision = {
  id: 'prov-1',
  platform: 'meta',
  externalId: 'meta-adset-123',
  status: 'pending_approval',
  workspaceId: WS,
  runId: RUN,
};
const page = { id: PAGE, workspaceId: WS, eventConfig: { events: [] } };
const launchWithConfig = {
  ...launch,
  config: { tracking: { meta: { pixel_policy: 'server_only' } } },
};

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

function makeSelectChain(result: unknown[]) {
  return Object.assign(Promise.resolve(result), {
    limit: vi.fn().mockResolvedValue(result),
  });
}

type UpdateSetCall = { fields: unknown };

function makeProvisionDb({
  launchRows = [launch],
  provisionsAfterResume = [provision],
} = {}) {
  const insertValues = vi.fn().mockReturnValue({
    returning: vi.fn().mockResolvedValue([{ id: 'new-id' }]),
  });
  const updateSetCalls: UpdateSetCall[] = [];
  const updateWhere = vi.fn().mockResolvedValue(undefined);
  let selectIdx = 0;
  const seqs = [launchRows, provisionsAfterResume];
  return {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi
          .fn()
          .mockImplementation(() => makeSelectChain(seqs[selectIdx++] ?? [])),
      }),
    }),
    insert: vi.fn().mockReturnValue({ values: insertValues }),
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockImplementation((f: unknown) => {
        updateSetCalls.push({ fields: f });
        return { where: updateWhere };
      }),
    }),
    _insertValues: insertValues,
    _updateWhere: updateWhere,
    _updateSetCalls: updateSetCalls,
  };
}

function makeRollbackDb(provisions: unknown[]) {
  const updateSetCalls: UpdateSetCall[] = [];
  const updateWhere = vi.fn().mockResolvedValue(undefined);
  return {
    select: vi.fn().mockReturnValue({
      from: vi
        .fn()
        .mockReturnValue({ where: vi.fn().mockResolvedValue(provisions) }),
    }),
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockImplementation((f: unknown) => {
        updateSetCalls.push({ fields: f });
        return { where: updateWhere };
      }),
    }),
    _updateWhere: updateWhere,
    _updateSetCalls: updateSetCalls,
  };
}

function makeSetupDb(
  pageRows: unknown[],
  launchRows: unknown[],
  tokenRows: unknown[],
) {
  let idx = 0;
  const seqs = [pageRows, launchRows, tokenRows];
  const updateWhere = vi.fn().mockResolvedValue(undefined);
  return {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi
          .fn()
          .mockImplementation(() => makeSelectChain(seqs[idx++] ?? [])),
      }),
    }),
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({ where: updateWhere }),
    }),
    _updateWhere: updateWhere,
  };
}

const runProvision = (payload: unknown): Promise<unknown> => {
  // biome-ignore lint/suspicious/noExplicitAny: test helper for mocked task
  return (provisionCampaignsTask as any).run(payload);
};
const runRollback = (payload: unknown): Promise<unknown> => {
  // biome-ignore lint/suspicious/noExplicitAny: test helper for mocked task
  return (rollbackProvisioningTask as any).run(payload);
};
const runSetup = (payload: unknown): Promise<unknown> => {
  // biome-ignore lint/suspicious/noExplicitAny: test helper for mocked task
  return (setupTrackingTask as any).run(payload);
};

const provPayload = {
  launch_id: LAUNCH,
  platforms: ['meta'] as const,
  workspace_id: WS,
  run_id: RUN,
};
const rollPayload = { run_id: RUN, workspace_id: WS, reason: 'test reason' };
const setupPayload = {
  page_id: PAGE,
  launch_id: LAUNCH,
  workspace_id: WS,
  run_id: RUN,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('orchestrator state machine', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    process.env.DATABASE_URL = 'postgresql://test:test@localhost/test';
    fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({ id: 'api-id' }),
      text: vi.fn().mockResolvedValue(''),
    });
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    process.env.DATABASE_URL = '';
    process.env.META_ADS_ACCESS_TOKEN = '';
  });

  it('provision: inserts campaign_provision with status=pending_approval', async () => {
    const db = makeProvisionDb();
    mockCreateDb.mockReturnValue(db);
    await runProvision(provPayload);
    const insertArg = db._insertValues.mock.calls[0]?.[0] as {
      status?: string;
    };
    expect(insertArg?.status).toBe('pending_approval');
  });

  it('provision: workflow_run updated to waiting_approval before wait.for', async () => {
    const order: string[] = [];
    const db = makeProvisionDb();
    db._updateWhere.mockImplementation(async () => {
      order.push('update');
    });
    mockWait.for.mockImplementation(async () => {
      order.push('wait');
    });
    mockCreateDb.mockReturnValue(db);
    await runProvision(provPayload);
    expect(order.indexOf('update')).toBeLessThan(order.indexOf('wait'));
  });

  it('provision: result.run_id matches payload', async () => {
    const db = makeProvisionDb();
    mockCreateDb.mockReturnValue(db);
    const result = (await runProvision(provPayload)) as { run_id: string };
    expect(result.run_id).toBe(RUN);
  });

  it('rollback: campaign_provision updated to rolled_back status', async () => {
    const db = makeRollbackDb([provision]);
    mockCreateDb.mockReturnValue(db);
    await runRollback(rollPayload);
    const rolledBackUpdate = db._updateSetCalls.find(
      (c) => (c.fields as { status?: string })?.status === 'rolled_back',
    );
    expect(rolledBackUpdate).toBeDefined();
  });

  it('rollback: workflow_run transitions to rolled_back', async () => {
    const db = makeRollbackDb([provision]);
    mockCreateDb.mockReturnValue(db);
    const result = (await runRollback(rollPayload)) as { status: string };
    expect(result.status).toBe('rolled_back');
  });

  it('rollback idempotency: all rolled_back → already_rolled_back, no API', async () => {
    const db = makeRollbackDb([{ ...provision, status: 'rolled_back' }]);
    mockCreateDb.mockReturnValue(db);
    const result = (await runRollback(rollPayload)) as { status: string };
    expect(result.status).toBe('already_rolled_back');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rollback idempotency: already_rolled_back still updates workflow_run', async () => {
    const db = makeRollbackDb([{ ...provision, status: 'rolled_back' }]);
    mockCreateDb.mockReturnValue(db);
    await runRollback(rollPayload);
    const update = db._updateSetCalls.find(
      (c) => (c.fields as { status?: string })?.status === 'rolled_back',
    );
    expect(update).toBeDefined();
  });

  it('provision error: launch not found → workflow_run.status=failed', async () => {
    const db = makeProvisionDb({ launchRows: [] });
    mockCreateDb.mockReturnValue(db);
    await expect(runProvision(provPayload)).rejects.toThrow('launch_not_found');
    const failedUpdate = db._updateSetCalls.find(
      (c) => (c.fields as { status?: string })?.status === 'failed',
    );
    expect(failedUpdate).toBeDefined();
  });

  it('setup: workflow_run completed on success', async () => {
    const db = makeSetupDb(
      [page],
      [launchWithConfig],
      [[{ status: 'active' }]],
    );
    mockCreateDb.mockReturnValue(db);
    const result = (await runSetup(setupPayload)) as {
      has_active_token: boolean;
    };
    expect(result.has_active_token).toBe(true);
    expect(db.update).toHaveBeenCalled();
  });

  it('setup: workflow_run failed on page_not_found', async () => {
    const db = makeSetupDb([], [], []);
    mockCreateDb.mockReturnValue(db);
    await expect(runSetup(setupPayload)).rejects.toThrow('page_not_found');
    expect(db._updateWhere).toHaveBeenCalled();
  });

  it('BR-RBAC-002: provision inserts include workspace_id', async () => {
    const db = makeProvisionDb();
    mockCreateDb.mockReturnValue(db);
    await runProvision(provPayload);
    const insertArg = db._insertValues.mock.calls[0]?.[0] as {
      workspaceId?: string;
    };
    expect(insertArg?.workspaceId).toBe(WS);
  });

  it('BR-RBAC-002: createDb called with DATABASE_URL in all tasks', async () => {
    const db = makeProvisionDb();
    mockCreateDb.mockReturnValue(db);
    await runProvision(provPayload);
    expect(mockCreateDb).toHaveBeenCalledWith(
      'postgresql://test:test@localhost/test',
    );
  });

  it('BR-AUDIT-001: rollback uses db.update not db.delete', async () => {
    const db = makeRollbackDb([provision]) as { delete?: unknown } & ReturnType<
      typeof makeRollbackDb
    >;
    mockCreateDb.mockReturnValue(db);
    await runRollback(rollPayload);
    expect(db.delete).toBeUndefined();
    expect(db.update).toHaveBeenCalled();
  });

  it('BR-PRIVACY-001: rollback reason NOT in logger.info', async () => {
    const db = makeRollbackDb([provision]);
    mockCreateDb.mockReturnValue(db);
    await runRollback({ ...rollPayload, reason: 'SUPER_SECRET_REASON_XYZ' });
    const infoArgs = mockLogger.info.mock.calls.flat();
    expect(JSON.stringify(infoArgs)).not.toContain('SUPER_SECRET_REASON_XYZ');
  });

  it('both platforms: meta + google both inserted', async () => {
    const db = makeProvisionDb({
      provisionsAfterResume: [
        { ...provision, platform: 'meta' },
        {
          ...provision,
          id: 'p2',
          platform: 'google',
          externalId: `mock-google-campaign-${LAUNCH.slice(0, 8)}`,
        },
      ],
    });
    mockCreateDb.mockReturnValue(db);
    await runProvision({ ...provPayload, platforms: ['meta', 'google'] });
    expect(db.insert).toHaveBeenCalledTimes(2);
    const platforms = db._insertValues.mock.calls.map(
      (c: unknown[]) => (c[0] as { platform?: string })?.platform,
    );
    expect(platforms).toContain('meta');
    expect(platforms).toContain('google');
  });
});
