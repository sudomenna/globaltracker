/**
 * Unit tests for apps/edge/src/integrations/guru/mapper.ts
 *
 * T-ID: T-3-004
 * Spec: docs/40-integrations/13-digitalmanager-guru-webhook.md
 *
 * Coverage:
 *   - Each transaction status → correct InternalEvent type or skip
 *   - Each subscription status → correct InternalEvent type or skip
 *   - Monetary value conversion: centavos → base unit
 *   - Idempotency key determinism and truncation
 *   - Lead hints hierarchy (pptc → email → phone → subscriber_email)
 *   - UTM attribution mapping
 *   - Missing required fields
 *
 * BRs verified:
 *   BR-WEBHOOK-002: event_id is deterministic and 32 chars
 *   BR-WEBHOOK-003: waiting_payment, expired, overdue → skip (not error)
 *   BR-WEBHOOK-004: lead_hints hierarchy
 *   BR-PRIVACY-001: email/phone passed as raw strings (not hashed here)
 */

import { describe, expect, it } from 'vitest';
import {
  deriveGuruEventId,
  mapGuruSubscriptionToInternal,
  mapGuruTransactionToInternal,
} from '../../../apps/edge/src/integrations/guru/mapper';
import type {
  GuruSubscriptionPayload,
  GuruTransactionPayload,
} from '../../../apps/edge/src/integrations/guru/types';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function makeTransactionPayload(
  overrides: Partial<GuruTransactionPayload> = {},
): GuruTransactionPayload {
  return {
    webhook_type: 'transaction',
    api_token: 'test_token_0000000000000000000000000000000000',
    id: '9081534a-7512-4dab-9172-218c1dc1f263',
    type: 'producer',
    status: 'approved',
    created_at: '2024-01-15T10:30:00Z',
    confirmed_at: '2024-01-15T10:31:00Z',
    contact: {
      name: 'Comprador Teste',
      email: 'comprador@example.com',
      doc: '12345678900',
      phone_number: '999999999',
      phone_local_code: '55',
    },
    payment: {
      method: 'credit_card',
      total: 29700,
      gross: 29700,
      net: 25245,
      currency: 'BRL',
      installments: { qty: 1, value: 29700 },
    },
    product: {
      id: 'prod-uuid-0001',
      name: 'Curso Teste XYZ',
      type: 'product',
      offer: { id: 'offer-uuid-0001', name: 'Oferta Principal' },
    },
    source: {
      utm_source: 'facebook',
      utm_campaign: 'camp_123',
      utm_medium: 'paid',
      utm_content: 'ad_456',
      utm_term: null,
      pptc: null,
    },
    ...overrides,
  };
}

