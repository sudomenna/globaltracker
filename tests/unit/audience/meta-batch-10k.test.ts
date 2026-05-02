/**
 * Unit tests — Meta Custom Audiences batcher
 *
 * Verifies that batchMembers correctly splits large member lists into chunks
 * of at most META_BATCH_SIZE (10 000) items.
 *
 * T-5-005 / Meta batcher
 */

import { describe, expect, it } from 'vitest';
import {
  META_BATCH_SIZE,
  batchMembers,
} from '../../../apps/edge/src/dispatchers/audience-sync/meta/batcher';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('batchMembers — Meta Custom Audiences batcher', () => {
  it('empty list produces 0 batches', () => {
    const batches = [...batchMembers([], META_BATCH_SIZE)];
    expect(batches).toHaveLength(0);
  });

  it('list of exactly 10 000 items produces 1 batch', () => {
    const members = Array.from({ length: 10_000 }, (_, i) => `lead-${i}`);
    const batches = [...batchMembers(members)];
    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(10_000);
  });

  it('list of 10 001 items produces 2 batches: [10 000, 1]', () => {
    const members = Array.from({ length: 10_001 }, (_, i) => `lead-${i}`);
    const batches = [...batchMembers(members)];
    expect(batches).toHaveLength(2);
    expect(batches[0]).toHaveLength(10_000);
    expect(batches[1]).toHaveLength(1);
  });

  it('list of 25 001 items produces 3 batches: [10 000, 10 000, 5 001]', () => {
    const members = Array.from({ length: 25_001 }, (_, i) => `lead-${i}`);
    const batches = [...batchMembers(members)];
    expect(batches).toHaveLength(3);
    expect(batches[0]).toHaveLength(10_000);
    expect(batches[1]).toHaveLength(10_000);
    expect(batches[2]).toHaveLength(5_001);
  });

  it('all batch items together reconstruct the original list (no loss, no duplication)', () => {
    const members = Array.from({ length: 15_000 }, (_, i) => `lead-${i}`);
    const batches = [...batchMembers(members)];
    const flattened = batches.flat();
    expect(flattened).toHaveLength(members.length);
    expect(flattened).toEqual(members);
  });

  it('custom batch size of 3 splits correctly', () => {
    const members = ['a', 'b', 'c', 'd', 'e'];
    const batches = [...batchMembers(members, 3)];
    expect(batches).toHaveLength(2);
    expect(batches[0]).toEqual(['a', 'b', 'c']);
    expect(batches[1]).toEqual(['d', 'e']);
  });

  it('list of exactly META_BATCH_SIZE items is a single complete batch', () => {
    const members = Array.from(
      { length: META_BATCH_SIZE },
      (_, i) => `id-${i}`,
    );
    const batches = [...batchMembers(members)];
    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(META_BATCH_SIZE);
  });

  it('META_BATCH_SIZE constant is 10 000', () => {
    expect(META_BATCH_SIZE).toBe(10_000);
  });
});
