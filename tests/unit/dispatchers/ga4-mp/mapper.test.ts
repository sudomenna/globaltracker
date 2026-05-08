/**
 * Unit tests for GA4 Measurement Protocol mapper — mapEventToGa4Payload.
 *
 * Scope: T-14-013 — ecommerce field enrichment for Purchase and Lead events.
 *
 * BRs tested:
 *   BR-DISPATCH-001: transaction_id derived from event_id when order_id absent (idempotency)
 *   BR-CONSENT-003: consent signals forwarded; events with consent_snapshot=null omit consent
 *   BR-PRIVACY-001: no PII in mapper output (mapper is pure, no hashing here; PII is excluded
 *                   by design — items/transaction fields are non-PII)
 *
 * Fixtures:
 *   tests/fixtures/ga4-mp/request-purchase-with-items.json — full Guru-shape Purchase payload
 */

import { describe, expect, it } from 'vitest';

import {
  type Ga4DispatchableEvent,
  type Ga4DispatchableLead,
  mapEventToGa4Payload,
} from '../../../../apps/edge/src/dispatchers/ga4-mp/mapper.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FIXED_DATE = new Date('2024-05-02T00:00:00.000Z');
const FIXED_UNIX_SECONDS = Math.floor(FIXED_DATE.getTime() / 1000); // 1714608000
const FIXED_MICROS = FIXED_UNIX_SECONDS * 1_000_000; // 1714608000000000

function makePurchaseEvent(
  overrides: Partial<Ga4DispatchableEvent> = {},
): Ga4DispatchableEvent {
  return {
    event_id: 'evt_01HXK2N3P4QR5ST6UV7WX8YZ90',
    event_name: 'Purchase',
    event_time: FIXED_DATE,
    lead_id: 'lead-uuid-001',
    workspace_id: 'ws-uuid-001',
    user_data: {
      client_id_ga4: 'GA1.1.12345678.1234567890',
      session_id_ga4: 'session_abc123',
    },
    custom_data: {
      value: 197.0,
      currency: 'BRL',
      order_id: 'ORD-2024-001',
    },
    consent_snapshot: {
      analytics: 'granted',
      ad_user_data: 'granted',
      ad_personalization: 'granted',
    },
    ...overrides,
  };
}

function makeLeadEvent(
  overrides: Partial<Ga4DispatchableEvent> = {},
): Ga4DispatchableEvent {
  return {
    event_id: 'evt_lead_001',
    event_name: 'Lead',
    event_time: FIXED_DATE,
    lead_id: 'lead-uuid-002',
    workspace_id: 'ws-uuid-001',
    user_data: {
      client_id_ga4: 'GA1.1.12345678.1234567890',
    },
    custom_data: null,
    consent_snapshot: {
      analytics: 'granted',
      ad_user_data: 'granted',
    },
    ...overrides,
  };
}

