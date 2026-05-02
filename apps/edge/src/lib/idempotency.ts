/**
 * Idempotency helper — deterministic key generation + KV check-and-set.
 *
 * BR-EVENT-002: idempotência por (workspace_id, event_id) em events.
 * ADR-013: idempotency via event_id + idempotency_key.
 *
 * Compatible with Cloudflare Workers KV (KVNamespace).
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };

export type IdempotencyError = { code: 'kv_error'; message: string };

/** Minimal interface — compatible with KVNamespace but also mockable in tests. */
export interface KvStore {
  get(key: string): Promise<string | null>;
  put(
    key: string,
    value: string,
    options?: { expirationTtl?: number },
  ): Promise<void>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** KV key prefix to namespace replay protection entries. */
const IDEMPOTENCY_KEY_PREFIX = 'idmp:';

/** Default TTL for idempotency records: 7 days in seconds. */
export const DEFAULT_IDEMPOTENCY_TTL_SECONDS = 7 * 24 * 60 * 60; // 604800

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Construct a deterministic idempotency key scoped to workspace + event.
 *
 * BR-EVENT-002: idempotência por (workspace_id, event_id).
 * ADR-013: idempotency_key is deterministic from these two fields.
 *
 * @returns string safe for use as a KV key
 */
export function makeIdempotencyKey(
  workspaceId: string,
  eventId: string,
): string {
  // BR-EVENT-002: key is scoped to workspace so cross-workspace collision is impossible
  return `${IDEMPOTENCY_KEY_PREFIX}${workspaceId}:${eventId}`;
}

/**
 * Check whether a key has been seen before, and mark it seen if not.
 *
 * Returns `true` if the key is NEW (not a duplicate) — caller should proceed.
 * Returns `false` if the key already exists — caller should treat as duplicate.
 *
 * Note: Cloudflare KV is eventually consistent. This provides a first-layer
 * defence (BR-EVENT-004) — the DB unique constraint is the authoritative guard.
 *
 * BR-EVENT-002: first-layer KV guard before DB insert.
 *
 * @param key - idempotency key (from makeIdempotencyKey)
 * @param ttlSeconds - how long to keep the entry; default 7 days
 * @param kv - KV store (KVNamespace or test mock)
 * @returns Result<boolean> — true = new, false = duplicate
 */
export async function checkAndSet(
  key: string,
  ttlSeconds: number,
  kv: KvStore,
): Promise<Result<boolean, IdempotencyError>> {
  try {
    const existing = await kv.get(key);
    if (existing !== null) {
      // Already seen — duplicate
      return { ok: true, value: false };
    }

    // Not seen — mark it and report new
    await kv.put(key, '1', { expirationTtl: ttlSeconds });
    return { ok: true, value: true };
  } catch (err) {
    return {
      ok: false,
      error: {
        code: 'kv_error',
        message: err instanceof Error ? err.message : 'Unknown KV error',
      },
    };
  }
}
