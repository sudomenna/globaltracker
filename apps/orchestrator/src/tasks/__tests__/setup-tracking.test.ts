/**
 * Unit tests — setup-tracking Trigger.dev task
 *
 * T-ID: T-7-010
 *
 * NOTE: This file lives inside apps/orchestrator/src/ so that @trigger.dev/sdk/v3
 * resolves from the orchestrator package's node_modules (not the root).
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
  pageTokens: 'pageTokens',
  pages: 'pages',
  launches: 'launches',
}));

vi.mock('drizzle-orm', () => ({
  and: (...args: unknown[]) => ({ _and: args }),
  eq: (col: unknown, val: unknown) => ({ _eq: [col, val] }),
}));

import { setupTrackingTask } from '../setup-tracking.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const WS = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const RUN = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const PAGE = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const LAUNCH = 'dddddddd-dddd-dddd-dddd-dddddddddddd';

function makeSelectChain(result: unknown[]) {
  return Object.assign(Promise.resolve(result), {
    limit: vi.fn().mockResolvedValue(result),
  });
}

function makeDb(selectSequence: unknown[][] = []) {
  let idx = 0;
  const updateWhere = vi.fn().mockResolvedValue(undefined);
  return {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi
          .fn()
          .mockImplementation(() =>
            makeSelectChain(selectSequence[idx++] ?? []),
          ),
      }),
    }),
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({ where: updateWhere }),
    }),
    _updateWhere: updateWhere,
  };
}

const basePage = { id: PAGE, workspaceId: WS, eventConfig: { foo: 'bar' } };
const baseLaunch = {
  id: LAUNCH,
  workspaceId: WS,
  config: { tracking: { meta: { pixel_policy: 'server_only' } } },
};
const activeToken = [{ pageId: PAGE, workspaceId: WS, status: 'active' }];
const basePayload = {
  page_id: PAGE,
  launch_id: LAUNCH,
  workspace_id: WS,
  run_id: RUN,
};

// biome-ignore lint/suspicious/noExplicitAny: test helper for mocked task
const runTask = (payload: unknown) => (setupTrackingTask as any).run(payload);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('setup-tracking task', () => {
  beforeEach(() => {
    process.env.DATABASE_URL = 'postgresql://test:test@localhost/test';
  });

  afterEach(() => {
    vi.clearAllMocks();
    process.env.DATABASE_URL = '';
  });

  it('throws when DATABASE_URL is missing', async () => {
    process.env.DATABASE_URL = '';
    await expect(runTask(basePayload)).rejects.toThrow('DATABASE_URL');
  });

  it('page not found → workflow_run set to failed, throws page_not_found', async () => {
    const db = makeDb([[], [baseLaunch]]);
    mockCreateDb.mockReturnValue(db);
    await expect(runTask(basePayload)).rejects.toThrow('page_not_found');
    expect(db._updateWhere).toHaveBeenCalled();
  });

  it('launch not found → workflow_run set to failed, throws launch_not_found', async () => {
    const db = makeDb([[basePage], []]);
    mockCreateDb.mockReturnValue(db);
    await expect(runTask(basePayload)).rejects.toThrow('launch_not_found');
    expect(db._updateWhere).toHaveBeenCalled();
  });

  it('pixel_policy missing → logger.warn, pixel_policy=null, does not throw', async () => {
    const launchNoPx = { ...baseLaunch, config: { tracking: {} } };
    const db = makeDb([[basePage], [launchNoPx], activeToken]);
    mockCreateDb.mockReturnValue(db);
    const result = await runTask(basePayload);
    expect(mockLogger.warn).toHaveBeenCalled();
    expect(result.pixel_policy).toBeNull();
  });

  it('pixel_policy invalid → logger.warn, pixel_policy=null', async () => {
    const launchBadPx = {
      ...baseLaunch,
      config: { tracking: { meta: { pixel_policy: 'bad_value' } } },
    };
    const db = makeDb([[basePage], [launchBadPx], activeToken]);
    mockCreateDb.mockReturnValue(db);
    const result = await runTask(basePayload);
    expect(mockLogger.warn).toHaveBeenCalled();
    expect(result.pixel_policy).toBeNull();
  });

  it('pixel_policy valid → no warn, pixel_policy=server_only', async () => {
    const db = makeDb([[basePage], [baseLaunch], activeToken]);
    mockCreateDb.mockReturnValue(db);
    const result = await runTask(basePayload);
    expect(result.pixel_policy).toBe('server_only');
  });

  it('event_config null → logger.warn, event_config_valid=false', async () => {
    const pageNoConfig = { ...basePage, eventConfig: null };
    const db = makeDb([[pageNoConfig], [baseLaunch], activeToken]);
    mockCreateDb.mockReturnValue(db);
    const result = await runTask(basePayload);
    expect(mockLogger.warn).toHaveBeenCalled();
    expect(result.event_config_valid).toBe(false);
  });

  it('event_config present → event_config_valid=true', async () => {
    const db = makeDb([[basePage], [baseLaunch], activeToken]);
    mockCreateDb.mockReturnValue(db);
    const result = await runTask(basePayload);
    expect(result.event_config_valid).toBe(true);
  });

  it('active token found → has_active_token=true', async () => {
    const db = makeDb([[basePage], [baseLaunch], activeToken]);
    mockCreateDb.mockReturnValue(db);
    const result = await runTask(basePayload);
    expect(result.has_active_token).toBe(true);
  });

  it('no active token → has_active_token=false', async () => {
    const db = makeDb([[basePage], [baseLaunch], []]);
    mockCreateDb.mockReturnValue(db);
    const result = await runTask(basePayload);
    expect(result.has_active_token).toBe(false);
  });

  it('result persisted to workflow_runs via db.update', async () => {
    const db = makeDb([[basePage], [baseLaunch], activeToken]);
    mockCreateDb.mockReturnValue(db);
    await runTask(basePayload);
    expect(db.update).toHaveBeenCalled();
  });

  it('return value matches SetupTrackingResult shape', async () => {
    const db = makeDb([[basePage], [baseLaunch], activeToken]);
    mockCreateDb.mockReturnValue(db);
    const result = await runTask(basePayload);
    expect(result).toMatchObject({
      page_id: PAGE,
      launch_id: LAUNCH,
      has_active_token: expect.any(Boolean),
      event_config_valid: expect.any(Boolean),
      validated_at: expect.any(String),
    });
  });

  it('BR-RBAC-002: createDb called with DATABASE_URL', async () => {
    const db = makeDb([[basePage], [baseLaunch], activeToken]);
    mockCreateDb.mockReturnValue(db);
    await runTask(basePayload);
    expect(mockCreateDb).toHaveBeenCalledWith(
      'postgresql://test:test@localhost/test',
    );
  });
});
