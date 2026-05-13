/**
 * Unit tests — onprofit/mapper (ADR-045).
 *
 * Verifies the cart_abandonment event_id derivation now keys on
 * `payload.id` alone, so legitimately-distinct carts produce distinct
 * event_ids and the unique constraint on `(workspace_id, event_id)`
 * only dedupes true re-deliveries.
 */

import { describe, expect, it } from 'vitest';
import {
  deriveOnProfitCartAbandonmentEventId,
  mapOnProfitCartAbandonmentToInternal,
} from '../../../../apps/edge/src/integrations/onprofit/mapper';
import type { OnProfitCartAbandonmentPayload } from '../../../../apps/edge/src/integrations/onprofit/types';

const HEX_32 = /^[0-9a-f]{32}$/;

function makePayload(
  overrides: Partial<OnProfitCartAbandonmentPayload> = {},
): OnProfitCartAbandonmentPayload {
  return {
    object: 'cart_abandonment',
    id: 884370,
    customer: {
      name: 'Bruna',
      last_name: 'Puga',
      email: 'bruna.siagino@gmail.com',
      phone: '19996225210',
    },
    product_details: { id: 4852, name: 'Workshop', hash: 'fvOsQjDO' },
    offer_details: { id: 9563, name: 'Workshop - Lote 1', price: 5700 },
    created_at: '2026-05-12 20:51:28',
    url: 'https://pay.onprofit.com.br/fvOsQjDO?off=Fn4XA0',
    orderbumps: [],
    session: 'c19e642859df2389abcd',
    ...overrides,
  };
}

describe('deriveOnProfitCartAbandonmentEventId — ADR-045', () => {
  it('returns a 32-char hex string', async () => {
    const id = await deriveOnProfitCartAbandonmentEventId(884370);
    expect(id).toMatch(HEX_32);
  });

  it('same id → same event_id (idempotent / re-delivery dedup)', async () => {
    const a = await deriveOnProfitCartAbandonmentEventId(884370);
    const b = await deriveOnProfitCartAbandonmentEventId(884370);
    expect(a).toBe(b);
  });

  it('different ids → different event_ids (distinct cart instances)', async () => {
    const a = await deriveOnProfitCartAbandonmentEventId(884370);
    const b = await deriveOnProfitCartAbandonmentEventId(884371);
    expect(a).not.toBe(b);
  });

  it('regression: two carts with same (offer_hash, email) but different ids → different event_ids', async () => {
    // This is the Bruna scenario: same buyer abandoning the same offer twice
    // on different days. Pre-ADR-045 these would collide. Post-fix they
    // distinguish naturally via the id.
    const cart1 = await deriveOnProfitCartAbandonmentEventId(880000);
    const cart2 = await deriveOnProfitCartAbandonmentEventId(884370);
    expect(cart1).not.toBe(cart2);
  });

  it('produces the deterministic hash for a known id', async () => {
    // sha256("onprofit:cart_abandonment:1")[:32] is fixed and reproducible.
    // Computed offline with the same algorithm; locks the format.
    const id = await deriveOnProfitCartAbandonmentEventId(1);
    expect(id).toBe('66ae8a4d341760268b7ad67b31f62556');
  });
});

describe('mapOnProfitCartAbandonmentToInternal — event_id derivation', () => {
  it('two payloads with same (offer_hash, email) but different ids → different internal event_ids', async () => {
    const r1 = await mapOnProfitCartAbandonmentToInternal(
      makePayload({ id: 100001 }),
    );
    const r2 = await mapOnProfitCartAbandonmentToInternal(
      makePayload({ id: 100002 }),
    );
    expect(r1.ok && r2.ok).toBe(true);
    if (r1.ok && r2.ok) {
      expect(r1.value.event_id).not.toBe(r2.value.event_id);
      expect(r1.value.event_id).toMatch(HEX_32);
      expect(r2.value.event_id).toMatch(HEX_32);
    }
  });

  it('two payloads with same id but different offer/email → same event_id (re-delivery dedup)', async () => {
    const r1 = await mapOnProfitCartAbandonmentToInternal(
      makePayload({
        id: 200000,
        product_details: { id: 1, name: 'A', hash: 'AAAAAA' },
        customer: {
          name: 'X',
          last_name: 'Y',
          email: 'x@y.com',
          phone: null,
        },
      }),
    );
    const r2 = await mapOnProfitCartAbandonmentToInternal(
      makePayload({
        id: 200000,
        product_details: { id: 2, name: 'B', hash: 'BBBBBB' },
        customer: {
          name: 'P',
          last_name: 'Q',
          email: 'p@q.com',
          phone: null,
        },
      }),
    );
    expect(r1.ok && r2.ok).toBe(true);
    if (r1.ok && r2.ok) {
      expect(r1.value.event_id).toBe(r2.value.event_id);
    }
  });

  it('fails fast when customer.email is missing', async () => {
    const r = await mapOnProfitCartAbandonmentToInternal(
      makePayload({
        customer: {
          name: 'X',
          last_name: 'Y',
          email: '' as string,
          phone: null,
        },
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('missing_required_field');
    }
  });
});
