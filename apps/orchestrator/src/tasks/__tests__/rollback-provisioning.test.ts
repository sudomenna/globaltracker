/**
 * Unit tests — rollback-provisioning Trigger.dev task
 *
 * T-ID: T-7-010
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockLogger, mockCreateDb } = vi.hoisted(() => ({
  mockLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  mockCreateDb: vi.fn(),
}));

vi.mock('@trigger.dev/sdk/v3', () => ({
  task: (config: unknown) => config,
  logger: mockLogger,
}));

vi.mock('@globaltracker/db', () => ({
  createDb: mockCreateDb,
  workflowRuns: 'workflowRuns',
  campaignProvisions: 'campaignProvisions',
}));

vi.mock('drizzle-orm', () => ({
  and: (...args: unknown[]) => ({ _and: args }),
  eq: (col: unknown, val: unknown) => ({ _eq: [col, val] }),
}));

import { rollbackProvisioningTask } from '../rollback-provisioning.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const WS = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const RUN = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

type Provision = {
  id: string;
  platform: string;
  externalId: string | null;
  status: string;
  workspaceId: string;
  runId: string;
};

function metaProv(overrides: Partial<Provision> = {}): Provision {
  return {
    id: 'prov-1',
    platform: 'meta',
    externalId: 'meta-adset-123',
    status: 'pending_approval',
    workspaceId: WS,
    runId: RUN,
    ...overrides,
  };
}

function googleProv(overrides: Partial<Provision> = {}): Provision {
  return {
    id: 'prov-2',
    platform: 'google',
    externalId: 'mock-google-campaign-abc',
    status: 'pending_approval',
    workspaceId: WS,
    runId: RUN,
    ...overrides,
  };
}

function makeDb(provisions: Provision[]) {
  const updateWhere = vi.fn().mockResolvedValue(undefined);
  const updateSetCalls: Array<{ fields: unknown }> = [];
  return {
    select: vi.fn().mockReturnValue({
      from: vi
        .fn()
        .mockReturnValue({ where: vi.fn().mockResolvedValue(provisions) }),
    }),
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockImplementation((fields: unknown) => {
        updateSetCalls.push({ fields });
        return { where: updateWhere };
      }),
    }),
    _updateWhere: updateWhere,
    _updateSetCalls: updateSetCalls,
  };
}

const runTask = (payload: unknown): Promise<unknown> => {
  // biome-ignore lint/suspicious/noExplicitAny: test helper for mocked task
  return (rollbackProvisioningTask as any).run(payload);
};
const basePayload = {
  run_id: RUN,
  workspace_id: WS,
  reason: 'test rollback reason',
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('rollback-provisioning task', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    process.env.DATABASE_URL = 'postgresql://test:test@localhost/test';
    fetchSpy = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    process.env.DATABASE_URL = '';
    process.env.META_ADS_ACCESS_TOKEN = '';
  });

  it('throws when DATABASE_URL is missing', async () => {
    process.env.DATABASE_URL = '';
    await expect(runTask(basePayload)).rejects.toThrow('DATABASE_URL');
  });

  it('no provisions found → throws no_provisions_found', async () => {
    const db = makeDb([]);
    mockCreateDb.mockReturnValue(db);
    await expect(runTask(basePayload)).rejects.toThrow(
      `no_provisions_found: ${RUN}`,
    );
  });

  it('all already rolled_back → returns already_rolled_back, no fetch', async () => {
    const db = makeDb([metaProv({ status: 'rolled_back' })]);
    mockCreateDb.mockReturnValue(db);
    const result = (await runTask(basePayload)) as { status: string };
    expect(result.status).toBe('already_rolled_back');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('all rolled_back → still updates workflow_run', async () => {
    const db = makeDb([metaProv({ status: 'rolled_back' })]);
    mockCreateDb.mockReturnValue(db);
    await runTask(basePayload);
    expect(db._updateWhere).toHaveBeenCalled();
  });

  it('meta provision → DELETE called on Graph API', async () => {
    process.env.META_ADS_ACCESS_TOKEN = 'test-token';
    const db = makeDb([metaProv()]);
    mockCreateDb.mockReturnValue(db);
    await runTask(basePayload);
    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining('meta-adset-123'),
      expect.objectContaining({ method: 'DELETE' }),
    );
  });

  it('meta 404 on delete → continues, marks rolled_back', async () => {
    process.env.META_ADS_ACCESS_TOKEN = 'test-token';
    fetchSpy.mockResolvedValue({ ok: false, status: 404 });
    const db = makeDb([metaProv()]);
    mockCreateDb.mockReturnValue(db);
    const result = (await runTask(basePayload)) as { status: string };
    expect(result.status).toBe('rolled_back');
  });

  it('meta no token → logger.warn, no fetch, marks rolled_back', async () => {
    const db = makeDb([metaProv()]);
    mockCreateDb.mockReturnValue(db);
    await runTask(basePayload);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('mock'),
      expect.objectContaining({ run_id: RUN }),
    );
  });

  it('google provision → logger.warn, no real API, marks rolled_back', async () => {
    const db = makeDb([googleProv()]);
    mockCreateDb.mockReturnValue(db);
    await runTask(basePayload);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('google'),
      expect.objectContaining({ run_id: RUN }),
    );
  });

  it('mixed: rolled_back + pending → only processes pending', async () => {
    process.env.META_ADS_ACCESS_TOKEN = 'test-token';
    const db = makeDb([
      metaProv({ id: 'p1', status: 'rolled_back' }),
      metaProv({
        id: 'p2',
        externalId: 'adset-p2',
        status: 'pending_approval',
      }),
    ]);
    mockCreateDb.mockReturnValue(db);
    await runTask(basePayload);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining('adset-p2'),
      expect.any(Object),
    );
  });

  it('returns { status: rolled_back, count } after processing', async () => {
    const db = makeDb([metaProv()]);
    mockCreateDb.mockReturnValue(db);
    const result = await runTask(basePayload);
    expect(result).toMatchObject({ status: 'rolled_back', count: 1 });
  });

  it('BR-PRIVACY-001: reason NOT in logger.info calls', async () => {
    const db = makeDb([metaProv()]);
    mockCreateDb.mockReturnValue(db);
    await runTask({ ...basePayload, reason: 'SUPER_SECRET_REASON_XYZ' });
    const infoArgs = mockLogger.info.mock.calls.flat();
    expect(JSON.stringify(infoArgs)).not.toContain('SUPER_SECRET_REASON_XYZ');
  });
});
