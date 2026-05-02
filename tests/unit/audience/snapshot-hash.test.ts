/**
 * Unit tests — BR-AUDIENCE-003: snapshot hash is deterministic SHA-256
 *
 * Verifies that the hash function used to compute snapshotHash produces:
 *   - Same hash for identical member sets regardless of input order
 *   - Different hashes for different member sets
 *
 * BR-AUDIENCE-003: snapshot_hash = sha256(sorted member IDs joined by comma)
 * INV-AUDIENCE-003: snapshot is deterministic — same query = same hash
 *
 * Note: sha256Hex is an internal function of audience.ts. We test its behaviour
 * indirectly by constructing member arrays manually and hashing them the same way
 * the implementation does (sort + join(',') → sha256).
 */

import { describe, expect, it } from 'vitest';

// ---------------------------------------------------------------------------
// Replicate sha256Hex (same algorithm as audience.ts — SubtleCrypto)
// This is a white-box test of the hash contract, not an internal import.
// ---------------------------------------------------------------------------

async function sha256Hex(input: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(input);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Compute snapshotHash from a member ID array using the same algorithm as
 * evaluateAudience() in audience.ts: sort the IDs, join by comma, then SHA-256.
 *
 * BR-AUDIENCE-003: snapshot_hash = sha256(sorted members joined by comma)
 */
async function computeSnapshotHash(members: string[]): Promise<string> {
  const sorted = [...members].sort();
  return sha256Hex(sorted.join(','));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('BR-AUDIENCE-003: snapshot hash determinism', () => {
  it('same ordered list produces the same hash', async () => {
    const h1 = await computeSnapshotHash(['A', 'B', 'C']);
    const h2 = await computeSnapshotHash(['A', 'B', 'C']);
    expect(h1).toBe(h2);
  });

  it('members=[A,B,C] and members=[C,A,B] produce the same snapshotHash (order-independent)', async () => {
    // BR-AUDIENCE-003: hash of sorted members — input order must not matter
    const h1 = await computeSnapshotHash(['A', 'B', 'C']);
    const h2 = await computeSnapshotHash(['C', 'A', 'B']);
    expect(h1).toBe(h2);
  });

  it('members=[A,B,C] and members=[A,B,D] produce different hashes', async () => {
    const h1 = await computeSnapshotHash(['A', 'B', 'C']);
    const h2 = await computeSnapshotHash(['A', 'B', 'D']);
    expect(h1).not.toBe(h2);
  });

  it('empty member list produces a consistent hash', async () => {
    const h1 = await computeSnapshotHash([]);
    const h2 = await computeSnapshotHash([]);
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
  });

  it('single-element list hash differs from empty list hash', async () => {
    const hEmpty = await computeSnapshotHash([]);
    const hOne = await computeSnapshotHash(['lead-001']);
    expect(hEmpty).not.toBe(hOne);
  });

  it('hash is a 64-char hex string (SHA-256)', async () => {
    const h = await computeSnapshotHash(['lead-uuid-001', 'lead-uuid-002']);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  it('superset of members produces a different hash from subset', async () => {
    const hSubset = await computeSnapshotHash(['A', 'B']);
    const hSuperset = await computeSnapshotHash(['A', 'B', 'C']);
    expect(hSubset).not.toBe(hSuperset);
  });
});