function makeSubscriptionPayload(
  overrides: Partial<GuruSubscriptionPayload> = {},
): GuruSubscriptionPayload {
  return {
    webhook_type: 'subscription',
    api_token: 'test_token_0000000000000000000000000000000000',
    id: 'sub_BOAEj2WTKoclmg4X',
    internal_id: '9ad693fe-4366-487b-8ac3-ff4831864929',
    subscription_code: 'sub_9CFyWTuPwXdJUikS',
    name: 'Plano Mensal Teste',
    last_status: 'active',
    provider: 'guru',
    payment_method: 'credit_card',
    charged_every_days: 30,
    subscriber: {
      id: '906d1e37-de6a-4f4d-8271-91ecd0d65ec6',
      name: 'Assinante Teste',
      email: 'assinante@example.com',
      doc: '01234567890',
    },
    current_invoice: {
      id: '9b71cfb2-da2e-44d5-92ce-d83459dec85f',
      status: 'paid',
      value: 2937,
      cycle: 1,
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// deriveGuruEventId
// ---------------------------------------------------------------------------

describe('deriveGuruEventId', () => {
  it('BR-WEBHOOK-002: returns a 32-char hex string', async () => {
    const id = await deriveGuruEventId(
      'transaction',
      '9081534a-7512-4dab-9172-218c1dc1f263',
      'approved',
    );
    expect(id).toHaveLength(32);
    expect(id).toMatch(/^[0-9a-f]{32}$/);
  });

  it('BR-WEBHOOK-002: is deterministic — same inputs produce same key', async () => {
    const id1 = await deriveGuruEventId('transaction', 'abc-123', 'approved');
    const id2 = await deriveGuruEventId('transaction', 'abc-123', 'approved');
    expect(id1).toBe(id2);
  });

  it('BR-WEBHOOK-002: different status produces different key', async () => {
    const id1 = await deriveGuruEventId('transaction', 'abc-123', 'approved');
    const id2 = await deriveGuruEventId('transaction', 'abc-123', 'refunded');
    expect(id1).not.toBe(id2);
  });

  it('BR-WEBHOOK-002: different transaction id produces different key', async () => {
    const id1 = await deriveGuruEventId('transaction', 'abc-111', 'approved');
    const id2 = await deriveGuruEventId('transaction', 'abc-222', 'approved');
    expect(id1).not.toBe(id2);
  });

  it('BR-WEBHOOK-002: different webhook_type produces different key', async () => {
    const id1 = await deriveGuruEventId('transaction', 'abc-123', 'approved');
    const id2 = await deriveGuruEventId('subscription', 'abc-123', 'approved');
    expect(id1).not.toBe(id2);
  });

  it('truncates sha256 to exactly 32 chars (first 32 hex chars of digest)', async () => {
    // SHA-256 produces 64 hex chars; we use the first 32
    const id = await deriveGuruEventId('transaction', 'x', 'y');
    expect(id.length).toBe(32);
  });
});

// ---------------------------------------------------------------------------
// mapGuruTransactionToInternal — approved
// ---------------------------------------------------------------------------

describe('mapGuruTransactionToInternal — approved', () => {
  it('maps approved → Purchase', async () => {
    const result = await mapGuruTransactionToInternal(makeTransactionPayload());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.event_type).toBe('Purchase');
  });

  it('sets platform to guru', async () => {
    const result = await mapGuruTransactionToInternal(makeTransactionPayload());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.platform).toBe('guru');
  });

  it('sets platform_event_id from payload.id', async () => {
    const result = await mapGuruTransactionToInternal(makeTransactionPayload());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.platform_event_id).toBe(
      '9081534a-7512-4dab-9172-218c1dc1f263',
    );
  });

  it('derives deterministic event_id (32 chars)', async () => {
    const result = await mapGuruTransactionToInternal(makeTransactionPayload());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.event_id).toHaveLength(32);
    expect(result.value.event_id).toMatch(/^[0-9a-f]{32}$/);
  });

  it('BR-WEBHOOK-002: same payload produces same event_id', async () => {
    const payload = makeTransactionPayload();
    const r1 = await mapGuruTransactionToInternal(payload);
    const r2 = await mapGuruTransactionToInternal(payload);
    expect(r1.ok && r2.ok).toBe(true);
    if (!r1.ok || !r2.ok) return;
    expect(r1.value.event_id).toBe(r2.value.event_id);
  });

  it('converts amount from centavos to base unit (29700 → 297)', async () => {
    const result = await mapGuruTransactionToInternal(makeTransactionPayload());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.amount).toBe(297);
  });

  it('uses confirmed_at as occurred_at when available', async () => {
    const result = await mapGuruTransactionToInternal(makeTransactionPayload());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.occurred_at).toBe('2024-01-15T10:31:00Z');
  });

  it('falls back to created_at when confirmed_at is missing', async () => {
    const payload = makeTransactionPayload({ confirmed_at: null });
    const result = await mapGuruTransactionToInternal(payload);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.occurred_at).toBe('2024-01-15T10:30:00Z');
  });

  it('maps product fields', async () => {
    const result = await mapGuruTransactionToInternal(makeTransactionPayload());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.product?.id).toBe('prod-uuid-0001');
    expect(result.value.product?.name).toBe('Curso Teste XYZ');
    expect(result.value.product?.offer_id).toBe('offer-uuid-0001');
    expect(result.value.product?.offer_name).toBe('Oferta Principal');
  });

  it('maps UTM attribution from source', async () => {
    const result = await mapGuruTransactionToInternal(makeTransactionPayload());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.attribution?.utm_source).toBe('facebook');
    expect(result.value.attribution?.utm_campaign).toBe('camp_123');
    expect(result.value.attribution?.utm_medium).toBe('paid');
    expect(result.value.attribution?.utm_content).toBe('ad_456');
    expect(result.value.attribution?.utm_term).toBeNull();
  });

  it('maps currency from payment', async () => {
    const result = await mapGuruTransactionToInternal(makeTransactionPayload());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.currency).toBe('BRL');
  });
});

// ---------------------------------------------------------------------------
// mapGuruTransactionToInternal — other statuses
// ---------------------------------------------------------------------------

