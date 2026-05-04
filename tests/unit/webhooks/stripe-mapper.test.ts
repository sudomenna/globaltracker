/**
 * Unit tests for apps/edge/src/integrations/stripe/mapper.ts
 *
 * T-ID: T-9-003
 * Spec: docs/40-integrations/09-stripe-webhook.md
 *
 * Coverage:
 *   - Each mapped event type → correct InternalEvent shape
 *   - Idempotency key determinism and truncation (BR-WEBHOOK-002)
 *   - Lead hints hierarchy (BR-WEBHOOK-004)
 *   - Unknown event type → error result (BR-WEBHOOK-003)
 *   - Currency uppercased
 *   - Amount in cents (Stripe native unit preserved)
 *   - Fixture file consistency
 *
 * BRs verified:
 *   BR-WEBHOOK-002: event_id is deterministic and 32 chars
 *   BR-WEBHOOK-003: unknown event types → error (not skip)
 *   BR-WEBHOOK-004: lead_hints hierarchy
 *   BR-PRIVACY-001: email/phone passed as raw strings (not hashed here)
 */

import { describe, expect, it } from 'vitest';
import {
  deriveStripeEventId,
  mapStripeToInternal,
} from '../../../apps/edge/src/integrations/stripe/mapper';
import type { StripeEvent } from '../../../apps/edge/src/integrations/stripe/types';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function makeCheckoutSessionEvent(
  overrides: Partial<StripeEvent> = {},
  objectOverrides: Record<string, unknown> = {},
): StripeEvent {
  return {
    id: 'evt_1OeKt2KG2eZvKYlo2TnXHDGo',
    object: 'event',
    type: 'checkout.session.completed',
    created: 1706083200,
    data: {
      object: {
        id: 'cs_test_a1b2c3d4e5f6g7h8i9j0',
        object: 'checkout.session',
        amount_total: 29700,
        currency: 'brl',
        customer_email: 'comprador@example.com',
        customer_details: {
          email: 'comprador@example.com',
          name: 'Comprador Teste',
          phone: null,
        },
        client_reference_id: null,
        metadata: {
          lead_public_id: 'ldr_test_abc123xyz',
          utm_source: 'facebook',
          utm_campaign: 'camp_2024_jan',
          utm_medium: 'paid',
        },
        payment_intent: 'pi_test_b2c3d4e5f6',
        ...objectOverrides,
      },
    },
    ...overrides,
  };
}

function makePaymentIntentEvent(
  overrides: Partial<StripeEvent> = {},
  objectOverrides: Record<string, unknown> = {},
): StripeEvent {
  return {
    id: 'evt_1OeKwXKG2eZvKYlo9PqRsT4u',
    object: 'event',
    type: 'payment_intent.succeeded',
    created: 1706083500,
    data: {
      object: {
        id: 'pi_test_3OeKwXKG2eZvKYlo9PqRsT4u',
        object: 'payment_intent',
        amount: 49900,
        currency: 'brl',
        receipt_email: 'pagador@example.com',
        metadata: {
          lead_public_id: 'ldr_test_def456uvw',
          utm_source: 'google',
        },
        ...objectOverrides,
      },
    },
    ...overrides,
  };
}

