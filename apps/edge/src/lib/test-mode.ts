/**
 * Test Mode helper — isTestModeHeader, isTestModeCookie, isTestModeRequest,
 * getTestModeStatus, activateTestMode, deactivateTestMode, isWorkspaceInTestMode.
 *
 * Manages a per-workspace "test mode" flag stored in Cloudflare KV with a 1h TTL.
 * Requests carrying `X-GT-Test-Mode: 1` header or `__gt_test=1` cookie are treated
 * as test traffic; events are marked `is_test = true` and dispatchers use test
 * credentials / debug flags (e.g. META_CAPI_TEST_EVENT_CODE, GA4 debug_mode=1).
 *
 * BR-PRIVACY-001: test mode flag is not PII; no encryption required.
 * BR-RBAC-002: workspaceId is always the multi-tenant scope — keys are never shared
 *   across workspaces.
 */

import { parseCookies } from './cookies.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** KV key prefix for test mode activation records. */
const KV_KEY_PREFIX = 'workspace_test_mode';

/** Default TTL for an activated test mode session: 1 hour (seconds). */
const TEST_MODE_TTL_SECONDS = 3600;

/** Request header that signals a test-mode event ingest. */
const HEADER_NAME = 'X-GT-Test-Mode';

/** Cookie name that signals a test-mode event ingest. */
const COOKIE_NAME = '__gt_test';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Snapshot of the current test mode activation state for a workspace. */
export type TestModeStatus = {
  /** Whether test mode is currently active (not expired). */
  active: boolean;
  /** When the current activation expires; null when inactive. */
  expiresAt: Date | null;
  /** Seconds remaining until expiry; null when inactive. */
  ttlSeconds: number | null;
};

/** Shape of the JSON value stored in KV under `workspace_test_mode:<id>`. */
type KvRecord = {
  activatedAt: string; // ISO 8601
  expiresAt: string; // ISO 8601
};

// ---------------------------------------------------------------------------
// Pure request-inspection helpers (no I/O)
// ---------------------------------------------------------------------------

/**
 * Returns true when the `X-GT-Test-Mode` header equals `'1'`.
 *
 * Pure function — no side effects, no I/O.
 *
 * BR-RBAC-002: header inspection only; no workspace context needed here.
 */
export function isTestModeHeader(headers: Headers): boolean {
  return headers.get(HEADER_NAME) === '1';
}

/**
 * Returns true when the raw `Cookie` header contains `__gt_test=1`.
 *
 * Pure function — no side effects, no I/O.
 * Delegates cookie parsing to the canonical `parseCookies` helper.
 *
 * BR-RBAC-002: cookie inspection only; no workspace context needed here.
 */
export function isTestModeCookie(cookieHeader: string | null): boolean {
  const cookies = parseCookies(cookieHeader);
  return cookies[COOKIE_NAME] === '1';
}

/**
 * Returns true when the incoming request carries any test-mode signal
 * (header **or** cookie).
 *
 * Pure function — no side effects, no I/O.
 */
export function isTestModeRequest(headers: Headers): boolean {
  return isTestModeHeader(headers) || isTestModeCookie(headers.get('cookie'));
}

// ---------------------------------------------------------------------------
// KV-backed workspace helpers
// ---------------------------------------------------------------------------

/**
 * Builds the KV key for a workspace's test mode record.
 *
 * BR-RBAC-002: key is scoped to workspaceId to prevent cross-workspace leakage.
 */
function kvKey(workspaceId: string): string {
  return `${KV_KEY_PREFIX}:${workspaceId}`;
}

/**
 * Reads the current test mode activation state for a workspace from KV.
 *
 * - Key absent → `{ active: false, expiresAt: null, ttlSeconds: null }`
 * - Key present but `expiresAt` is in the past → treated as inactive even if
 *   KV has not yet reaped the entry (defensive guard against clock skew).
 * - Key present and not expired → `{ active: true, expiresAt, ttlSeconds }`
 *
 * BR-RBAC-002: workspace scope enforced via KV key prefix.
 *
 * @param workspaceId - internal workspace UUID
 * @param kv          - Cloudflare KV namespace (DI)
 */
export async function getTestModeStatus(
  workspaceId: string,
  kv: KVNamespace,
): Promise<TestModeStatus> {
  const raw = await kv.get(kvKey(workspaceId));

  if (raw === null) {
    return { active: false, expiresAt: null, ttlSeconds: null };
  }

  let record: KvRecord;
  try {
    record = JSON.parse(raw) as KvRecord;
  } catch {
    // Malformed entry — treat as inactive; KV TTL will clean it up.
    return { active: false, expiresAt: null, ttlSeconds: null };
  }

  const expiresAt = new Date(record.expiresAt);
  const now = new Date();

  // Defensive expiry check: KV may not have reaped the key yet.
  if (expiresAt <= now) {
    return { active: false, expiresAt: null, ttlSeconds: null };
  }

  const ttlSeconds = Math.round((expiresAt.getTime() - now.getTime()) / 1000);

  return { active: true, expiresAt, ttlSeconds };
}

/**
 * Activates test mode for the workspace and stores the record in KV with a 1h TTL.
 *
 * Calling this when test mode is already active **resets** the 1h window
 * (idempotent re-activation is intentional — operator clicked "activate" again).
 *
 * BR-PRIVACY-001: no PII stored; only timestamps.
 * BR-RBAC-002: workspace scope enforced via KV key prefix.
 *
 * @param workspaceId - internal workspace UUID
 * @param kv          - Cloudflare KV namespace (DI)
 */
export async function activateTestMode(
  workspaceId: string,
  kv: KVNamespace,
): Promise<TestModeStatus> {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + TEST_MODE_TTL_SECONDS * 1000);

  const record: KvRecord = {
    activatedAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
  };

  // BR-PRIVACY-001: value contains only timestamps — no PII.
  // BR-RBAC-002: key is workspace-scoped.
  await kv.put(kvKey(workspaceId), JSON.stringify(record), {
    expirationTtl: TEST_MODE_TTL_SECONDS,
  });

  return {
    active: true,
    expiresAt,
    ttlSeconds: TEST_MODE_TTL_SECONDS,
  };
}

/**
 * Deactivates test mode for the workspace by deleting the KV key.
 *
 * Idempotent: calling when test mode is already inactive is a no-op.
 *
 * BR-RBAC-002: workspace scope enforced via KV key prefix.
 *
 * @param workspaceId - internal workspace UUID
 * @param kv          - Cloudflare KV namespace (DI)
 */
export async function deactivateTestMode(
  workspaceId: string,
  kv: KVNamespace,
): Promise<void> {
  // BR-RBAC-002: key is workspace-scoped; delete affects only this workspace.
  await kv.delete(kvKey(workspaceId));
}

/**
 * Convenience wrapper: returns `true` when the workspace has an active
 * (non-expired) test mode session.
 *
 * BR-RBAC-002: delegates to `getTestModeStatus` which enforces workspace scope.
 *
 * @param workspaceId - internal workspace UUID
 * @param kv          - Cloudflare KV namespace (DI)
 */
export async function isWorkspaceInTestMode(
  workspaceId: string,
  kv: KVNamespace,
): Promise<boolean> {
  return (await getTestModeStatus(workspaceId, kv)).active;
}