describe('mapGuruTransactionToInternal — status mapping', () => {
  it('refunded → RefundProcessed', async () => {
    const result = await mapGuruTransactionToInternal(
      makeTransactionPayload({ status: 'refunded' }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.event_type).toBe('RefundProcessed');
  });

  it('chargedback → Chargeback', async () => {
    const result = await mapGuruTransactionToInternal(
      makeTransactionPayload({ status: 'chargedback' }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.event_type).toBe('Chargeback');
  });

  it('canceled → OrderCanceled', async () => {
    const result = await mapGuruTransactionToInternal(
      makeTransactionPayload({ status: 'canceled' }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.event_type).toBe('OrderCanceled');
  });

  it('BR-WEBHOOK-003: waiting_payment → skip (not error)', async () => {
    const result = await mapGuruTransactionToInternal(
      makeTransactionPayload({ status: 'waiting_payment' }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect('skip' in result && result.skip).toBe(true);
  });

  it('BR-WEBHOOK-003: expired → skip (not error)', async () => {
    const result = await mapGuruTransactionToInternal(
      makeTransactionPayload({ status: 'expired' }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect('skip' in result && result.skip).toBe(true);
  });

  it('BR-WEBHOOK-003: unknown status → error with code unknown_status', async () => {
    const result = await mapGuruTransactionToInternal(
      makeTransactionPayload({ status: 'future_unknown_status' }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    // Must NOT be a skip — should be a mapping error
    expect('skip' in result ? result.skip : undefined).toBeFalsy();
    if (!('error' in result)) return;
    expect(result.error.code).toBe('unknown_status');
  });

  it('returns error when id is missing', async () => {
    const payload = makeTransactionPayload({ id: '' });
    const result = await mapGuruTransactionToInternal(payload);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    if (!('error' in result)) return;
    expect(result.error.code).toBe('missing_required_field');
  });
});

// ---------------------------------------------------------------------------
// mapGuruTransactionToInternal — lead hints (BR-WEBHOOK-004)
// ---------------------------------------------------------------------------

describe('mapGuruTransactionToInternal — lead hints', () => {
  it('BR-WEBHOOK-004: email from contact.email', async () => {
    const result = await mapGuruTransactionToInternal(makeTransactionPayload());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // BR-PRIVACY-001: raw string, not hashed
    expect(result.value.lead_hints.email).toBe('comprador@example.com');
  });

  it('BR-WEBHOOK-004: phone concatenated from local_code + number', async () => {
    const result = await mapGuruTransactionToInternal(makeTransactionPayload());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.lead_hints.phone).toBe('55999999999');
  });

  it('BR-WEBHOOK-004: pptc in source.pptc → lead_public_id', async () => {
    const payload = makeTransactionPayload({
      source: {
        utm_source: 'facebook',
        utm_campaign: 'camp_123',
        utm_medium: 'paid',
        utm_content: null,
        utm_term: null,
        pptc: 'pub_lead_abc123',
      },
    });
    const result = await mapGuruTransactionToInternal(payload);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.lead_hints.lead_public_id).toBe('pub_lead_abc123');
  });

  it('lead_public_id is null when pptc is absent', async () => {
    const result = await mapGuruTransactionToInternal(makeTransactionPayload());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.lead_hints.lead_public_id).toBeNull();
  });

  it('phone uses only phone_number when local_code is missing', async () => {
    const payload = makeTransactionPayload({
      contact: {
        name: 'Teste',
        email: 'teste@example.com',
        phone_number: '988887777',
        phone_local_code: null,
      },
    });
    const result = await mapGuruTransactionToInternal(payload);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.lead_hints.phone).toBe('988887777');
  });
});

// ---------------------------------------------------------------------------
// mapGuruTransactionToInternal — monetary conversion edge cases
// ---------------------------------------------------------------------------

describe('mapGuruTransactionToInternal — monetary conversion', () => {
  it('converts 500 centavos → 5.00', async () => {
    const payload = makeTransactionPayload({
      payment: {
        method: 'pix',
        total: 500,
        gross: 500,
        net: 450,
        currency: 'BRL',
      },
    });
    const result = await mapGuruTransactionToInternal(payload);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.amount).toBe(5);
  });

  it('converts 100 centavos → 1.00', async () => {
    const payload = makeTransactionPayload({
      payment: {
        method: 'credit_card',
        total: 100,
        gross: 100,
        net: 85,
        currency: 'BRL',
      },
    });
    const result = await mapGuruTransactionToInternal(payload);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.amount).toBe(1);
  });

  it('converts 0 centavos → 0.00 (free product)', async () => {
    const payload = makeTransactionPayload({
      payment: {
        method: 'free',
        total: 0,
        gross: 0,
        net: 0,
        currency: 'BRL',
      },
    });
    const result = await mapGuruTransactionToInternal(payload);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.amount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// mapGuruSubscriptionToInternal
// ---------------------------------------------------------------------------

describe('mapGuruSubscriptionToInternal — status mapping', () => {
  it('active → SubscriptionActivated', async () => {
    const result = await mapGuruSubscriptionToInternal(
      makeSubscriptionPayload(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.event_type).toBe('SubscriptionActivated');
  });

  it('canceled → SubscriptionCanceled', async () => {
    const result = await mapGuruSubscriptionToInternal(
      makeSubscriptionPayload({ last_status: 'canceled' }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.event_type).toBe('SubscriptionCanceled');
  });

  it('BR-WEBHOOK-003: overdue → skip (not error)', async () => {
    const result = await mapGuruSubscriptionToInternal(
      makeSubscriptionPayload({ last_status: 'overdue' }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect('skip' in result && result.skip).toBe(true);
  });

  it('BR-WEBHOOK-003: unknown status → error with code unknown_status', async () => {
    const result = await mapGuruSubscriptionToInternal(
      makeSubscriptionPayload({ last_status: 'future_unknown_status' }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    if (!('error' in result)) return;
    expect(result.error.code).toBe('unknown_status');
  });

  it('returns error when id is missing', async () => {
    const payload = makeSubscriptionPayload({ id: '' });
    const result = await mapGuruSubscriptionToInternal(payload);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    if (!('error' in result)) return;
    expect(result.error.code).toBe('missing_required_field');
  });
});

describe('mapGuruSubscriptionToInternal — fields', () => {
  it('sets platform to guru', async () => {
    const result = await mapGuruSubscriptionToInternal(
      makeSubscriptionPayload(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.platform).toBe('guru');
  });

  it('sets platform_event_id from payload.id', async () => {
    const result = await mapGuruSubscriptionToInternal(
      makeSubscriptionPayload(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.platform_event_id).toBe('sub_BOAEj2WTKoclmg4X');
  });

  it('derives deterministic event_id (32 chars)', async () => {
    const result = await mapGuruSubscriptionToInternal(
      makeSubscriptionPayload(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.event_id).toHaveLength(32);
    expect(result.value.event_id).toMatch(/^[0-9a-f]{32}$/);
  });

  it('BR-WEBHOOK-002: same payload produces same event_id', async () => {
    const payload = makeSubscriptionPayload();
    const r1 = await mapGuruSubscriptionToInternal(payload);
    const r2 = await mapGuruSubscriptionToInternal(payload);
    expect(r1.ok && r2.ok).toBe(true);
    if (!r1.ok || !r2.ok) return;
    expect(r1.value.event_id).toBe(r2.value.event_id);
  });

  it('converts invoice amount from centavos to base unit (2937 → 29.37)', async () => {
    const result = await mapGuruSubscriptionToInternal(
      makeSubscriptionPayload(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.amount).toBeCloseTo(29.37, 2);
  });

  it('BR-WEBHOOK-004: subscriber.email in lead_hints.subscriber_email', async () => {
    const result = await mapGuruSubscriptionToInternal(
      makeSubscriptionPayload(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // BR-PRIVACY-001: raw string
    expect(result.value.lead_hints.subscriber_email).toBe(
      'assinante@example.com',
    );
  });

  it('subscription event_id differs from transaction event_id with same id and status', async () => {
    const txId = await deriveGuruEventId(
      'transaction',
      'sub_BOAEj2WTKoclmg4X',
      'active',
    );
    const subId = await deriveGuruEventId(
      'subscription',
      'sub_BOAEj2WTKoclmg4X',
      'active',
    );
    expect(txId).not.toBe(subId);
  });
});

// ---------------------------------------------------------------------------
// Fixture file consistency
// ---------------------------------------------------------------------------

describe('fixture files', () => {
  it('transaction-approved fixture maps to Purchase', async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fixture = (await import(
      '../../fixtures/guru/transaction-approved.json',
      { assert: { type: 'json' } }
    )) as { default: GuruTransactionPayload };
    const result = await mapGuruTransactionToInternal(fixture.default);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.event_type).toBe('Purchase');
  });

  it('transaction-refunded fixture maps to RefundProcessed', async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fixture = (await import(
      '../../fixtures/guru/transaction-refunded.json',
      { assert: { type: 'json' } }
    )) as { default: GuruTransactionPayload };
    const result = await mapGuruTransactionToInternal(fixture.default);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.event_type).toBe('RefundProcessed');
  });

  it('subscription-active fixture maps to SubscriptionActivated', async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fixture = (await import(
      '../../fixtures/guru/subscription-active.json',
      { assert: { type: 'json' } }
    )) as { default: GuruSubscriptionPayload };
    const result = await mapGuruSubscriptionToInternal(fixture.default);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.event_type).toBe('SubscriptionActivated');
  });

  it('subscription-canceled fixture maps to SubscriptionCanceled', async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fixture = (await import(
      '../../fixtures/guru/subscription-canceled.json',
      { assert: { type: 'json' } }
    )) as { default: GuruSubscriptionPayload };
    const result = await mapGuruSubscriptionToInternal(fixture.default);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.event_type).toBe('SubscriptionCanceled');
  });
});