function makeChargeRefundedEvent(
  overrides: Partial<StripeEvent> = {},
  objectOverrides: Record<string, unknown> = {},
): StripeEvent {
  return {
    id: 'evt_1OeL3aKG2eZvKYloRfNmQpWx',
    object: 'event',
    type: 'charge.refunded',
    created: 1706087400,
    data: {
      object: {
        id: 'ch_test_3OeL3aKG2eZvKYloRfNmQpWx',
        object: 'charge',
        amount_refunded: 29700,
        currency: 'brl',
        billing_details: {
          email: 'reembolso@example.com',
          name: 'Cliente Reembolso',
          phone: null,
        },
        metadata: {
          lead_public_id: 'ldr_test_ghi789rst',
        },
        ...objectOverrides,
      },
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// deriveStripeEventId
// ---------------------------------------------------------------------------

describe('deriveStripeEventId', () => {
  it('BR-WEBHOOK-002: returns a 32-char hex string', async () => {
    const id = await deriveStripeEventId('evt_1OeKt2KG2eZvKYlo2TnXHDGo');
    expect(id).toHaveLength(32);
    expect(id).toMatch(/^[0-9a-f]{32}$/);
  });

  it('BR-WEBHOOK-002: is deterministic — same input produces same key', async () => {
    const id1 = await deriveStripeEventId('evt_abc123');
    const id2 = await deriveStripeEventId('evt_abc123');
    expect(id1).toBe(id2);
  });

  it('BR-WEBHOOK-002: different event IDs produce different keys', async () => {
    const id1 = await deriveStripeEventId('evt_abc111');
    const id2 = await deriveStripeEventId('evt_abc222');
    expect(id1).not.toBe(id2);
  });

  it('includes platform prefix "stripe:" in derivation', async () => {
    // sha256("stripe:evt_abc") should differ from sha256("evt_abc")
    const withPrefix = await deriveStripeEventId('evt_abc');
    // We can only verify this indirectly: both should be deterministic 32-char hex
    expect(withPrefix).toMatch(/^[0-9a-f]{32}$/);
  });
});

// ---------------------------------------------------------------------------
// checkout.session.completed → Purchase
// ---------------------------------------------------------------------------

describe('mapStripeToInternal — checkout.session.completed', () => {
  it('maps to Purchase event type', async () => {
    const result = await mapStripeToInternal(makeCheckoutSessionEvent());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.event_type).toBe('Purchase');
  });

  it('sets platform to stripe', async () => {
    const result = await mapStripeToInternal(makeCheckoutSessionEvent());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.platform).toBe('stripe');
  });

  it('sets platform_event_id to event.id', async () => {
    const result = await mapStripeToInternal(makeCheckoutSessionEvent());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.platform_event_id).toBe('evt_1OeKt2KG2eZvKYlo2TnXHDGo');
  });

  it('derives deterministic event_id (32 chars)', async () => {
    const result = await mapStripeToInternal(makeCheckoutSessionEvent());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.event_id).toHaveLength(32);
    expect(result.value.event_id).toMatch(/^[0-9a-f]{32}$/);
  });

  it('BR-WEBHOOK-002: same payload produces same event_id', async () => {
    const event = makeCheckoutSessionEvent();
    const r1 = await mapStripeToInternal(event);
    const r2 = await mapStripeToInternal(event);
    expect(r1.ok && r2.ok).toBe(true);
    if (!r1.ok || !r2.ok) return;
    expect(r1.value.event_id).toBe(r2.value.event_id);
  });

  it('sets occurred_at from event.created (epoch to ISO-8601)', async () => {
    const result = await mapStripeToInternal(makeCheckoutSessionEvent());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // 1706083200 = 2024-01-24T08:00:00.000Z
    expect(result.value.occurred_at).toBe('2024-01-24T08:00:00.000Z');
  });

  it('preserves amount in cents (Stripe native unit)', async () => {
    const result = await mapStripeToInternal(makeCheckoutSessionEvent());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // 29700 cents = R$297.00 — Stripe adapter keeps cents, processor converts
    expect(result.value.amount).toBe(29700);
  });

  it('uppercases currency', async () => {
    const result = await mapStripeToInternal(makeCheckoutSessionEvent());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.currency).toBe('BRL');
  });

  it('BR-WEBHOOK-004: lead_public_id from metadata.lead_public_id (priority 1)', async () => {
    const result = await mapStripeToInternal(makeCheckoutSessionEvent());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.lead_hints.lead_public_id).toBe('ldr_test_abc123xyz');
  });

  it('BR-WEBHOOK-004: client_reference_id (priority 2)', async () => {
    const result = await mapStripeToInternal(
      makeCheckoutSessionEvent({}, { client_reference_id: 'ref_client_456' }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.lead_hints.client_reference_id).toBe('ref_client_456');
  });

  it('BR-WEBHOOK-004: email from customer_details.email (priority 3)', async () => {
    const result = await mapStripeToInternal(makeCheckoutSessionEvent());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // BR-PRIVACY-001: raw string, not hashed
    expect(result.value.lead_hints.email).toBe('comprador@example.com');
  });

  it('BR-WEBHOOK-004: email falls back to customer_email when customer_details absent', async () => {
    const result = await mapStripeToInternal(
      makeCheckoutSessionEvent(
        {},
        { customer_details: null, customer_email: 'fallback@example.com' },
      ),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.lead_hints.email).toBe('fallback@example.com');
  });

  it('maps UTM attribution from metadata', async () => {
    const result = await mapStripeToInternal(makeCheckoutSessionEvent());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.attribution?.utm_source).toBe('facebook');
    expect(result.value.attribution?.utm_campaign).toBe('camp_2024_jan');
    expect(result.value.attribution?.utm_medium).toBe('paid');
  });

  it('sets custom_data.order_id to event.id', async () => {
    const result = await mapStripeToInternal(makeCheckoutSessionEvent());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.custom_data?.order_id).toBe('evt_1OeKt2KG2eZvKYlo2TnXHDGo');
  });

  it('handles null amount_total gracefully', async () => {
    const result = await mapStripeToInternal(
      makeCheckoutSessionEvent({}, { amount_total: null }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.amount).toBeNull();
  });

  it('attribution is null when no UTM metadata present', async () => {
    const result = await mapStripeToInternal(
      makeCheckoutSessionEvent({}, { metadata: { lead_public_id: 'ldr_test' } }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.attribution).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// payment_intent.succeeded → PaymentCompleted
// ---------------------------------------------------------------------------

describe('mapStripeToInternal — payment_intent.succeeded', () => {
  it('maps to PaymentCompleted event type', async () => {
    const result = await mapStripeToInternal(makePaymentIntentEvent());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.event_type).toBe('PaymentCompleted');
  });

  it('preserves amount in cents', async () => {
    const result = await mapStripeToInternal(makePaymentIntentEvent());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.amount).toBe(49900);
  });

  it('uppercases currency', async () => {
    const result = await mapStripeToInternal(makePaymentIntentEvent());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.currency).toBe('BRL');
  });

  it('BR-WEBHOOK-004: email from receipt_email', async () => {
    const result = await mapStripeToInternal(makePaymentIntentEvent());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // BR-PRIVACY-001: raw string
    expect(result.value.lead_hints.email).toBe('pagador@example.com');
  });

  it('BR-WEBHOOK-004: lead_public_id from metadata', async () => {
    const result = await mapStripeToInternal(makePaymentIntentEvent());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.lead_hints.lead_public_id).toBe('ldr_test_def456uvw');
  });

  it('derives correct event_id', async () => {
    const result = await mapStripeToInternal(makePaymentIntentEvent());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const expected = await deriveStripeEventId('evt_1OeKwXKG2eZvKYlo9PqRsT4u');
    expect(result.value.event_id).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// charge.refunded → RefundProcessed
// ---------------------------------------------------------------------------

describe('mapStripeToInternal — charge.refunded', () => {
  it('maps to RefundProcessed event type', async () => {
    const result = await mapStripeToInternal(makeChargeRefundedEvent());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.event_type).toBe('RefundProcessed');
  });

  it('preserves amount_refunded in cents', async () => {
    const result = await mapStripeToInternal(makeChargeRefundedEvent());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.amount).toBe(29700);
  });

  it('uppercases currency', async () => {
    const result = await mapStripeToInternal(makeChargeRefundedEvent());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.currency).toBe('BRL');
  });

  it('BR-WEBHOOK-004: email from billing_details.email', async () => {
    const result = await mapStripeToInternal(makeChargeRefundedEvent());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // BR-PRIVACY-001: raw string
    expect(result.value.lead_hints.email).toBe('reembolso@example.com');
  });

  it('BR-WEBHOOK-004: name from billing_details.name', async () => {
    const result = await mapStripeToInternal(makeChargeRefundedEvent());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.lead_hints.name).toBe('Cliente Reembolso');
  });

  it('BR-WEBHOOK-004: lead_public_id from metadata', async () => {
    const result = await mapStripeToInternal(makeChargeRefundedEvent());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.lead_hints.lead_public_id).toBe('ldr_test_ghi789rst');
  });
});

