/**
 * Unit tests for apps/edge/src/lib/idempotency.ts
 *
 * Covers:
 *   BR-EVENT-002: idempotência por (workspace_id, event_id)
 *   ADR-013: idempotency_key is deterministic
 */

import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_IDEMPOTENCY_TTL_SECONDS,
  type KvStore,
  checkAndSet,
  makeIdempotencyKey,
} from '../../../apps/edge/src/lib/idempotency';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMemoryKv(): KvStore {
  const store = new Map<string, string>();
  return {
    async get(key: string) {
      return store.get(key) ?? null;
    },
    async put(key: string, value: string) {
      store.set(key, value);
    },
  };
}

// ---------------------------------------------------------------------------
// makeIdempotencyKey
// ---------------------------------------------------------------------------

describe('makeIdempotencyKey', () => {
  it('BR-EVENT-002: is deterministic — same inputs produce same key', () => {
    const k1 = makeIdempotencyKey('ws_abc', 'evt_001');
    const k2 = makeIdempotencyKey('ws_abc', 'evt_001');
    expect(k1).toBe(k2);
  });

  it('different workspaces produce different keys for same eventId', () => {
    const k1 = makeIdempotencyKey('ws_A', 'evt_001');
    const k2 = makeIdempotencyKey('ws_B', 'evt_001');
    expect(k1).not.toBe(k2);
  });

  it('different eventIds produce different keys for same workspace', () => {
    const k1 = makeIdempotencyKey('ws_A', 'evt_001');
    const k2 = makeIdempotencyKey('ws_A', 'evt_002');
    expect(k1).not.toBe(k2);
  });

  it('returns a non-empty string', () => {
    const k = makeIdempotencyKey('ws_A', 'evt_001');
    expect(typeof k).toBe('string');
    expect(k.length).toBeGreaterThan(0);
  });

  it('includes workspace scope prefix to prevent cross-workspace collision', () => {
    const k = makeIdempotencyKey('ws_A', 'evt_001');
    expect(k).toContain('ws_A');
    expect(k).toContain('evt_001');
  });
});

// ---------------------------------------------------------------------------
// checkAndSet
// ---------------------------------------------------------------------------

describe('checkAndSet', () => {
  it('BR-EVENT-002: returns true (new) for a key that does not exist', async () => {
    const kv = makeMemoryKv();
    const key = makeIdempotencyKey('ws_A', 'evt_001');
    const result = await checkAndSet(key, DEFAULT_IDEMPOTENCY_TTL_SECONDS, kv);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBe(true); // new event
  });

  it('BR-EVENT-002: returns false (duplicate) for a key that already exists', async () => {
    const kv = makeMemoryKv();
    const key = makeIdempotencyKey('ws_A', 'evt_001');

    // First call — new
    const first = await checkAndSet(key, DEFAULT_IDEMPOTENCY_TTL_SECONDS, kv);
    expect(first.ok && first.value).toBe(true);

    // Second call — duplicate
    const second = await checkAndSet(key, DEFAULT_IDEMPOTENCY_TTL_SECONDS, kv);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value).toBe(false);
  });

  it('different keys are independent', async () => {
    const kv = makeMemoryKv();
    const key1 = makeIdempotencyKey('ws_A', 'evt_001');
    const key2 = makeIdempotencyKey('ws_A', 'evt_002');

    await checkAndSet(key1, DEFAULT_IDEMPOTENCY_TTL_SECONDS, kv);
    const result = await checkAndSet(key2, DEFAULT_IDEMPOTENCY_TTL_SECONDS, kv);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBe(true); // key2 is new
  });

  it('same event in different workspaces are independent', async () => {
    const kv = makeMemoryKv();
    const keyA = makeIdempotencyKey('ws_A', 'evt_001');
    const keyB = makeIdempotencyKey('ws_B', 'evt_001');

    await checkAndSet(keyA, DEFAULT_IDEMPOTENCY_TTL_SECONDS, kv);
    const result = await checkAndSet(keyB, DEFAULT_IDEMPOTENCY_TTL_SECONDS, kv);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBe(true); // ws_B never saw this eventId
  });

  it('passes ttlSeconds to kv.put', async () => {
    const putSpy = vi.fn().mockResolvedValue(undefined);
    const kv: KvStore = {
      get: async () => null,
      put: putSpy,
    };

    const key = makeIdempotencyKey('ws_A', 'evt_001');
    await checkAndSet(key, 3600, kv);

    expect(putSpy).toHaveBeenCalledWith(key, '1', { expirationTtl: 3600 });
  });

  it('does not call kv.put when key already exists (avoids unnecessary write)', async () => {
    const putSpy = vi.fn().mockResolvedValue(undefined);
    const kv: KvStore = {
      get: async () => '1', // already exists
      put: putSpy,
    };

    const key = makeIdempotencyKey('ws_A', 'evt_001');
    await checkAndSet(key, DEFAULT_IDEMPOTENCY_TTL_SECONDS, kv);

    expect(putSpy).not.toHaveBeenCalled();
  });

  it('returns kv_error result when KV throws', async () => {
    const kv: KvStore = {
      get: async () => {
        throw new Error('KV unavailable');
      },
      put: async () => {},
    };

    const key = makeIdempotencyKey('ws_A', 'evt_001');
    const result = await checkAndSet(key, DEFAULT_IDEMPOTENCY_TTL_SECONDS, kv);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('kv_error');
    expect(result.error.message).toContain('KV unavailable');
  });

  it('DEFAULT_IDEMPOTENCY_TTL_SECONDS is 7 days', () => {
    expect(DEFAULT_IDEMPOTENCY_TTL_SECONDS).toBe(604800);
  });
});
