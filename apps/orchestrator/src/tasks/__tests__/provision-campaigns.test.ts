/**
 * Unit tests — provision-campaigns Trigger.dev task
 *
 * T-ID: T-7-010
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
}));

vi.mock('drizzle-orm', () => ({
  and: (...args: unknown[]) => ({ _and: args }),
  eq: (col: unknown, val: unknown) => ({ _eq: [col, val] }),
}));

import { provisionCampaignsTask } from '../provision-campaigns.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const WS = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const RUN = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const LAUNCH = 'cccccccc-cccc-cccc-cccc-cccccccccccc';

const baseLaunch = { id: LAUNCH, workspaceId: WS, config: {} };

const baseProvision = {
  id: 'prov-1',
  platform: 'meta',
  externalId: 'meta-adset-999',
  status: 'pending_approval',
  workspaceId: WS,
  runId: RUN,
};

function makeDb({
  launchRows = [baseLaunch],
  provisionsAfterResume = [baseProvision],
}: { launchRows?: unknown[]; provisionsAfterResume?: unknown[] } = {}) {
  const insertReturning = vi.fn().mockResolvedValue([{ id: 'new-prov-id' }]);
  const insertValues = vi.fn().mockReturnValue({ returning: insertReturning });
  const updateWhere = vi.fn().mockResolvedValue(undefined);
  const updateSetCalls: Array<{ fields: unknown }> = [];

  let selectIdx = 0;
  const sequences = [launchRows, provisionsAfterResume];

  return {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockImplementation(() => {
          const result = sequences[selectIdx++] ?? [];
          return Object.assign(Promise.resolve(result), {
            limit: vi.fn().mockResolvedValue(result),
          });
        }),
      }),
    }),
    insert: vi.fn().mockReturnValue({ values: insertValues }),
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockImplementation((fields: unknown) => {
        updateSetCalls.push({ fields });
        return { where: updateWhere };
      }),
    }),
    _insertValues: insertValues,
    _updateWhere: updateWhere,
    _updateSetCalls: updateSetCalls,
  };
}

const runTask = (payload: unknown): Promise<unknown> => {
  // biome-ignore lint/suspicious/noExplicitAny: test helper for mocked task
  return (provisionCampaignsTask as any).run(payload);
};
const basePayload = {
  launch_id: LAUNCH,
  platforms: ['meta'] as const,
  workspace_id: WS,
  run_id: RUN,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('provision-campaigns task', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    process.env.DATABASE_URL = 'postgresql://test:test@localhost/test';
    fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({ id: 'meta-adset-from-api' }),
      text: vi.fn().mockResolvedValue(''),
    });
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    process.env.DATABASE_URL = '';
    process.env.META_ADS_ACCOUNT_ID = '';
    process.env.META_ADS_ACCESS_TOKEN = '';
  });

  it('throws when DATABASE_URL is missing', async () => {
    process.env.DATABASE_URL = '';
    await expect(runTask(basePayload)).rejects.toThrow('DATABASE_URL');
  });

  it('launch not found → workflow_run set to failed, throws launch_not_found', async () => {
    const db = makeDb({ launchRows: [] });
    mockCreateDb.mockReturnValue(db);
    await expect(runTask(basePayload)).rejects.toThrow('launch_not_found');
    expect(db._updateWhere).toHaveBeenCalled();
  });

  it('meta mock provisioning (no env vars) → external_id starts with mock-meta-adset-', async () => {
    const db = makeDb();
    mockCreateDb.mockReturnValue(db);
    await runTask(basePayload);
    const insertArg = db._insertValues.mock.calls[0]?.[0] as {
      externalId?: string;
    };
    expect(insertArg?.externalId).toMatch(/^mock-meta-adset-/);
  });

  it('google mock provisioning → external_id starts with mock-google-campaign-', async () => {
    const db = makeDb({
      provisionsAfterResume: [
        {
          ...baseProvision,
          platform: 'google',
          externalId: `mock-google-campaign-${LAUNCH.slice(0, 8)}`,
        },
      ],
    });
    mockCreateDb.mockReturnValue(db);
    await runTask({ ...basePayload, platforms: ['google'] });
    const insertArg = db._insertValues.mock.calls[0]?.[0] as {
      externalId?: string;
    };
    expect(insertArg?.externalId).toMatch(/^mock-google-campaign-/);
  });

  it('both platforms → insert called twice', async () => {
    const db = makeDb({
      provisionsAfterResume: [
        { ...baseProvision, platform: 'meta' },
        {
          ...baseProvision,
          id: 'p2',
          platform: 'google',
          externalId: 'mock-google-campaign-abc',
        },
      ],
    });
    mockCreateDb.mockReturnValue(db);
    await runTask({ ...basePayload, platforms: ['meta', 'google'] });
    expect(db.insert).toHaveBeenCalledTimes(2);
  });

  it('workflow_run updated to waiting_approval before wait.for', async () => {
    const order: string[] = [];
    const db = makeDb();
    db._updateWhere.mockImplementation(async () => {
      order.push('update');
    });
    mockWait.for.mockImplementation(async () => {
      order.push('wait');
    });
    mockCreateDb.mockReturnValue(db);
    await runTask(basePayload);
    expect(order.indexOf('update')).toBeLessThan(order.indexOf('wait'));
  });

  it('wait.for called with 72h in seconds', async () => {
    const db = makeDb();
    mockCreateDb.mockReturnValue(db);
    await runTask(basePayload);
    expect(mockWait.for).toHaveBeenCalledWith({ seconds: 72 * 3600 });
  });

  it('after resume: Meta PATCH called when META_ADS_ACCESS_TOKEN set', async () => {
    process.env.META_ADS_ACCESS_TOKEN = 'test-token';
    const db = makeDb({
      provisionsAfterResume: [{ ...baseProvision, externalId: 'adset-888' }],
    });
    mockCreateDb.mockReturnValue(db);
    await runTask(basePayload);
    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining('adset-888'),
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('after resume: google mock activation → logger.info with run_id', async () => {
    const db = makeDb({
      provisionsAfterResume: [
        {
          ...baseProvision,
          platform: 'google',
          externalId: 'mock-google-campaign-xyz',
        },
      ],
    });
    mockCreateDb.mockReturnValue(db);
    await runTask({ ...basePayload, platforms: ['google'] });
    expect(mockLogger.info).toHaveBeenCalledWith(
      'google_ads: mock activation',
      expect.objectContaining({ run_id: RUN }),
    );
  });

  it('result includes provisions summary with run_id', async () => {
    const db = makeDb();
    mockCreateDb.mockReturnValue(db);
    const result = await runTask(basePayload);
    expect(result).toMatchObject({
      run_id: RUN,
      workspace_id: WS,
      platforms: expect.arrayContaining(['meta']),
      provisions: expect.any(Array),
    });
  });

  it('BR-RBAC-002: insert values include workspace_id', async () => {
    const db = makeDb();
    mockCreateDb.mockReturnValue(db);
    await runTask(basePayload);
    const insertArg = db._insertValues.mock.calls[0]?.[0] as {
      workspaceId?: string;
    };
    expect(insertArg?.workspaceId).toBe(WS);
  });

  it('BR-AUDIT-001: insert values include status=pending_approval', async () => {
    const db = makeDb();
    mockCreateDb.mockReturnValue(db);
    await runTask(basePayload);
    const insertArg = db._insertValues.mock.calls[0]?.[0] as {
      status?: string;
    };
    expect(insertArg?.status).toBe('pending_approval');
  });

  it('BR-AUDIT-001: rollback_payload included in insert values', async () => {
    const db = makeDb();
    mockCreateDb.mockReturnValue(db);
    await runTask(basePayload);
    const insertArg = db._insertValues.mock.calls[0]?.[0] as {
      rollbackPayload?: unknown;
    };
    expect(insertArg?.rollbackPayload).toBeDefined();
  });
});
