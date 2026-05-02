/**
 * Unit tests — apps/edge/src/lib/test-mode.ts (KV-backed workspace helpers)
 *
 * T-ID: T-8-006
 *
 * Covers:
 *   activateTestMode   — writes JSON record to KV with 1h TTL
 *   getTestModeStatus  — reads KV and returns status (active/inactive)
 *   deactivateTestMode — deletes KV key
 *   isWorkspaceInTestMode — convenience wrapper over getTestModeStatus
 *
 * BR-RBAC-002: KV key is scoped to workspaceId (no cross-workspace leakage)
 * BR-PRIVACY-001: no PII in KV values — only timestamps
 *
 * Uses a mock KVNamespace (vi.fn()) — no real KV required.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  activateTestMode,
  deactivateTestMode,
  getTestModeStatus,
  isWorkspaceInTestMode,
} from '../../../apps/edge/src/lib/test-mode.js';

// ---------------------------------------------------------------------------
// KV mock factory
// ---------------------------------------------------------------------------

/** Minimal KVNamespace mock for test-mode helpers. */
function makeKvMock(
  getReturnValue: string | null = null,
): KVNamespace & {
  _putCalls: Array<{
    key: string;
    value: string;
    options: KVNamespacePutOptions;
  }>;
  _deleteCalls: string[];
} {
  const _putCalls: Array<{
    key: string;
    value: string;
    options: KVNamespacePutOptions;
  }> = [];
  const _deleteCalls: string[] = [];

  return {
    _putCalls,
    _deleteCalls,
    get: vi.fn().mockResolvedValue(getReturnValue),
    put: vi.fn().mockImplementation(
      async (
        key: string,
        value: string,
        options: KVNamespacePutOptions = {},
      ) => {
        _putCalls.push({ key, value, options });
      },
    ),
    delete: vi.fn().mockImplementation(async (key: string) => {
      _deleteCalls.push(key);
    }),
    list: vi.fn().mockResolvedValue({ keys: [], list_complete: true }),
    getWithMetadata: vi.fn().mockResolvedValue({ value: null, metadata: null }),
  } as unknown as KVNamespace & {
    _putCalls: Array<{
      key: string;
      value: string;
      options: KVNamespacePutOptions;
    }>;
    _deleteCalls: string[];
  };
}

const WORKSPACE_ID = 'ws-test-aaaaaa-111111';
const EXPECTED_KV_KEY = `workspace_test_mode:${WORKSPACE_ID}`;

// ---------------------------------------------------------------------------
// activateTestMode
// ---------------------------------------------------------------------------