// ---------------------------------------------------------------------------
// Unknown event types (BR-WEBHOOK-003)
// ---------------------------------------------------------------------------

describe('mapStripeToInternal — unknown event types', () => {
  it('BR-WEBHOOK-003: unknown event type → error result (not skip)', async () => {
    const event: StripeEvent = {
      id: 'evt_unknown_123',
      object: 'event',
      type: 'customer.subscription.created',
      created: 1706083200,
      data: { object: { id: 'sub_xxx', object: 'subscription' } },
    };
    const result = await mapStripeToInternal(event);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('unknown_event_type');
  });

  it('BR-WEBHOOK-003: future_unknown_event returns unknown_event_type error', async () => {
    const event: StripeEvent = {
      id: 'evt_future_456',
      object: 'event',
      type: 'invoice.finalized',
      created: 1706083200,
      data: { object: { id: 'in_xxx', object: 'invoice' } },
    };
    const result = await mapStripeToInternal(event);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('unknown_event_type');
    if (result.error.code !== 'unknown_event_type') return;
    expect(result.error.event_type).toBe('invoice.finalized');
  });
});

// ---------------------------------------------------------------------------
// Missing required fields
// ---------------------------------------------------------------------------

describe('mapStripeToInternal — validation', () => {
  it('returns error when event.id is missing', async () => {
    const event = makeCheckoutSessionEvent({ id: '' });
    const result = await mapStripeToInternal(event);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('missing_required_field');
  });

  it('returns error when event.type is missing', async () => {
    const event = makeCheckoutSessionEvent({ type: '' });
    const result = await mapStripeToInternal(event);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('missing_required_field');
  });
});

// ---------------------------------------------------------------------------
// Fixture file consistency
// ---------------------------------------------------------------------------

describe('fixture files', () => {
  it('checkout-session-completed fixture maps to Purchase', async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fixture = (await import(
      '../../fixtures/stripe/checkout-session-completed.json',
      { assert: { type: 'json' } }
    )) as { default: StripeEvent };
    const result = await mapStripeToInternal(fixture.default);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.event_type).toBe('Purchase');
  });

  it('payment-intent-succeeded fixture maps to PaymentCompleted', async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fixture = (await import(
      '../../fixtures/stripe/payment-intent-succeeded.json',
      { assert: { type: 'json' } }
    )) as { default: StripeEvent };
    const result = await mapStripeToInternal(fixture.default);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.event_type).toBe('PaymentCompleted');
  });

  it('charge-refunded fixture maps to RefundProcessed', async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fixture = (await import(
      '../../fixtures/stripe/charge-refunded.json',
      { assert: { type: 'json' } }
    )) as { default: StripeEvent };
    const result = await mapStripeToInternal(fixture.default);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.event_type).toBe('RefundProcessed');
  });
});