function makeLead(
  overrides: Partial<Ga4DispatchableLead> = {},
): Ga4DispatchableLead {
  return {
    public_id: 'lead_pub_01HXK2N3P4QR5ST6UV7WX8YZ90',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Purchase — value / currency fields
// ---------------------------------------------------------------------------

describe('mapEventToGa4Payload — Purchase value/currency', () => {
  it('reads cd.value as params.value', () => {
    const payload = mapEventToGa4Payload(
      makePurchaseEvent({ custom_data: { value: 197.0, currency: 'BRL' } }),
      makeLead(),
    );
    expect(payload).not.toBeNull();
    expect(payload?.events[0]?.params?.value).toBe(197.0);
  });

  it('reads cd.amount as params.value when cd.value absent (Guru shape)', () => {
    const payload = mapEventToGa4Payload(
      makePurchaseEvent({
        custom_data: { amount: 497.0, currency: 'BRL' },
      }),
      makeLead(),
    );
    expect(payload).not.toBeNull();
    // BR-DISPATCH-001: value from cd.amount (Guru webhook already converts centavos→reais upstream)
    expect(payload?.events[0]?.params?.value).toBe(497.0);
  });

  it('prefers cd.value over cd.amount when both present', () => {
    const payload = mapEventToGa4Payload(
      makePurchaseEvent({
        custom_data: { value: 100.0, amount: 200.0, currency: 'BRL' },
      }),
      makeLead(),
    );
    expect(payload).not.toBeNull();
    expect(payload?.events[0]?.params?.value).toBe(100.0);
  });

  it('omits params.value when neither cd.value nor cd.amount present', () => {
    const payload = mapEventToGa4Payload(
      makePurchaseEvent({ custom_data: { currency: 'BRL' } }),
      makeLead(),
    );
    expect(payload).not.toBeNull();
    expect(payload?.events[0]?.params?.value).toBeUndefined();
  });

  it('sets currency from cd.currency when present', () => {
    const payload = mapEventToGa4Payload(
      makePurchaseEvent({ custom_data: { value: 197.0, currency: 'USD' } }),
      makeLead(),
    );
    expect(payload).not.toBeNull();
    expect(payload?.events[0]?.params?.currency).toBe('USD');
  });

  it('omits currency when cd.currency absent', () => {
    const payload = mapEventToGa4Payload(
      makePurchaseEvent({ custom_data: { value: 197.0 } }),
      makeLead(),
    );
    expect(payload).not.toBeNull();
    expect(payload?.events[0]?.params?.currency).toBeUndefined();
  });

  it('does not crash when custom_data is null', () => {
    const payload = mapEventToGa4Payload(
      makePurchaseEvent({ custom_data: null }),
      makeLead(),
    );
    expect(payload).not.toBeNull();
    const params = payload?.events[0]?.params;
    expect(params?.value).toBeUndefined();
    expect(params?.currency).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Purchase — transaction_id (BR-DISPATCH-001: idempotency)
// ---------------------------------------------------------------------------

describe('mapEventToGa4Payload — Purchase transaction_id', () => {
  it('BR-DISPATCH-001: uses order_id as transaction_id when present', () => {
    const payload = mapEventToGa4Payload(
      makePurchaseEvent({
        event_id: 'evt_ignored',
        custom_data: { value: 197.0, order_id: 'ORD-2024-001' },
      }),
      makeLead(),
    );
    expect(payload).not.toBeNull();
    expect(payload?.events[0]?.params?.transaction_id).toBe('ORD-2024-001');
  });

  it('BR-DISPATCH-001: falls back to event_id as transaction_id when order_id absent (Guru shape)', () => {
    const payload = mapEventToGa4Payload(
      makePurchaseEvent({
        event_id: 'evt_guru_fallback_id',
        custom_data: { amount: 497.0, currency: 'BRL', product_id: 'abc123' },
      }),
      makeLead(),
    );
    expect(payload).not.toBeNull();
    // Idempotency: GA4 dedup relies on transaction_id; use event_id ensures each
    // dispatch attempt carries a stable, unique identifier (BR-DISPATCH-001).
    expect(payload?.events[0]?.params?.transaction_id).toBe(
      'evt_guru_fallback_id',
    );
  });

  it('non-Purchase event does not get transaction_id from event_id fallback', () => {
    const payload = mapEventToGa4Payload(
      makeLeadEvent({
        event_id: 'evt_lead_no_txn',
        custom_data: { value: 50.0 },
      }),
      makeLead(),
    );
    expect(payload).not.toBeNull();
    expect(payload?.events[0]?.params?.transaction_id).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Purchase — items array (required for GA4 purchase audiences)
// ---------------------------------------------------------------------------

describe('mapEventToGa4Payload — Purchase items array', () => {
  it('populates items with item_id and item_name when both present', () => {
    const payload = mapEventToGa4Payload(
      makePurchaseEvent({
        custom_data: {
          amount: 497.0,
          currency: 'BRL',
          product_id: 'abc123',
          product_name: 'Workshop de Marketing',
        },
      }),
      makeLead(),
    );
    expect(payload).not.toBeNull();
    const items = payload?.events[0]?.params?.items;
    expect(items).toHaveLength(1);
    expect(items?.[0]).toEqual({
      item_id: 'abc123',
      item_name: 'Workshop de Marketing',
      price: 497.0,
      quantity: 1,
    });
  });

  it('populates items with only item_id when product_name absent', () => {
    const payload = mapEventToGa4Payload(
      makePurchaseEvent({
        custom_data: { amount: 497.0, currency: 'BRL', product_id: 'abc123' },
      }),
      makeLead(),
    );
    expect(payload).not.toBeNull();
    const item = payload?.events[0]?.params?.items?.[0];
    expect(item?.item_id).toBe('abc123');
    expect(item?.item_name).toBeUndefined();
    expect(item?.price).toBe(497.0);
    expect(item?.quantity).toBe(1);
  });

  it('populates items with only item_name when product_id absent', () => {
    const payload = mapEventToGa4Payload(
      makePurchaseEvent({
        custom_data: {
          amount: 497.0,
          currency: 'BRL',
          product_name: 'Workshop de Marketing',
        },
      }),
      makeLead(),
    );
    expect(payload).not.toBeNull();
    const item = payload?.events[0]?.params?.items?.[0];
    expect(item?.item_id).toBeUndefined();
    expect(item?.item_name).toBe('Workshop de Marketing');
    expect(item?.quantity).toBe(1);
  });

  it('omits price from items when value/amount absent', () => {
    const payload = mapEventToGa4Payload(
      makePurchaseEvent({
        custom_data: { product_id: 'abc123' },
      }),
      makeLead(),
    );
    expect(payload).not.toBeNull();
    const item = payload?.events[0]?.params?.items?.[0];
    expect(item?.price).toBeUndefined();
    expect(item?.quantity).toBe(1);
  });

  it('omits items array when neither product_id nor product_name present', () => {
    const payload = mapEventToGa4Payload(
      makePurchaseEvent({
        custom_data: { amount: 497.0, currency: 'BRL' },
      }),
      makeLead(),
    );
    expect(payload).not.toBeNull();
    expect(payload?.events[0]?.params?.items).toBeUndefined();
  });

  it('omits items for non-Purchase event even when product_id present', () => {
    const payload = mapEventToGa4Payload(
      makeLeadEvent({
        event_name: 'ViewContent',
        custom_data: { product_id: 'abc123', product_name: 'Workshop' },
      }),
      makeLead(),
    );
    expect(payload).not.toBeNull();
    expect(payload?.events[0]?.params?.items).toBeUndefined();
  });

  it('items array has exactly 1 element for Purchase (single-product GA4 convention)', () => {
    const payload = mapEventToGa4Payload(
      makePurchaseEvent({
        custom_data: {
          amount: 197.0,
          currency: 'BRL',
          product_id: 'prod_a',
          product_name: 'Produto A',
        },
      }),
      makeLead(),
    );
    expect(payload).not.toBeNull();
    expect(payload?.events[0]?.params?.items).toHaveLength(1);
  });

  it('full Guru Purchase: fixture snapshot matches expected payload shape', () => {
    // Mirrors tests/fixtures/ga4-mp/request-purchase-with-items.json
    const payload = mapEventToGa4Payload(
      {
        event_id: 'evt_guru_001',
        event_name: 'Purchase',
        event_time: FIXED_DATE,
        lead_id: 'lead-uuid-001',
        workspace_id: 'ws-uuid-001',
        user_data: {
          client_id_ga4: 'GA1.1.12345678.1234567890',
          session_id_ga4: 'session_abc123',
        },
        custom_data: {
          amount: 497.0,
          currency: 'BRL',
          product_id: 'abc123',
          product_name: 'Workshop de Marketing',
        },
        consent_snapshot: {
          analytics: 'granted',
          ad_user_data: 'granted',
          ad_personalization: 'granted',
        },
      },
      makeLead(),
    );
    expect(payload).not.toBeNull();
    expect(payload).toMatchObject({
      client_id: 'GA1.1.12345678.1234567890',
      user_id: 'lead_pub_01HXK2N3P4QR5ST6UV7WX8YZ90',
      timestamp_micros: FIXED_MICROS,
      events: [
        {
          name: 'purchase',
          params: {
            value: 497.0,
            currency: 'BRL',
            transaction_id: 'evt_guru_001',
            session_id: 'session_abc123',
            items: [
              {
                item_id: 'abc123',
                item_name: 'Workshop de Marketing',
                price: 497.0,
                quantity: 1,
              },
            ],
          },
        },
      ],
      consent: {
        ad_user_data: 'granted',
        ad_personalization: 'granted',
      },
    });
  });
});

// ---------------------------------------------------------------------------
// Lead — value enrichment
// ---------------------------------------------------------------------------

describe('mapEventToGa4Payload — Lead value enrichment', () => {
  it('adds params.value from cd.value when present', () => {
    const payload = mapEventToGa4Payload(
      makeLeadEvent({ custom_data: { value: 50.0 } }),
      makeLead(),
    );
    expect(payload).not.toBeNull();
    expect(payload?.events[0]?.params?.value).toBe(50.0);
  });

  it('adds params.value from cd.amount when cd.value absent', () => {
    const payload = mapEventToGa4Payload(
      makeLeadEvent({ custom_data: { amount: 75.0 } }),
      makeLead(),
    );
    expect(payload).not.toBeNull();
    expect(payload?.events[0]?.params?.value).toBe(75.0);
  });

  it('omits params.value when custom_data has no value/amount', () => {
    const payload = mapEventToGa4Payload(
      makeLeadEvent({ custom_data: {} }),
      makeLead(),
    );
    expect(payload).not.toBeNull();
    expect(payload?.events[0]?.params?.value).toBeUndefined();
  });

  it('omits params.value when custom_data is null — no crash', () => {
    const payload = mapEventToGa4Payload(
      makeLeadEvent({ custom_data: null }),
      makeLead(),
    );
    expect(payload).not.toBeNull();
    // BR-PRIVACY-001: null custom_data produces no value; no undefined serialized
    expect(payload?.events[0]?.params?.value).toBeUndefined();
  });

  it('Lead event does not get items array even with product_id', () => {
    const payload = mapEventToGa4Payload(
      makeLeadEvent({
        custom_data: {
          value: 50.0,
          product_id: 'abc123',
          product_name: 'Product',
        },
      }),
      makeLead(),
    );
    expect(payload).not.toBeNull();
    expect(payload?.events[0]?.params?.items).toBeUndefined();
  });

  it('maps to generate_lead GA4 event name', () => {
    const payload = mapEventToGa4Payload(
      makeLeadEvent({ custom_data: { value: 50.0 } }),
      makeLead(),
    );
    expect(payload).not.toBeNull();
    expect(payload?.events[0]?.name).toBe('generate_lead');
  });

  it('Contact event also maps to generate_lead and picks up value', () => {
    const payload = mapEventToGa4Payload(
      makeLeadEvent({ event_name: 'Contact', custom_data: { value: 30.0 } }),
      makeLead(),
    );
    expect(payload).not.toBeNull();
    expect(payload?.events[0]?.name).toBe('generate_lead');
    expect(payload?.events[0]?.params?.value).toBe(30.0);
  });
});

// ---------------------------------------------------------------------------
// Payload structure invariants
// ---------------------------------------------------------------------------

describe('mapEventToGa4Payload — payload structure invariants', () => {
  it('does not serialize undefined values into params (JSON-safe)', () => {
    const payload = mapEventToGa4Payload(
      makePurchaseEvent({ custom_data: null }),
      makeLead(),
    );
    expect(payload).not.toBeNull();
    // Serialize to JSON and back — no "undefined" values must appear as null
    const json = JSON.stringify(payload);
    const parsed = JSON.parse(json) as typeof payload;
    const params = parsed?.events[0]?.params;
    // Params may be missing entirely or present without undefined-coerced-to-null keys
    if (params) {
      expect(params.value).toBeUndefined();
      expect(params.currency).toBeUndefined();
      expect(params.items).toBeUndefined();
    }
  });

  it('BR-CONSENT-003: consent object forwarded when analytics=granted', () => {
    const payload = mapEventToGa4Payload(
      makePurchaseEvent({
        consent_snapshot: {
          analytics: 'granted',
          ad_user_data: 'granted',
          ad_personalization: 'denied',
        },
      }),
      makeLead(),
    );
    expect(payload).not.toBeNull();
    expect(payload?.consent?.ad_user_data).toBe('granted');
    expect(payload?.consent?.ad_personalization).toBe('denied');
  });

  it('consent omitted when consent_snapshot is null', () => {
    const payload = mapEventToGa4Payload(
      makePurchaseEvent({ consent_snapshot: null }),
      makeLead(),
    );
    expect(payload).not.toBeNull();
    expect(payload?.consent).toBeUndefined();
  });

  it('returns null for events with no GA4 equivalent (Subscribe)', () => {
    const payload = mapEventToGa4Payload(
      makePurchaseEvent({ event_name: 'Subscribe' }),
      makeLead(),
    );
    expect(payload).toBeNull();
  });
});