describe('activateTestMode', () => {
  it('writes to KV with key scoped to workspaceId — BR-RBAC-002', async () => {
    const kv = makeKvMock();
    await activateTestMode(WORKSPACE_ID, kv);

    expect(kv._putCalls).toHaveLength(1);
    expect(kv._putCalls[0]!.key).toBe(EXPECTED_KV_KEY);
  });

  it('writes with expirationTtl of 3600 seconds', async () => {
    const kv = makeKvMock();
    await activateTestMode(WORKSPACE_ID, kv);

    expect(kv._putCalls[0]!.options.expirationTtl).toBe(3600);
  });

  it('stores valid JSON with activatedAt and expiresAt timestamps — BR-PRIVACY-001', async () => {
    const kv = makeKvMock();
    const before = new Date();
    await activateTestMode(WORKSPACE_ID, kv);
    const after = new Date();

    const stored = JSON.parse(kv._putCalls[0]!.value) as {
      activatedAt: string;
      expiresAt: string;
    };

    expect(stored.activatedAt).toBeTruthy();
    expect(stored.expiresAt).toBeTruthy();

    const activatedAt = new Date(stored.activatedAt);
    const expiresAt = new Date(stored.expiresAt);

    // activatedAt must be within the test window
    expect(activatedAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(activatedAt.getTime()).toBeLessThanOrEqual(after.getTime());

    // expiresAt must be ~3600 seconds after activatedAt
    const diffSeconds = (expiresAt.getTime() - activatedAt.getTime()) / 1000;
    expect(diffSeconds).toBeCloseTo(3600, -1); // within 10s tolerance
  });

  it('returns status with active=true and ttlSeconds=3600', async () => {
    const kv = makeKvMock();
    const status = await activateTestMode(WORKSPACE_ID, kv);

    expect(status.active).toBe(true);
    expect(status.ttlSeconds).toBe(3600);
    expect(status.expiresAt).toBeInstanceOf(Date);
  });

  it('idempotent re-activation resets TTL (called twice, two puts)', async () => {
    const kv = makeKvMock();
    await activateTestMode(WORKSPACE_ID, kv);
    await activateTestMode(WORKSPACE_ID, kv);

    // Both calls write — second one resets the 1h window
    expect(kv._putCalls).toHaveLength(2);
    expect(kv._putCalls[0]!.options.expirationTtl).toBe(3600);
    expect(kv._putCalls[1]!.options.expirationTtl).toBe(3600);
  });
});

// ---------------------------------------------------------------------------
// getTestModeStatus
// ---------------------------------------------------------------------------

describe('getTestModeStatus', () => {
  it('returns inactive status when KV returns null (key absent)', async () => {
    const kv = makeKvMock(null);
    const status = await getTestModeStatus(WORKSPACE_ID, kv);

    expect(status.active).toBe(false);
    expect(status.expiresAt).toBeNull();
    expect(status.ttlSeconds).toBeNull();
  });

  it('returns active status when KV contains valid record with future expiresAt', async () => {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 30 * 60 * 1000); // 30 min from now

    const record = JSON.stringify({
      activatedAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
    });

    const kv = makeKvMock(record);
    const status = await getTestModeStatus(WORKSPACE_ID, kv);

    expect(status.active).toBe(true);
    expect(status.expiresAt).toBeInstanceOf(Date);
    // ttlSeconds should be approximately 1800 (30 min)
    expect(status.ttlSeconds).toBeGreaterThan(1700);
    expect(status.ttlSeconds).toBeLessThan(1900);
  });

  it('returns inactive when expiresAt is in the past (defensive expiry guard)', async () => {
    const now = new Date();
    const expiredAt = new Date(now.getTime() - 60 * 1000); // 1 min ago

    const record = JSON.stringify({
      activatedAt: new Date(now.getTime() - 3700 * 1000).toISOString(),
      expiresAt: expiredAt.toISOString(),
    });

    const kv = makeKvMock(record);
    const status = await getTestModeStatus(WORKSPACE_ID, kv);

    expect(status.active).toBe(false);
    expect(status.expiresAt).toBeNull();
    expect(status.ttlSeconds).toBeNull();
  });

  it('returns inactive for malformed KV JSON (corrupted entry)', async () => {
    const kv = makeKvMock('not_valid_json{{{');
    const status = await getTestModeStatus(WORKSPACE_ID, kv);

    expect(status.active).toBe(false);
    expect(status.expiresAt).toBeNull();
    expect(status.ttlSeconds).toBeNull();
  });

  it('queries KV with workspace-scoped key — BR-RBAC-002', async () => {
    const kv = makeKvMock(null);
    await getTestModeStatus(WORKSPACE_ID, kv);

    expect(kv.get).toHaveBeenCalledWith(EXPECTED_KV_KEY);
  });
});

// ---------------------------------------------------------------------------
// deactivateTestMode
// ---------------------------------------------------------------------------

describe('deactivateTestMode', () => {
  it('deletes the workspace-scoped KV key — BR-RBAC-002', async () => {
    const kv = makeKvMock();
    await deactivateTestMode(WORKSPACE_ID, kv);

    expect(kv._deleteCalls).toHaveLength(1);
    expect(kv._deleteCalls[0]).toBe(EXPECTED_KV_KEY);
  });

  it('is idempotent — calling twice deletes twice (KV delete is a no-op when key absent)', async () => {
    const kv = makeKvMock();
    await deactivateTestMode(WORKSPACE_ID, kv);
    await deactivateTestMode(WORKSPACE_ID, kv);

    expect(kv._deleteCalls).toHaveLength(2);
    expect(kv._deleteCalls.every((k) => k === EXPECTED_KV_KEY)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// isWorkspaceInTestMode
// ---------------------------------------------------------------------------

describe('isWorkspaceInTestMode', () => {
  it('returns false when KV is empty', async () => {
    const kv = makeKvMock(null);
    const result = await isWorkspaceInTestMode(WORKSPACE_ID, kv);
    expect(result).toBe(false);
  });

  it('returns true when workspace has active test mode', async () => {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 3600 * 1000);
    const record = JSON.stringify({
      activatedAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
    });

    const kv = makeKvMock(record);
    const result = await isWorkspaceInTestMode(WORKSPACE_ID, kv);
    expect(result).toBe(true);
  });
});
