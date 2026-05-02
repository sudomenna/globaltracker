/**
 * Unit tests — dispatch idempotency key derivation
 *
 * INV-DISPATCH-002: computeIdempotencyKey is pure — same inputs always yield same output.
 * BR-DISPATCH-001: key = sha256(workspace_id|event_id|destination|destination_resource_id|destination_subresource)
 * ADR-013: deterministic derivation from five canonical fields.
 */

import { describe, expect, it } from 'vitest';
import {
  type IdempotencyKeyParams,
  computeIdempotencyKey,
} from '../../../apps/edge/src/lib/dispatch';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const BASE: IdempotencyKeyParams = {
  workspace_id: 'ws-00000000-0000-0000-0000-000000000001',
  event_id: 'evt-00000000-0000-0000-0000-000000000002',
  destination: 'meta_capi',
  destination_resource_id: 'pixel-123456',
  destination_subresource: null,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('computeIdempotencyKey', () => {
  it('INV-DISPATCH-002: returns a hex SHA-256 string (64 chars)', async () => {
    const key = await computeIdempotencyKey(BASE);
    expect(typeof key).toBe('string');
    expect(key).toHaveLength(64);
    expect(key).toMatch(/^[0-9a-f]{64}$/);
  });

  it('INV-DISPATCH-002: same inputs produce the same output (deterministic)', async () => {
    const key1 = await computeIdempotencyKey(BASE);
    const key2 = await computeIdempotencyKey({ ...BASE });
    expect(key1).toBe(key2);
  });

  it('INV-DISPATCH-002: different workspace_id → different key', async () => {
    const key1 = await computeIdempotencyKey(BASE);
    const key2 = await computeIdempotencyKey({
      ...BASE,
      workspace_id: 'ws-00000000-0000-0000-0000-000000000099',
    });
    expect(key1).not.toBe(key2);
  });

  it('INV-DISPATCH-002: different event_id → different key', async () => {
    const key1 = await computeIdempotencyKey(BASE);
    const key2 = await computeIdempotencyKey({
      ...BASE,
      event_id: 'evt-00000000-0000-0000-0000-000000000099',
    });
    expect(key1).not.toBe(key2);
  });

  it('INV-DISPATCH-002: different destination → different key', async () => {
    const key1 = await computeIdempotencyKey(BASE);
    const key2 = await computeIdempotencyKey({
      ...BASE,
      destination: 'ga4_mp',
    });
    expect(key1).not.toBe(key2);
  });

  it('INV-DISPATCH-002: different destination_resource_id → different key', async () => {
    const key1 = await computeIdempotencyKey(BASE);
    const key2 = await computeIdempotencyKey({
      ...BASE,
      destination_resource_id: 'pixel-999999',
    });
    expect(key1).not.toBe(key2);
  });

  it('INV-DISPATCH-002: different destination_subresource → different key', async () => {
    const key1 = await computeIdempotencyKey({
      ...BASE,
      destination_subresource: 'conversion_action_A',
    });
    const key2 = await computeIdempotencyKey({
      ...BASE,
      destination_subresource: 'conversion_action_B',
    });
    expect(key1).not.toBe(key2);
  });

  it('BR-DISPATCH-001: null and empty string for destination_subresource are equivalent', async () => {
    // spec: destination_subresource=null → '' in hash
    const keyNull = await computeIdempotencyKey({
      ...BASE,
      destination_subresource: null,
    });
    const keyEmpty = await computeIdempotencyKey({
      ...BASE,
      destination_subresource: '',
    });
    expect(keyNull).toBe(keyEmpty);
  });

  it('BR-DISPATCH-001: two different destinations on same event produce distinct keys', async () => {
    // Scenario: event E dispatched to meta_capi (pixel P) AND ga4_mp (measurement M)
    const keyMeta = await computeIdempotencyKey({
      ...BASE,
      destination: 'meta_capi',
      destination_resource_id: 'pixel-P',
    });
    const keyGa4 = await computeIdempotencyKey({
      ...BASE,
      destination: 'ga4_mp',
      destination_resource_id: 'measurement-M',
    });
    expect(keyMeta).not.toBe(keyGa4);
  });

  it('BR-DISPATCH-001: input fields are separated by pipe (not concatenation-collision)', async () => {
    // Ensure "ab|c" and "a|bc" hash differently — field separator is unambiguous
    const key1 = await computeIdempotencyKey({
      ...BASE,
      workspace_id: 'ab',
      event_id: 'c',
    });
    const key2 = await computeIdempotencyKey({
      ...BASE,
      workspace_id: 'a',
      event_id: 'bc',
    });
    expect(key1).not.toBe(key2);
  });
});
