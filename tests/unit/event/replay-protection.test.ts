/**
 * Unit tests for apps/edge/src/lib/replay-protection.ts
 *
 * Covers:
 *   BR-EVENT-004: KV replay protection TTL 7 days
 *   INV-EVENT-003: replay with same event_id in 7d returns duplicate_accepted
 */

import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_REPLAY_TTL_SECONDS,
  type KvStore,
  isReplay,
  markSeen,
} from '../../../apps/edge/src/lib/replay-protection';

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
// isReplay
// ---------------------------------------------------------------------------

describe('isReplay', () => {
  it('BR-EVENT-004: returns false for an unseen event_id', async () => {
    const kv = makeMemoryKv();
    const result = await isReplay('evt_new', 'ws_A', kv);
    expect(result).toBe(false);
  });

  it('BR-EVENT-004: returns true for an event_id that was marked seen', async () => {
    const kv = makeMemoryKv();
    await markSeen('evt_001', 'ws_A', kv);
    const result = await isReplay('evt_001', 'ws_A', kv);
    expect(result).toBe(true);
  });

  it('INV-EVENT-003: replay with same event_id is detected', async () => {
    const kv = makeMemoryKv();
    await markSeen('evt_replay', 'ws_A', kv);

    // Simulate second request with same event_id
    const replay = await isReplay('evt_replay', 'ws_A', kv);
    expect(replay).toBe(true);
  });

  it('BR-EVENT-004: different workspace does not see the other workspace replay', async () => {
    const kv = makeMemoryKv();
    await markSeen('evt_001', 'ws_A', kv);

    // ws_B never saw evt_001 — not a replay
    const result = await isReplay('evt_001', 'ws_B', kv);
    expect(result).toBe(false);
  });

  it('different event_id in same workspace is not a replay', async () => {
    const kv = makeMemoryKv();
    await markSeen('evt_001', 'ws_A', kv);

    const result = await isReplay('evt_002', 'ws_A', kv);
    expect(result).toBe(false);
  });

  it('BR-EVENT-004: only 1 KV read per isReplay call (no extra writes)', async () => {
    const getSpy = vi.fn().mockResolvedValue(null);
    const putSpy = vi.fn();
    const kv: KvStore = { get: getSpy, put: putSpy };

    await isReplay('evt_001', 'ws_A', kv);

    expect(getSpy).toHaveBeenCalledTimes(1);
    expect(putSpy).not.toHaveBeenCalled(); // isReplay must NOT write
  });
});

// ---------------------------------------------------------------------------
// markSeen
// ---------------------------------------------------------------------------

describe('markSeen', () => {
  it('BR-EVENT-004: marks event as seen so subsequent isReplay returns true', async () => {
    const kv = makeMemoryKv();
    expect(await isReplay('evt_001', 'ws_A', kv)).toBe(false);
    await markSeen('evt_001', 'ws_A', kv);
    expect(await isReplay('evt_001', 'ws_A', kv)).toBe(true);
  });

  it('BR-EVENT-004: passes default TTL of 7 days to KV', async () => {
    const putSpy = vi.fn().mockResolvedValue(undefined);
    const kv: KvStore = { get: async () => null, put: putSpy };

    await markSeen('evt_001', 'ws_A', kv);

    expect(putSpy).toHaveBeenCalledWith(expect.stringContaining('ws_A'), '1', {
      expirationTtl: DEFAULT_REPLAY_TTL_SECONDS,
    });
  });

  it('BR-EVENT-004: accepts custom TTL override', async () => {
    const putSpy = vi.fn().mockResolvedValue(undefined);
    const kv: KvStore = { get: async () => null, put: putSpy };

    await markSeen('evt_001', 'ws_A', kv, 3600);

    expect(putSpy).toHaveBeenCalledWith(expect.any(String), '1', {
      expirationTtl: 3600,
    });
  });

  it('is idempotent — calling twice does not throw', async () => {
    const kv = makeMemoryKv();
    await markSeen('evt_001', 'ws_A', kv);
    await expect(markSeen('evt_001', 'ws_A', kv)).resolves.toBeUndefined();
  });

  it('KV key is scoped to workspace (prevents cross-workspace interference)', async () => {
    const putSpy = vi.fn().mockResolvedValue(undefined);
    const kv: KvStore = { get: async () => null, put: putSpy };

    await markSeen('evt_001', 'ws_A', kv);
    await markSeen('evt_001', 'ws_B', kv);

    const keys = putSpy.mock.calls.map((c) => c[0] as string);
    expect(keys[0]).not.toBe(keys[1]);
    expect(keys[0]).toContain('ws_A');
    expect(keys[1]).toContain('ws_B');
  });

  it('BR-EVENT-004: DEFAULT_REPLAY_TTL_SECONDS is 7 days (604800)', () => {
    expect(DEFAULT_REPLAY_TTL_SECONDS).toBe(604800);
  });
});

// ---------------------------------------------------------------------------
// Combined flow
// ---------------------------------------------------------------------------

describe('replay protection combined flow', () => {
  it('INV-EVENT-003: new event is accepted, replay is rejected', async () => {
    const kv = makeMemoryKv();
    const eventId = 'evt_flow_001';
    const workspaceId = 'ws_flow';

    // First encounter — not a replay
    const firstCheck = await isReplay(eventId, workspaceId, kv);
    expect(firstCheck).toBe(false);

    // Accept and mark seen
    await markSeen(eventId, workspaceId, kv);

    // Second encounter — is a replay
    const secondCheck = await isReplay(eventId, workspaceId, kv);
    expect(secondCheck).toBe(true);
  });

  it('after TTL expiry simulation, event is accepted again as new', async () => {
    // Simulate TTL expiry by using a fresh KV store (entries cleared)
    const kvT0 = makeMemoryKv();
    await markSeen('evt_ttl', 'ws_A', kvT0);
    expect(await isReplay('evt_ttl', 'ws_A', kvT0)).toBe(true);

    // New KV (simulates TTL expiry)
    const kvT8d = makeMemoryKv(); // empty — entries expired
    expect(await isReplay('evt_ttl', 'ws_A', kvT8d)).toBe(false);
  });
});
